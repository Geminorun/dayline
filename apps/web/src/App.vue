<script setup lang="ts">
import AdmissionReview from './AdmissionReview.vue';
import { onMounted, onBeforeUnmount } from 'vue';
import { useWorkspace } from './records/workspace';
import { useAccount } from './account';
const workspace = useWorkspace();
const { mode, identityState, switchMode, cacheError } = workspace,
  { current } = useAccount();
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
onMounted(() => {
  void workspace.ensure();
  window.addEventListener('focus', focus);
  window.addEventListener('online', online);
  document.addEventListener('visibilitychange', visible);
});
onBeforeUnmount(() => {
  workspace.lifecycle(false);
  window.removeEventListener('focus', focus);
  window.removeEventListener('online', online);
  document.removeEventListener('visibilitychange', visible);
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
        ><RouterLink to="/drafts">草稿</RouterLink
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
        <section
          v-if="identityState === 'unknown' || identityState === 'expired'"
          class="notice"
          role="status"
        >
          <p>身份尚未确认，私人缓存已隐藏；原账号草稿仍保留。</p>
          <button class="secondary" @click="workspace.retryIdentity">
            重新验证已有会话</button
          ><RouterLink to="/auth/login">重新登录</RouterLink
          ><button class="secondary" @click="switchMode('guest')">
            明确继续游客
          </button>
        </section>
        <AdmissionReview v-if="mode === 'account'" />
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
      </main>
      <footer>日序 Dayline · 每段经历都值得回看</footer>
    </div>
  </div>
</template>
