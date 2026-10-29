<script setup lang="ts">
import { errorMessage } from './records/record-service';
import { formatBeijingTime, tr, messageRef } from './i18n/index';

import { ClientError, createIdentityClient } from '@dayline/api-client';

import { msg } from '@dayline/locales';
import IconButton from './components/IconButton.vue';

import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import ReauthForm from './ReauthForm.vue';

import { recoverMergeDraft } from './merge-drafts';
import type { MergeMappings, EntryDraft } from '@dayline/contracts';

import { useAccount } from './account';
import { useWorkspace } from './records/workspace';
import { api } from './api';
import { localEnvironment, localRepository } from './adapters/local-repository';
const workspace = useWorkspace();
const drafts = ref<EntryDraft[]>([]),
  error = messageRef(),
  account = useAccount();
async function load() {
  drafts.value = [];
  error.value = '';
  if (workspace.mode.value !== 'account') {
    error.value = msg('drafts.pleaseClearlyEnterTheVerifiedAccountSpace');
    return;
  }
  const space = workspace.generation(),
    generation = api.getGeneration();
  try {
    await account.refresh();
    if (
      space !== workspace.generation() ||
      generation !== api.getGeneration() ||
      workspace.mode.value !== 'account'
    )
      return;
    const userId = account.current.value?.id,
      g = api.getGeneration();
    if (!userId) return;
    const next = await localRepository.drafts(userId);
    if (
      g === api.getGeneration() &&
      space === workspace.generation() &&
      workspace.mode.value === 'account'
    )
      drafts.value = next;
  } catch {
    error.value = msg('drafts.pleaseGoOnlineToReVerifyYour');
  }
}
const mergeClient = createIdentityClient(api);
const mergeJobs = ref<
    NonNullable<Awaited<ReturnType<typeof mergeClient.list>>['data']>
  >([]),
  selectedMerge = ref(''),
  mergeOperation = ref<string>(crypto.randomUUID()),
  sourceDrafts = ref<EntryDraft[]>([]),
  mapping = ref<MergeMappings | null>(null),
  selectedCategory = ref(''),
  recoveryNotice = messageRef();
