import { defineConfig } from 'vite';
import type { PluginOption } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';

// DCloud publishes CommonJS; native ESM and Vite's loader can wrap default twice.
function uniPlugin(factory: unknown): PluginOption {
  if (typeof factory === 'function') return factory();
  if (factory && typeof factory === 'object' && 'default' in factory)
    return uniPlugin(factory.default);
  throw new Error('Unsupported uni-app Vite plugin export.');
}
export default defineConfig({ plugins: [uniPlugin(uni)] });
