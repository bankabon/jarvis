import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 開発時(npm run dev)は backend(localhost:8000)へプロキシ
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8000' } },
})
