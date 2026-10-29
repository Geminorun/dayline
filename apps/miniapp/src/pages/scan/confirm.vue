<script setup lang="ts">
import PageShell from '../../components/PageShell.vue';
import { formatBeijingTime, tr, messageRef } from '../../i18n/index';

import { msg } from '@dayline/locales';

import { qrResolvedDtoSchema, qrStatusDtoSchema } from '@dayline/contracts';
import { ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import { ClientError } from '@dayline/api-client';
import { api, wechatCode } from '../../api';
const purpose = ref('login');
const requestId = ref('');
const proof = ref('');
const busy = ref(false);
const error = messageRef();
const state = ref('loading');
const expiresAt = ref('');
let disposed = false;
function message(cause: unknown) {
  return cause instanceof ClientError
    ? cause.message
    : tr('confirm.theCodeScanningOperationIsNotCompleted');
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
      error.value = msg('confirm.theRequestHasBeenClaimedByThe');
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
    error.value = msg('confirm.theScanCodeParametersAreInvalidPlease');
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
  <PageShell
    ><view class="card"
      ><text class="subtitle">{{ tr('confirm.daylineWebLogin') }}</text
      ><text class="title">{{
        purpose === 'login'
          ? tr('common.confirmLoginPage')
          : purpose === 'reauth'
            ? tr('confirm.confirmCurrentIdentityReAuthentication')
            : tr('common.confirmBindingToWechat')
      }}</text
      ><text class="text">{{
        tr('confirm.pleaseConfirmThatItWasInitiatedBy', {
          value0:
            purpose === 'login'
              ? tr('confirm.thisOperationWillAllowTheWebpageThat')
              : purpose === 'reauth'
                ? tr('confirm.thisTimeOnlyTheSpecifiedOperationsOf')
                : tr('confirm.addThisWechatToTheCurrentAccount'),
        })
      }}</text
      ><text v-if="state === 'loading'" class="text muted">{{
        tr('confirm.verifyingThisScan')
      }}</text
      ><text v-if="error" class="text error" role="alert">{{ error }}</text
      ><template v-if="state === 'scanned'"
        ><text class="text muted">{{
          tr('confirm.scanNotAuthorizedYetPleaseExplicitlySelect', {
            value0: formatBeijingTime(expiresAt),
          })
        }}</text
        ><button :disabled="busy" @click="confirm">
          {{
            purpose === 'login'
              ? tr('common.confirmLoginPage')
              : purpose === 'reauth'
                ? tr('common.confirmThisReVerification')
                : tr('common.confirmThisWechatBinding')
          }}</button
        ><button class="secondary" :disabled="busy" @click="cancel">
          {{ tr('common.cancelThisOperation') }}
        </button></template
      ><template v-if="state === 'confirmed'"
        ><text class="text notice">{{
          tr('confirm.confirmedPleaseReturnToTheOriginalWebpage')
        }}</text
        ><button class="secondary" :disabled="busy" @click="cancel">
          {{ tr('common.cancelConfirmedLogin') }}
        </button></template
      ><text v-if="state === 'cancelled'" class="text notice">{{
        tr('common.thisOperationHasBeenCancelled')
      }}</text></view
    ></PageShell
  >
</template>
