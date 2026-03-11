import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'

export default defineConfig({
  base: '/',   // History 模式无 #，开发/生产均通过 HTTP 服务访问
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // 告诉 Vue webview 是原生自定义元素
          isCustomElement: (tag) => tag === 'webview'
        }
      }
    }),
    AutoImport({
      imports: ['vue', 'vue-router'],
      dts: true
    }),
    Components({
      dts: true
    })
  ],
  server: {
    host: '127.0.0.1', // 明确绑定 IPv4，使 localhost 与 127.0.0.1 都能访问（避免只监听 IPv6 ::1 导致 127 打不开）
    port: 28791,       // 开发用 28791，与正式包 UI 28789 分离，同机双装不冲突
    strictPort: true,  // 端口被占用则直接报错
    open: false       // 不自动打开浏览器，由 Electron 窗口加载页面
  }
})
