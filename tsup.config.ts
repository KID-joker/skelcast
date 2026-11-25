import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const compilerHash = createHash('sha256').update(['src/compiler/index.ts', 'src/compiler/expression.ts', 'src/compiler/styles.ts', 'src/compiler/components.ts', 'src/compiler/presets/index.ts', 'src/compiler/presets/types.ts', 'src/compiler/presets/naive-ui.ts', 'src/compiler/presets/shared.ts', 'src/compiler/presets/element-plus.ts', 'src/compiler/presets/ant-design.ts', 'src/generator.ts', 'src/types.ts'].map(f => readFileSync(f, 'utf8')).join('\n')).digest('hex').slice(0, 12);

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/vite.ts', 'src/runtime/index.ts', 'src/adapters/react.ts', 'src/adapters/vue.ts', 'src/client.ts'],
  format: ['esm'], target: 'es2022', platform: 'neutral', splitting: true,
  sourcemap: true, clean: true, dts: true,
  define: { __SKELETON_COMPILER_HASH__: JSON.stringify(compilerHash) },
  external: ['react', 'vue', 'vite', '@babel/parser', '@babel/types', '@vue/compiler-dom', '@vue/compiler-sfc', 'postcss', 'postcss-modules', 'postcss-import', 'less', '@unocss/core', '@unocss/preset-mini', '@unocss/preset-attributify'],
});
