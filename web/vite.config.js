import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const api = process.env.API_URL || 'http://localhost:3000'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '0.0.0.0', port: 5173, proxy: { '/api': { target: api, changeOrigin: false } } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: { output: { manualChunks: { vue: ['vue', 'vue-router', 'pinia', 'vue-i18n'], naive: ['naive-ui'] } } },
  },
})
