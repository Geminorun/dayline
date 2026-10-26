import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import IdentityPage from './IdentityPage.vue';
import DataPage from './DataPage.vue';
import DraftsPage from './DraftsPage.vue';
import App from './App.vue';
import AuthPage from './AuthPage.vue';
import AccountPage from './AccountPage.vue';
import RecordsPage from './records/RecordsPage.vue';
import './style.css';
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/day' },
    { path: '/review', redirect: '/day' },
    { path: '/day', component: RecordsPage },
    { path: '/entries', component: RecordsPage },
    { path: '/entries/new', component: RecordsPage },
    { path: '/entries/:id', component: RecordsPage },
    { path: '/timeline', component: RecordsPage },
    { path: '/categories', component: RecordsPage },
    { path: '/trash', component: RecordsPage },
    {
      path: '/:mode(login|register|verify|verified|forgot-password|reset-password|change-password)',
      component: AuthPage,
    },
    { path: '/account', redirect: '/settings' },
    { path: '/settings', component: AccountPage },
    { path: '/drafts', component: DraftsPage },
    { path: '/data', component: DataPage },
    { path: '/identity', component: IdentityPage },
    { path: '/auth/email-binding', component: IdentityPage },
    {
      path: '/auth/:mode(login|register|verify-email|forgot-password|reset-password)',
      component: AuthPage,
    },
  ],
});
createApp(App).use(router).mount('#app');
