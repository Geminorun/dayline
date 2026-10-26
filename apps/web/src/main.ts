import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import AuthPage from './AuthPage.vue';
import AccountPage from './AccountPage.vue';
import RecordsPage from './records/RecordsPage.vue';
import './style.css';
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/review' },
    { path: '/review', component: RecordsPage },
    {
      path: '/:mode(login|register|verify|verified|forgot-password|reset-password|change-password)',
      component: AuthPage,
    },
    { path: '/account', component: AccountPage },
  ],
});
createApp(App).use(router).mount('#app');
