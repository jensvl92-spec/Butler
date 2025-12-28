import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000, // ✅ forceer poort 3000 voor dev-server
    hmr: {
      host: 'localhost',
      port: 3000, // ✅ expliciet HMR via dezelfde poort
    },
    proxy: {
      // Alles wat naar /api gaat, wordt doorgestuurd naar Home Assistant
      '/api': {
        target: 'http://homeassistant.local:8123',
        changeOrigin: true,
        secure: false,
        ws: true, // ✅ Support Websockets via Proxy
      },
    },
  },
})