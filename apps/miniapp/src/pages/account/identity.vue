<script setup lang="ts">
import {
  identityStatusLabel,
  formatBeijingTime,
  tr,
  messageRef,
  renderMessage,
} from '../../i18n/index';

import { msg } from '@dayline/locales';

import { computed, ref, watch } from 'vue';
import { onShow, onUnload } from '@dcloudio/uni-app';
import { createIdentityClient } from '@dayline/api-client';
import {
  reviewSelectionKey,
  mergeReviewInput,
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
  error = messageRef(),
  notice = messageRef(),
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
    notice.value = msg('identity.theCurrentIdentityHasBeenReVerified2');
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
    await refresh();
    if (!current()) return;
    const response = await client.preview(data.mergeContext, operationId.value);
    if (!current()) return;
    publishPlan(response.data ?? null);
  }
  if (data?.status === 'bound') {
    if (data.reauthenticate) api.invalidate();
    notice.value = msg('identity.bindingCompletedPleaseLogInAgainThe');
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
    notice.value = msg('identity.theEmailHasBeenAppliedForOpen');
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
      title: tr('common.confirmBindingToCurrentWechat'),
      content: tr('identity.associateTheCurrentAccountWhenItIs'),
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
  notice.value = msg('identity.pleaseReVerifyBothPartiesTheSame2');
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
      title: tr('common.mergeAndRetainBothParties'),
      content: tr('identity.allEntriesAndTrashOfBothParties'),
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
      notice.value = msg('identity.theMergerHasBeenCompletedPleaseUse');
    }
  });
}
async function cancel() {
  await run(async (current) => {
    if (plan.value) await client.cancel(plan.value.id);
    if (id.value) await client.cancelEmail(id.value);
    if (!current()) return;
    if (!(await begin(mode.value))) return;
    notice.value = msg('identity.thisOperationHasBeenCancelledAndThe2');
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
    ><text class="title">{{ tr('common.loginMethodsAndMerging') }}</text
    ><text v-if="error" class="text error">{{ error }}</text
    ><text v-if="notice" class="text notice">{{ notice }}</text
    ><button v-if="!w.current.value" @click="w.login">
      {{ tr('common.logInAgainWithWechat') }}</button
    ><button
      v-if="!ready && w.current.value"
      class="secondary"
      :disabled="busy"
      @click="initialize"
    >
      {{ tr('identity.confirmCurrentSpaceAndResumeTask') }}</button
    ><template v-if="ready && w.current.value && w.mode.value === 'account'"
      ><text class="text">{{
        tr('identity.unifiedTargetTheFirstVersionHasOne', {
          value0: w.current.value.displayName,
        })
      }}</text
      ><button
        :disabled="busy || !!w.current.value.email"
        @click="begin('bind_email')"
      >
        {{ tr('common.addEmail') }}</button
      ><button :disabled="busy" @click="begin('bind_wechat')">
        {{ tr('common.bindWechat') }}</button
      ><view v-if="!plan" class="card"
        ><input
          v-if="mode === 'bind_email'"
          v-model="email"
          :maxlength="254"
          :placeholder="tr('common.emailToBeBound')"
          :aria-label="tr('common.emailToBeBound')"
          @input="proof = ''"
        /><text class="heading">{{
          tr('reauthForm.reAuthenticateForThisOperation')
        }}</text
        ><button
          v-if="w.current.value.wechatBound"
          :disabled="busy"
          @click="verify('wechat')"
        >
          {{ tr('identity.obtainNewWechatCredentialsToReVerify') }}</button
        ><template v-if="w.current.value.passwordEnabled"
          ><input
            v-model="currentPassword"
            password
            :placeholder="tr('common.currentAccountPassword')"
          /><button :disabled="busy" @click="verify('password')">
            {{ tr('common.verifyCurrentPassword') }}
          </button></template
        ><template v-if="proof"
          ><template v-if="mode === 'bind_email'"
            ><button :disabled="busy" @click="send">
              {{ tr('identity.sendOrResendBindingEmail') }}</button
            ><template v-if="id"
              ><text class="text">{{
                tr('identity.returnToThisPageAfterOpeningEmail')
              }}</text
              ><input
                v-model="password"
                password
                :placeholder="tr('common.setPasswordForNewEmailAddress')"
              /><input
                v-model="otherPassword"
                password
                :placeholder="tr('identity.alreadyHaveAnEmailAccountWithA')"
              /><button :disabled="busy" @click="complete">
                {{ tr('common.continueAfterEmailVerification') }}
              </button></template
            ></template
          ><button v-else :disabled="busy" @click="bind">
            {{ tr('common.confirmBindingToCurrentWechat') }}
          </button></template
        ></view
      ><button class="secondary" :disabled="busy" @click="cancel">
        {{ tr('identity.notBindingCancelYet') }}</button
      ><view class="card"
        ><text class="heading">{{
          tr('identity.restoreOriginalOperationQueryUnknownResults')
        }}</text
        ><button :disabled="busy" @click="run(refresh)">
          {{ tr('common.queryOriginalTask') }}</button
        ><button
          v-for="j in emails"
          :key="j.id"
          class="secondary"
          @click="restore(j)"
        >
          {{
            tr('identity.continueAdding2', {
              value0: j.email,
              value1: identityStatusLabel(j.status),
            })
          }}</button
        ><button
          v-for="j in jobs"
          :key="j.id"
          class="secondary"
          @click="query(j.id)"
        >
          {{
            tr('identity.queryMerge', {
              value0: formatBeijingTime(j.completedAt ?? j.createdAt),
              value1: identityStatusLabel(j.status),
            })
          }}
        </button></view
      ></template
    ><view
      v-if="plan && w.current.value && w.mode.value === 'account'"
      class="card"
      ><text class="heading">{{
        plan.status === 'committed'
          ? tr('common.mergeCompleted2')
          : tr('identity.mergeAndKeepBothPartiesCheck')
      }}</text
      ><text class="text">{{
        tr('identity.targetActivityTrashCategoryFocusStatus', {
          value0: plan.targetSummary.displayName,
          value1: plan.targetSummary.entries,
          value2: plan.targetSummary.trash,
          value3: plan.targetSummary.categories,
          value4: plan.targetSummary.focusDays,
        })
      }}</text
      ><text class="text">{{
        tr('identity.sourceActivityTrashCategoryFocusStatus', {
          value0: plan.sourceSummary.displayName,
          value1: plan.sourceSummary.entries,
          value2: plan.sourceSummary.trash,
          value3: plan.sourceSummary.categories,
          value4: plan.sourceSummary.focusDays,
        })
      }}</text
      ><text class="text">{{
        tr('identity.thereAreTwoEntriesWithTheSame')
      }}</text
      ><template v-if="plan.status === 'preview'"
        ><button :disabled="busy" @click="renew">
          {{ tr('identity.reVerifyBothPartiesAndRestoreOriginal') }}</button
        ><text v-for="c in plan.conflicts" :key="c" class="text error">{{
          renderMessage(c)
        }}</text
        ><view v-for="(c, index) in plan.categoryMappings" :key="c.sourceId"
          ><text class="text">{{ c.sourceName }} / {{ c.sourceColor }} →</text
          ><picker
            :disabled="busy"
            :range="[
              tr('common.createACategory'),
              ...plan.targetCategories.map((t) => t.name + ' / ' + t.color),
            ]"
            @change="map(index, $event)"
            ><view class="text">{{
              tr('identity.clickToSelect', {
                value0: c.targetId
                  ? tr('common.mappedTo') + c.name
                  : tr('common.newCategory') + c.name,
              })
            }}</view></picker
          ><input
            v-model="c.name"
            :maxlength="24"
            :disabled="busy || !!c.targetId"
            :placeholder="
              tr('identity.newCategoryNameUpTo12Characters')
            " /><input
            v-model="c.color"
            :disabled="busy || !!c.targetId"
            placeholder="#RRGGBB" /></view
        ><picker
          :disabled="busy"
          :range="[
            tr('common.useTargetDisplayName'),
            tr('common.useSourceDisplayName'),
          ]"
          @change="
            plan.displayNameFrom =
              Number($event.detail.value) === 0 ? 'target' : 'source'
          "
          ><view class="text">{{
            tr('identity.displayNameClickToSelect', {
              value0:
                plan.displayNameFrom === 'target'
                  ? plan.targetSummary.displayName
                  : plan.sourceSummary.displayName,
            })
          }}</view></picker
        ><button :disabled="busy" @click="review">
          {{ tr('identity.saveCheckAndUpdatePreview') }}
        </button></template
      ><text v-if="selectionNeedsReview" class="text notice">{{
        tr('identity.theCategoryOrDisplayNameSelectionHas')
      }}</text
      ><text class="heading">{{ tr('identity.sourceEntryReserveAll') }}</text
      ><view
        v-for="e in plan.entries.slice(page * 50, page * 50 + 50)"
        :key="e.id"
        ><text class="text"
          >{{ e.title }} · {{ e.startDate }}—{{
            e.endDate ?? tr('common.notFinished')
          }}
          ·
          {{
            e.deletedAt
              ? tr('common.trashTo') + formatBeijingTime(e.purgeAfter)
              : tr('common.activity')
          }}</text
        ><button class="secondary" @click="openFocus(e.id)">
          {{
            tr('identity.checkKeyStatus', {
              value0: groupedFocus.get(e.id)?.length ?? 0,
            })
          }}
        </button></view
      ><button :disabled="page === 0" @click="page--">
        {{ tr('common.previousPage') }}</button
      ><button
        :disabled="(page + 1) * 50 >= plan.entries.length"
        @click="page++"
      >
        {{ tr('common.nextPage') }}</button
      ><text class="heading">{{ tr('identity.targetEntryAllReserved') }}</text
      ><view
        v-for="e in plan.targetEntries.slice(
          targetPageIndex * 50,
          targetPageIndex * 50 + 50,
        )"
        :key="e.id"
        ><text class="text"
          >{{ e.title }} · {{ e.startDate }}—{{
            e.endDate ?? tr('common.notFinished')
          }}
          ·
          {{
            e.deletedAt
              ? tr('common.trashTo') + formatBeijingTime(e.purgeAfter)
              : tr('common.activity')
          }}</text
        ><button class="secondary" @click="openFocus(e.id)">
          {{
            tr('identity.checkKeyStatus', {
              value0: groupedFocus.get(e.id)?.length ?? 0,
            })
          }}
        </button></view
      ><button :disabled="targetPageIndex === 0" @click="targetPageIndex--">
        {{ tr('common.previousPageTarget') }}</button
      ><button
        :disabled="(targetPageIndex + 1) * 50 >= plan.targetEntries.length"
        @click="targetPageIndex++"
      >
        {{ tr('common.nextPageTarget') }}</button
      ><view v-if="focusEntry"
        ><text class="heading">{{ tr('common.focusDateVerification') }}</text
        ><text
          v-for="f in focusDetail.slice(focusPage * 50, focusPage * 50 + 50)"
          :key="f.date"
          class="text"
          >{{
            tr('identity.leaveOriginalState', {
              value0: f.date,
              value1: f.focused ? tr('common.focus') : tr('common.canceled'),
            })
          }}</text
        ><button :disabled="focusPage === 0" @click="focusPage--">
          {{ tr('common.previousPageDate') }}</button
        ><button
          :disabled="(focusPage + 1) * 50 >= focusDetail.length"
          @click="focusPage++"
        >
          {{ tr('common.nextPageDate') }}
        </button></view
      ><button
        v-if="plan.status === 'preview'"
        :disabled="busy || !plan.canCommit || selectionNeedsReview"
        @click="commit"
      >
        {{
          busy
            ? tr('identity.processingAsAWholeTheResultsCan')
            : tr('identity.mergerConfirmedAndPartiesRetained')
        }}
      </button></view
    ></view
  >
</template>
