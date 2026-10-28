<script setup lang="ts">
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
  logoutError = ref('');
async function logout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  logoutError.value = '';
  try {
    await useAccount().logout();
    await switchMode('guest');
    closeAccountMenu();
    await router.replace('/day');
    workspace.notice.value = '已退出登录。';
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
const monthLabel = computed(
  () =>
    `${Number(calendarMonth.value.slice(0, 4))}年 ${Number(calendarMonth.value.slice(5, 7))}月`,
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
    ? '时间轴'
    : ({
        '/day': '每日回看',
        '/categories':
          recordView.activeView === 'timeline' ? '时间轴' : '每日回看',
        '/trash': '回收站',
        '/drafts': '未提交修改',
        '/data': '数据管理',
        '/settings': '设置',
        '/identity': '账号关联',
        '/account-deletion': '账号注销',
      }[route.path] ??
      (route.path.startsWith('/entries/')
        ? recordView.activeView === 'timeline'
          ? '时间轴'
          : '每日回看'
        : '账号')),
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
  <div class="app-shell">
    <aside class="sidebar">
      <RouterLink class="brand" to="/day" aria-label="日序首页"
        ><span class="brand-mark"><i></i><i></i><i></i></span
        ><span>日序<small>DAYLINE</small></span></RouterLink
      >
      <div class="workspace-label">我的生活足迹</div>
      <nav class="primary-nav" aria-label="主导航">
        <RouterLink
          class="nav-item"
          :class="{
            active: recordView.activeView === 'day',
          }"
          to="/day"
          ><PlannerIcon name="calendar" />每日回看<span class="nav-dot"></span
        ></RouterLink>
        <RouterLink
          class="nav-item"
          :class="{ active: recordView.activeView === 'timeline' }"
          to="/timeline"
          ><PlannerIcon name="timeline" />时间轴<span class="nav-dot"></span
        ></RouterLink>
      </nav>
      <div class="mini-calendar">
        <div class="mini-header">
          <strong>{{ monthLabel }}</strong>
          <div>
            <button
              class="icon-btn small"
              aria-label="上个月"
              :disabled="calendarMonth === '0001-01-01'"
              @click="calendarMonth = shiftMonth(calendarMonth, -1)"
            >
              <PlannerIcon class="flip" name="chevron" />
            </button>
            <button
              class="icon-btn small"
              aria-label="下个月"
              :disabled="calendarMonth === '9999-12-01'"
              @click="calendarMonth = shiftMonth(calendarMonth, 1)"
            >
              <PlannerIcon name="chevron" />
            </button>
          </div>
        </div>
        <div class="mini-weekdays">
          <span
            v-for="day in ['一', '二', '三', '四', '五', '六', '日']"
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
        事项分类<RouterLink class="manage-link" to="/categories"
          >管理</RouterLink
        >
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
            :aria-label="`编辑分类${category.name}`"
            ><PlannerIcon name="edit"
          /></RouterLink>
          <RouterLink
            class="icon-btn small"
            :to="{ path: '/categories', query: { remove: category.id } }"
            :aria-label="`删除分类${category.name}`"
            ><PlannerIcon name="trash"
          /></RouterLink>
        </div>
      </div>
      <div class="sidebar-bottom">
        <div class="little-spark">✧</div>
        <p>时间有迹，生活有序。</p>
        <span>为每一件小事，留一点空间。</span>
      </div>
      <div class="storage-label">
        <span></span
        >{{ mode === 'guest' ? '记录保存在当前浏览器' : '账号记录 · 云端保存' }}
      </div>
    </aside>
    <main>
      <header class="topbar">
        <div class="breadcrumb">
          我的空间<span>/</span><strong>{{ pageLabel }}</strong>
        </div>
        <div class="topbar-end">
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
                current?.displayName?.slice(0, 1) ?? '客'
              }}</span
              ><span>{{ current?.displayName ?? '游客 · 登录·注册' }}</span>
            </summary>
            <section class="profile-popover" aria-label="账号与更多功能">
              <div class="profile-heading">
                {{ current ? '我的账号' : '欢迎使用日序' }}
              </div>
              <strong class="profile-name">{{
                current?.displayName ?? '每一段经历，都值得记录'
              }}</strong>
              <div class="account-actions">
                <RouterLink
                  v-if="!current"
                  class="button account-signin"
                  to="/login"
                  >登录·注册</RouterLink
                >
                <RouterLink class="button" to="/settings">设置</RouterLink
                ><RouterLink
                  v-if="draftCount > 0 || draftsUnavailable"
                  class="button"
                  to="/drafts"
                  >未提交修改
                  <span
                    class="draft-count"
                    :title="
                      draftsUnavailable
                        ? '本机未提交内容暂时无法读取'
                        : undefined
                    "
                    >{{ draftsUnavailable ? '!' : draftCount }}</span
                  ></RouterLink
                ><RouterLink class="button" to="/trash">回收站</RouterLink>
                <button
                  v-if="current"
                  class="button account-logout"
                  :disabled="loggingOut"
                  @click="logout"
                >
                  <PlannerIcon name="logout" />{{
                    loggingOut ? '正在退出…' : '退出登录'
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
          <p>身份尚未确认，私人缓存已隐藏；原账号草稿仍保留。</p>
          <button class="button subtle" @click="workspace.retryIdentity">
            重新验证已有会话</button
          ><RouterLink to="/auth/login">重新登录</RouterLink
          ><button class="button subtle" @click="switchMode('guest')">
            明确继续游客
          </button>
        </section>
        <section
          v-if="current?.status === 'pending_deletion'"
          class="notice"
          role="status"
        >
          <p>账号正在注销中，普通登录不会撤销。业务写入已暂停。</p>
          <RouterLink to="/account-deletion"
            >查看到期时间 / 明确撤销</RouterLink
          >
          · <RouterLink to="/data">导出已保存记录</RouterLink>
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
          <span>日序 DAYLINE</span><span>慢慢来，每一天都算数。</span>
        </footer>
      </div>
    </main>
  </div>
</template>
