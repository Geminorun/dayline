<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { onShow, onUnload } from '@dcloudio/uni-app';
import { createIdentityClient } from '@dayline/api-client';
import {
  reviewSelectionKey,
  mergeReviewInput,
  identityStatusLabel,
  bindingResultSchema,
  emailBindingListSchema,
} from '@dayline/contracts';
import type {
  EmailBindingItem,
  BindingResult,
  MergePlan,
} from '@dayline/contracts';
import { api, wechatCode } from '../../api';
import { useWorkspace, message } from '../../workspace';
import { newId } from '../../adapters/uuid';
const w = useWorkspace(),
  client = createIdentityClient(api);
const mode = ref<'bind_email' | 'bind_wechat'>('bind_email'),
  email = ref(''),
  operationId = ref(''),
  proof = ref(''),
  id = ref(''),
  password = ref(''),
  otherPassword = ref(''),
  currentPassword = ref(''),
  error = ref(''),
  notice = ref(''),
  busy = ref(false),
  ready = ref(false),
  plan = ref<MergePlan | null>(null),
  page = ref(0),
  jobs = ref<NonNullable<Awaited<ReturnType<typeof client.list>>['data']>>([]);
const emailJobsSchema = emailBindingListSchema,
  emails = ref<EmailBindingItem[]>([]);
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
  focusPage = ref(0),
  targetPageIndex = ref(0);
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
let intent = 0,
  disposed = false,
  initializationSequence = 0;
