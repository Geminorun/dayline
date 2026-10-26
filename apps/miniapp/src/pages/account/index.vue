<script setup lang="ts">
import { successDtoSchema } from '@dayline/contracts';
import { userDtoSchema, wechatLoginDtoSchema } from '@dayline/contracts';
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { ClientError } from '@dayline/api-client';
import type { UserDto } from '@dayline/contracts';
import { api, clearCredential, wechatCode } from '../../api';
const current = ref<UserDto | null>(null);
const busy = ref(false);
const checked = ref(false);
const error = ref('');
function message(cause: unknown) {
  return cause instanceof ClientError
    ? cause.message
    : '操作未完成，请稍后重试。';
}
async function refresh() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const { data } = await api.request('/api/v1/me', {
      decode: userDtoSchema.parse,
    });
    if (data) {
      current.value = data;
      api.setAccount(data.id);
    }
  } catch (cause) {
    if (cause instanceof ClientError && cause.status === 401) {
      current.value = null;
      api.invalidate();
      clearCredential();
    } else error.value = message(cause);
  } finally {
    busy.value = false;
    checked.value = true;
  }
}
async function login() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const code = await wechatCode();
    const { data } = await api.request('/api/v1/auth/wechat/login', {
      decode: wechatLoginDtoSchema.parse,
      method: 'POST',
      body: { code },
    });
    if (!data) throw new Error('Empty response');
    current.value = data.user;
    api.setAccount(data.user.id);
  } catch (cause) {
    error.value = message(cause);
  } finally {
    busy.value = false;
  }
}
async function logout() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.request('/api/v1/auth/logout', {
      decode: successDtoSchema.parse,
      method: 'POST',
      account: true,
      body: {},
    });
    clearCredential();
    api.invalidate();
    current.value = null;
  } catch (cause) {
    error.value = message(cause);
    if (!api.getAccount()) {
      current.value = null;
      clearCredential();
    }
  } finally {
    busy.value = false;
  }
}
onShow(refresh);
</script>
<template>
  <view class="page"
    ><view class="card"
      ><text class="subtitle">DAYLINE</text
      ><text class="title">{{ current ? '当前账号' : '日序 · 账号' }}</text
      ><text v-if="busy || !checked" class="text muted">正在确认登录状态…</text
      ><text v-if="error" class="text error" role="alert">{{ error }}</text>
      <template v-if="current"
        ><text class="text">{{ current.displayName }}</text
        ><text class="text"
          >邮箱：{{ current.email ?? '尚未绑定真实邮箱' }}</text
        ><text class="text"
          >微信：{{ current.wechatBound ? '已关联' : '尚未关联' }}</text
        ><text v-if="current.status !== 'active'" class="text notice"
          >账号当前受限</text
        ><button :disabled="busy" @click="logout">
          退出当前账号
        </button></template
      >
      <template v-else-if="checked"
        ><text class="text muted"
          >微信登录可在不同设备取回同一账号。进入页面不会创建云端账号。</text
        ><button :disabled="busy" @click="login">微信登录</button></template
      ><button class="secondary" :disabled="busy" @click="refresh">
        重新读取账号
      </button>
    </view></view
  >
</template>
