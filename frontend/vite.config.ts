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
    rollupOptions: {
      external: ['react', 'react-dom', 'lucide-react', 'recharts']
    }
  },
  optimizeDeps: {
    exclude: ['react', 'react-dom', 'lucide-react', 'recharts']
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '..')
    }
  }
})
