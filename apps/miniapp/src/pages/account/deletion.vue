<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { onShow, onUnload } from '@dcloudio/uni-app';
import { createIdentityClient } from '@dayline/api-client';
import { deletionResultSchema } from '@dayline/contracts';
import { formatBeijingTime } from '@dayline/core';
import { api, wechatCode } from '../../api';
import { newId } from '../../adapters/uuid';
import { useWorkspace, message } from '../../workspace';
const w = useWorkspace(),
  client = createIdentityClient(api);
const confirmed = ref(false),
  operationId = ref(''),
  proof = ref(''),
  password = ref(''),
  busy = ref(false),
  ready = ref(false),
  error = ref(''),
  notice = ref('');
const pending = computed(() => w.current.value?.status === 'pending_deletion');
let disposed = false,
  intent = 0,
  loadSequence = 0;
function reset() {
  intent++;
  loadSequence++;
  ready.value = false;
  busy.value = false;
  proof.value = '';
  password.value = '';
  confirmed.value = false;
  operationId.value = '';
  error.value = '';
  notice.value = '';
}
function capture() {
  const generation = api.getGeneration(),
    own = intent,
    space = w.generation(),
    id = w.current.value?.id;
  return () =>
    !disposed &&
    own === intent &&
    generation === api.getGeneration() &&
    space === w.generation() &&
    id === w.current.value?.id &&
    w.mode.value === 'account';
}
watch(
  () => `${w.current.value?.id}:${w.current.value?.status}:${w.mode.value}`,
  () => {
    reset();
    if (w.current.value && w.mode.value === 'account') void load();
  },
  { flush: 'sync' },
);
async function load() {
  if (!w.current.value || w.mode.value !== 'account') return;
  const current = capture(),
    sequence = ++loadSequence;
  ready.value = false;
  error.value = '';
  try {
    await w.restoreSession();
    if (current() && sequence === loadSequence) ready.value = true;
  } catch (e) {
    if (current() && sequence === loadSequence) error.value = message(e);
  }
}
async function verify(wechat: boolean) {
  if (
    busy.value ||
    !confirmed.value ||
    !w.current.value ||
    !ready.value ||
    w.mode.value !== 'account'
  )
    return;
  const current = capture(),
    purpose = pending.value
      ? ('cancel_deletion' as const)
      : ('delete_account' as const),
    target = w.current.value.id;
  busy.value = true;
  error.value = '';
  try {
    const id = operationId.value || (await newId());
    if (!current()) return;
    operationId.value = id;
    const credential = wechat
      ? { code: await wechatCode() }
      : { password: password.value };
    if (!current()) return;
    const r = await client.reauth({
      purpose,
      operationId: id,
      target,
      ...credential,
    });
    if (!current()) return;
    password.value = '';
    proof.value = r.data?.proof ?? '';
    notice.value = '本次身份已验证，五分钟内明确确认。';
  } catch (e) {
    if (current()) error.value = message(e);
  } finally {
    if (current()) busy.value = false;
  }
}
async function submit() {
  if (
    !confirmed.value ||
    !proof.value ||
    busy.value ||
    !ready.value ||
    w.mode.value !== 'account'
  )
    return;
  const current = capture(),
    cancel = pending.value,
    body = { operationId: operationId.value, proof: proof.value };
  busy.value = true;
  error.value = '';
  try {
    const r = await w.identityWrite(() => {
      if (!current()) throw new Error('账号或操作已变化。');
      return api.request('/api/v1/me/deletion', {
        method: cancel ? 'DELETE' : 'POST',
        account: true,
        body,
        decode: deletionResultSchema.parse,
      });
    });
    if (!current() || !r.data) return;
    const completion =
      r.data.status === 'pending_deletion'
        ? `注销已申请，到期 ${formatBeijingTime(r.data.dueAt)}。普通登录不会撤销；请重新登录查询或撤销。`
        : '注销已明确撤销，请重新登录后继续。原游客记录保留。';
    if (r.data.reauthenticate) {
      api.invalidate();
      notice.value = completion;
    } else {
      reset();
      await load();
      notice.value = completion;
    }
  } catch (e) {
    if (current())
      error.value = `${message(e)} 结果不明时，请以原微信重新登录并读取注销状态。`;
  } finally {
    if (current()) busy.value = false;
  }
}
function back() {
  uni.switchTab({ url: '/pages/me/index' });
}
onShow(async () => {
  await w.ensure();
  if (!disposed) await load();
});
onUnload(() => {
  disposed = true;
  reset();
});
</script>
<template>
  <view class="page"
    ><text class="title">{{
      pending ? '注销状态与撤销' : '注销统一账号'
    }}</text>
    <text v-if="error" class="text error">{{ error }}</text
    ><text v-if="notice" class="text notice">{{ notice }}</text>
    <view
      v-if="ready && w.current.value && w.mode.value === 'account'"
      class="card"
    >
      <text v-if="pending" class="text"
        >到期：{{
          formatBeijingTime(w.current.value.deletionDueAt)
        }}。普通登录不会撤销申请。</text
      >
      <text class="text"
        >注销涵盖这个统一账号的全部事项、重点、分类、回收站及关联邮箱 /
        微信和合并来源。服务器确认后连续七天内可重新验证并明确撤销，到期清理不能恢复。</text
      >
      <text class="text"
        >申请和撤销均撤销全部旧会话，需重新登录。请先在网页导出记录，并复制 /
        下载原账号本机草稿；新账号不会解锁旧账号草稿。</text
      >
      <button
        class="secondary"
        :disabled="busy"
        @click="confirmed = !confirmed"
      >
        {{
          confirmed
            ? '已明确了解，点此取消确认'
            : pending
              ? '我明确撤销本次注销'
              : '我已了解，继续申请七天后注销'
        }}
      </button>
      <template v-if="confirmed"
        ><input
          v-if="w.current.value.passwordEnabled"
          v-model="password"
          password
          :maxlength="128"
          placeholder="当前账号密码"
          aria-label="当前账号密码"
        /><button
          v-if="w.current.value.passwordEnabled"
          :disabled="busy"
          @click="verify(false)"
        >
          验证当前密码</button
        ><button
          v-if="w.current.value.wechatBound"
          :disabled="busy"
          @click="verify(true)"
        >
          使用当前微信重新验证
        </button></template
      >
      <button :disabled="busy || !confirmed || !proof" @click="submit">
        {{
          busy
            ? '正在等待服务器确认…'
            : pending
              ? '明确撤销注销'
              : '确认申请七天后注销'
        }}
      </button>
      <button class="secondary" :disabled="busy" @click="load">
        读取服务器注销状态
      </button>
    </view>
    <view v-else class="card"
      ><text class="text"
        >请在“我的”用原微信重新登录，再回来查询注销状态。普通登录不会自动撤销。</text
      ><button @click="back">返回我的并重新登录</button></view
    >
  </view>
</template>