function resetRecovery() {
  sourceDrafts.value = [];
  mapping.value = null;
  selectedCategory.value = '';
  recoveryNotice.value = '';
  mergeOperation.value = crypto.randomUUID();
}
async function listMerges() {
  if (workspace.mode.value !== 'account' || !account.current.value) return;
  const generation = api.getGeneration(),
    space = workspace.generation();
  try {
    const r = await mergeClient.list();
    if (generation === api.getGeneration() && space === workspace.generation())
      mergeJobs.value = (r.data ?? []).filter((j) => j.status === 'committed');
  } catch {
    error.value = msg('drafts.pleaseCheckOnlineToCheckThatThe');
  }
}
async function authorizeRecovery(proof: string) {
  const generation = api.getGeneration(),
    space = workspace.generation(),
    selected = selectedMerge.value,
    operation = mergeOperation.value;
  sourceDrafts.value = [];
  mapping.value = null;
  try {
    const r = await mergeClient.mappings(selected, proof, operation);
    if (
      generation !== api.getGeneration() ||
      space !== workspace.generation() ||
      selected !== selectedMerge.value ||
      operation !== mergeOperation.value ||
      !r.data
    )
      return;
    const authorized = r.data;
    const originals = await localRepository.drafts(authorized.sourceUserId);
    if (
      generation !== api.getGeneration() ||
      space !== workspace.generation() ||
      selected !== selectedMerge.value ||
      operation !== mergeOperation.value
    )
      return;
    mapping.value = authorized;
    sourceDrafts.value = originals;
    recoveryNotice.value = originals.length
      ? msg('drafts.theBackendIsAuthorizedToReadThe')
      : msg('drafts.thisDeviceDoesNotHaveADraft');
  } catch {
    if (
      generation !== api.getGeneration() ||
      space !== workspace.generation() ||
      selected !== selectedMerge.value ||
      operation !== mergeOperation.value
    )
      return;
    error.value = msg('drafts.unableToAuthorizeRecoveryPleaseReVerify');
  }
}
async function recover(draft: EntryDraft) {
  const authorized = mapping.value,
    userId = account.current.value?.id,
    generation = api.getGeneration(),
    space = workspace.generation();
  if (
    !authorized ||
    userId !== authorized.targetUserId ||
    workspace.mode.value !== 'account'
  )
    return;
  try {
    const copy = recoverMergeDraft(
      draft,
      authorized,
      crypto.randomUUID(),
      crypto.randomUUID(),
      new Date().toISOString(),
      selectedCategory.value || undefined,
    );
    await localRepository.putDraft(copy);
    if (generation !== api.getGeneration() || space !== workspace.generation())
      return;
    recoveryNotice.value = copy.baseEntry
      ? msg('drafts.copiedToTheTargetAccountDraftRetaining')
      : msg('drafts.theReliableOriginalBaselineIsMissingAnd');
    await load();
  } catch (e) {
    error.value =
      e instanceof ClientError && e.code === 'DRAFT_CATEGORY_REQUIRED'
        ? errorMessage(e)
        : msg('drafts.localCopyFailedTheOriginalDraftIs');
  }
}
const unsubscribe = api.onIdentityChange(() => {
  drafts.value = [];
  sourceDrafts.value = [];
  mapping.value = null;
  mergeJobs.value = [];
  selectedMerge.value = '';
  selectedCategory.value = '';
  recoveryNotice.value = '';
});
function resume(draft: EntryDraft) {
  if (!permitted(draft)) return;
  try {
    sessionStorage.removeItem(
      `dayline:${localEnvironment}:${draft.userId}:resume:${draft.draftId}`,
    );
  } catch {
    /* original key remains the route target */
  }
}
function permitted(draft: EntryDraft) {
  return (
    workspace.mode.value === 'account' &&
    account.current.value?.id === draft.userId
  );
}
async function discard(draft: EntryDraft) {
  if (!permitted(draft)) return;
  if (!window.confirm(tr('drafts.abandonThisLocalDraftTheCloudEntry'))) return;
  await localRepository.removeDraft(
    draft.userId,
    draft.draftId,
    draft.inputRevision,
  );
  await load();
}
function download(draft: EntryDraft) {
  if (!permitted(draft)) return;
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }),
    ),
    a = document.createElement('a');
  a.href = url;
  a.download = 'dayline-draft.json';
  a.click();
  URL.revokeObjectURL(url);
}
async function copy(draft: EntryDraft) {
  if (!permitted(draft)) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(draft.fields, null, 2));
  } catch {
    error.value = msg('drafts.copyIsNotAvailablePleaseDownloadDraft');
  }
}
watch([() => workspace.mode.value, () => account.current.value?.id], () => {
  drafts.value = [];
  sourceDrafts.value = [];
  mapping.value = null;
  mergeJobs.value = [];
  selectedMerge.value = '';
  selectedCategory.value = '';
  recoveryNotice.value = '';
  if (workspace.mode.value === 'account') void load();
  else error.value = msg('drafts.pleaseClearlyEnterTheVerifiedAccountSpace');
});
onMounted(load);
onBeforeUnmount(unsubscribe);
</script>
<template>
  <section class="records-page settings-subpage themed-form">
    <h1>{{ tr('common.unsavedChanges') }}</h1>
    <p>{{ tr('drafts.theseContentsAreOnlyTemporaryOnThis') }}</p>
    <p v-if="error" class="error">{{ error }}</p>
    <article v-for="draft in drafts" :key="draft.draftId" class="record-panel">
      <h2>{{ draft.fields.title || tr('common.unnamedDraft') }}</h2>
      <p>
        {{
          tr('drafts.lastBuffer', {
            value0:
              draft.baseEntryVersion === null
                ? tr('common.new2')
                : tr('common.edit'),
            value1: formatBeijingTime(draft.savedLocallyAt),
          })
        }}
      </p>
      <RouterLink
        v-if="account.current.value?.status === 'active'"
        :to="{ path: '/entries/new', query: { draftId: draft.draftId } }"
        @click="resume(draft)"
        >{{ tr('common.continueEditing') }}</RouterLink
      ><IconButton
        icon="copy"
        :label="tr('common.copyInput')"
        @click="copy(draft)"
      />
      <IconButton
        icon="download"
        :label="tr('common.downloadACopy')"
        @click="download(draft)"
      />
      <IconButton
        icon="trash"
        :label="tr('common.abandonModification')"
        danger
        @click="discard(draft)"
      />
    </article>
    <section
      v-if="
        workspace.mode.value === 'account' &&
        account.current.value?.status === 'active'
      "
      class="record-panel"
    >
      <h2>{{ tr('common.revertPreMergeChanges') }}</h2>
      <p>{{ tr('drafts.onlyAfterTheUnifiedAccountIsRe') }}</p>
      <IconButton
        icon="refresh"
        :label="tr('common.queryMergeCompleted')"
        @click="listMerges"
      />
      <label
        >{{ tr('common.selectMerge')
        }}<select v-model="selectedMerge" @change="resetRecovery">
          <option value="">{{ tr('common.pleaseSelect') }}</option>
          <option v-for="j in mergeJobs" :key="j.id" :value="j.id">
            {{
              tr('drafts.mergeCompleted', {
                value0: formatBeijingTime(j.completedAt ?? j.createdAt),
              })
            }}
          </option>
        </select></label
      ><ReauthForm
        v-if="selectedMerge"
        :action="{
          purpose: 'recover_drafts',
          operationId: mergeOperation,
          target: selectedMerge,
        }"
        @verified="authorizeRecovery"
      />
      <p v-if="recoveryNotice" role="status">{{ recoveryNotice }}</p>
      <label v-if="sourceDrafts.length"
        >{{ tr('drafts.explicitlySelectSaveCategoryAsWhenCategory')
        }}<select v-model="selectedCategory">
          <option value="">{{ tr('common.pleaseSelect') }}</option>
          <option
            v-for="c in workspace.snapshot.value?.categories ?? []"
            :key="c.id"
            :value="c.id"
          >
            {{ c.name }}
          </option>
        </select></label
      >
      <article v-for="draft in sourceDrafts" :key="draft.draftId">
        <h3>{{ draft.fields.title || tr('common.unnamedDraft') }}</h3>
        <p>
          {{
            tr('drafts.originalDatum', {
              value0: draft.fields.startDate,
              value1: draft.fields.endDate ?? tr('common.notFinished'),
              value2: draft.baseEntryVersion ?? tr('common.missing'),
            })
          }}
        </p>
        <button class="button primary" @click="recover(draft)">
          {{ tr('drafts.keepTheOriginalAndCopyItAs') }}
        </button>
      </article>
    </section>
    <p v-if="!error && !drafts.length">{{ tr('drafts.noUnsavedChanges') }}</p>
  </section>
</template>
