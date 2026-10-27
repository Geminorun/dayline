<script setup lang="ts">
import { formatBeijingTime } from '@dayline/core';
import {
  qrCreatedDtoSchema,
  qrStatusDtoSchema,
  nativeUserSchema,
  nativeStatusSchema,
  wechatLoginDtoSchema,
} from '@dayline/contracts';
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ClientError } from '@dayline/api-client';
import { displayNameSchema } from '@dayline/contracts';
import type { QrCreatedDto } from '@dayline/contracts';
import { api } from './api';
import { useAccount } from './account';
import { useWorkspace } from './records/workspace';
import { takeAuthCallback } from './callback';
const route = useRoute();
const router = useRouter();
const account = useAccount();
const mode = computed(() =>
  route.params.mode === 'verify-email' ? 'verify' : String(route.params.mode),
);
const titles: Record<string, string> = {
  login: '欢迎回来',
  register: '创建日序账号',
  verify: '验证邮箱',
  verified: '邮箱验证结果',
  'forgot-password': '找回密码',
  'reset-password': '设置新密码',
  'change-password': '修改密码',
};
const callback = takeAuthCallback(window.location, window.history);
let resetToken: string | null = callback.token;
const name = ref('');
const email = ref('');
const password = ref('');
const currentPassword = ref('');
const confirmPassword = ref('');
const busy = ref(false);
const message = ref(
  callback.error
    ? '链接已失效或验证失败，请重新申请。'
    : mode.value === 'verified'
      ? '如已通过邮件链接验证，请使用邮箱和密码登录。登录时将由服务器确认验证状态。'
      : '',
);
const error = ref('');
const rateLimited = ref(false);
const retrySeconds = ref(0);
const errorTip = computed(() =>
  rateLimited.value && retrySeconds.value > 0
    ? `操作过于频繁，请等待 ${retrySeconds.value} 秒后再试。`
    : error.value,
);
const submitLabels: Record<string, string> = {
  login: '邮箱登录',
  register: '注册并发送验证邮件',
  verify: '重发验证邮件',
  'forgot-password': '发送密码重置邮件',
  'reset-password': '重置密码',
  'change-password': '修改密码',
};
const submitLabel = computed(() => {
  if (busy.value) return '处理中…';
  if (retrySeconds.value > 0) return `${retrySeconds.value} 秒后可重试`;
  return submitLabels[mode.value] ?? '提交';
});
let retryTimer: ReturnType<typeof setInterval> | undefined;
function stopRetry() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = undefined;
  retrySeconds.value = 0;
  if (rateLimited.value) error.value = '';
  rateLimited.value = false;
}
function waitForRetry(seconds: number) {
  stopRetry();
  rateLimited.value = true;
  const until = Date.now() + seconds * 1000;
  retrySeconds.value = seconds;
  retryTimer = setInterval(() => {
    retrySeconds.value = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (!retrySeconds.value) {
      stopRetry();
      message.value = '等待已结束，可以重新提交。';
    }
  }, 1000);
}
const unsubscribeRetry = api.onIdentityChange(stopRetry);
const qr = ref<QrCreatedDto | null>(null);
const qrBusy = ref(false);
const qrMessage = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let polling = false;
const isPassword = computed(() =>
  ['login', 'register', 'reset-password', 'change-password'].includes(
    mode.value,
  ),
);
const isEmail = computed(() =>
  ['login', 'register', 'verify', 'forgot-password'].includes(mode.value),
);
function feedback(cause: unknown) {
  return cause instanceof ClientError
    ? cause.message
    : '操作未完成，请稍后重试。';
}
async function submit() {
  if (disposed || retrySeconds.value > 0) return;
  const generation = api.getGeneration();
  error.value = '';
  message.value = '';
  if (busy.value) return;
  if (
    mode.value === 'register' &&
    !displayNameSchema.safeParse(name.value).success
  ) {
    error.value = '显示名须为 1–40 个字符。';
    return;
  }
  if (
    ['register', 'reset-password', 'change-password'].includes(mode.value) &&
    password.value !== confirmPassword.value
  ) {
    error.value = '两次输入的新密码不一致。';
    return;
  }
  busy.value = true;
  try {
    const callbackURL = `${window.location.origin}/verified`;
    if (mode.value === 'login') {
      await api.request('/api/auth/sign-in/email', {
        decode: nativeUserSchema.parse,
        method: 'POST',
        native: true,
        body: { email: email.value, password: password.value },
      });
      await account.refresh(true);
      account.announce();
      await useWorkspace().switchMode('account');
      await router.push(
        account.current.value?.status === 'pending_deletion' ||
          route.query.returnTo === '/account-deletion'
          ? '/account-deletion'
          : '/day',
      );
    } else if (mode.value === 'register') {
      await api.request('/api/auth/sign-up/email', {
        decode: nativeUserSchema.parse,
        method: 'POST',
        native: true,
        body: {
          name: name.value.trim(),
          email: email.value,
          password: password.value,
          callbackURL,
        },
      });
      message.value = '注册请求已完成。请查收验证邮件，验证后再登录。';
    } else if (mode.value === 'verify') {
      await api.request('/api/auth/send-verification-email', {
        decode: nativeStatusSchema.parse,
        method: 'POST',
        native: true,
        body: { email: email.value, callbackURL },
      });
      message.value =
        '验证邮件请求已受理；如该邮箱需要验证，我们会尝试发送。未收到可稍后重试。';
    } else if (mode.value === 'forgot-password') {
      await api.request('/api/auth/request-password-reset', {
        decode: nativeStatusSchema.parse,
        method: 'POST',
        native: true,
        body: {
          email: email.value,
          redirectTo: `${window.location.origin}/reset-password`,
        },
      });
      message.value = '如该邮箱已注册，重置邮件将发送到该邮箱。';
    } else if (mode.value === 'reset-password') {
      if (!resetToken)
        throw new ClientError(
          'TOKEN_REQUIRED',
          '缺少有效重置链接，请重新申请。',
        );
      await api.request('/api/auth/reset-password', {
        decode: nativeStatusSchema.parse,
        method: 'POST',
        native: true,
        body: { token: resetToken, newPassword: password.value },
      });
      resetToken = null;
      account.clear();
      message.value = '密码已重置，请重新登录。';
    } else if (mode.value === 'change-password') {
      if (!api.getAccount()) await account.refresh();
      await api.request('/api/auth/change-password', {
        decode: nativeUserSchema.parse,
        method: 'POST',
        native: true,
        account: true,
        body: {
          currentPassword: currentPassword.value,
          newPassword: password.value,
          revokeOtherSessions: true,
        },
      });
      await account.refresh();
      message.value = '密码已修改，其他设备会话已退出。';
    }
  } catch (cause) {
    if (disposed || generation !== api.getGeneration()) return;
    error.value = feedback(cause);
    if (
      cause instanceof ClientError &&
      cause.status === 429 &&
      cause.retryAfterSeconds !== undefined
    )
      waitForRetry(cause.retryAfterSeconds);
    if (
      !api.getAccount() &&
      cause instanceof ClientError &&
      cause.status === 401
    )
      account.clear();
  } finally {
    busy.value = false;
    password.value = '';
    currentPassword.value = '';
    confirmPassword.value = '';
  }
}
function stopPolling() {
  if (timer) clearTimeout(timer);
  timer = undefined;
}
async function poll() {
  const id = qr.value?.id;
  if (!id || disposed || polling) return;
  stopPolling();
  polling = true;
  try {
    const { data } = await api.request(`/api/v1/auth/qr-requests/${id}`, {
      decode: qrStatusDtoSchema.parse,
    });
    if (disposed || qr.value?.id !== id || !data) return;
    qr.value.status = data.status;
    if (data.status === 'confirmed') {
      qrMessage.value = '微信已确认，请点击下方完成登录。';
      return;
    }
    if (['expired', 'cancelled', 'consumed'].includes(data.status)) {
      qrMessage.value =
        data.status === 'expired'
          ? '二维码已过期，请重新生成。'
          : '扫码请求已结束，请重新生成。';
      return;
    }
    qrMessage.value =
      data.status === 'scanned'
        ? '已扫描，等待在小程序中确认。'
        : '请用微信扫描，并在小程序中确认登录网页。';
    timer = setTimeout(() => {
      void poll();
    }, 2000);
  } catch (cause) {
    if (!disposed) qrMessage.value = feedback(cause) + ' 可手动刷新状态。';
  } finally {
    polling = false;
  }
}
async function cancelQr() {
  stopPolling();
  if (!qr.value) return;
  await api.request(`/api/v1/auth/qr-requests/${qr.value.id}`, {
    decode: qrStatusDtoSchema.parse,
    method: 'DELETE',
  });
  qr.value = null;
  qrMessage.value = '扫码请求已取消。';
}
async function createQr() {
  if (qrBusy.value) return;
  qrBusy.value = true;
  error.value = '';
  try {
    if (
      qr.value &&
      !['consumed', 'expired', 'cancelled'].includes(qr.value.status)
    )
      await cancelQr();
    const { data } = await api.request('/api/v1/auth/qr-requests', {
      decode: qrCreatedDtoSchema.parse,
      method: 'POST',
      body: { id: crypto.randomUUID(), purpose: 'login' },
    });
    if (!disposed && data) {
      qr.value = data;
      await poll();
    }
  } catch (cause) {
    error.value = feedback(cause);
  } finally {
    qrBusy.value = false;
  }
}
async function consume() {
  if (!qr.value || qrBusy.value) return;
  qrBusy.value = true;
  try {
    await api.request(`/api/v1/auth/qr-requests/${qr.value.id}/consume`, {
      decode: wechatLoginDtoSchema.parse,
      method: 'POST',
    });
    await account.refresh(true);
    account.announce();
    await useWorkspace().switchMode('account');
    await router.push(
      account.current.value?.status === 'pending_deletion' ||
        route.query.returnTo === '/account-deletion'
        ? '/account-deletion'
        : '/day',
    );
  } catch (cause) {
    error.value =
      feedback(cause) + ' 请先到当前账号页检查登录结果；未登录时重新扫码。';
  } finally {
    qrBusy.value = false;
  }
}
async function cancelSafely() {
  try {
    await cancelQr();
  } catch (cause) {
    error.value = feedback(cause);
  }
}
onBeforeUnmount(() => {
  disposed = true;
  stopRetry();
  unsubscribeRetry();
  stopPolling();
  resetToken = null;
  password.value = '';
  currentPassword.value = '';
});
</script>

