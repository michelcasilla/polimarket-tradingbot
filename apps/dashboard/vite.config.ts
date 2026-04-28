import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const gatewayProxyTarget = env.VITE_GATEWAY_PROXY_TARGET || 'http://127.0.0.1:7010';

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      /** Same-origin `/control/*` → dashboard-gateway (avoids CORS + fixes LAN IP in browser). */
      proxy: {
        '/control': {
          target: gatewayProxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