async function run(work: (current: () => boolean) => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  const g = api.getGeneration(),
    space = w.generation(),
    ownIntent = intent;
  const current = () =>
    !disposed &&
    g === api.getGeneration() &&
    space === w.generation() &&
    ownIntent === intent;
  try {
    await work(current);
  } catch (e) {
    if (current()) error.value = message(e);
  } finally {
    if (current()) busy.value = false;
  }
}
async function begin(next: 'bind_email' | 'bind_wechat') {
  const ownIntent = ++intent,
    g = api.getGeneration(),
    space = w.generation();
  try {
    const nextId = await newId();
    if (
      ownIntent !== intent ||
      g !== api.getGeneration() ||
      space !== w.generation()
    )
      return false;
    mode.value = next;
    operationId.value = nextId;
    proof.value = '';
    id.value = '';
    publishPlan(null);
    password.value = '';
    otherPassword.value = '';
    currentPassword.value = '';
    busy.value = false;
    return true;
  } catch (e) {
    if (ownIntent === intent) {
      error.value = message(e);
      busy.value = false;
    }
  }
  return false;
}
async function verify(method: 'wechat' | 'password') {
  await run(async (current) => {
    const intended = { ...action.value },
      entered = currentPassword.value;
    const credential =
      method === 'wechat'
        ? { code: await wechatCode() }
        : { password: entered };
    if (!current()) return;
    const r = await client.reauth({ ...intended, ...credential });
    if (!current()) return;
    currentPassword.value = '';
    proof.value = r.data?.proof ?? '';
    notice.value = '当前身份已重新验证，五分钟内继续本次操作。';
  });
}
async function refresh() {
  if (!w.current.value) return;
  const g = api.getGeneration(),
    space = w.generation(),
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
    space !== w.generation() ||
    ownIntent !== intent
  )
    return;
  jobs.value = a.data ?? [];
  emails.value = b.data ?? [];
}
async function handle(data: BindingResult | undefined, current: () => boolean) {
  if (!current()) return;
  if (data?.status === 'merge_required' && data.mergeContext) {
    const response = await client.preview(data.mergeContext, operationId.value);
    if (!current()) return;
    publishPlan(response.data ?? null);
  }
  if (data?.status === 'bound') {
    if (data.reauthenticate) api.invalidate();
    notice.value = '绑定已完成，请重新登录。原游客记录仍保留。';
  }
}
async function send() {
  await run(async (current) => {
    const r = await client.email({
      email: email.value,
      operationId: operationId.value,
      proof: proof.value,
    });
    if (!current()) return;
    id.value = r.data?.id ?? '';
    notice.value = '邮件已申请；打开邮件验证后回到原账号继续。';
    await refresh();
  });
}
async function complete() {
  await run(async (current) => {
    const r = await w.identityWrite(() =>
      client.completeEmail(id.value, {
        operationId: operationId.value,
        proof: proof.value,
        ...(password.value ? { password: password.value } : {}),
        ...(otherPassword.value ? { otherPassword: otherPassword.value } : {}),
      }),
    );
    if (!current()) return;
    password.value = '';
    otherPassword.value = '';
    await handle(r.data, current);
  });
}
async function bind() {
  const g = api.getGeneration(),
    space = w.generation(),
    ownIntent = intent;
  const confirmed = await new Promise<boolean>((resolve) =>
    uni.showModal({
      title: '确认绑定当前微信',
      content:
        '未占用时关联当前账号；已有账号时只建立双方受验证预览，不切换登录。',
      success: (r) => resolve(r.confirm),
    }),
  );
  if (
    !confirmed ||
    g !== api.getGeneration() ||
    space !== w.generation() ||
    ownIntent !== intent
  )
    return;
  await run(async (current) => {
    const intended = { operationId: operationId.value, proof: proof.value },
      code = await wechatCode();
    if (!current()) return;
    const r = await w.identityWrite(() =>
      api.request('/api/v1/me/wechat-binding', {
        account: true,
        method: 'POST',
        body: {
          code,
          ...intended,
        },
        decode: bindingResultSchema.parse,
      }),
    );
    await handle(r.data, current);
  });
}
async function query(jobId: string) {
  await run(async (current) => {
    const response = await client.get(jobId);
    if (!current()) return;
    publishPlan(response.data ?? null);
  });
}
async function restore(item: EmailBindingItem) {
  if (!(await begin('bind_email'))) return;
  operationId.value = item.operationId;
  email.value = item.email;
  id.value = item.id;
}
async function renew() {
  const old = plan.value;
  if (!old) return;
  const item = emails.value.find((e) => e.operationId === old.operationId);
  if (!(await begin(item ? 'bind_email' : 'bind_wechat'))) return;
  operationId.value = old.operationId;
  if (item) {
    email.value = item.email;
    id.value = item.id;
  }
  notice.value = '请重新验证双方；同操作将恢复已保存核对。';
}
async function review() {
  await run(async (current) => {
    const p = plan.value;
    if (!p) return;
    const response =
      (await client.review(p.id, mergeReviewInput(p))).data ?? null;
    if (current()) publishPlan(response);
  });
}
function map(index: number, event: { detail: { value: string | number } }) {
  if (busy.value) return;
  const p = plan.value,
    c = p?.categoryMappings[index];
  if (!c || !p) return;
  const t = p.targetCategories[Number(event.detail.value) - 1];
  c.targetId = t?.id ?? null;
  if (t) {
    c.name = t.name;
    c.color = t.color;
  }
}
async function commit() {
  if (busy.value || selectionNeedsReview.value) return;
  const p = plan.value;
  if (!p || !p.canCommit) return;
  const g = api.getGeneration(),
    space = w.generation(),
    ownIntent = intent;
  const ok = await new Promise<boolean>((resolve) =>
    uni.showModal({
      title: '合并并保留双方',
      content:
        '双方全部事项及回收站保留，旧会话将退出。确认前已核对分类及显示名。',
      success: (r) => resolve(r.confirm),
    }),
  );
  if (
    !ok ||
    selectionNeedsReview.value ||
    g !== api.getGeneration() ||
    space !== w.generation() ||
    ownIntent !== intent
  )
    return;
  await run(async (current) => {
    const response = await w.identityWrite(() =>
      client.commit(p.id, {
        expectedPlanRevision: p.planRevision,
        planDigest: p.planDigest,
      }),
    );
    if (!current()) return;
    publishPlan(response.data ?? null);
    if (response.data?.status === 'committed') {
      api.invalidate();
      notice.value = '合并已完成，请用原微信重新登录统一账号。';
    }
  });
}
async function cancel() {
  await run(async (current) => {
    if (plan.value) await client.cancel(plan.value.id);
    if (id.value) await client.cancelEmail(id.value);
    if (!current()) return;
    if (!(await begin(mode.value))) return;
    notice.value = '本次操作已取消，双方账号和数据保持独立。';
    await refresh();
  });
}
function hidePrivate() {
  intent++;
  proof.value = '';
  email.value = '';
  id.value = '';
  currentPassword.value = '';
  password.value = '';
  otherPassword.value = '';
  jobs.value = [];
  emails.value = [];
  publishPlan(null);
  notice.value = '';
  error.value = '';
  busy.value = false;
  ready.value = false;
}
const unsubscribe = api.onIdentityChange(hidePrivate);
watch([() => w.mode.value, () => w.current.value?.id], hidePrivate, {
  flush: 'sync',
});
async function initialize() {
  if (busy.value) return;
  const sequence = ++initializationSequence;
  busy.value = true;
  ready.value = false;
  try {
    if (!operationId.value) operationId.value = await newId();
    await w.ensure();
    if (disposed || sequence !== initializationSequence) return;
    const g = api.getGeneration(),
      space = w.generation();
    await refresh();
    if (
      !disposed &&
      g === api.getGeneration() &&
      space === w.generation() &&
      w.mode.value === 'account' &&
      w.current.value
    )
      ready.value = true;
  } catch (e) {
    if (!disposed && sequence === initializationSequence)
      error.value = message(e);
  } finally {
    if (!disposed && sequence === initializationSequence) busy.value = false;
  }
}
onShow(initialize);
onUnload(() => {
  disposed = true;
  unsubscribe();
  hidePrivate();
});
</script>
<template>
  <view class="page"
    ><text class="title">登录方式与合并</text
    ><text v-if="error" class="text error">{{ error }}</text
    ><text v-if="notice" class="text notice">{{ notice }}</text
    ><button v-if="!w.current.value" @click="w.login">重新微信登录</button
    ><button
      v-if="!ready && w.current.value"
      class="secondary"
      :disabled="busy"
      @click="initialize"
    >
      确认当前空间并恢复任务</button
    ><template v-if="ready && w.current.value && w.mode.value === 'account'"
      ><text class="text"
        >统一目标：{{
          w.current.value.displayName
        }}。首版一个邮箱与一个微信；原游客与草稿不自动提交。</text
      ><button
        :disabled="busy || !!w.current.value.email"
        @click="begin('bind_email')"
      >
        添加邮箱</button
      ><button :disabled="busy" @click="begin('bind_wechat')">绑定微信</button
      ><view v-if="!plan" class="card"
        ><input
          v-if="mode === 'bind_email'"
          v-model="email"
          placeholder="待绑定邮箱"
          aria-label="待绑定邮箱"
          @input="proof = ''"
        /><text class="heading">为本次操作重新验证</text
        ><button
          v-if="w.current.value.wechatBound"
          :disabled="busy"
          @click="verify('wechat')"
        >
          获取新微信凭据重新验证</button
        ><template v-if="w.current.value.passwordEnabled"
          ><input
            v-model="currentPassword"
            password
            placeholder="当前账号密码"
          /><button :disabled="busy" @click="verify('password')">
            验证当前密码
          </button></template
        ><template v-if="proof"
          ><template v-if="mode === 'bind_email'"
            ><button :disabled="busy" @click="send">发送或重发绑定邮件</button
            ><template v-if="id"
              ><text class="text"
                >打开邮件验证后回本页。新邮箱设置密码；已有邮箱账号须验证该账号当前密码。</text
              ><input
                v-model="password"
                password
                placeholder="新邮箱设置密码"
              /><input
                v-model="otherPassword"
                password
                placeholder="已有邮箱账号当前密码"
              /><button :disabled="busy" @click="complete">
                邮件验证后继续
              </button></template
            ></template
          ><button v-else :disabled="busy" @click="bind">
            确认绑定当前微信
          </button></template
        ></view
      ><button class="secondary" :disabled="busy" @click="cancel">
        暂不绑定 / 取消</button
      ><view class="card"
        ><text class="heading">恢复原操作 / 查询未知结果</text
        ><button :disabled="busy" @click="run(refresh)">查询原任务</button
        ><button
          v-for="j in emails"
          :key="j.id"
          class="secondary"
          @click="restore(j)"
        >
          继续添加 {{ j.email }} · {{ identityStatusLabel(j.status) }}</button
        ><button
          v-for="j in jobs"
          :key="j.id"
          class="secondary"
          @click="query(j.id)"
        >
          查询合并
          {{ new Date(j.completedAt ?? j.createdAt).toLocaleString() }} ·
          {{ identityStatusLabel(j.status) }}
        </button></view
      ></template
    ><view
      v-if="plan && w.current.value && w.mode.value === 'account'"
      class="card"
      ><text class="heading">{{
        plan.status === 'committed' ? '合并完成' : '合并并保留双方 · 核对'
      }}</text
      ><text class="text"
        >目标 {{ plan.targetSummary.displayName }}：{{
          plan.targetSummary.entries
        }}
        活动、{{ plan.targetSummary.trash }} 回收站、{{
          plan.targetSummary.categories
        }}
        分类、{{ plan.targetSummary.focusDays }} 重点状态</text
      ><text class="text"
        >来源 {{ plan.sourceSummary.displayName }}：{{
          plan.sourceSummary.entries
        }}
        活动、{{ plan.sourceSummary.trash }} 回收站、{{
          plan.sourceSummary.categories
        }}
        分类、{{ plan.sourceSummary.focusDays }} 重点状态</text
      ><text class="text"
        >同名事项保留两条，删除期限与 false 重点状态跟随原记录。</text
      ><template v-if="plan.status === 'preview'"
        ><button :disabled="busy" @click="renew">
          重新验证双方并恢复原计划</button
        ><text v-for="c in plan.conflicts" :key="c" class="text error">{{
          c
        }}</text
        ><view v-for="(c, index) in plan.categoryMappings" :key="c.sourceId"
          ><text class="text">{{ c.sourceName }} / {{ c.sourceColor }} →</text
          ><picker
            :disabled="busy"
            :range="[
              '保留为新分类',
              ...plan.targetCategories.map((t) => t.name + ' / ' + t.color),
            ]"
            @change="map(index, $event)"
            ><view class="text"
              >{{
                c.targetId ? '映射到 ' + c.name : '新分类：' + c.name
              }}（点击选择）</view
            ></picker
          ><input
            v-model="c.name"
            :disabled="busy || !!c.targetId"
            placeholder="新分类名称（最多12字）" /><input
            v-model="c.color"
            :disabled="busy || !!c.targetId"
            placeholder="#RRGGBB" /></view
        ><picker
          :disabled="busy"
          :range="['使用目标显示名', '使用来源显示名']"
          @change="
            plan.displayNameFrom =
              Number($event.detail.value) === 0 ? 'target' : 'source'
          "
          ><view class="text"
            >显示名：{{
              plan.displayNameFrom === 'target'
                ? plan.targetSummary.displayName
                : plan.sourceSummary.displayName
            }}（点击选择）</view
          ></picker
        ><button :disabled="busy" @click="review">
          保存核对并更新预览
        </button></template
      ><text v-if="selectionNeedsReview" class="text notice"
        >分类或显示名选择尚未保存核对，请先保存核对并更新预览。</text
      ><text class="heading">来源事项（全部保留）</text
      ><view
        v-for="e in plan.entries.slice(page * 50, page * 50 + 50)"
        :key="e.id"
        ><text class="text"
          >{{ e.title }} · {{ e.startDate }}—{{ e.endDate ?? '未结束' }} ·
          {{ e.deletedAt ? '回收站至 ' + e.purgeAfter : '活动' }}</text
        ><button class="secondary" @click="openFocus(e.id)">
          核对 {{ groupedFocus.get(e.id)?.length ?? 0 }} 个重点状态
        </button></view
      ><button :disabled="page === 0" @click="page--">上一页</button
      ><button
        :disabled="(page + 1) * 50 >= plan.entries.length"
        @click="page++"
      >
        下一页</button
      ><text class="heading">目标事项（全部保留）</text
      ><view
        v-for="e in plan.targetEntries.slice(
          targetPageIndex * 50,
          targetPageIndex * 50 + 50,
        )"
        :key="e.id"
        ><text class="text"
          >{{ e.title }} · {{ e.startDate }}—{{ e.endDate ?? '未结束' }} ·
          {{ e.deletedAt ? '回收站至 ' + e.purgeAfter : '活动' }}</text
        ><button class="secondary" @click="openFocus(e.id)">
          核对 {{ groupedFocus.get(e.id)?.length ?? 0 }} 个重点状态
        </button></view
      ><button :disabled="targetPageIndex === 0" @click="targetPageIndex--">
        上一页目标</button
      ><button
        :disabled="(targetPageIndex + 1) * 50 >= plan.targetEntries.length"
        @click="targetPageIndex++"
      >
        下一页目标</button
      ><view v-if="focusEntry"
        ><text class="heading">重点日期核对</text
        ><text
          v-for="f in focusDetail.slice(focusPage * 50, focusPage * 50 + 50)"
          :key="f.date"
          class="text"
          >{{ f.date }} · {{ f.focused ? '重点' : '已取消' }} · 保留原状态</text
        ><button :disabled="focusPage === 0" @click="focusPage--">
          上一页日期</button
        ><button
          :disabled="(focusPage + 1) * 50 >= focusDetail.length"
          @click="focusPage++"
        >
          下一页日期
        </button></view
      ><button
        v-if="plan.status === 'preview'"
        :disabled="busy || !plan.canCommit || selectionNeedsReview"
        @click="commit"
      >
        {{ busy ? '正在整体处理，结果可查询…' : '确认合并并保留双方' }}
      </button></view
    ></view
  >
</template>
