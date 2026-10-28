<script setup lang="ts">
import PasswordInput from './components/PasswordInput.vue';
import IconButton from './components/IconButton.vue';
import { formatBeijingTime } from '@dayline/core';
import { onBeforeUnmount, ref, watch } from 'vue';
import {
  identityStatusLabel,
  actionProofDtoSchema,
  qrCreatedDtoSchema,
  qrStatusDtoSchema,
} from '@dayline/contracts';
import type { ActionRequest, QrCreatedDto } from '@dayline/contracts';
import { createIdentityClient } from '@dayline/api-client';
import { api } from './api';
import { useAccount } from './account';
import { errorMessage } from './records/record-service';
const props = defineProps<{ action: ActionRequest }>(),
  emit = defineEmits<{ verified: [proof: string] }>();
const account = useAccount(),
  client = createIdentityClient(api);
const password = ref(''),
  error = ref(''),
  busy = ref(false),
  qr = ref<QrCreatedDto | null>(null),
  status = ref('');
let timer: ReturnType<typeof setTimeout> | undefined,
  generation = 0;
async function cancel(strict = false) {
  generation++;
  busy.value = false;
  clearTimeout(timer);
  const old = qr.value;
  qr.value = null;
  if (old && !['consumed', 'cancelled', 'expired'].includes(status.value))
    await api
      .request(`/api/v1/auth/qr-requests/${old.id}`, {
        method: 'DELETE',
        account: true,
        decode: qrStatusDtoSchema.parse,
      })
      .catch((e: unknown) => {
        if (strict) throw e;
      });
}
async function poll(id: string, own: number) {
  if (own !== generation) return;
  try {
    const r = await api.request(`/api/v1/auth/qr-requests/${id}`, {
      account: true,
      decode: qrStatusDtoSchema.parse,
    });
    if (own !== generation) return;
    status.value = r.data?.status ?? '';
    if (['pending', 'scanned'].includes(status.value))
      timer = setTimeout(() => void poll(id, own), 2000);
  } catch (e) {
    if (own === generation) error.value = errorMessage(e);
  }
}
async function start() {
  await cancel();
  busy.value = true;
  error.value = '';
  const own = generation,
    createdId = crypto.randomUUID();
  try {
    const r = await api.request('/api/v1/auth/qr-requests', {
      method: 'POST',
      account: true,
      body: {
        id: createdId,
        purpose: 'reauth',
        action: props.action,
      },
      decode: qrCreatedDtoSchema.parse,
    });
    if (own !== generation) return;
    qr.value = r.data ?? null;
    status.value = 'pending';
    if (qr.value) void poll(qr.value.id, own);
  } catch (e) {
    if (own === generation) error.value = errorMessage(e);
  } finally {
    if (own !== generation)
      await api
        .request(`/api/v1/auth/qr-requests/${createdId}`, {
          method: 'DELETE',
          decode: qrStatusDtoSchema.parse,
        })
        .catch(() => {});
    if (own === generation) busy.value = false;
  }
}
async function consume() {
  const own = generation;
  if (!qr.value) return;
  busy.value = true;
  error.value = '';
  try {
    const r = await api.request(
      `/api/v1/auth/qr-requests/${qr.value.id}/consume`,
      {
        method: 'POST',
        account: true,
        body: {},
        decode: actionProofDtoSchema.parse,
      },
    );
    if (own !== generation) return;
    if (r.data) {
      status.value = 'consumed';
      emit('verified', r.data.proof);
    }
  } catch (e) {
    if (own === generation) error.value = errorMessage(e);
  } finally {
    if (own === generation) busy.value = false;
  }
}
async function verify() {
  const own = generation;
  busy.value = true;
  error.value = '';
  try {
    const r = await client.reauth({
      ...props.action,
      password: password.value,
    });
    if (own !== generation) return;
    password.value = '';
    if (r.data) emit('verified', r.data.proof);
  } catch (e) {
    if (own === generation) error.value = errorMessage(e);
  } finally {
    if (own === generation) busy.value = false;
  }
}
watch(
  () => JSON.stringify(props.action),
  () => {
    password.value = '';
    void cancel();
  },
  { flush: 'sync' },
);
defineExpose({ cancel: () => cancel(true) });
const unsubscribe = api.onIdentityChange(() => {
  password.value = '';
  void cancel();
});
onBeforeUnmount(() => {
  unsubscribe();
  void cancel();
});
</script>
<template>
  <section class="record-panel reauth-panel">
    <h2>为本次操作重新验证</h2>
    <p>验证只授权当前操作，五分钟内有效。</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <form
      v-if="account.current.value?.passwordEnabled"
      @submit.prevent="verify"
    >
      <label
        >当前账号密码<PasswordInput
          v-model="password"
          autocomplete="current-password" /></label
      ><button class="button primary" :disabled="busy">验证密码</button>
    </form>
    <template v-if="account.current.value?.wechatBound"
      ><button class="button subtle" :disabled="busy" @click="start">
        用已绑定微信扫码重新验证
      </button>
      <div v-if="qr">
        <img :src="qr.miniappCode" alt="本次身份重新验证小程序码" width="220" />
        <p>
          请使用当前账号的微信扫描并明确确认。状态：{{
            identityStatusLabel(status)
          }}，有效至
          {{ formatBeijingTime(qr.expiresAt) }}
        </p>
        <button
          class="button primary"
          v-if="status === 'confirmed'"
          :disabled="busy"
          @click="consume"
        >
          领取本次验证证明</button
        ><IconButton
          icon="close"
          label="取消重新验证"
          :disabled="busy"
          @click="cancel()"
        /></div
    ></template>
  </section>
</template>
