<script setup lang="ts">
import { tr, messageRef } from './i18n/index';
import { msg } from '@dayline/locales';
import { ref, watch, onBeforeUnmount } from 'vue';
import { api } from './api';
import { useAccount } from './account';
import { useWorkspace } from './records/workspace';
import { localRepository } from './adapters/local-repository';
import { errorMessage } from './records/record-service';
const account = useAccount(),
  workspace = useWorkspace();
const busy = ref(false),
  error = messageRef(),
  notice = messageRef(),
  warning = ref(false),
  warningText = messageRef(),
  selected = ref<'csv' | 'json'>('json');
let intent = 0;
onBeforeUnmount(() => {
  intent++;
});
watch(
  () => `${account.current.value?.id}:${workspace.mode.value}`,
  () => {
    intent++;
    busy.value = false;
    error.value = '';
    notice.value = '';
    warning.value = false;
    warningText.value = '';
  },
  { flush: 'sync' },
);
async function download(format: 'csv' | 'json', confirmed = false) {
  const id = account.current.value?.id,
    generation = api.getGeneration(),
    space = workspace.generation(),
    own = intent;
  if (!id || workspace.mode.value !== 'account' || busy.value) return;
  const current = () =>
    own === intent &&
    generation === api.getGeneration() &&
    space === workspace.generation() &&
    id === account.current.value?.id &&
    workspace.mode.value === 'account';
  busy.value = true;
  error.value = '';
  selected.value = format;
  try {
    if (!confirmed) {
      let drafts: Awaited<ReturnType<typeof localRepository.drafts>>;
      try {
        drafts = await localRepository.drafts(id);
      } catch {
        if (current()) {
          warningText.value = msg(
            'accountExports.theLocalDraftCannotBeReadTemporarily',
          );
          warning.value = true;
        }
        return;
      }
      if (!current()) return;
      if (drafts.length) {
        warningText.value = msg(
          'accountExports.thereIsAnUncommittedDraftYouCan',
        );
        warning.value = true;
        return;
      }
    }
    warning.value = false;
    const response = await api.request(`/api/v1/exports/${format}`, {
      native: true,
      account: true,
      decode: (v: unknown) => {
        if (typeof v !== 'string')
          throw new Error(tr('common.fileNotGenerated'));
        return v;
      },
    });
    if (!current() || !response.data) return;
    const url = URL.createObjectURL(
      new Blob([response.data], {
        type:
          format === 'csv'
            ? 'text/csv;charset=utf-8'
            : 'application/json;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `dayline-${new Date().toISOString().slice(0, 10)}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice.value = msg('accountExports.theFileHasBeenGeneratedPleaseKeep');
  } catch (e) {
    if (current()) error.value = errorMessage(e);
  } finally {
    if (current()) busy.value = false;
  }
}
</script>
<template>
  <section
    v-if="account.current.value && workspace.mode.value === 'account'"
    class="record-panel"
  >
    <h2>{{ tr('common.exportingSavedRecords') }}</h2>
    <p>{{ tr('accountExports.csvContainsActivityEntriesAndTheComplete') }}</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <button class="button primary" :disabled="busy" @click="download('csv')">
      {{ tr('common.exportCsv') }}</button
    ><button class="button primary" :disabled="busy" @click="download('json')">
      {{ tr('accountExports.exportFullJson') }}
    </button>
    <div v-if="warning" role="status">
      <p>{{ warningText }}</p>
      <button
        class="button primary"
        :disabled="busy"
        @click="download(selected, true)"
      >
        {{ tr('accountExports.continueToExportCloudRecordsOnly') }}</button
      ><RouterLink to="/drafts">{{
        tr('common.copyOrDownloadDraft')
      }}</RouterLink>
    </div>
  </section>
</template>
