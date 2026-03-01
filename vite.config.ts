import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/ws': {
        target: 'ws://localhost:5000',
        ws: true
      },
      '/api': {
        target: 'http://localhost:5000'
      }
    }
  },
  // 显式声明需要预构建的重依赖，让 Vite 在启动时一次性打包完成，
  // 避免首次浏览器请求时才临时编译（那会造成几秒卡顿）
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'recharts',
      'lucide-react',
    ]
  }
})