<template>
  <section class="card" :aria-busy="busy">
    <p class="eyebrow">DAYLINE · 账号</p>
    <h1>{{ titles[mode] ?? '账号' }}</h1>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <p v-if="errorTip" role="alert" class="error">{{ errorTip }}</p>
    <p v-if="retrySeconds > 0" class="muted">
      请等待倒计时结束后手动重试，系统不会自动重复提交。
    </p>
    <form v-if="mode !== 'verified'" @submit.prevent="submit">
      <label v-if="mode === 'register'"
        >显示名<input
          v-model="name"
          name="name"
          autocomplete="nickname"
          maxlength="80"
          required
      /></label>
      <label v-if="isEmail"
        >邮箱<input
          v-model="email"
          name="email"
          type="email"
          autocomplete="email"
          required
      /></label>
      <label v-if="mode === 'change-password'"
        >当前密码<input
          v-model="currentPassword"
          type="password"
          autocomplete="current-password"
          required
      /></label>
      <label v-if="isPassword"
        >{{ mode === 'login' ? '密码' : '新密码（8–128 字符）'
        }}<input
          v-model="password"
          name="password"
          type="password"
          :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
          minlength="8"
          maxlength="128"
          required
      /></label>
      <label
        v-if="['register', 'reset-password', 'change-password'].includes(mode)"
        >再次输入新密码<input
          v-model="confirmPassword"
          type="password"
          autocomplete="new-password"
          minlength="8"
          maxlength="128"
          required
      /></label>
      <button type="submit" :disabled="busy || retrySeconds > 0">
        {{ submitLabel }}
      </button>
    </form>
    <div class="links">
      <RouterLink to="/login">返回登录</RouterLink
      ><RouterLink to="/verify">重发验证邮件</RouterLink
      ><RouterLink to="/forgot-password">忘记密码</RouterLink>
    </div>
    <section v-if="mode === 'login'" class="qr" aria-label="微信扫码登录">
      <h2>微信扫码登录网页</h2>
      <p>扫描后请在小程序中明确确认。已有账号将切换为扫码的微信账号。</p>
      <button
        type="button"
        class="secondary"
        :disabled="qrBusy"
        @click="createQr"
      >
        {{ qrBusy ? '处理中…' : qr ? '重新生成小程序码' : '生成小程序码' }}
      </button>
      <template v-if="qr"
        ><img
          :src="qr.miniappCode"
          alt="用于确认本次网页登录的小程序码"
          width="240"
          height="240"
        />
        <p role="status">{{ qrMessage }}</p>
        <p>有效至 {{ formatBeijingTime(qr.expiresAt) }}</p>
        <button
          v-if="qr.status === 'confirmed'"
          :disabled="qrBusy"
          @click="consume"
        >
          完成本次网页登录</button
        ><button
          v-else-if="['pending', 'scanned'].includes(qr.status)"
          class="secondary"
          @click="poll"
        >
          刷新状态</button
        ><button
          v-if="['pending', 'scanned', 'confirmed'].includes(qr.status)"
          class="secondary"
          @click="cancelSafely"
        >
          取消本次扫码
        </button></template
      >
    </section>
  </section>
</template>
