import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { skelcastPlugin } from '../../dist/vite.js';
import { demoAPI } from '../shared-api.ts';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), plugins: [vue(), skelcastPlugin(), demoAPI()], server: { port: 5174, strictPort: true }, build: { outDir: 'dist' } });
