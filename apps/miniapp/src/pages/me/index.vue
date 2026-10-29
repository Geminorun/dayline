<script setup lang="ts">
import { formatBeijingTime, tr } from '../../i18n/index';

import { msg } from '@dayline/locales';

import AdmissionReview from '../../components/AdmissionReview.vue';
import { useAdmission } from '../../admission';
import { ref, watch } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { patchProfileSchema, userDtoSchema } from '@dayline/contracts';
import { useWorkspace, message } from '../../workspace';
import { api } from '../../api';
import LanguageSettings from '../../i18n/LanguageSettings.vue';
const {
  mode,
  credentialWarning,
  identityState,
  current,
  snapshot,
  busy,
  loading,
  error,
  notice,
  ensure,
  switchMode,
  login,
  restoreSession,
  logout,
} = useWorkspace();
const name = ref(''),
  base = ref(0);
onShow(async () => {
  await ensure();
  name.value = current.value?.displayName ?? '';
  base.value = current.value?.profileVersion ?? 0;
});
watch(
  () => current.value?.id,
  () => {
    name.value = current.value?.displayName ?? '';
    base.value = current.value?.profileVersion ?? 0;
  },
);
watch(current, (next, previous) => {
  if (
    next &&
    previous &&
    next.id === previous.id &&
    next.displayName === previous.displayName
  )
    base.value = next.profileVersion;
});
async function save() {
  const input = patchProfileSchema.safeParse({
    displayName: name.value,
    expectedProfileVersion: base.value,
  });
  if (!input.success) {
    error.value = msg('account.displayNameMustBe140Characters');
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const generation = api.getGeneration();
    const response = await api.request('/api/v1/me', {
      method: 'PATCH',
      account: true,
      body: input.data,
      decode: userDtoSchema.parse,
    });
    if (response.data && generation === api.getGeneration()) {
      current.value = response.data;
      base.value = response.data.profileVersion;
      notice.value = msg('common.displayNameSaved');
    }
  } catch (cause) {
    error.value = message(cause);
  } finally {
    busy.value = false;
  }
}
function navigate(url: string) {
  uni.navigateTo({ url });
}
</script>
<template>
  <view class="page"
    ><text class="subtitle">DAYLINE</text
    ><text class="title">{{ tr('common.myDayline') }}</text
    ><text v-if="loading" class="text">{{ tr('common.loading') }}</text
    ><text v-if="error" class="text error">{{ error }}</text
    ><text v-if="credentialWarning" class="text error">{{
      credentialWarning
    }}</text
    ><text v-if="notice" class="text notice">{{ notice }}</text
    ><view
      v-if="identityState === 'unknown' || identityState === 'expired'"
      class="card"
      ><text class="text">{{
        tr('mini.identityNotConfirmedPrivateCacheHiddenPlease')
      }}</text
      ><button class="secondary" @click="restoreSession">
        {{ tr('common.reauthenticateExistingSession') }}</button
      ><button class="secondary" @click="switchMode('guest')">
        {{ tr('common.continueAsGuest') }}
      </button></view
    ><LanguageSettings /><view class="card"
      ><text class="heading">{{
        mode === 'guest'
          ? tr('recordsScreen.guestSaveLocallyOnly')
          : tr('mini.verifiedAccountCloudRecords')
      }}</text
      ><text class="text muted">{{
        mode === 'guest'
          ? tr('mini.theLocalRecordOnlyExistsOnThis')
          : tr('mini.whenSavingOnlineUnsavedInputOnThe')
      }}</text
      ><text v-if="snapshot" class="text">{{
        tr('mini.activeEntriesCategories', {
          value0: snapshot.entries.length,
          value1: snapshot.categories.length,
        })
      }}</text
      ><button class="secondary" :disabled="busy" @click="switchMode('guest')">
        {{ tr('mini.continueToUseGuestNativeLogging') }}</button
      ><button v-if="current" :disabled="busy" @click="switchMode('account')">
        {{ tr('mini.enterVerifiedAccountRecords') }}</button
      ><template v-else
        ><button :disabled="busy" @click="login">
          {{ tr('common.signInWithWechat3') }}</button
        ><button class="secondary" :disabled="busy" @click="restoreSession">
          {{ tr('mini.readExistingSessionAndEnterAccount') }}
        </button></template
      ><text class="text muted">{{
        tr('mini.guestAndAccountRecordsAreKeptSeparately')
      }}</text></view
    ><AdmissionReview
      v-if="mode === 'account' && current?.status === 'active'"
    /><button
      v-if="mode === 'account' && current?.status === 'active'"
      class="secondary"
      @click="useAdmission().begin(true)"
    >
      {{ tr('mini.prepareOrQueryGuestAccess') }}</button
    ><view v-if="current" class="card"
      ><text class="heading">{{ tr('common.accountInformation') }}</text
      ><text class="text">{{ current.displayName }}</text
      ><text class="text">{{
        tr('mini.email', {
          value0: current.email ?? tr('common.noRealEmailAddressHasBeenBound'),
          value1: current.emailVerified
            ? tr('common.verified')
            : tr('common.notVerified'),
        })
      }}</text
      ><text class="text">{{
        tr('mini.wechat', {
          value0: current.wechatBound
            ? tr('common.alreadyAssociated')
            : tr('common.notAssociatedYet'),
        })
      }}</text
      ><text class="text">{{
        tr('mini.password', {
          value0: current.passwordEnabled
            ? tr('common.enabled')
            : tr('common.notEnabled'),
        })
      }}</text
      ><text v-if="current.status !== 'active'" class="text notice">{{
        tr('mini.accountRestrictedCancellationDue', {
          value0: formatBeijingTime(current.deletionDueAt),
        })
      }}</text
      ><text class="text">{{ tr('common.displayName') }}</text
      ><input
        v-model="name"
        :maxlength="80"
        :aria-label="tr('common.displayName')"
      /><button :disabled="busy || current.status !== 'active'" @click="save">
        {{ tr('common.saveDisplayName') }}</button
      ><button class="secondary" :disabled="busy" @click="logout">
        {{ tr('common.logOutOfCurrentAccount') }}
      </button></view
    ><view class="card"
      ><button
        v-if="current"
        class="secondary"
        @click="navigate('/pages/account/deletion')"
      >
        {{ tr('mini.cancelAccountCheckStatusAndCancellation') }}</button
      ><button class="secondary" @click="navigate('/pages/categories/index')">
        {{ tr('common.categoryManagement') }}</button
      ><button class="secondary" @click="navigate('/pages/trash/index')">
        {{ tr('common.trash') }}</button
      ><button
        v-if="current?.status === 'active'"
        class="secondary"
        @click="navigate('/pages/account/identity')"
      >
        {{ tr('mini.addEmailBindWechatMergeAccounts') }}</button
      ><text class="text muted">{{
        tr('mini.pleaseOperateCsvJsonFilesOnThe')
      }}</text></view
    ></view
  >
</template>
