# Hello Web App Template

这是 OpenUltron 的示例沙盒应用模板，默认采用服务模式运行。

## 应用信息

- id: `com.openultron.hello`
- version: `1.0.0`
- 入口页面: `index.html`
- 服务命令: `node server.js`

## 文件结构

- `manifest.json`: 应用声明（运行时、入口、服务）
- `index.html`: 前端页面
- `server.js`: 本地服务（含 `/api/health`）
- `README.md`: 本文档

## 运行机制

OpenUltron 打开该应用时会优先启动服务，然后加载 `http://127.0.0.1:<port>`。

- 服务端口通过环境变量 `PORT` 注入
- 页面可请求 `/api/health` 检查服务是否在线

## 主题兼容（必须）

沙箱预览会跟随宿主主题在 **light / dark** 间切换，页面实现必须兼容两套主题。

- 建议通过 CSS 变量管理颜色，不要写死单一深浅风格。
- 兼容选择器建议：`html[data-theme="light"]` / `html[data-theme="dark"]`，或 `.theme-light` / `.theme-dark`。
- 需保证文字与背景对比度可读，避免主题切换后出现“看不见文字”。

## 开发调试

在应用工作室右侧 AI 中可直接执行命令：

```bash
node --check server.js
node -e "console.log('node ok', process.version)"
python3 -c "print('python ok')"
```

## 扩展建议

1. 按业务拆分 `api/`、`public/`、`src/` 目录。
2. 在 `manifest.json` 的 `entry.service.command` 配置你的启动命令（如 `npm run dev`）。
3. 如需开放 AI 工具，可在 `manifest.aiTools` 声明并由应用实现。
