<script setup lang="ts">
import { ClientError } from '@dayline/api-client';
import { onMounted, ref } from 'vue';
import {
  patchProfileSchema,
  successDtoSchema,
  userDtoSchema,
} from '@dayline/contracts';
import { api } from './api';
import { useAccount } from './account';
import { useWorkspace } from './records/workspace';
import { errorMessage } from './records/record-service';
const { current, refresh, clear } = useAccount(),
  { mode, switchMode } = useWorkspace();
const name = ref(''),
  base = ref(0),
  busy = ref(false),
  error = ref(''),
  notice = ref('');
async function load() {
  try {
    await refresh();
    name.value = current.value?.displayName ?? '';
    base.value = current.value?.profileVersion ?? 0;
  } catch (cause) {
    error.value =
      cause instanceof ClientError && cause.status === 401
        ? ''
        : errorMessage(cause);
  }
}
async function save() {
  const input = patchProfileSchema.safeParse({
    displayName: name.value,
    expectedProfileVersion: base.value,
  });
  if (!input.success) {
    error.value = '显示名须为 1–40 字。';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await api.request('/api/v1/me', {
      method: 'PATCH',
      account: true,
      body: input.data,
      decode: userDtoSchema.parse,
    });
    await load();
    notice.value = '显示名已保存。';
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function logout() {
  busy.value = true;
  error.value = '';
  try {
    await api.request('/api/v1/auth/logout', {
      method: 'POST',
      account: true,
      body: {},
      decode: successDtoSchema.parse,
    });
    clear();
    await switchMode('guest');
    notice.value = '已退出，原游客本机记录仍保留。';
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section class="records-page">
    <p class="eyebrow">DAYLINE · 设置</p>
    <h1>我的日序</h1>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <section class="record-panel">
      <h2>当前数据空间</h2>
      <p>
        {{ mode === 'guest' ? '游客 · 仅本机保存' : '已验证账号 · 云端记录' }}
      </p>
      <button class="secondary" :disabled="busy" @click="switchMode('guest')">
        继续使用游客本机记录</button
      ><button v-if="current" :disabled="busy" @click="switchMode('account')">
        进入已验证账号记录</button
      ><RouterLink v-else to="/auth/login">登录云端账号</RouterLink>
      <p class="muted">
        游客与账号记录独立保留。游客登录接入将在下一阶段开放，当前不会自动导入或清空本机记录。
      </p>
    </section>
    <section v-if="current" class="record-panel">
      <h2>账号资料</h2>
      <p>
        邮箱：{{ current.email ?? '尚未绑定真实邮箱' }} ·
        {{ current.emailVerified ? '已验证' : '未验证' }}
      </p>
      <p>
        微信：{{ current.wechatBound ? '已关联' : '尚未关联' }} · 密码：{{
          current.passwordEnabled ? '已启用' : '未启用'
        }}
      </p>
      <p v-if="current.status !== 'active'">
        账号正在注销中，仅可读取；到期 {{ current.deletionDueAt }}
      </p>
      <form @submit.prevent="save">
        <label>显示名<input v-model="name" required /></label
        ><button :disabled="busy || current.status !== 'active'">
          保存显示名
        </button>
      </form>
      <RouterLink v-if="current.passwordEnabled" to="/change-password"
        >修改密码</RouterLink
      ><button class="secondary" :disabled="busy" @click="load">
        重新读取账号</button
      ><button class="secondary" :disabled="busy" @click="logout">
        退出当前账号
      </button>
    </section>
    <section class="record-panel">
      <h2>数据与账号管理</h2>
      <p>
        CSV / JSON 文件功能在阶段 5 开放；绑定与合并在阶段 6
        开放；自助注销在阶段 7 开放。
      </p>
      <p>游客数据仅保存在此设备，清除浏览器存储后无法找回。</p>
    </section>
  </section>
</template>
