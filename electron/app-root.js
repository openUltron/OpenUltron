/**
 * 应用数据根目录（全局唯一配置）
 * 原 ~/.gitManager，现改为 ~/.openultron，所有持久化路径均基于此目录。
 */
const path = require('path')
const os = require('os')
const fs = require('fs')

/** 应用数据目录名（位于用户 home 下） */
const APP_ROOT_DIRNAME = '.openultron'
const WORKSPACE_DIRNAME = 'workspace'

/**
 * 返回应用数据根目录的完整路径，例如 /Users/xxx/.openultron
 */
function getAppRoot() {
  return path.join(os.homedir(), APP_ROOT_DIRNAME)
}

/**
 * 返回根目录下某子路径，例如 getAppRootPath('conversations') => .../conversations
 */
function getAppRootPath(...segments) {
  return path.join(getAppRoot(), ...segments)
}

/**
 * 统一工作空间根目录：~/.openultron/workspace
 */
function getWorkspaceRoot() {
  return getAppRootPath(WORKSPACE_DIRNAME)
}

/**
 * 工作空间子路径，例如 getWorkspacePath('scripts') => ~/.openultron/workspace/scripts
 */
function getWorkspacePath(...segments) {
  return path.join(getWorkspaceRoot(), ...segments)
}

/**
 * 确保工作空间目录存在（workspace/scripts/projects）
 */
function ensureWorkspaceDirs() {
  const dirs = [
    getWorkspaceRoot(),
    getWorkspacePath('scripts'),
    getWorkspacePath('projects'),
    getWorkspacePath('attachments')
  ]
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

module.exports = {
  APP_ROOT_DIRNAME,
  WORKSPACE_DIRNAME,
  getAppRoot,
  getAppRootPath,
  getWorkspaceRoot,
  getWorkspacePath,
  ensureWorkspaceDirs
}
