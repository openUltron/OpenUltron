/** 避免 stdout/stderr 已销毁时的 EPIPE */

function createSafeConsoleLoggers() {
  const safeLog = (...args) => {
    try {
      if (process.stdout && !process.stdout.destroyed) {
        console.log(...args)
      }
    } catch (_) {}
  }

  const safeError = (...args) => {
    try {
      if (process.stderr && !process.stderr.destroyed) {
        console.error(...args)
      }
    } catch (_) {}
  }

  return { safeLog, safeError }
}

module.exports = { createSafeConsoleLoggers }
