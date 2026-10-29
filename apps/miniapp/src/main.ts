import { createSSRApp } from 'vue';
import App from './App.vue';
import { initializeAppearance, useAppearance } from './appearance/theme';
import { i18n, initializeLanguage, syncNavigationLanguage } from './i18n';
export function createApp() {
  initializeLanguage();
  initializeAppearance();
  const app = createSSRApp(App);
  app.use(i18n);
  app.mixin({
    onShow() {
      syncNavigationLanguage();
      useAppearance().applyNativeTheme();
    },
  });
  return { app };
}
