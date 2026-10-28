<script setup lang="ts">
import IconButton from './components/IconButton.vue';
import { formatBeijingTime } from '@dayline/core';
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import ReauthForm from './ReauthForm.vue';
import { createIdentityClient } from '@dayline/api-client';
import { recoverMergeDraft } from './merge-drafts';
import type { MergeMappings } from '@dayline/contracts';
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
const mergeClient = createIdentityClient(api);
const mergeJobs = ref<
    NonNullable<Awaited<ReturnType<typeof mergeClient.list>>['data']>
  >([]),
  selectedMerge = ref(''),
  mergeOperation = ref<string>(crypto.randomUUID()),
  sourceDrafts = ref<EntryDraft[]>([]),
  mapping = ref<MergeMappings | null>(null),
  selectedCategory = ref(''),
  recoveryNotice = ref('');
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
    error.value = '请联网查询已完成合并。';
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
      ? '已获后端授权读取来源草稿。原稿保留；请逐份复制为待核对草稿，之后手动保存。'
      : '此设备没有该来源账号的草稿。';
  } catch {
    if (
      generation !== api.getGeneration() ||
      space !== workspace.generation() ||
      selected !== selectedMerge.value ||
      operation !== mergeOperation.value
    )
      return;
    error.value = '无法授权恢复；请重新验证统一账号。原草稿保留。';
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
      ? '已复制为目标账号草稿，保留原始基准；继续编辑时读取最新记录并核对版本。尚未提交云端。'
      : '缺少可靠原始基准，已复制为待核对的新建草稿；请选择字段后手动另存。原稿保留。';
    await load();
  } catch (e) {
    error.value =
      e instanceof Error && e.message === '请明确选择目标分类；旧草稿原文保留。'
        ? e.message
        : '本机复制失败，原草稿保留。请检查本机存储后重试。';
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
watch([() => workspace.mode.value, () => account.current.value?.id], () => {
  drafts.value = [];
  sourceDrafts.value = [];
  mapping.value = null;
  mergeJobs.value = [];
  selectedMerge.value = '';
  selectedCategory.value = '';
  recoveryNotice.value = '';
  if (workspace.mode.value === 'account') void load();
  else error.value = '请先明确进入已验证账号空间后查看草稿。';
});
onMounted(load);
onBeforeUnmount(unsubscribe);
</script>
<template>
  <section class="records-page settings-subpage themed-form">
    <h1>未提交修改</h1>
    <p>这些内容只暂存在此设备。继续编辑并保存后，才会上传到账号。</p>
    <p v-if="error" class="error">{{ error }}</p>
    <article v-for="draft in drafts" :key="draft.draftId" class="record-panel">
      <h2>{{ draft.fields.title || '未命名草稿' }}</h2>
      <p>
        {{ draft.baseEntryVersion === null ? '新建' : '编辑' }} · 最后暂存
        {{ formatBeijingTime(draft.savedLocallyAt) }}
      </p>
      <RouterLink
        v-if="account.current.value?.status === 'active'"
        :to="{ path: '/entries/new', query: { draftId: draft.draftId } }"
        @click="resume(draft)"
        >继续编辑</RouterLink
      ><IconButton icon="copy" label="复制输入" @click="copy(draft)" />
      <IconButton icon="download" label="下载副本" @click="download(draft)" />
      <IconButton
        icon="trash"
        label="放弃修改"
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
      <h2>恢复合并前的修改</h2>
      <p>
        只有重新验证统一账号并取得后端映射后，才读取本机来源草稿。普通切换账号不会迁移草稿。
      </p>
      <IconButton icon="refresh" label="查询已完成合并" @click="listMerges" />
      <label
        >选择合并<select v-model="selectedMerge" @change="resetRecovery">
          <option value="">请选择</option>
          <option v-for="j in mergeJobs" :key="j.id" :value="j.id">
            {{ formatBeijingTime(j.completedAt ?? j.createdAt) }} · 已完成合并
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
        >缺少分类映射时，明确选择另存分类<select v-model="selectedCategory">
          <option value="">请选择</option>
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
        <h3>{{ draft.fields.title || '未命名草稿' }}</h3>
        <p>
          {{ draft.fields.startDate }} —
          {{ draft.fields.endDate ?? '未结束' }} · 原基准{{
            draft.baseEntryVersion ?? '缺失'
          }}
        </p>
        <button class="button primary" @click="recover(draft)">
          保留原稿，复制为待核对草稿
        </button>
      </article>
    </section>
    <p v-if="!error && !drafts.length">没有未提交的修改。</p>
  </section>
</template>
