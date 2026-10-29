<script setup lang="ts">
import { tr, messageRef } from './i18n/index';
import { msg } from '@dayline/locales';
import { onMounted, ref, watch } from 'vue';
import { patchProfileSchema, userDtoSchema } from '@dayline/contracts';
import { api } from './api';
import { useAccount } from './account';
import { useWorkspace } from './records/workspace';
import { errorMessage } from './records/record-service';
import AppearanceSettings from './appearance/AppearanceSettings.vue';
import LanguageSettings from './i18n/LanguageSettings.vue';
const account = useAccount(),
  workspace = useWorkspace();
const { current } = account;
const tab = ref<'appearance' | 'account'>('appearance');
const name = ref(''),
  base = ref(0),
  editingName = ref(false),
  busy = ref(false),
  error = messageRef(),
  notice = messageRef();
function useCurrentProfile() {
  name.value = current.value?.displayName ?? '';
  base.value = current.value?.profileVersion ?? 0;
  editingName.value = false;
}
watch(
  () => current.value?.id,
  () => {
    useCurrentProfile();
    error.value = '';
    notice.value = '';
  },
);
onMounted(async () => {
  await workspace.ensure();
  if (!editingName.value) useCurrentProfile();
});
watch(current, (next, previous) => {
  if (
    next &&
    previous &&
    next.id === previous.id &&
    next.displayName === previous.displayName
  )
    base.value = next.profileVersion;
});
function selectTab(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  tab.value = tab.value === 'appearance' ? 'account' : 'appearance';
  document.getElementById(`settings-tab-${tab.value}`)?.focus();
}
async function save() {
  if (busy.value) return;
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
  notice.value = '';
  try {
    const generation = api.getGeneration();
    await api.request('/api/v1/me', {
      method: 'PATCH',
      account: true,
      body: input.data,
      decode: userDtoSchema.parse,
    });
    if (generation !== api.getGeneration()) return;
    await account.refresh();
    if (generation !== api.getGeneration()) return;
    useCurrentProfile();
    notice.value = msg('common.displayNameSaved');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="settings-page">
    <header class="settings-heading">
      <h1>{{ tr('common.settings') }}</h1>
      <p>{{ tr('account.personalizeDaylineAndManageYourAccount') }}</p>
    </header>
    <nav
      class="settings-tabs"
      role="tablist"
      :aria-label="tr('common.settingsSections')"
      @keydown="selectTab"
    >
      <button
        id="settings-tab-appearance"
        role="tab"
        :aria-selected="tab === 'appearance'"
        :tabindex="tab === 'appearance' ? 0 : -1"
        aria-controls="settings-appearance"
        @click="tab = 'appearance'"
      >
        {{ tr('common.appearance') }}
      </button>
      <button
        id="settings-tab-account"
        role="tab"
        :aria-selected="tab === 'account'"
        :tabindex="tab === 'account' ? 0 : -1"
        aria-controls="settings-account"
        @click="tab = 'account'"
      >
        {{ tr('common.accountSecurity') }}
      </button>
    </nav>
    <div
      v-if="tab === 'appearance'"
      id="settings-appearance"
      role="tabpanel"
      aria-labelledby="settings-tab-appearance"
    >
      <LanguageSettings /><AppearanceSettings />
    </div>
    <section
      v-else
      id="settings-account"
      role="tabpanel"
      aria-labelledby="settings-tab-account"
      class="account-settings"
    >
      <template v-if="current">
        <p v-if="error" role="alert" class="settings-error">{{ error }}</p>
        <p v-if="notice" role="status" class="settings-success">{{ notice }}</p>
        <div class="settings-row">
          <div>
            <h2>{{ tr('common.displayName') }}</h2>
            <p>{{ current.displayName }}</p>
          </div>
          <button
            v-if="!editingName"
            class="settings-link"
            :disabled="current.status !== 'active'"
            @click="
              useCurrentProfile();
              editingName = true;
            "
          >
            {{ tr('common.edit') }}
          </button>
          <form v-else class="profile-edit" @submit.prevent="save">
            <label class="sr-only" for="profile-name">{{
              tr('common.displayName')
            }}</label
            ><input
              id="profile-name"
              v-model="name"
              required
              maxlength="40"
              :disabled="busy"
            />
            <button class="settings-primary" :disabled="busy">
              {{ tr('common.save') }}</button
            ><button
              type="button"
              class="settings-link"
              :disabled="busy"
              @click="useCurrentProfile"
            >
              {{ tr('common.cancel') }}
            </button>
          </form>
        </div>
        <div class="settings-row">
          <div>
            <h2>{{ tr('common.email') }}</h2>
            <p>
              {{ current.email ?? tr('common.emailHasNotBeenBoundYet')
              }}<span v-if="current.email" class="settings-badge">{{
                current.emailVerified
                  ? tr('common.verified')
                  : tr('common.pendingVerification')
              }}</span>
            </p>
          </div>
          <RouterLink
            v-if="current.status === 'active'"
            class="settings-link"
            to="/identity"
            >{{ tr('common.manage') }}</RouterLink
          >
        </div>
        <div class="settings-row">
          <div>
            <h2>{{ tr('common.wechat') }}</h2>
            <p>
              {{
                current.wechatBound
                  ? tr('common.wechatAccountHasBeenAssociated')
                  : tr('common.wechatAccountNotYetAssociated')
              }}
            </p>
          </div>
          <RouterLink
            v-if="current.status === 'active'"
            class="settings-link"
            to="/identity"
            >{{
              current.wechatBound
                ? tr('common.manage')
                : tr('common.association')
            }}</RouterLink
          >
        </div>
        <div class="settings-row">
          <div>
            <h2>{{ tr('common.password') }}</h2>
            <p>
              {{
                current.passwordEnabled
                  ? tr('account.logInUsingEmailAndPassword')
                  : tr('account.afterBindingTheEmailAddressYouCan')
              }}
            </p>
          </div>
          <RouterLink
            v-if="current.passwordEnabled && current.status === 'active'"
            class="settings-link"
            to="/change-password"
            >{{ tr('common.changePassword') }}</RouterLink
          >
        </div>
        <details class="settings-advanced">
          <summary>{{ tr('common.moreAccountOptions') }}</summary>
          <RouterLink class="settings-detail-link" to="/identity"
            ><span
              >{{ tr('common.linkOrMergeAccounts')
              }}<small>{{
                tr('account.afterConfirmingTheIdentityOfTheEmail')
              }}</small></span
            ><span aria-hidden="true">›</span></RouterLink
          >
          <RouterLink
            class="settings-detail-link settings-danger"
            to="/account-deletion"
            ><span
              >{{
                current.status === 'pending_deletion'
                  ? tr('account.viewOrCancelAccountAccountDeletion')
                  : tr('common.cancelAccount')
              }}<small>{{
                tr('account.checkTheAccountDeletionRulesAndRecovery')
              }}</small></span
            ><span aria-hidden="true">›</span></RouterLink
          >
        </details>
      </template>
      <div v-else class="settings-empty">
        <h2>{{ tr('common.manageYourAccount') }}</h2>
        <p>{{ tr('account.afterLoggingInYouCanModifyInformation') }}</p>
        <RouterLink class="settings-primary" to="/login">{{
          tr('common.signInSignUp')
        }}</RouterLink>
      </div>
    </section>
  </section>
</template>
