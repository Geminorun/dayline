import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) =>
            ['view', 'text', 'picker', 'scroll-view'].includes(tag),
        },
      },
    }),
  ],
  resolve: {
    dedupe: ['vue'],
    alias: {
      vue: fileURLToPath(
        new URL('./node_modules/vue/dist/vue.esm-bundler.js', import.meta.url),
      ),
      '@vue/test-utils': fileURLToPath(
        new URL(
          './node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs',
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    server: { deps: { inline: [/vue/, /@vue/] } },
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
});
