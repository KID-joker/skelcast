import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { skelcastPlugin } from '../../dist/vite.js';
import { demoAPI } from '../shared-api.ts';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), plugins: [react(), skelcastPlugin(), demoAPI()], server: { port: 5173, strictPort: true }, build: { outDir: 'dist' } });
