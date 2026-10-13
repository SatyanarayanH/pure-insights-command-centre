import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env.VITE_API_TARGET ?? `http://localhost:${process.env.API_PORT ?? 4000}`;

// In development the browser talks to Vite only; Vite forwards API and WebSocket traffic.
// Same origin means the refresh cookie can stay SameSite=Strict and no CORS is involved.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/ws': { target: API, ws: true, changeOrigin: false },
      '/docs': API,
      '/openapi.json': API,
      '/asyncapi.json': API,
    },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 900 },
});
