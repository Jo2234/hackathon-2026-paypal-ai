import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Disable development refresh injection; the HTML keeps script-src 'self'.
// API proxy preserves the browser authority; the server binds that exact console origin.
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', port: 5173, strictPort: true, hmr: false, proxy: { '/api': 'http://127.0.0.1:8787' } } });
