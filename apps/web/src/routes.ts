import DeletionPage from './DeletionPage.vue';
import IdentityPage from './IdentityPage.vue';
import DataPage from './DataPage.vue';
import DraftsPage from './DraftsPage.vue';
import AuthPage from './AuthPage.vue';
import AccountPage from './AccountPage.vue';
import RecordsPage from './records/RecordsPage.vue';
import type { RouteRecordRaw } from 'vue-router';
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/day' },
  { path: '/review', redirect: '/day' },
  { path: '/day', component: RecordsPage },
  { path: '/entries', redirect: (to) => ({ path: '/day', query: to.query }) },
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
  { path: '/account-deletion', component: DeletionPage },
  { path: '/auth/email-binding', component: IdentityPage },
  {
    path: '/auth/:mode(login|register|verify-email|forgot-password|reset-password)',
    component: AuthPage,
  },
];
