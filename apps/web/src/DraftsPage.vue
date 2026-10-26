<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import type { EntryDraft } from '@dayline/contracts';
import { useAccount } from './account';
import { useWorkspace } from './records/workspace';
import { api } from './api';
import { localEnvironment, localRepository } from './adapters/local-repository';
const workspace = useWorkspace();
const drafts = ref<EntryDraft[]>([]),
  error = ref(''),
  account = useAccount();
async function load() {
  drafts.value = [];
  error.value = '';
  if (workspace.mode.value !== 'account') {
    error.value = '请先明确进入已验证账号空间后查看草稿。';
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
    error.value = '请联网重新验证所属账号后查看草稿；原草稿保留。';
  }
}
const unsubscribe = api.onIdentityChange(() => {
  drafts.value = [];
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
  if (!window.confirm('放弃此本机草稿？云端事项保持不变。')) return;
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
    error.value = '复制不可用，请下载草稿。';
  }
}
watch(
  () => [workspace.mode.value, account.current.value?.id],
  () => {
    drafts.value = [];
    if (workspace.mode.value === 'account') void load();
    else error.value = '请先明确进入已验证账号空间后查看草稿。';
  },
);
onMounted(load);
onBeforeUnmount(unsubscribe);
</script>
<template>
  <section class="records-page">
    <h1>本机未提交草稿</h1>
    <p>仅显示当前重新验证账号的输入；不计入正式记录或云端备份。</p>
    <p v-if="error" class="error">{{ error }}</p>
    <article v-for="draft in drafts" :key="draft.draftId" class="record-panel">
      <h2>{{ draft.fields.title || '未命名草稿' }}</h2>
      <p>
        {{ draft.baseEntryVersion === null ? '新建' : '编辑' }} · 最后暂存
        {{ draft.savedLocallyAt }}
      </p>
      <RouterLink
        :to="{ path: '/entries/new', query: { draftId: draft.draftId } }"
        @click="resume(draft)"
        >继续编辑</RouterLink
      ><button class="secondary" @click="copy(draft)">复制输入</button
      ><button class="secondary" @click="download(draft)">下载草稿</button
      ><button class="secondary" @click="discard(draft)">放弃草稿</button>
    </article>
    <p v-if="!error && !drafts.length">当前账号没有已暂存草稿。</p>
  </section>
</template>
