import { createSSRApp } from 'vue';
import App from './App.vue';
import { i18n, initializeLanguage, syncNavigationLanguage } from './i18n';
export function createApp() {
  initializeLanguage();
  const app = createSSRApp(App);
  app.use(i18n);
  app.mixin({ onShow: syncNavigationLanguage });
  return { app };
}
