<script setup lang="ts">
import { formatBeijingTime } from '@dayline/core';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  reviewSelectionKey,
  mergeReviewInput,
  identityStatusLabel,
  emailBindingListSchema,
  qrCreatedDtoSchema,
  qrStatusDtoSchema,
  bindingResultSchema,
  successDtoSchema,
} from '@dayline/contracts';
import type {
  EmailBindingItem,
  BindingResult,
  MergePlan,
  QrCreatedDto,
} from '@dayline/contracts';
import { ApiClient, createIdentityClient } from '@dayline/api-client';
import { takeAuthCallback } from './callback';
import ReauthForm from './ReauthForm.vue';
import { api, cookieTransport } from './api';
import { useAccount } from './account';
import { useWorkspace } from './records/workspace';
import { errorMessage } from './records/record-service';
const emailVerificationApi = new ApiClient(cookieTransport);
const client = createIdentityClient(api),
  account = useAccount(),
  workspace = useWorkspace(),
  route = useRoute();
const isEmailCallback = route.path === '/auth/email-binding';
const callbackId =
  isEmailCallback && typeof route.query.id === 'string' ? route.query.id : '';
const callbackToken = isEmailCallback
  ? takeAuthCallback(window.location, window.history).token
  : null;
const reauthForm = ref<InstanceType<typeof ReauthForm> | null>(null);
const mode = ref<'bind_email' | 'bind_wechat'>('bind_email'),
  operationId = ref<string>(crypto.randomUUID()),
  email = ref(''),
  proof = ref(''),
  requestId = ref(''),
  password = ref(''),
  otherPassword = ref(''),
  error = ref(''),
  notice = ref(''),
  busy = ref(false),
  ready = ref(false),
  qr = ref<QrCreatedDto | null>(null),
  qrStatus = ref(''),
  plan = ref<MergePlan | null>(null),
  page = ref(0),
  targetPage = ref(0),
  recoveryId = ref('');
const reviewBaseline = ref('');
const selectionNeedsReview = computed(() =>
  Boolean(
    plan.value &&
    reviewSelectionKey(mergeReviewInput(plan.value)) !== reviewBaseline.value,
  ),
);
function publishPlan(next: MergePlan | null) {
  plan.value = next;
  reviewBaseline.value = next ? reviewSelectionKey(mergeReviewInput(next)) : '';
}
const focusEntry = ref(''),
  focusPage = ref(0);
const groupedFocus = computed(() => {
  const map = new Map<string, MergePlan['focusDays']>();
  for (const f of [
    ...(plan.value?.focusDays ?? []),
    ...(plan.value?.targetFocusDays ?? []),
  ]) {
    const list = map.get(f.entryId) ?? [];
    list.push(f);
    map.set(f.entryId, list);
  }
  return map;
});
const focusDetail = computed(
  () => groupedFocus.value.get(focusEntry.value) ?? [],
);
function openFocus(id: string) {
  focusEntry.value = id;
  focusPage.value = 0;
}
const action = computed(() => ({
  purpose: mode.value,
  operationId: operationId.value,
  target:
    mode.value === 'bind_email' ? email.value.trim().toLowerCase() : 'wechat',
}));
const jobs = ref<NonNullable<Awaited<ReturnType<typeof client.list>>['data']>>(
  [],
);
const emailJobs = ref<EmailBindingItem[]>([]);
const emailJobsSchema = emailBindingListSchema;
let timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false,
  intent = 0,
  initializationSequence = 0;
const own = () =>
  account.current.value?.id === api.getAccount() &&
  workspace.mode.value === 'account';
