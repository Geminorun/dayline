<script setup lang="ts">
import { monthYearLabel } from './i18n';
import { tr, messageRef } from './i18n/index';
import { msg } from '@dayline/locales';
import AdmissionReview from './AdmissionReview.vue';
import { useRouter, useRoute } from 'vue-router';
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import {
  businessToday,
  coversDate,
  dateOrdinal,
  isCalendarDate,
  shiftDate,
  shiftMonth,
  weekDates,
} from '@dayline/core';
import { recordView } from './records/view-state';
import PlannerIcon from './components/PlannerIcon.vue';
import PlannerSymbols from './components/PlannerSymbols.vue';
import SyncStatus from './components/SyncStatus.vue';
import PwaExperience from './pwa/PwaExperience.vue';
import { pwa } from './pwa/client';
import { useDraftCount } from './records/use-draft-count';
import { initializeAppearance, stopAppearance } from './appearance/theme';
import { errorMessage } from './records/record-service';
import { useWorkspace } from './records/workspace';
import { useAccount } from './account';
const workspace = useWorkspace();
const router = useRouter(),
  route = useRoute();
watch(
  () =>
    `${workspace.mode.value}:${useAccount().current.value?.status}:${route.path}`,
  () => {
    if (
      workspace.mode.value !== 'account' ||
      useAccount().current.value?.status !== 'pending_deletion'
    )
      return;
    if (
      [
        '/account-deletion',
        '/data',
        '/drafts',
        '/settings',
        '/login',
        '/register',
        '/verify',
        '/verified',
        '/forgot-password',
        '/reset-password',
      ].includes(route.path) ||
      route.path.startsWith('/auth/')
    )
      return;
    void router.replace('/account-deletion');
  },
);
const { mode, identityState, switchMode, cacheError } = workspace,
  { current } = useAccount();
const { count: draftCount, unavailable: draftsUnavailable } = useDraftCount();
const starting = ref(true);
const loggingOut = ref(false),
  logoutError = messageRef();
async function logout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  logoutError.value = '';
  try {
    await useAccount().logout();
    await switchMode('guest');
    closeAccountMenu();
    await router.replace('/day');
    workspace.notice.value = msg('common.signedOut');
  } catch (cause) {
    logoutError.value = errorMessage(cause);
  } finally {
    loggingOut.value = false;
  }
}
function visible() {
  workspace.lifecycle(document.visibilityState === 'visible');
}
function focus() {
  if (document.visibilityState === 'visible') {
    void workspace.reprobe();
    workspace.lifecycle(true);
  }
}
function online() {
  if (document.visibilityState === 'visible') workspace.networkRestored();
}
function outsideAccountMenu(event: PointerEvent) {
  if (
    event.target instanceof Node &&
    !accountMenu.value?.contains(event.target)
  )
    closeAccountMenu();
}
onMounted(() => {
  initializeAppearance();
  void workspace.ensure().finally(() => {
    starting.value = false;
  });
  window.addEventListener('focus', focus);
  window.addEventListener('online', online);
  window.addEventListener('pointerdown', outsideAccountMenu);
  document.addEventListener('visibilitychange', visible);
});
onBeforeUnmount(() => {
  stopAppearance();
  workspace.lifecycle(false);
  window.removeEventListener('focus', focus);
  window.removeEventListener('online', online);
  window.removeEventListener('pointerdown', outsideAccountMenu);
  document.removeEventListener('visibilitychange', visible);
});
const accountMenu = ref<HTMLDetailsElement | null>(null);
let menuCloseTimer: ReturnType<typeof setTimeout> | undefined;
let menuHovered = false;
function closeAccountMenu() {
  if (menuCloseTimer !== undefined) clearTimeout(menuCloseTimer);
  menuCloseTimer = undefined;
  menuHovered = false;
  if (accountMenu.value) accountMenu.value.open = false;
}
function enterAccountMenu(event: PointerEvent) {
  if (event.pointerType !== 'mouse') return;
  if (menuCloseTimer !== undefined) clearTimeout(menuCloseTimer);
  menuCloseTimer = undefined;
  menuHovered = true;
  if (accountMenu.value) accountMenu.value.open = true;
}
function leaveAccountMenu(event: PointerEvent) {
  if (event.pointerType !== 'mouse') return;
  menuHovered = false;
  menuCloseTimer = setTimeout(closeAccountMenu, 120);
}
function focusAccountMenu(event: FocusEvent) {
  if (
    event.target instanceof HTMLElement &&
    event.target.matches(':focus-visible') &&
    accountMenu.value
  )
    accountMenu.value.open = true;
}
function blurAccountMenu(event: FocusEvent) {
  if (
    !menuHovered &&
    !(
      event.relatedTarget instanceof Node &&
      accountMenu.value?.contains(event.relatedTarget)
    )
  )
    closeAccountMenu();
}
function toggleAccountMenu(event: MouseEvent) {
  // Pointer hover owns the desktop state; taps and keyboard keep native details behavior.
  if (event.detail > 0 && menuHovered) event.preventDefault();
}
onBeforeUnmount(closeAccountMenu);
watch(
  () => route.fullPath,
  () => {
    closeAccountMenu();
  },
);
const calendarMonth = ref('');
const calendarToday = computed(
  () => workspace.snapshot.value?.businessToday ?? businessToday(),
);
const calendarSelected = computed(
  () => recordView.selectedDate || calendarToday.value,
);
watch(
  calendarSelected,
  (date) => {
    calendarMonth.value = date.slice(0, 7) + '-01';
  },
  { immediate: true },
);
const monthLabel = computed(() =>
  monthYearLabel(
    Number(calendarMonth.value.slice(0, 4)),
    Number(calendarMonth.value.slice(5, 7)),
  ),
);

