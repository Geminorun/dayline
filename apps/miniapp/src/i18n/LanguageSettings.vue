<script setup lang="ts">
import { ClientError } from '@dayline/api-client';
import { ref, nextTick } from 'vue';
import { msg } from '@dayline/locales';
import { patchProfileSchema, userDtoSchema } from '@dayline/contracts';
import { api } from '../api';
import { useWorkspace } from '../workspace';
import {
  changeLanguage,
  languageChoices,
  languageName,
  locale,
  messageRef,
  tr,
} from './index';
const workspace = useWorkspace(),
  busy = ref(false),
  notice = messageRef(),
  error = messageRef();
async function select(event: { detail: { value: string | number } }) {
  if (busy.value) return;
  const next = languageChoices[Number(event.detail.value)]?.value;
  if (!next) return;
  const persisted = changeLanguage(next);
  notice.value = '';
  error.value = '';
  if (!persisted) error.value = msg('language.storageUnavailable');
  const profile = workspace.current.value;
  if (!profile || profile.status !== 'active') {
    notice.value = msg('language.localSaved');
    return;
  }
  const generation = api.getGeneration();
  busy.value = true;
  try {
    const result = await api.request('/api/v1/me', {
      method: 'PATCH',
      account: true,
      body: patchProfileSchema.parse({
        locale: next,
        expectedProfileVersion: profile.profileVersion,
      }),
      decode: userDtoSchema.parse,
    });
    if (generation !== api.getGeneration() || !result.data) return;
    workspace.current.value = result.data;
    notice.value = msg('language.saved');
  } catch (cause) {
    if (
      generation === api.getGeneration() &&
      cause instanceof ClientError &&
      cause.code === 'VERSION_CONFLICT'
    ) {
      try {
        const result = await api.request('/api/v1/me', {
          account: true,
          decode: userDtoSchema.parse,
        });
        if (result.data && generation === api.getGeneration()) {
          workspace.current.value = result.data;
          await nextTick();
          changeLanguage(next, false);
        }
      } catch {
        /* Preserve the user's selected local language. */
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
  <view class="card"
    ><text class="heading">{{ tr('language.title') }}</text
    ><text class="text muted">{{ tr('language.description') }}</text
    ><picker
      :range="languageChoices.map((c) => c.label)"
      :value="locale === 'en' ? 1 : 0"
      :disabled="busy"
      @change="select"
      ><view class="picker">{{ languageName }}</view></picker
    ><text v-if="notice" class="text notice">{{ notice }}</text
    ><text v-if="error" class="text error">{{ error }}</text
    ><button
      v-if="error"
      class="secondary"
      :disabled="busy"
      @click="select({ detail: { value: locale === 'en' ? 1 : 0 } })"
    >
      {{ tr('language.retry') }}
    </button></view
  >
</template>