async function run(work: (current: () => boolean) => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  const g = api.getGeneration(),
    space = workspace.generation(),
    ownIntent = intent;
  const current = () =>
    !disposed &&
    g === api.getGeneration() &&
    space === workspace.generation() &&
    ownIntent === intent;
  try {
    await work(current);
  } catch (e) {
    if (current()) error.value = errorMessage(e);
  } finally {
    if (current()) busy.value = false;
  }
}
async function refreshJobs() {
  if (!own()) return;
  const g = api.getGeneration(),
    space = workspace.generation(),
    ownIntent = intent;
  const [a, b] = await Promise.all([
    client.list(),
    api.request('/api/v1/me/email-binding-requests', {
      account: true,
      decode: emailJobsSchema.parse,
    }),
  ]);
  if (
    g !== api.getGeneration() ||
    space !== workspace.generation() ||
    ownIntent !== intent
  )
    return;
  jobs.value = a.data ?? [];
  emailJobs.value = b.data ?? [];
}
async function restoreEmail(item: EmailBindingItem) {
  const ownIntent = ++intent,
    g = api.getGeneration(),
    space = workspace.generation();
  try {
    await stopQr();
  } catch (e) {
    if (ownIntent === intent) error.value = errorMessage(e);
    return;
  }
  if (
    ownIntent !== intent ||
    g !== api.getGeneration() ||
    space !== workspace.generation()
  )
    return;
  clear();
  mode.value = 'bind_email';
  operationId.value = item.operationId;
  email.value = item.email;
  requestId.value = item.id;
  notice.value = '已恢复原绑定申请；请为此操作重新验证当前账号。';
}
function clear() {
  clearTimeout(timer);
  proof.value = '';
  password.value = '';
  otherPassword.value = '';
  requestId.value = '';
  qr.value = null;
  publishPlan(null);
  page.value = 0;
  targetPage.value = 0;
  error.value = '';
  notice.value = '';
}
function renew() {
  intent++;
  const old = plan.value;
  if (!old) return;
  const e = emailJobs.value.find((j) => j.operationId === old.operationId);
  clear();
  operationId.value = old.operationId;
  recoveryId.value = old.id;
  if (e) {
    mode.value = 'bind_email';
    email.value = e.email;
    requestId.value = e.id;
  } else mode.value = 'bind_wechat';
  notice.value =
    '请重新验证双方；同一操作、同一双方和未变化的计划将保留已保存核对。';
}
async function begin(next: 'bind_email' | 'bind_wechat') {
  const ownIntent = ++intent,
    g = api.getGeneration(),
    space = workspace.generation();
  try {
    await stopQr();
  } catch (e) {
    if (ownIntent === intent) error.value = errorMessage(e);
    return;
  }
  if (
    ownIntent !== intent ||
    g !== api.getGeneration() ||
    space !== workspace.generation()
  )
    return;
  clear();
  mode.value = next;
  operationId.value = crypto.randomUUID();
}
async function stopQr() {
  await reauthForm.value?.cancel();
  const old = qr.value;
  if (old && !['consumed', 'cancelled', 'expired'].includes(qrStatus.value))
    await api.request(`/api/v1/auth/qr-requests/${old.id}`, {
      method: 'DELETE',
      account: true,
      decode: qrStatusDtoSchema.parse,
    });
  clearTimeout(timer);
}
async function result(data: BindingResult | undefined, current: () => boolean) {
  if (!data || !current()) return;
  if (data.status === 'merge_required' && data.mergeContext) {
    await refreshJobs();
    if (!current()) return;
    const response = await client.preview(data.mergeContext, operationId.value);
    if (!current()) return;
    publishPlan(response.data ?? null);
    notice.value =
      '双方已验证。默认统一到当前账号，全部事项保留；请核对分类及资料。';
  } else if (data.status === 'bound') {
    if (data.reauthenticate) account.clear();
    else await account.refresh();
    notice.value = '绑定已完成，请重新登录统一账号。原本机草稿保留。';
  }
}
async function sendEmail() {
  await run(async (current) => {
    const r = await client.email({
      email: email.value,
      operationId: operationId.value,
      proof: proof.value,
    });
    if (!current()) return;
    requestId.value = r.data?.id ?? '';
    notice.value =
      '邮件已申请。打开验证链接后回原设备继续；一分钟后可重新发送。';
    await refreshJobs();
  });
}
async function completeEmail() {
  await run(async (current) => {
    const r = await workspace.identityWrite(() =>
      client.completeEmail(requestId.value, {
        operationId: operationId.value,
        proof: proof.value,
        ...(password.value ? { password: password.value } : {}),
        ...(otherPassword.value ? { otherPassword: otherPassword.value } : {}),
      }),
    );
    if (!current()) return;
    password.value = '';
    otherPassword.value = '';
    await result(r.data, current);
  });
}
async function poll(id: string, g: number) {
  if (disposed || g !== api.getGeneration() || qr.value?.id !== id) return;
  try {
    const r = await api.request(`/api/v1/auth/qr-requests/${id}`, {
      account: true,
      decode: qrStatusDtoSchema.parse,
    });
    if (disposed || g !== api.getGeneration() || qr.value?.id !== id) return;
    qrStatus.value = r.data?.status ?? '';
    if (['pending', 'scanned'].includes(qrStatus.value))
      timer = setTimeout(() => void poll(id, g), 2000);
  } catch (e) {
    if (!disposed && g === api.getGeneration() && qr.value?.id === id)
      error.value = errorMessage(e);
  }
}
async function bindWechat() {
  await run(async (current) => {
    const createdId = crypto.randomUUID();
    try {
      const r = await api.request('/api/v1/auth/qr-requests', {
        account: true,
        method: 'POST',
        body: {
          id: createdId,
          purpose: 'bind_wechat',
          action: { ...action.value, proof: proof.value },
        },
        decode: qrCreatedDtoSchema.parse,
      });
      if (!current()) return;
      qr.value = r.data ?? null;
      qrStatus.value = 'pending';
      if (qr.value) void poll(qr.value.id, api.getGeneration());
    } finally {
      if (!current())
        await api
          .request(`/api/v1/auth/qr-requests/${createdId}`, {
            method: 'DELETE',
            decode: qrStatusDtoSchema.parse,
          })
          .catch(() => {});
    }
  });
}
async function consume() {
  await run(async (current) => {
    if (!qr.value) return;
    const qrId = qr.value.id;
    const r = await workspace.identityWrite(() =>
      api.request(`/api/v1/auth/qr-requests/${qrId}/consume`, {
        method: 'POST',
        account: true,
        body: {},
        decode: bindingResultSchema.parse,
      }),
    );
    if (!current()) return;
    qrStatus.value = 'consumed';
    await result(r.data, current);
  });
}
async function cancel() {
  await run(async (current) => {
    if (plan.value) await client.cancel(plan.value.id);
    if (requestId.value) await client.cancelEmail(requestId.value);
    if (
      qr.value &&
      !['consumed', 'cancelled', 'expired'].includes(qrStatus.value)
    )
      await api.request(`/api/v1/auth/qr-requests/${qr.value.id}`, {
        method: 'DELETE',
        account: true,
        decode: qrStatusDtoSchema.parse,
      });
    if (!current()) return;
    clear();
    notice.value = '本次操作已取消，双方账号与数据保持原状。';
    await refreshJobs();
  });
}
async function review() {
  await run(async (current) => {
    if (!plan.value) return;
    const r = await client.review(plan.value.id, mergeReviewInput(plan.value));
    if (!current()) return;
    publishPlan(r.data ?? null);
  });
}
function selectTarget(index: number, event: Event) {
  if (busy.value) return;
  const id = (event.target as HTMLSelectElement).value,
    mapping = plan.value?.categoryMappings[index];
  if (!mapping) return;
  mapping.targetId = id || null;
  const target = plan.value?.targetCategories.find((c) => c.id === id);
  if (target) {
    mapping.name = target.name;
    mapping.color = target.color;
  }
}
async function commit() {
  await run(async (current) => {
    const p = plan.value;
    if (
      !p ||
      !p.canCommit ||
      selectionNeedsReview.value ||
      !window.confirm(
        '合并并保留双方全部记录？双方旧会话将退出，本机草稿仍保留。',
      )
    )
      return;
    recoveryId.value = p.id;
    const r = await workspace.identityWrite(() =>
      client.commit(p.id, {
        expectedPlanRevision: p.planRevision,
        planDigest: p.planDigest,
      }),
    );
    if (!current()) return;
    publishPlan(r.data ?? null);
    if (r.data?.status === 'committed') {
      notice.value =
        '合并已完成。请用原邮箱或微信重新登录统一账号，之后到草稿页核对旧草稿。';
      const completedId = r.data.id;
      account.clear();
      notice.value =
        '合并已完成。请用原邮箱或微信重新登录统一账号，之后到草稿页核对旧草稿。';
      recoveryId.value = completedId;
    }
  });
}
async function query(id = recoveryId.value) {
  await run(async (current) => {
    if (!id) return;
    const response = await client.get(id);
    if (!current()) return;
    publishPlan(response.data ?? null);
    recoveryId.value = id;
  });
}
function hidePrivate() {
  if (isEmailCallback) return;
  intent++;
  clear();
  email.value = '';
  jobs.value = [];
  emailJobs.value = [];
  recoveryId.value = '';
  busy.value = false;
  ready.value = false;
}
const unsubscribe = api.onIdentityChange(hidePrivate);
watch(
  [() => workspace.mode.value, () => account.current.value?.id],
  hidePrivate,
  {
    flush: 'sync',
  },
);
async function initialize() {
  if (busy.value) return;
  const sequence = ++initializationSequence;
  busy.value = true;
  ready.value = false;
  try {
    await workspace.ensure();
    if (disposed || sequence !== initializationSequence) return;
    const generation = api.getGeneration(),
      space = workspace.generation();
    await refreshJobs();
    if (
      !disposed &&
      generation === api.getGeneration() &&
      space === workspace.generation() &&
      own()
    )
      ready.value = true;
  } catch (e) {
    if (!disposed && sequence === initializationSequence)
      error.value = errorMessage(e);
  } finally {
    if (!disposed && sequence === initializationSequence) busy.value = false;
  }
}
onMounted(async () => {
  if (isEmailCallback) {
    if (!callbackId || !callbackToken) {
      error.value = '邮件验证参数无效。';
      return;
    }
    busy.value = true;
    try {
      await emailVerificationApi.request(
        '/api/v1/me/email-binding-requests/verify',
        {
          method: 'POST',
          body: { id: callbackId, token: callbackToken },
          decode: successDtoSchema.parse,
        },
      );
      if (!disposed)
        notice.value =
          '邮箱已验证；此页面不会登录或变更身份。请回原设备、原账号继续添加邮箱。';
    } catch (e) {
      if (!disposed) error.value = errorMessage(e);
    } finally {
      if (!disposed) busy.value = false;
    }
    return;
  }
  await initialize();
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
  unsubscribe();
});
</script>
<template>
  <section class="records-page">
    <h1>登录方式与账号合并</h1>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <RouterLink
      v-if="!isEmailCallback && !account.current.value"
      to="/auth/login"
      >重新登录统一账号</RouterLink
    >
    <p v-if="!isEmailCallback && !ready">
      正在确认当前空间或恢复身份任务；请等待就绪后操作。
    </p>
    <button
      v-if="!isEmailCallback && !ready && account.current.value"
      class="secondary"
      :disabled="busy"
      @click="initialize"
    >
      确认当前空间并恢复任务</button
    ><template
      v-if="
        !isEmailCallback &&
        ready &&
        account.current.value &&
        workspace.mode.value === 'account'
      "
      ><p>
        当前统一目标：{{ account.current.value.displayName }}（{{
          account.current.value.email ?? '微信账号'
        }}）。绑定与普通登录分别处理。
      </p>
      <button
        :disabled="busy || !!account.current.value.email"
        @click="begin('bind_email')"
      >
        添加邮箱</button
      ><button :disabled="busy" @click="begin('bind_wechat')">绑定微信</button>
      <p>
        首版支持一个邮箱与一个微信；超出组合时双方保持独立。原本机草稿不会自动提交。
      </p>
      <template v-if="!plan"
        ><label v-if="mode === 'bind_email'"
          >待绑定邮箱<input
            v-model="email"
            :disabled="busy"
            type="email"
            @input="proof = ''" /></label
        ><ReauthForm
          ref="reauthForm"
          v-if="action.target"
          :action="action"
          @verified="
            proof = $event;
            notice = '当前身份已重新验证，请继续本次绑定。';
          "
        /><template v-if="proof"
          ><template v-if="mode === 'bind_email'"
            ><button :disabled="busy" @click="sendEmail">
              发送或重发绑定邮件
            </button>
            <section v-if="requestId" class="record-panel">
              <p>
                打开邮件验证后回来继续。未知邮箱设置新密码；如邮箱已有账号，须验证该账号当前密码后才能预览合并。
              </p>
              <label
                >新邮箱设置密码<input
                  v-model="password"
                  type="password"
                  autocomplete="new-password" /></label
              ><label
                >已有邮箱账号的当前密码<input
                  v-model="otherPassword"
                  type="password"
                  autocomplete="current-password" /></label
              ><button :disabled="busy" @click="completeEmail">
                邮件验证后继续
              </button>
            </section></template
          ><template v-else
            ><button :disabled="busy" @click="bindWechat">
              生成绑定微信小程序码
            </button>
            <div v-if="qr">
              <img :src="qr.miniappCode" alt="绑定微信小程序码" width="220" />
              <p>
                状态：{{
                  identityStatusLabel(qrStatus)
                }}。扫码者明确确认后，原网页领取绑定结果。
              </p>
              <button
                v-if="qrStatus === 'confirmed'"
                :disabled="busy"
                @click="consume"
              >
                领取绑定结果
              </button>
            </div></template
          ></template
        ></template
      ><button class="secondary" :disabled="busy" @click="cancel">
        暂不绑定 / 取消
      </button>
      <section class="record-panel">
        <h2>恢复原操作</h2>
        <button class="secondary" :disabled="busy" @click="run(refreshJobs)">
          查询我的绑定与合并任务</button
        ><button
          v-for="j in emailJobs"
          :key="j.id"
          class="secondary"
          :disabled="busy"
          @click="restoreEmail(j)"
        >
          继续添加 {{ j.email }}（{{ identityStatusLabel(j.status) }}）</button
        ><button
          v-for="j in jobs"
          :key="j.id"
          class="secondary"
          :disabled="busy"
          @click="query(j.id)"
        >
          查询原合并 ·
          {{ formatBeijingTime(j.completedAt ?? j.createdAt) }} ·
          {{ identityStatusLabel(j.status) }}</button
        ><button v-if="recoveryId" :disabled="busy" @click="query()">
          查询本次提交结果
        </button>
      </section></template
    >
    <section v-if="plan && !isEmailCallback && own()" class="record-panel">
      <h2>
        {{
          plan.status === 'committed'
            ? '合并已完成'
            : '合并并保留双方 · 逐项核对'
        }}
      </h2>
      <p>
        当前目标 {{ plan.targetSummary.displayName }}：{{
          plan.targetSummary.entries
        }}
        条活动、{{ plan.targetSummary.trash }} 条回收站、{{
          plan.targetSummary.categories
        }}
        分类、{{ plan.targetSummary.focusDays }} 重点状态。
      </p>
      <p>
        来源 {{ plan.sourceSummary.displayName }}：{{
          plan.sourceSummary.entries
        }}
        条活动、{{ plan.sourceSummary.trash }} 条回收站、{{
          plan.sourceSummary.categories
        }}
        分类、{{ plan.sourceSummary.focusDays }} 重点状态。
      </p>
      <p>
        同标题事项全部保留；回收站删除期限和取消的重点也保留。计划有效至
        {{
          formatBeijingTime(plan.expiresAt)
        }}。验证到期时，点击重新验证双方，将保留已保存的核对计划。
      </p>
      <p v-for="conflict in plan.conflicts" :key="conflict" class="error">
        {{ conflict }}
      </p>
      <template v-if="plan.status === 'preview'"
        ><button class="secondary" :disabled="busy" @click="renew">
          重新验证双方并继续原计划
        </button>
        <h3>分类映射</h3>
        <div v-for="(c, index) in plan.categoryMappings" :key="c.sourceId">
          <p>来源：{{ c.sourceName }} / {{ c.sourceColor }}</p>
          <select
            :value="c.targetId ?? ''"
            :disabled="busy"
            @change="selectTarget(index, $event)"
          >
            <option value="">保留为新分类</option>
            <option
              v-for="t in plan.targetCategories"
              :key="t.id"
              :value="t.id"
            >
              {{ t.name }} / {{ t.color }}
            </option></select
          ><input
            v-model="c.name"
            :disabled="busy || !!c.targetId"
            aria-label="合并分类名称"
          /><input
            v-model="c.color"
            type="color"
            :disabled="busy || !!c.targetId"
            aria-label="合并分类颜色"
          />
        </div>
        <label
          >统一账号显示名<select
            v-model="plan.displayNameFrom"
            :disabled="busy"
          >
            <option value="target">
              当前目标：{{ plan.targetSummary.displayName }}
            </option>
            <option value="source">
              来源：{{ plan.sourceSummary.displayName }}
            </option>
          </select></label
        ><button :disabled="busy" @click="review">
          保存核对并更新预览
        </button></template
      >
      <p v-if="selectionNeedsReview" role="status" class="notice">
        分类或显示名选择尚未保存核对，请先保存核对并更新预览。
      </p>
      <h3>来源事项（全部保留）</h3>
      <article
        v-for="e in plan.entries.slice(page * 50, page * 50 + 50)"
        :key="e.id"
      >
        <p>
          {{ e.title }} · {{ e.startDate }}—{{ e.endDate ?? '未结束' }} ·
          {{
            e.deletedAt ? `回收站至 ${formatBeijingTime(e.purgeAfter)}` : '活动'
          }}
          · 分类
          {{
            plan.categoryMappings.find((c) => c.sourceId === e.categoryId)
              ?.sourceName
          }}
        </p>
        <button class="secondary" @click="openFocus(e.id)">
          核对 {{ groupedFocus.get(e.id)?.length ?? 0 }} 个重点状态
        </button>
      </article>
      <button :disabled="page === 0" @click="page--">上一页来源</button
      ><button
        :disabled="(page + 1) * 50 >= plan.entries.length"
        @click="page++"
      >
        下一页来源
      </button>
      <h3>目标事项（全部保留）</h3>
      <p
        v-for="e in plan.targetEntries.slice(
          targetPage * 50,
          targetPage * 50 + 50,
        )"
        :key="e.id"
      >
        {{ e.title }} · {{ e.startDate }}—{{ e.endDate ?? '未结束' }} ·
        {{
          e.deletedAt ? `回收站至 ${formatBeijingTime(e.purgeAfter)}` : '活动'
        }}
        <button class="secondary" @click="openFocus(e.id)">
          核对 {{ groupedFocus.get(e.id)?.length ?? 0 }} 个重点状态
        </button>
      </p>
      <button :disabled="targetPage === 0" @click="targetPage--">
        上一页目标</button
      ><button
        :disabled="(targetPage + 1) * 50 >= plan.targetEntries.length"
        @click="targetPage++"
      >
        下一页目标</button
      ><button
        v-if="plan.status === 'preview'"
        :disabled="busy || !plan.canCommit || selectionNeedsReview"
        @click="commit"
      >
        {{ busy ? '正在整体处理，结果可查询…' : '确认合并并保留双方' }}
      </button>
      <section v-if="focusEntry">
        <h3>重点日期核对</h3>
        <p
          v-for="f in focusDetail.slice(focusPage * 50, focusPage * 50 + 50)"
          :key="f.date"
        >
          {{ f.date }} · {{ f.focused ? '重点' : '已取消' }} · 保留原状态
        </p>
        <button :disabled="focusPage === 0" @click="focusPage--">
          上一页日期</button
        ><button
          :disabled="(focusPage + 1) * 50 >= focusDetail.length"
          @click="focusPage++"
        >
          下一页日期
        </button>
      </section>
      <p v-if="plan.result">
        合并完成，请重新登录并完整刷新，再手动核对本机草稿。
      </p>
    </section>
  </section>
</template>
