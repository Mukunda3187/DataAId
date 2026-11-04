
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': import.meta.dirname,
      },
    },
    server: {
      allowedHosts: ['dataaid.onrender.com'],
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        ignored: [
          '**/persistent_database.json',
          '**/dataaid.db',
          '**/*.db'
        ]
      },
      // No proxy — Express serves both the API and Vite frontend on port 3000
    },
  };
});
