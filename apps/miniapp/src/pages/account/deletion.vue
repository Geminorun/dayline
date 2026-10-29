<script setup lang="ts">
import PageShell from '../../components/PageShell.vue';
import { formatBeijingTime, tr, messageRef } from '../../i18n/index';

import { msg } from '@dayline/locales';
import { computed, ref, watch } from 'vue';
import { onShow, onUnload } from '@dcloudio/uni-app';
import { createIdentityClient } from '@dayline/api-client';
import { deletionResultSchema } from '@dayline/contracts';

import { api, wechatCode } from '../../api';
import { newId } from '../../adapters/uuid';
import { useWorkspace, message } from '../../workspace';
const w = useWorkspace(),
  client = createIdentityClient(api);
const confirmed = ref(false),
  operationId = ref(''),
  proof = ref(''),
  busy = ref(false),
  ready = ref(false),
  error = messageRef(),
  notice = messageRef();
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
async function verify() {
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
    const credential = { code: await wechatCode() };
    if (!current()) return;
    const r = await client.reauth({
      purpose,
      operationId: id,
      target,
      ...credential,
    });
    if (!current()) return;
    proof.value = r.data?.proof ?? '';
    notice.value = msg('deletion.thisIdentityHasBeenVerifiedAndWill');
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
      if (!current())
        throw new Error(tr('deletion.theAccountOrOperationHasChanged'));
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
        ? tr('deletion.cancellationRequestedExpiredOrdinaryLoginWillNot2', {
            value0: formatBeijingTime(r.data.dueAt),
          })
        : tr('deletion.accountDeletionHasBeenExplicitlyRevokedPlease2');
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
      error.value = msg('deletion.whenTheResultIsUnknownPleaseLog', {
        value0: message(e),
      });
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
  <PageShell
    ><text class="title">{{
      pending
        ? tr('common.accountDeletionStatusAndRevocation')
        : tr('common.cancelUnifiedAccount')
    }}</text>
    <text v-if="error" class="text error">{{ error }}</text
    ><text v-if="notice" class="text notice">{{ notice }}</text>
    <view
      v-if="ready && w.current.value && w.mode.value === 'account'"
      class="card"
    >
      <text v-if="pending" class="text">{{
        tr('deletion.expiredOrdinaryLoginWillNotCancelThe', {
          value0: formatBeijingTime(w.current.value.deletionDueAt),
        })
      }}</text>
      <text class="text">{{
        tr('deletion.accountDeletionCoversAllEntriesKeyPoints')
      }}</text>
      <text class="text">{{
        tr('deletion.bothApplicationAndCancellationCancelAllOld')
      }}</text>
      <button
        class="secondary"
        :disabled="busy"
        @click="confirmed = !confirmed"
      >
        {{
          confirmed
            ? tr('deletion.clearlyUnderstoodClickHereToCancelConfirmation')
            : pending
              ? tr('deletion.iExplicitlyCancelThisCancellation')
              : tr('deletion.iUnderstandContinueToApplyAndCancel')
        }}
      </button>
      <template v-if="confirmed"
        ><button
          v-if="w.current.value.wechatBound"
          :disabled="busy"
          @click="verify()"
        >
          {{ tr('deletion.reVerifyUsingCurrentWechat') }}
        </button></template
      >
      <button :disabled="busy || !confirmed || !proof" @click="submit">
        {{
          busy
            ? tr('deletion.waitingForServerConfirmation')
            : pending
              ? tr('common.explicitCancellationOfCancellation')
              : tr('deletion.cancellationAfterSevenDaysAfterConfirmationOf')
        }}
      </button>
      <button class="secondary" :disabled="busy" @click="load">
        {{ tr('deletion.checkAccountDeletionStatus') }}
      </button>
    </view>
    <view v-else class="card"
      ><text class="text">{{
        tr('deletion.pleaseLogInAgainUsingTheOriginal2')
      }}</text
      ><button @click="back">
        {{ tr('deletion.goBackToMineAndLogIn') }}
      </button></view
    >
  </PageShell>
</template>
