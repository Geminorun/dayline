<script setup lang="ts">
import { formatBeijingTime } from '@dayline/core';
import { qrResolvedDtoSchema, qrStatusDtoSchema } from '@dayline/contracts';
import { ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import { ClientError } from '@dayline/api-client';
import { api, wechatCode } from '../../api';
const purpose = ref('login');
const requestId = ref('');
const proof = ref('');
const busy = ref(false);
const error = ref('');
const state = ref('loading');
const expiresAt = ref('');
let disposed = false;
function message(cause: unknown) {
  return cause instanceof ClientError
    ? cause.message
    : '扫码操作未完成，请回网页重新生成小程序码。';
}
async function load(scene: string) {
  busy.value = true;
  try {
    const code = await wechatCode();
    const { data } = await api.request('/api/v1/auth/qr-requests/resolve', {
      decode: qrResolvedDtoSchema.parse,
      method: 'POST',
      body: { scene, code },
    });
    if (!disposed && data) {
      purpose.value = data.purpose;
      requestId.value = data.id;
      proof.value = data.scannerProof;
      expiresAt.value = data.expiresAt;
      state.value = 'scanned';
    }
  } catch (cause) {
    if (!disposed) {
      error.value = message(cause);
      state.value = 'failed';
    }
  } finally {
    busy.value = false;
  }
}
async function confirm() {
  if (busy.value || !proof.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.request(`/api/v1/auth/qr-requests/${requestId.value}/confirm`, {
      decode: qrStatusDtoSchema.parse,
      method: 'POST',
      body: { scannerProof: proof.value },
    });
    state.value = 'confirmed';
  } catch (cause) {
    error.value = message(cause);
  } finally {
    busy.value = false;
  }
}
async function cancel() {
  if (busy.value || !proof.value) return;
  busy.value = true;
  try {
    await api.request(`/api/v1/auth/qr-requests/${requestId.value}`, {
      decode: qrStatusDtoSchema.parse,
      method: 'DELETE',
      headers: { 'X-Dayline-Scanner-Proof': proof.value },
    });
    state.value = 'cancelled';
    proof.value = '';
  } catch (cause) {
    if (
      cause instanceof ClientError &&
      ['QR_STATE_CONFLICT', 'QR_NOT_FOUND'].includes(cause.code)
    ) {
      state.value = 'ended';
      proof.value = '';
      error.value =
        '请求已被网页领取或已经结束，无法再取消。请在电脑检查当前账号。';
    } else error.value = message(cause);
  } finally {
    busy.value = false;
  }
}
onLoad((options) => {
  let scene = '';
  try {
    scene = decodeURIComponent(
      typeof options?.scene === 'string' ? options.scene : '',
    );
  } catch {
    /* Invalid scene is reported below. */
  }
  if (!/^[A-Za-z0-9_-]{32}$/.test(scene)) {
    state.value = 'failed';
    error.value = '扫码参数无效，请从网页重新扫码。';
    return;
  }
  void load(scene);
});
onUnload(() => {
  disposed = true;
  proof.value = '';
});
</script>
<template>
  <view class="page"
    ><view class="card"
      ><text class="subtitle">DAYLINE · 网页登录</text
      ><text class="title">{{
        purpose === 'login'
          ? '确认登录网页'
          : purpose === 'reauth'
            ? '确认当前身份重新验证'
            : '确认绑定微信'
      }}</text
      ><text class="text"
        >{{
          purpose === 'login'
            ? '本次操作将让发起扫码的网页进入此微信对应的账号。'
            : purpose === 'reauth'
              ? '本次仅为网页当前账号的指定操作重新验证，不会切换账号。'
              : '将此微信添加到网页当前账号；已有独立账号时仅允许受验证预览合并，双方数据保留。'
        }}请确认是你本人发起。</text
      ><text v-if="state === 'loading'" class="text muted"
        >正在验证本次扫码…</text
      ><text v-if="error" class="text error" role="alert">{{ error }}</text
      ><template v-if="state === 'scanned'"
        ><text class="text muted"
          >扫描尚未授权。请明确选择确认或取消。有效至
          {{ formatBeijingTime(expiresAt) }}。</text
        ><button :disabled="busy" @click="confirm">
          {{
            purpose === 'login'
              ? '确认登录网页'
              : purpose === 'reauth'
                ? '确认本次重新验证'
                : '确认本次微信绑定'
          }}</button
        ><button class="secondary" :disabled="busy" @click="cancel">
          取消本次操作
        </button></template
      ><template v-if="state === 'confirmed'"
        ><text class="text notice"
          >已确认。请回到原网页领取本次操作结果；领取前仍可取消。</text
        ><button class="secondary" :disabled="busy" @click="cancel">
          取消已确认的登录
        </button></template
      ><text v-if="state === 'cancelled'" class="text notice"
        >本次操作已取消。</text
      ></view
    ></view
  >
</template>
