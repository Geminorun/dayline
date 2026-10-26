<script setup lang="ts">
import { successDtoSchema } from '@dayline/contracts';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ClientError } from '@dayline/api-client';
import { api } from './api';
import { useAccount } from './account';
const { current, loading, refresh, clear } = useAccount();
const router = useRouter();
const error = ref('');
const busy = ref(false);
async function load() {
  error.value = '';
  try {
    await refresh();
  } catch (cause) {
    error.value =
      cause instanceof ClientError ? cause.message : '无法读取账号，请重试。';
  }
}
async function logout() {
  busy.value = true;
  error.value = '';
  try {
    await api.request('/api/v1/auth/logout', {
      decode: successDtoSchema.parse,
      method: 'POST',
      account: true,
      body: {},
    });
    clear();
    await router.push('/login');
  } catch (cause) {
    error.value =
      cause instanceof ClientError ? cause.message : '退出未完成，请重试。';
    if (!api.getAccount()) clear();
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section class="card">
    <p class="eyebrow">DAYLINE · 账号</p>
    <h1>当前账号</h1>
    <p v-if="loading" role="status">正在确认登录身份…</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <template v-if="current && !loading"
      ><h2>{{ current.displayName }}</h2>
      <dl>
        <dt>邮箱</dt>
        <dd>{{ current.email ?? '尚未绑定真实邮箱' }}</dd>
        <dt>邮箱验证</dt>
        <dd>{{ current.emailVerified ? '已验证' : '未验证' }}</dd>
        <dt>微信</dt>
        <dd>{{ current.wechatBound ? '已关联微信' : '尚未关联' }}</dd>
        <dt>账号状态</dt>
        <dd>{{ current.status === 'active' ? '正常' : '账号受限' }}</dd>
      </dl>
      <RouterLink v-if="current.passwordEnabled" to="/change-password"
        >修改密码</RouterLink
      ><button :disabled="busy" @click="logout">
        {{ busy ? '正在退出…' : '退出当前账号' }}
      </button></template
    >
    <button v-if="error" class="secondary" @click="load">重新读取账号</button
    ><RouterLink v-if="!current && !loading" to="/login">前往登录</RouterLink>
  </section>
</template>
