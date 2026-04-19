#!/bin/bash

# Local macOS release flow aligned with .github/workflows/release.yml:
# 1) Build renderer
# 2) Build prepackaged app dir(s) via electron-builder --dir
# 3) Ad-hoc sign .app bundles
# 4) Repackage signed apps into dmg/zip via --prepackaged

set -euo pipefail

cd "$(dirname "$0")/.."

# 结束本机调试用的 Vite / Gateway / Electron，避免 electron-builder 替换 dist-electron 时 EBUSY 或端口占用
bash scripts/kill-for-release.sh

# 避免历史 ~/.npm 缓存权限污染导致 npm ci 在 release 阶段直接 EPERM 退出。
# release 构建使用仓库内独立缓存，确保脚本在 CI/本机都可重复执行。
export npm_config_cache="${npm_config_cache:-$PWD/.cache/npm-release}"
export NPM_CONFIG_CACHE="$npm_config_cache"
mkdir -p "$npm_config_cache"
RELEASE_HOME="${RELEASE_HOME:-$PWD/.cache/release-home}"
mkdir -p "$RELEASE_HOME"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi
if [ -f ".nvmrc" ] && command -v nvm >/dev/null 2>&1; then
  echo "🔄 Using Node from .nvmrc..."
  nvm use >/dev/null 2>&1 || nvm install >/dev/null 2>&1
fi

ARCH_INPUT="${1:-all}" # all | arm64 | x64
case "$ARCH_INPUT" in
  all) ARCHES=(arm64 x64) ;;
  arm64) ARCHES=(arm64) ;;
  x64) ARCHES=(x64) ;;
  *)
    echo "Invalid arch: $ARCH_INPUT (use: all | arm64 | x64)"
    exit 1
    ;;
esac

DIST_DIR="dist-electron"
PRODUCT_NAME="$(node -p "require('./package.json').build?.productName || 'OpenUltron'")"
ELECTRON_VERSION="$(node -p "(require('./package.json').devDependencies?.electron || require('./package.json').dependencies?.electron || '').replace(/^[^0-9]*/, '')")"

echo "🚀 Local mac release (ad-hoc): ${ARCHES[*]}"
echo "📦 Product: ${PRODUCT_NAME}"

has_release_toolchain() {
  [ -x "node_modules/.bin/vite" ] &&
  [ -x "node_modules/.bin/electron-builder" ] &&
  [ -f "node_modules/node-edge-tts/package.json" ]
}

validate_electron_cache() {
  local arch="$1"
  local cache_zip="$HOME/Library/Caches/electron/electron-v${ELECTRON_VERSION}-darwin-${arch}.zip"
  if [ ! -f "$cache_zip" ]; then
    return 0
  fi

  if unzip -t "$cache_zip" >/dev/null 2>&1; then
    return 0
  fi

  echo "⚠️  Detected corrupted Electron cache: $cache_zip"
  rm -f "$cache_zip"
}

prepare_builder_inputs() {
  for arch in "${ARCHES[@]}"; do
    validate_electron_cache "$arch"
  done

  rm -rf "$DIST_DIR/mac" "$DIST_DIR/mac-arm64" "$DIST_DIR/mac-x64"
}

ensure_ffmpeg_binary() {
  if [ ! -f "node_modules/ffmpeg-static/package.json" ]; then
    return 0
  fi

  local ffmpeg_path
  ffmpeg_path="$(node -p "require('./node_modules/ffmpeg-static')" 2>/dev/null || true)"
  if [ -n "$ffmpeg_path" ] && [ -x "$ffmpeg_path" ]; then
    return 0
  fi

  local release_tag
  local executable_name
  release_tag="$(node -p "require('./node_modules/ffmpeg-static/package.json')['ffmpeg-static']['binary-release-tag']")"
  executable_name="$(node -p "require('./node_modules/ffmpeg-static/package.json')['ffmpeg-static']['executable-base-name']")"
  ffmpeg_path="${ffmpeg_path:-$PWD/node_modules/ffmpeg-static/${executable_name}}"

  local downloads_base
  downloads_base="${FFMPEG_BINARIES_URL:-https://github.com/eugeneware/ffmpeg-static/releases/download}"
  local machine_arch
  machine_arch="$(uname -m)"
  case "$machine_arch" in
    x86_64) machine_arch="x64" ;;
    aarch64) machine_arch="arm64" ;;
  esac
  local download_url="${downloads_base}/${release_tag}/${executable_name}-$(uname -s | tr '[:upper:]' '[:lower:]')-${machine_arch}.gz"
  local tmp_gz
  tmp_gz="$(mktemp "${TMPDIR:-/tmp}/ffmpeg-static.XXXXXX.gz")"

  echo "📥 Downloading ffmpeg-static binary..."
  curl -L --fail --retry 5 --connect-timeout 15 --max-time 0 "$download_url" -o "$tmp_gz"
  gunzip -c "$tmp_gz" > "$ffmpeg_path"
  chmod +x "$ffmpeg_path"
  rm -f "$tmp_gz"
}

