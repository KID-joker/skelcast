import { defineConfig } from 'tsup';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const compilerFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = `${directory}/${entry.name}`;
  return entry.isDirectory() ? compilerFiles(file) : file.endsWith('.ts') ? [file] : [];
});
const compilerHash = createHash('sha256').update([...compilerFiles('src/compiler'), 'src/generator.ts', 'src/types.ts'].sort().map(file => `${file}\n${readFileSync(file, 'utf8')}`).join('\n')).digest('hex').slice(0, 12);

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/vite.ts', 'src/runtime/index.ts', 'src/adapters/react.ts', 'src/adapters/vue.ts', 'src/client.ts', 'src/browser.ts'],
  format: ['esm'], target: 'es2022', platform: 'neutral', splitting: true,
  sourcemap: true, clean: true, dts: true,
  define: { __SKELETON_COMPILER_HASH__: JSON.stringify(compilerHash) },
  external: ['react', 'vue', 'vite', '@babel/parser', '@babel/types', '@vue/compiler-dom', '@vue/compiler-sfc', 'postcss', 'postcss-modules', 'postcss-import', 'postcss-selector-parser', 'less', '@unocss/core', '@unocss/preset-mini', '@unocss/preset-attributify'],
});
