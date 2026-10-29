<script setup lang="ts">
import {
  identityStatusLabel,
  formatBeijingTime,
  tr,
  messageRef,
  renderMessage,
} from './i18n/index';

import { msg } from '@dayline/locales';
import ColorPicker from './components/ColorPicker.vue';
import PasswordInput from './components/PasswordInput.vue';
import PlannerIcon from './components/PlannerIcon.vue';
import IconButton from './components/IconButton.vue';

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  reviewSelectionKey,
  mergeReviewInput,
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
  error = messageRef(),
  notice = messageRef(),
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
  notice.value = msg('identity.theOriginalBindingApplicationHasBeenRestored');
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
  notice.value = msg('identity.pleaseReVerifyBothPartiesTheSame');
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
    notice.value = msg('identity.bothPartiesHaveBeenVerifiedByDefault');
  } else if (data.status === 'bound') {
    if (data.reauthenticate) account.clear();
    else await account.refresh();
    notice.value = msg('identity.bindingHasBeenCompletedPleaseLogIn');
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
    notice.value = msg('identity.emailHasBeenRequestedAfterOpeningThe');
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
    notice.value = msg('identity.thisOperationHasBeenCancelledAndThe');
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
      !window.confirm(tr('identity.mergeAndRetainAllRecordsOfBoth'))
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
      notice.value = msg('identity.mergeCompletedPleaseUseYourOriginalEmail');
      const completedId = r.data.id;
      account.clear();
      notice.value = msg('identity.mergeCompletedPleaseUseYourOriginalEmail');
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
      error.value = msg('identity.invalidEmailVerificationParameters');
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
        notice.value = msg('identity.emailHasBeenVerifiedThisPageWill');
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
  <section class="records-page settings-subpage themed-form">
    <div class="subpage-heading">
      <RouterLink
        class="icon-btn tool-button"
        to="/settings"
        :aria-label="tr('common.returnToSettings')"
        :title="tr('common.returnToSettings')"
        ><PlannerIcon name="back"
      /></RouterLink>
      <div>
        <h1>{{ tr('identity.mergeLoginMethodAndAccount') }}</h1>
        <p class="muted">
          {{ tr('identity.manageEmailWechatAndAccountMerging') }}
        </p>
      </div>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <RouterLink
      v-if="!isEmailCallback && !account.current.value"
      to="/auth/login"
      >{{ tr('common.logInToTheUnifiedAccountAgain') }}</RouterLink
    >
    <p v-if="!isEmailCallback && !ready">
      {{ tr('identity.confirmingTheCurrentSpaceOrIdentityRecovery') }}
    </p>
    <button
      v-if="!isEmailCallback && !ready && account.current.value"
      class="button subtle"
      :disabled="busy"
      @click="initialize"
    >
      {{ tr('identity.confirmCurrentSpaceAndResumeTask') }}</button
    ><template
      v-if="
        !isEmailCallback &&
        ready &&
        account.current.value &&
        workspace.mode.value === 'account'
      "
      ><p>
        {{
          tr('identity.currentUnifiedTargetBindingAndNormalLogin', {
            value0: account.current.value.displayName,
            value1: account.current.value.email ?? tr('common.wechatAccount'),
          })
        }}
      </p>
      <button
        class="button"
        :class="mode === 'bind_email' ? 'primary' : 'subtle'"
        :aria-pressed="mode === 'bind_email'"
        :disabled="busy || !!account.current.value.email"
        @click="begin('bind_email')"
      >
        {{ tr('common.addEmail') }}</button
      ><button
        class="button"
        :class="mode === 'bind_wechat' ? 'primary' : 'subtle'"
        :aria-pressed="mode === 'bind_wechat'"
        :disabled="busy"
        @click="begin('bind_wechat')"
      >
        {{ tr('common.bindWechat') }}
      </button>
      <p>{{ tr('identity.theFirstVersionSupportsOneEmailAnd') }}</p>
      <template v-if="!plan"
        ><label v-if="mode === 'bind_email'"
          >{{ tr('common.emailToBeBound')
          }}<input
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
            notice = tr('identity.theCurrentIdentityHasBeenReVerified');
          "
        /><template v-if="proof"
          ><template v-if="mode === 'bind_email'"
            ><button class="button primary" :disabled="busy" @click="sendEmail">
              {{ tr('identity.sendOrResendBindingEmail') }}
            </button>
            <section v-if="requestId" class="record-panel">
              <p>{{ tr('identity.openTheEmailVerificationAndComeBack') }}</p>
              <label
                >{{ tr('common.setPasswordForNewEmailAddress')
                }}<PasswordInput
                  v-model="password"
                  autocomplete="new-password" /></label
              ><label
                >{{ tr('identity.currentPasswordForAnExistingEmailAccount')
                }}<PasswordInput
                  v-model="otherPassword"
                  autocomplete="current-password" /></label
              ><button
                class="button primary"
                :disabled="busy"
                @click="completeEmail"
              >
                {{ tr('common.continueAfterEmailVerification') }}
              </button>
            </section></template
          ><template v-else
            ><button
              class="button primary"
              :disabled="busy"
              @click="bindWechat"
            >
              {{ tr('identity.generateBindingWechatAppletCode') }}
            </button>
            <div v-if="qr">
              <img
                :src="qr.miniappCode"
                :alt="tr('common.bindWechatAppletCode')"
                width="220"
              />
              <p>
                {{
                  tr('identity.statusAfterThePersonWhoScansThe', {
                    value0: identityStatusLabel(qrStatus),
                  })
                }}
              </p>
              <button
                class="button primary"
                v-if="qrStatus === 'confirmed'"
                :disabled="busy"
                @click="consume"
              >
                {{ tr('common.receiveBindingResults') }}
              </button>
            </div></template
          ></template
        ></template
      ><IconButton
        icon="close"
        :label="tr('identity.notBindingCancelYet')"
        :disabled="busy"
        @click="cancel"
      />
      <section class="record-panel">
        <h2>{{ tr('common.revertToOriginalOperation') }}</h2>
        <IconButton
          icon="refresh"
          :label="tr('identity.queryMyBindingAndMergingTasks')"
          :disabled="busy"
          @click="run(refreshJobs)"
        />
        <button
          v-for="j in emailJobs"
          :key="j.id"
          class="button subtle"
          :disabled="busy"
          @click="restoreEmail(j)"
        >
          {{
            tr('identity.continueAdding', {
              value0: j.email,
              value1: identityStatusLabel(j.status),
            })
          }}</button
        ><button
          v-for="j in jobs"
          :key="j.id"
          class="button subtle"
          :disabled="busy"
          @click="query(j.id)"
        >
          {{
            tr('identity.queryOriginalMerge', {
              value0: formatBeijingTime(j.completedAt ?? j.createdAt),
              value1: identityStatusLabel(j.status),
            })
          }}</button
        ><IconButton
          icon="refresh"
          :label="tr('common.queryTheResultsOfThisSubmission')"
          v-if="recoveryId"
          :disabled="busy"
          @click="query()"
        />
        <RouterLink
          v-if="jobs.some((job) => job.status === 'committed')"
          class="settings-link"
          to="/drafts"
          >{{ tr('identity.revertUncommittedChangesBeforeMerge') }}</RouterLink
        >
      </section></template
    >
    <section v-if="plan && !isEmailCallback && own()" class="record-panel">
      <h2>
        {{
          plan.status === 'committed'
            ? tr('common.mergeCompleted')
            : tr('identity.mergeAndRetainBothPartiesCheckItem')
        }}
      </h2>
      <p>
        {{
          tr('identity.currentTargetActivitiesTrashCategoriesFocusStatus', {
            value0: plan.targetSummary.displayName,
            value1: plan.targetSummary.entries,
            value2: plan.targetSummary.trash,
            value3: plan.targetSummary.categories,
            value4: plan.targetSummary.focusDays,
          })
        }}
      </p>
      <p>
        {{
          tr('identity.sourceActivitiesTrashCategoriesKeyStatus', {
            value0: plan.sourceSummary.displayName,
            value1: plan.sourceSummary.entries,
            value2: plan.sourceSummary.trash,
            value3: plan.sourceSummary.categories,
            value4: plan.sourceSummary.focusDays,
          })
        }}
      </p>
      <p>
        {{
          tr('identity.allEntriesWithTheSameTitleAre', {
            value0: formatBeijingTime(plan.expiresAt),
          })
        }}
      </p>
      <p v-for="conflict in plan.conflicts" :key="conflict" class="error">
        {{ renderMessage(conflict) }}
      </p>
      <template v-if="plan.status === 'preview'"
        ><button class="button subtle" :disabled="busy" @click="renew">
          {{ tr('identity.reVerifyBothPartiesAndContinueWith') }}
        </button>
        <h3>{{ tr('common.categoryMapping2') }}</h3>
        <div v-for="(c, index) in plan.categoryMappings" :key="c.sourceId">
          <p>
            {{
              tr('identity.source', {
                value0: c.sourceName,
                value1: c.sourceColor,
              })
            }}
          </p>
          <select
            :value="c.targetId ?? ''"
            :disabled="busy"
            @change="selectTarget(index, $event)"
          >
            <option value="">{{ tr('common.createACategory') }}</option>
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
            :aria-label="tr('common.mergeCategoryNames')"
          /><ColorPicker
            v-model="c.color"
            :disabled="busy || !!c.targetId"
            :label="tr('identity.changeCategoryColor', { value0: c.name })"
          />
        </div>
        <label
          >{{ tr('common.unifiedAccountDisplayName')
          }}<select v-model="plan.displayNameFrom" :disabled="busy">
            <option value="target">
              {{
                tr('identity.currentTarget', {
                  value0: plan.targetSummary.displayName,
                })
              }}
            </option>
            <option value="source">
              {{
                tr('identity.source2', {
                  value0: plan.sourceSummary.displayName,
                })
              }}
            </option>
          </select></label
        ><button class="button primary" :disabled="busy" @click="review">
          {{ tr('identity.saveCheckAndUpdatePreview') }}
        </button></template
      >
      <p v-if="selectionNeedsReview" role="status" class="notice">
        {{ tr('identity.theCategoryOrDisplayNameSelectionHas') }}
      </p>
      <h3>{{ tr('identity.sourceEntryReserveAll') }}</h3>
      <article
        v-for="e in plan.entries.slice(page * 50, page * 50 + 50)"
        :key="e.id"
      >
        <p>
          {{
            tr('identity.category', {
              value0: e.title,
              value1: e.startDate,
              value2: e.endDate ?? tr('common.notFinished'),
              value3: e.deletedAt
                ? tr('identity.trashTo', {
                    value0: formatBeijingTime(e.purgeAfter),
                  })
                : tr('common.activity'),
              value4: plan.categoryMappings.find(
                (c) => c.sourceId === e.categoryId,
              )?.sourceName,
            })
          }}
        </p>
        <button class="button subtle" @click="openFocus(e.id)">
          {{
            tr('identity.checkKeyStatus', {
              value0: groupedFocus.get(e.id)?.length ?? 0,
            })
          }}
        </button>
      </article>
      <IconButton
        icon="chevron"
        :label="tr('common.previousPageSource')"
        class="chevron-back"
        :disabled="page === 0"
        @click="page--"
      />
      <IconButton
        icon="chevron"
        :label="tr('common.nextPageSource')"
        :disabled="(page + 1) * 50 >= plan.entries.length"
        @click="page++"
      />
      <h3>{{ tr('identity.targetEntryAllReserved') }}</h3>
      <p
        v-for="e in plan.targetEntries.slice(
          targetPage * 50,
          targetPage * 50 + 50,
        )"
        :key="e.id"
      >
        {{ e.title }} · {{ e.startDate }}—{{
          e.endDate ?? tr('common.notFinished')
        }}
        ·
        {{
          e.deletedAt
            ? tr('identity.trashTo', {
                value0: formatBeijingTime(e.purgeAfter),
              })
            : tr('common.activity')
        }}
        <button class="button subtle" @click="openFocus(e.id)">
          {{
            tr('identity.checkKeyStatus', {
              value0: groupedFocus.get(e.id)?.length ?? 0,
            })
          }}
        </button>
      </p>
      <IconButton
        icon="chevron"
        :label="tr('common.previousPageTarget')"
        class="chevron-back"
        :disabled="targetPage === 0"
        @click="targetPage--"
      />
      <IconButton
        icon="chevron"
        :label="tr('common.nextPageTarget')"
        :disabled="(targetPage + 1) * 50 >= plan.targetEntries.length"
        @click="targetPage++"
      />
      <button
        class="button primary"
        v-if="plan.status === 'preview'"
        :disabled="busy || !plan.canCommit || selectionNeedsReview"
        @click="commit"
      >
        {{
          busy
            ? tr('identity.processingAsAWholeTheResultsCan')
            : tr('identity.mergerConfirmedAndPartiesRetained')
        }}
      </button>
      <section v-if="focusEntry">
        <h3>{{ tr('common.focusDateVerification') }}</h3>
        <p
          v-for="f in focusDetail.slice(focusPage * 50, focusPage * 50 + 50)"
          :key="f.date"
        >
          {{
            tr('identity.leaveOriginalState', {
              value0: f.date,
              value1: f.focused ? tr('common.focus') : tr('common.canceled'),
            })
          }}
        </p>
        <IconButton
          icon="chevron"
          :label="tr('common.previousPageDate')"
          class="chevron-back"
          :disabled="focusPage === 0"
          @click="focusPage--"
        />
        <IconButton
          icon="chevron"
          :label="tr('common.nextPageDate')"
          :disabled="(focusPage + 1) * 50 >= focusDetail.length"
          @click="focusPage++"
        />
      </section>
      <p v-if="plan.result">
        {{ tr('identity.theMergeIsCompletedPleaseLogIn') }}
      </p>
    </section>
  </section>
</template>