install_dependencies() {
  local install_mode="$1"
  local install_flags=(--cache "$npm_config_cache" --no-audit --no-fund)
  if [ "$install_mode" = "offline" ]; then
    install_flags+=(--offline)
  else
    install_flags+=(--prefer-offline)
  fi

  HOME="$RELEASE_HOME" npm ci --ignore-scripts "${install_flags[@]}"
  ensure_ffmpeg_binary
}

if ! has_release_toolchain; then
  echo "📦 Release toolchain incomplete, restoring dependencies..."
  if ! install_dependencies offline; then
    echo "⚠️  Offline restore failed, retrying with network..."
    install_dependencies online
  fi
fi

if ! has_release_toolchain; then
  echo "Release toolchain is still incomplete after dependency restore."
  echo "Expected: node_modules/.bin/vite, node_modules/.bin/electron-builder, node_modules/node-edge-tts/package.json"
  exit 1
fi

prepare_builder_inputs

echo "📦 Step 1/4: Build renderer"
npm run build

echo "📦 Step 2/4: Build prepackaged app dir"
BUILD_ARGS=()
for a in "${ARCHES[@]}"; do BUILD_ARGS+=("--$a"); done
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac "${BUILD_ARGS[@]}" --dir --publish never

echo "🔏 Step 3/4: Ad-hoc sign app bundles"
shopt -s nullglob
APPS=(dist-electron/mac*/"${PRODUCT_NAME}.app")
if [ ${#APPS[@]} -eq 0 ]; then
  APPS=(dist-electron/mac*/*.app)
fi
if [ ${#APPS[@]} -eq 0 ]; then
  echo "No app bundles found in dist-electron/mac*"
  ls -la "$DIST_DIR" || true
  exit 1
fi
for app in "${APPS[@]}"; do
  echo " - Signing: $app"
  xattr -cr "$app" 2>/dev/null || true
  codesign --force --deep --sign - "$app"
  codesign --verify --deep --verbose=2 "$app"
done

echo "📦 Step 4/4: Repackage signed artifacts"
rm -f "$DIST_DIR"/*.dmg "$DIST_DIR"/*-mac.zip "$DIST_DIR"/*.blockmap "$DIST_DIR"/latest*.yml 2>/dev/null || true

BUILT_ANY=0
if [ -d "$DIST_DIR/mac-arm64" ] && [[ " ${ARCHES[*]} " == *" arm64 "* ]]; then
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --prepackaged="$DIST_DIR/mac-arm64" --publish never
  BUILT_ANY=1
fi
if [ -d "$DIST_DIR/mac" ] && [[ " ${ARCHES[*]} " == *" x64 "* ]]; then
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --x64 --prepackaged="$DIST_DIR/mac" --publish never
  BUILT_ANY=1
fi
if [ "$BUILT_ANY" -ne 1 ]; then
  echo "No prepackaged mac dirs found for requested arches: ${ARCHES[*]}"
  ls -la "$DIST_DIR" || true
  exit 1
fi

echo ""
echo "✅ Release build done."
echo "📦 Output:"
ls -lh "$DIST_DIR"/*.dmg "$DIST_DIR"/*.zip 2>/dev/null || true

if command -v open >/dev/null 2>&1; then
  open "$DIST_DIR/"
fi
