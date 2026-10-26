<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import { useWorkspace } from './records/workspace';
import { useAccount } from './account';
const { mode, snapshot, busy, load, switchMode } = useWorkspace(),
  { current } = useAccount();
function guestForeground() {
  if (
    mode.value === 'guest' &&
    snapshot.value &&
    !busy.value &&
    document.visibilityState === 'visible'
  )
    void load();
}
onMounted(() => {
  window.addEventListener('focus', guestForeground);
  document.addEventListener('visibilitychange', guestForeground);
});
onBeforeUnmount(() => {
  window.removeEventListener('focus', guestForeground);
  document.removeEventListener('visibilitychange', guestForeground);
});
</script>
<template>
  <div class="shell">
    <aside class="sidebar">
      <RouterLink class="brand" to="/day">日序 <span>Dayline</span></RouterLink>
      <p class="muted">记录持续的经历</p>
      <nav aria-label="主导航">
        <RouterLink to="/day">每日回看</RouterLink
        ><RouterLink to="/entries">全部记录</RouterLink
        ><RouterLink to="/timeline">时间轴</RouterLink
        ><RouterLink to="/categories">分类</RouterLink
        ><RouterLink to="/trash">回收站</RouterLink
        ><RouterLink to="/settings">设置</RouterLink>
      </nav>
      <p class="sidebar-note">回看每天的重点。</p>
    </aside>
    <div class="main-shell">
      <header>
        <span>{{
          mode === 'guest'
            ? '游客 · 仅本机保存'
            : `${current?.displayName ?? '账号'} · 云端记录`
        }}</span>
        <nav aria-label="账号导航">
          <button
            v-if="mode === 'account'"
            class="secondary"
            @click="switchMode('guest')"
          >
            继续游客</button
          ><RouterLink v-if="!current" to="/auth/login">登录</RouterLink
          ><RouterLink v-if="!current" to="/auth/register">注册</RouterLink
          ><RouterLink to="/settings">{{
            current?.displayName ?? '设置'
          }}</RouterLink>
        </nav>
      </header>
      <main>
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
      </main>
      <footer>日序 Dayline · 每段经历都值得回看</footer>
    </div>
  </div>
</template>