const calendarDays = computed(() => {
  if (!isCalendarDate(calendarMonth.value)) return [];
  const start = weekDates(calendarMonth.value)[0];
  if (!start) return [];
  return Array.from({ length: 42 }, (_, i) =>
    dateOrdinal(start) + i <= dateOrdinal('9999-12-31')
      ? shiftDate(start, i)
      : null,
  );
});
watch(
  () => [route.path, mode.value, current.value?.id] as const,
  ([path]) => {
    if (path === '/timeline') recordView.activeView = 'timeline';
    else if (path === '/day') recordView.activeView = 'day';
  },
  { immediate: true },
);
const pageLabel = computed(() =>
  route.path.startsWith('/timeline')
    ? tr('common.timeline')
    : ({
        '/day': tr('common.dailyReview'),
        '/categories':
          recordView.activeView === 'timeline'
            ? tr('common.timeline')
            : tr('common.dailyReview'),
        '/trash': tr('common.trash'),
        '/drafts': tr('common.unsavedChanges'),
        '/data': tr('common.dataManagement'),
        '/settings': tr('common.settings'),
        '/identity': tr('common.linkedAccounts'),
        '/account-deletion': tr('common.deleteAccount'),
      }[route.path] ??
      (route.path.startsWith('/entries/')
        ? recordView.activeView === 'timeline'
          ? tr('common.timeline')
          : tr('common.dailyReview')
        : tr('common.account'))),
);
function selectCalendar(date: string) {
  recordView.selectedDate = date;
  void router.push({ path: '/day', query: { date } });
}
function selectCategory(id: string) {
  recordView.filter.categoryId = recordView.filter.categoryId === id ? '' : id;
  if (!['/day', '/timeline'].includes(route.path)) void router.push('/day');
}
function categoryCount(id: string) {
  return (
    workspace.snapshot.value?.entries.filter(
      (entry) =>
        entry.categoryId === id &&
        (route.path === '/timeline' ||
          coversDate(entry, calendarSelected.value, calendarToday.value)),
    ).length ?? 0
  );
}
function hasEvent(date: string) {
  return workspace.snapshot.value?.entries.some((entry) =>
    coversDate(entry, date, calendarToday.value),
  );
}
</script>
<template>
  <PlannerSymbols />
  <PwaExperience />
  <div class="app-shell">
    <aside class="sidebar">
      <RouterLink class="brand" to="/day" :aria-label="tr('common.daylineHome')"
        ><span class="brand-mark"><i></i><i></i><i></i></span
        ><span
          >{{ tr('common.dayline') }}<small>DAYLINE</small></span
        ></RouterLink
      >
      <div class="workspace-label">{{ tr('common.myDays') }}</div>
      <nav class="primary-nav" :aria-label="tr('common.mainNavigation')">
        <RouterLink
          class="nav-item"
          :class="{
            active: recordView.activeView === 'day',
          }"
          to="/day"
          ><PlannerIcon name="calendar" />{{ tr('common.dailyReview')
          }}<span class="nav-dot"></span
        ></RouterLink>
        <RouterLink
          class="nav-item"
          :class="{ active: recordView.activeView === 'timeline' }"
          to="/timeline"
          ><PlannerIcon name="timeline" />{{ tr('common.timeline')
          }}<span class="nav-dot"></span
        ></RouterLink>
      </nav>
      <div class="mini-calendar">
        <div class="mini-header">
          <strong>{{ monthLabel }}</strong>
          <div>
            <button
              class="icon-btn small"
              :aria-label="tr('common.previousMonth')"
              :disabled="calendarMonth === '0001-01-01'"
              @click="calendarMonth = shiftMonth(calendarMonth, -1)"
            >
              <PlannerIcon class="flip" name="chevron" />
            </button>
            <button
              class="icon-btn small"
              :aria-label="tr('common.nextMonth')"
              :disabled="calendarMonth === '9999-12-01'"
              @click="calendarMonth = shiftMonth(calendarMonth, 1)"
            >
              <PlannerIcon name="chevron" />
            </button>
          </div>
        </div>
        <div class="mini-weekdays">
          <span
            v-for="day in [
              tr('common.mon'),
              tr('common.tue'),
              tr('common.wed'),
              tr('common.thu'),
              tr('common.fri'),
              tr('common.sat'),
              tr('common.sun'),
            ]"
            :key="day"
            >{{ day }}</span
          >
        </div>
        <div class="mini-days">
          <template v-for="(date, index) in calendarDays" :key="date ?? index"
            ><button
              v-if="date"
              :aria-label="date"
              :aria-pressed="date === calendarSelected"
              :class="{
                'other-month': date.slice(0, 7) !== calendarMonth.slice(0, 7),
                selected: date === calendarSelected,
                'is-today': date === calendarToday,
                'has-event': hasEvent(date),
              }"
              @click="selectCalendar(date)"
            >
              {{ Number(date.slice(8)) }}</button
            ><span v-else></span
          ></template>
        </div>
      </div>
      <div class="side-section-title">
        {{ tr('common.categories')
        }}<RouterLink class="manage-link" to="/categories">{{
          tr('common.manage')
        }}</RouterLink>
      </div>
      <div class="side-categories">
        <div
          v-for="category in workspace.snapshot.value?.categories ?? []"
          :key="category.id"
          class="side-category-row"
          :style="{ '--category-color': category.color }"
        >
          <button
            class="side-category"
            :class="{ active: recordView.filter.categoryId === category.id }"
            :aria-pressed="recordView.filter.categoryId === category.id"
            @click="selectCategory(category.id)"
          >
            <i class="category-dot"></i><span>{{ category.name }}</span
            ><span>{{ categoryCount(category.id) || '–' }}</span>
          </button>
          <RouterLink
            class="icon-btn small"
            :to="{ path: '/categories', query: { edit: category.id } }"
            :aria-label="tr('app.editCategory', { value0: category.name })"
            ><PlannerIcon name="edit"
          /></RouterLink>
          <RouterLink
            class="icon-btn small"
            :to="{ path: '/categories', query: { remove: category.id } }"
            :aria-label="tr('app.deleteCategory', { value0: category.name })"
            ><PlannerIcon name="trash"
          /></RouterLink>
        </div>
      </div>
      <div class="sidebar-bottom">
        <div class="little-spark">✧</div>
        <p>{{ tr('app.makeRoomForYourDays') }}</p>
        <span>{{ tr('app.aLittleSpaceForTheThingsThat') }}</span>
      </div>
      <div class="storage-label">
        <span></span
        >{{
          mode === 'guest'
            ? tr('app.recordSavedInCurrentBrowser')
            : tr('app.accountRecordsCloudStorage')
        }}
      </div>
    </aside>
    <main>
      <header class="topbar">
        <div class="breadcrumb">
          {{ tr('common.mySpace') }}<span>/</span
          ><strong>{{ pageLabel }}</strong>
        </div>
        <div class="topbar-end">
          <span
            v-if="pwa.state.offline"
            class="pwa-offline"
            role="status"
            :title="tr('pwa.offlineHint')"
            >{{ tr('pwa.offline') }}</span
          >
          <SyncStatus />
          <details
            ref="accountMenu"
            class="account-menu"
            @pointerenter="enterAccountMenu"
            @pointerleave="leaveAccountMenu"
            @focusin="focusAccountMenu"
            @focusout="blurAccountMenu"
            @keydown.esc.stop.prevent="closeAccountMenu"
          >
            <summary class="account-entry" @click="toggleAccountMenu">
              <span class="avatar">{{
                current?.displayName?.slice(0, 1) ?? tr('common.guest')
              }}</span
              ><span>{{
                current?.displayName ?? tr('app.guestLoginRegister')
              }}</span>
            </summary>
            <section
              class="profile-popover"
              :aria-label="tr('common.accountsAndMoreFeatures')"
            >
              <div class="profile-heading">
                {{
                  current
                    ? tr('common.myAccount')
                    : tr('common.welcomeToDayline')
                }}
              </div>
              <strong class="profile-name">{{
                current?.displayName ??
                tr('app.everyExperienceIsWorthRecording')
              }}</strong>
              <div class="account-actions">
                <RouterLink
                  v-if="!current"
                  class="button account-signin"
                  to="/login"
                  >{{ tr('common.signInSignUp') }}</RouterLink
                >
                <RouterLink class="button" to="/settings">{{
                  tr('common.settings')
                }}</RouterLink
                ><RouterLink
                  v-if="draftCount > 0 || draftsUnavailable"
                  class="button"
                  to="/drafts"
                  >{{ tr('common.unsavedChanges')
                  }}<span
                    class="draft-count"
                    :title="
                      draftsUnavailable
                        ? tr('app.theUnsubmittedContentOfThisMachineCannot')
                        : undefined
                    "
                    >{{ draftsUnavailable ? '!' : draftCount }}</span
                  ></RouterLink
                >
                <button
                  v-if="!pwa.state.installed"
                  class="button"
                  @click="
                    closeAccountMenu();
                    pwa.install();
                  "
                >
                  <PlannerIcon name="download" />{{ tr('pwa.install') }}
                </button>
                <RouterLink class="button" to="/trash">{{
                  tr('common.trash')
                }}</RouterLink>
                <button
                  v-if="current"
                  class="button account-logout"
                  :disabled="loggingOut"
                  @click="logout"
                >
                  <PlannerIcon name="logout" />{{
                    loggingOut ? tr('common.exiting') : tr('common.signOut')
                  }}
                </button>
                <p v-if="logoutError" role="alert" class="settings-error">
                  {{ logoutError }}
                </p>
              </div>
            </section>
          </details>
        </div>
      </header>
      <div class="main-content">
        <section
          v-if="
            !starting &&
            (identityState === 'unknown' || identityState === 'expired')
          "
          class="notice"
          role="status"
        >
          <p>{{ tr('app.theIdentityHasNotBeenConfirmedAnd') }}</p>
          <button class="button subtle" @click="workspace.retryIdentity">
            {{ tr('common.reauthenticateExistingSession') }}</button
          ><RouterLink to="/auth/login">{{
            tr('common.signInAgain')
          }}</RouterLink
          ><button class="button subtle" @click="switchMode('guest')">
            {{ tr('common.continueAsGuest') }}
          </button>
        </section>
        <section
          v-if="current?.status === 'pending_deletion'"
          class="notice"
          role="status"
        >
          <p>{{ tr('app.theAccountIsBeingAccountDeletionNormal') }}</p>
          <RouterLink to="/account-deletion">{{
            tr('app.viewExpirationDateExplicitCancellation')
          }}</RouterLink>
          ·
          <RouterLink to="/data">{{
            tr('common.exportingSavedRecords')
          }}</RouterLink>
        </section>
        <AdmissionReview
          v-if="mode === 'account' && current?.status === 'active'"
        />
        <p v-if="cacheError" class="error" role="status">{{ cacheError }}</p>
        <RouterView v-slot="{ Component, route }"
          ><component
            :is="Component"
            :key="
              route.path.startsWith('/auth/') ||
              [
                '/login',
                '/register',
                '/verify',
                '/verified',
                '/forgot-password',
                '/reset-password',
                '/change-password',
              ].includes(route.path)
                ? route.path
                : 'business'
            "
        /></RouterView>
        <footer class="page-footer">
          <span>{{ tr('app.dayline') }}</span
          ><span>{{ tr('app.oneDayAtATime') }}</span>
        </footer>
      </div>
    </main>
  </div>
</template>
