import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, '..'),
  publicDir: 'public',
  server: {
    port: 3000,
    proxy: {
      '/ws': {
        target: 'ws://localhost:5000',
        ws: true
      }
    }
  },
  build: {
    outDir: 'dist',
  },
  // 预构建重依赖，让 Vite 在服务器启动时就打包完成，首次打开浏览器无需等待
  optimizeDeps: {
    include: ['react', 'react-dom', 'recharts', 'lucide-react'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '..')
    }
  }
})
