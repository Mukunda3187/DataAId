import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': import.meta.dirname,
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        // Ignore the persistent database file — server writes to it on every upload
        // and Vite would otherwise trigger a full page reload, wiping React state
        ignored: ['**/persistent_database.json', '**/dataaid.db', '**/*.db']
      },
      // No proxy — Express serves both the API and the Vite frontend on port 3000
    },
  };
});
