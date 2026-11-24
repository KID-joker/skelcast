import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const compilerHash = createHash('sha256').update(['src/compiler/index.ts', 'src/compiler/expression.ts', 'src/compiler/styles.ts', 'src/generator.ts', 'src/types.ts'].map(f => readFileSync(f, 'utf8')).join('\n')).digest('hex').slice(0, 12);

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/vite.ts', 'src/runtime/index.ts', 'src/adapters/react.ts', 'src/adapters/vue.ts', 'src/client.ts'],
  format: ['esm'], target: 'es2022', platform: 'neutral', splitting: true,
  sourcemap: true, clean: true, dts: true,
  define: { __SKELETON_COMPILER_HASH__: JSON.stringify(compilerHash) },
  external: ['react', 'vue', 'vite', '@babel/parser', '@babel/types', '@vue/compiler-sfc', 'postcss', 'postcss-modules', 'postcss-import'],
});
