<script setup lang="ts">
import AccountExports from './AccountExports.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { deletionResultSchema } from '@dayline/contracts';
import { formatBeijingTime } from '@dayline/core';
import { api } from './api';
import { useAccount } from './account';
import { useWorkspace } from './records/workspace';
import { errorMessage } from './records/record-service';
import ReauthForm from './ReauthForm.vue';
const account = useAccount(),
  workspace = useWorkspace();
const busy = ref(false),
  ready = ref(false),
  confirmed = ref(false),
  proof = ref(''),
  operationId = ref(crypto.randomUUID()),
  error = ref(''),
  notice = ref('');
const pending = computed(
  () => account.current.value?.status === 'pending_deletion',
);
const action = computed(() => ({
  purpose: pending.value
    ? ('cancel_deletion' as const)
    : ('delete_account' as const),
  operationId: operationId.value,
  target: account.current.value?.id ?? '',
}));
let disposed = false,
  intent = 0,
  loadSequence = 0;
function reset() {
  intent++;
  loadSequence++;
  ready.value = false;
  busy.value = false;
  proof.value = '';
  confirmed.value = false;
  notice.value = '';
  error.value = '';
  operationId.value = crypto.randomUUID();
}
function capture() {
  const generation = api.getGeneration(),
    space = workspace.generation(),
    own = intent,
    id = account.current.value?.id;
  return () =>
    !disposed &&
    own === intent &&
    generation === api.getGeneration() &&
    space === workspace.generation() &&
    id === account.current.value?.id &&
    workspace.mode.value === 'account';
}
watch(
  () =>
    `${account.current.value?.id}:${account.current.value?.status}:${workspace.mode.value}`,
  () => {
    reset();
    if (workspace.mode.value === 'account' && account.current.value)
      void load();
  },
  { flush: 'sync' },
);
async function load() {
  if (workspace.mode.value !== 'account' || !account.current.value) return;
  const current = capture(),
    sequence = ++loadSequence;
  ready.value = false;
  error.value = '';
  try {
    await account.refresh();
    if (current() && sequence === loadSequence) ready.value = true;
  } catch (e) {
    if (current() && sequence === loadSequence) error.value = errorMessage(e);
  }
}
async function submit() {
  if (
    !confirmed.value ||
    !proof.value ||
    !account.current.value ||
    busy.value ||
    !ready.value ||
    workspace.mode.value !== 'account'
  )
    return;
  const current = capture(),
    cancel = pending.value,
    body = { operationId: operationId.value, proof: proof.value };
  busy.value = true;
  error.value = '';
  try {
    const response = await workspace.identityWrite(() => {
      if (!current()) throw new Error('账号或操作已变化，请重新确认。');
      return api.request('/api/v1/me/deletion', {
        method: cancel ? 'DELETE' : 'POST',
        account: true,
        body,
        decode: deletionResultSchema.parse,
      });
    });
    if (!current() || !response.data) return;
    const result = response.data;
    const completion =
      result.status === 'pending_deletion'
        ? `注销已申请，到期 ${formatBeijingTime(result.dueAt)}。普通登录不会撤销；请重新登录查看状态或撤销。`
        : '注销已明确撤销。请重新登录并完整读取后继续，原账号草稿保留。';
    if (result.reauthenticate) {
      account.clear();
      notice.value = completion;
    } else {
      reset();
      await load();
      notice.value = completion;
    }
  } catch (e) {
    if (current())
      error.value = `${errorMessage(e)} 如网络中断或结果不明，请重新登录原身份并读取注销状态。`;
  } finally {
    if (current()) busy.value = false;
  }
}
onMounted(async () => {
  await workspace.ensure();
  if (!disposed) await load();
});
onBeforeUnmount(() => {
  disposed = true;
  reset();
});
</script>
<template>
  <section class="records-page">
    <p class="eyebrow">DAYLINE · 账号注销</p>
    <h1>{{ pending ? '注销状态与撤销' : '注销统一账号' }}</h1>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <p
      v-if="
        !ready && account.current.value && workspace.mode.value === 'account'
      "
    >
      正在确认当前账号…
    </p>
    <template
      v-if="
        account.current.value && ready && workspace.mode.value === 'account'
      "
    >
      <section class="record-panel">
        <h2>
          {{ pending ? '账号处于七天撤销窗口' : '申请前请保留需要的数据' }}
        </h2>
        <p v-if="pending">
          到期：{{
            formatBeijingTime(account.current.value.deletionDueAt)
          }}。普通登录保持注销申请；只有服务器时间严格早于到期才可明确撤销。
        </p>
        <p>
          注销作用于这个统一账号的全部事项、重点、分类、回收站和关联邮箱 /
          微信登录方式，以及已合并来源记录。申请确认后连续 7
          天内可重新验证并明确撤销；到期后清理且不能恢复旧账号。
        </p>
        <p>
          申请和撤销均会撤销全部旧会话，需重新登录。未提交草稿仍留在原账号空间，不会自动迁移到新账号；请在到期前单独复制或下载。
        </p>
        <RouterLink to="/data">先导出云端 CSV / 完整 JSON</RouterLink> ·
        <RouterLink to="/drafts">复制或下载本机草稿</RouterLink>
      </section>
      <label
        ><input v-model="confirmed" type="checkbox" :disabled="busy" />{{
          pending
            ? '我明确撤销本次注销，保留账号及已保存记录'
            : '我已了解七天窗口、清理范围及会话失效，明确申请注销'
        }}</label
      >
      <ReauthForm
        v-if="confirmed"
        :key="operationId"
        :action="action"
        @verified="proof = $event"
      />
      <button
        class="danger"
        :disabled="busy || !confirmed || !proof"
        @click="submit"
      >
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
    </template>
    <template
      v-else-if="!account.current.value || workspace.mode.value !== 'account'"
      ><p>请用原登录方式重新登录后读取注销状态。登录本身不会撤销注销。</p>
      <RouterLink to="/auth/login?returnTo=/account-deletion"
        >重新登录并查询</RouterLink
      ><button
        v-if="account.current.value"
        class="secondary"
        @click="workspace.switchMode('account')"
      >
        进入已验证账号查看注销状态
      </button></template
    >
    <AccountExports /><RouterLink to="/settings">返回设置</RouterLink>
  </section>
</template>
