<script setup lang="ts">
import { formatBeijingTime, tr, messageRef } from './i18n/index';

import { msg } from '@dayline/locales';
import PlannerIcon from './components/PlannerIcon.vue';
import IconButton from './components/IconButton.vue';
import AccountExports from './AccountExports.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { deletionResultSchema } from '@dayline/contracts';

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
  error = messageRef(),
  notice = messageRef();
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
      if (!current())
        throw new Error(tr('deletion.theAccountOrOperationHasChangedPlease'));
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
        ? tr('deletion.cancellationRequestedExpiredOrdinaryLoginWillNot', {
            value0: formatBeijingTime(result.dueAt),
          })
        : tr('deletion.accountDeletionHasBeenExplicitlyRevokedPlease');
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
      error.value = msg('deletion.ifTheNetworkIsInterruptedOrThe', {
        value0: errorMessage(e),
      });
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
  <section class="records-page settings-subpage themed-form">
    <div class="subpage-heading">
      <RouterLink
        class="icon-btn tool-button"
        to="/settings"
        :aria-label="tr('common.returnToSettings')"
        :title="tr('common.returnToSettings')"
        ><PlannerIcon name="back"
      /></RouterLink>
      <h1>
        {{
          pending
            ? tr('common.accountDeletionStatusAndRevocation')
            : tr('common.cancelUnifiedAccount')
        }}
      </h1>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <p
      v-if="
        !ready && account.current.value && workspace.mode.value === 'account'
      "
    >
      {{ tr('deletion.confirmingCurrentAccount') }}
    </p>
    <template
      v-if="
        account.current.value && ready && workspace.mode.value === 'account'
      "
    >
      <section class="record-panel">
        <h2>
          {{
            pending
              ? tr('deletion.accountIsInSevenDayCancellationWindow')
              : tr('deletion.pleaseKeepTheRequiredDataBeforeApplying')
          }}
        </h2>
        <p v-if="pending">
          {{
            tr(
              'deletion.expiredOrdinaryLoginsMaintainAccountDeletionRequests',
              {
                value0: formatBeijingTime(account.current.value.deletionDueAt),
              },
            )
          }}
        </p>
        <p>{{ tr('deletion.accountDeletionAllEntriesKeyPointsCategories') }}</p>
        <p>{{ tr('deletion.bothApplicationAndCancellationWillCancelAll') }}</p>
        <RouterLink to="/data">{{
          tr('deletion.exportCloudCsvCompleteJsonFirst')
        }}</RouterLink>
        ·
        <RouterLink to="/drafts">{{
          tr('deletion.copyOrDownloadLocalDraft')
        }}</RouterLink>
      </section>
      <label
        ><input v-model="confirmed" type="checkbox" :disabled="busy" />{{
          pending
            ? tr('deletion.iClearlyCancelThisCancellationAndRetain')
            : tr('deletion.iUnderstandTheSevenDayWindowCleanup')
        }}</label
      >
      <ReauthForm
        v-if="confirmed"
        :key="operationId"
        :action="action"
        @verified="proof = $event"
      />
      <button
        class="button danger"
        :disabled="busy || !confirmed || !proof"
        @click="submit"
      >
        {{
          busy
            ? tr('deletion.waitingForServerConfirmation')
            : pending
              ? tr('common.explicitCancellationOfCancellation')
              : tr('deletion.cancellationAfterSevenDaysAfterConfirmationOf')
        }}
      </button>
      <IconButton
        icon="refresh"
        :label="tr('deletion.checkAccountDeletionStatus')"
        :disabled="busy"
        @click="load"
      />
    </template>
    <template
      v-else-if="!account.current.value || workspace.mode.value !== 'account'"
      ><p>{{ tr('deletion.pleaseLogInAgainUsingTheOriginal') }}</p>
      <RouterLink to="/auth/login?returnTo=/account-deletion">{{
        tr('common.logInAgainAndQuery')
      }}</RouterLink
      ><button
        v-if="account.current.value"
        class="button subtle"
        @click="workspace.switchMode('account')"
      >
        {{ tr('deletion.enterTheVerifiedAccountToCheckThe') }}
      </button></template
    >
    <AccountExports /><RouterLink to="/settings">{{
      tr('common.returnToSettings')
    }}</RouterLink>
  </section>
</template>
