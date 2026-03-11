#!/bin/bash

# Local macOS release flow aligned with .github/workflows/release.yml:
# 1) Build renderer
# 2) Build prepackaged app dir(s) via electron-builder --dir
# 3) Ad-hoc sign .app bundles
# 4) Repackage signed apps into dmg/zip via --prepackaged

set -euo pipefail

cd "$(dirname "$0")/.."

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

echo "🚀 Local mac release (ad-hoc): ${ARCHES[*]}"
echo "📦 Product: ${PRODUCT_NAME}"

if [ ! -d "node_modules/electron/dist" ] || [ ! -d "node_modules/vite" ]; then
  echo "📦 Installing dependencies..."
  npm ci
fi

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

