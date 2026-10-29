<script setup lang="ts">
import { ClientError } from '@dayline/api-client';
import { ref } from 'vue';
import { msg } from '@dayline/locales';
import { patchProfileSchema, userDtoSchema } from '@dayline/contracts';
import { api } from '../api';
import { useAccount } from '../account';
import {
  changeLanguage,
  languageChoices,
  locale,
  messageRef,
  tr,
} from './index';
const account = useAccount(),
  busy = ref(false),
  notice = messageRef(),
  error = messageRef();
async function save(event?: Event) {
  if (busy.value) return;
  const value =
    event?.target instanceof HTMLSelectElement
      ? event.target.value
      : locale.value;
  const selected = value === 'en' ? 'en' : 'zh-CN';
  const persisted = changeLanguage(selected);
  notice.value = '';
  error.value = '';
  if (!persisted) error.value = msg('language.storageUnavailable');
  const profile = account.current.value;
  if (!profile || profile.status !== 'active') {
    notice.value = msg('language.localSaved');
    return;
  }
  const generation = api.getGeneration();
  busy.value = true;
  try {
    await api.request('/api/v1/me', {
      method: 'PATCH',
      account: true,
      body: patchProfileSchema.parse({
        locale: selected,
        expectedProfileVersion: profile.profileVersion,
      }),
      decode: userDtoSchema.parse,
    });
    if (generation !== api.getGeneration()) return;
    await account.refresh();
    if (generation === api.getGeneration())
      notice.value = msg('language.saved');
  } catch (cause) {
    if (
      generation === api.getGeneration() &&
      cause instanceof ClientError &&
      cause.code === 'VERSION_CONFLICT'
    ) {
      try {
        await account.refresh();
        if (generation === api.getGeneration()) changeLanguage(selected, false);
      } catch {
        /* Identity errors are handled by the account adapter. */
      }
    }
    if (generation === api.getGeneration())
      error.value = msg('language.saveFailed');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section
    class="language-settings themed-form"
    :aria-label="tr('language.title')"
  >
    <div class="settings-row">
      <div>
        <h2>{{ tr('language.title') }}</h2>
        <p>{{ tr('language.description') }}</p>
      </div>
      <select
        :value="locale"
        :aria-label="tr('language.title')"
        :disabled="busy"
        @change="save"
      >
        <option
          v-for="choice in languageChoices"
          :key="choice.value"
          :value="choice.value"
        >
          {{ choice.label }}
        </option>
      </select>
    </div>
    <p v-if="notice" role="status" class="settings-success">{{ notice }}</p>
    <p v-if="error" role="alert" class="settings-error">
      {{ error }}
      <button
        v-if="account.current.value"
        type="button"
        class="settings-link"
        :disabled="busy"
        @click="save()"
      >
        {{ tr('language.retry') }}
      </button>
    </p>
  </section>
</template>

<style scoped>
.language-settings select {
  width: auto;
  min-width: 130px;
  margin-top: 0;
  flex-shrink: 0;
}
</style>
