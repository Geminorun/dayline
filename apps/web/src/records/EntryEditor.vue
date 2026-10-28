<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import type {
  CategoryDto,
  EntryDto,
  CreateEntryInput,
  PatchEntryInput,
  EntryDraft,
} from '@dayline/contracts';
import {
  createEntrySchema,
  focusRemovalDetailsSchema,
  entryResultSchema,
  GuestError,
} from '@dayline/contracts';
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  routeLocationKey,
} from 'vue-router';
import { ClientError } from '@dayline/api-client';
import { errorMessage, records } from './record-service';
import { useAccount } from '../account';
import { useWorkspace } from './workspace';
import {
  localRepository,
  localEnvironment,
} from '../adapters/local-repository';
import { api } from '../api';
import PlannerIcon from '../components/PlannerIcon.vue';
const route = inject(routeLocationKey, undefined);
const props = defineProps<{
  entry: EntryDto | null;
  categories: CategoryDto[];
  today: string;
  initialDate?: string;
  initialCategoryId?: string;
  local?: boolean;
  draft?: EntryDraft | undefined;
  save: (
    id: string,
    input: CreateEntryInput | PatchEntryInput,
    creating: boolean,
  ) => Promise<unknown>;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const userId = useAccount().current.value?.id ?? null,
  actor = api.getGeneration(),
  space = useWorkspace().generation();
const id = ref(props.draft?.entryId ?? props.entry?.id ?? crypto.randomUUID());
const draftId = crypto.randomUUID(); // Restoring creates an independent editor branch; no other tab's draft is overwritten.
const base = ref<EntryDto | null>(props.draft?.baseEntry ?? props.entry),
  baseVersion = ref<number | null>(
    props.draft?.baseEntryVersion ?? props.entry?.version ?? null,
  );
const title = ref(props.draft?.fields.title ?? props.entry?.title ?? ''),
  startDate = ref(
    props.draft?.fields.startDate ??
      props.entry?.startDate ??
      props.initialDate ??
      props.today,
  ),
  endDate = ref(props.draft?.fields.endDate ?? props.entry?.endDate ?? ''),
  categoryId = ref(
    props.draft?.fields.categoryId ??
      props.entry?.categoryId ??
      (props.categories.some(
        (category) => category.id === props.initialCategoryId,
      )
        ? props.initialCategoryId
        : props.categories[0]?.id) ??
      '',
  );
const error = ref(''),
  localError = ref(''),
  status = ref(''),
  busy = ref(false),
  saved = ref(false),
  revision = ref(props.draft?.inputRevision ?? 0),
  persisted = ref(props.draft?.persistedRevision ?? -1);
let writtenRevision = props.draft?.persistedRevision ?? -1,
  writtenBaseVersion = baseVersion.value,
  writtenEntryId = id.value;
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined,
  storageWork: Promise<void> | null = null;
const fields = () => ({
  title: title.value,
  startDate: startDate.value,
  endDate: endDate.value || null,
  categoryId: categoryId.value,
});
const original = ref(
  JSON.stringify(
    props.draft
      ? props.draft.baseEntry
        ? {
            title: props.draft.baseEntry.title,
            startDate: props.draft.baseEntry.startDate,
            endDate: props.draft.baseEntry.endDate,
            categoryId: props.draft.baseEntry.categoryId,
          }
        : {
            title: '',
            startDate: props.today,
            endDate: null,
            categoryId: props.categories[0]?.id ?? '',
          }
      : fields(),
  ),
);
const dirty = computed(
  () => !saved.value && JSON.stringify(fields()) !== original.value,
);
const durable = !!userId && !props.local;
function active() {
  return (
    !disposed &&
    actor === api.getGeneration() &&
    space === useWorkspace().generation() &&
    userId === useAccount().current.value?.id
  );
}
function draftValue(): EntryDraft {
  return {
    format: 'dayline-draft',
    localSchemaVersion: 1,
    environment: localEnvironment,
    userId: userId ?? '',
    draftId,
    entryId: id.value,
    baseEntryVersion: baseVersion.value,
    baseEntry: base.value,
    inputRevision: revision.value,
    persistedRevision: revision.value,
    savedLocallyAt: new Date().toISOString(),
    fields: fields(),
  };
}
async function flush() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!durable || !dirty.value) return;
  if (storageWork) {
    await storageWork;
    if (
      revision.value !== writtenRevision ||
      baseVersion.value !== writtenBaseVersion ||
      id.value !== writtenEntryId
    )
      return flush();
    return;
  }
  const captured = draftValue();
  const work = (async () => {
    try {
      await localRepository.putDraft(captured);
      writtenRevision = captured.inputRevision;
      writtenBaseVersion = captured.baseEntryVersion;
      writtenEntryId = captured.entryId;
      try {
        sessionStorage.setItem(
          `dayline:${localEnvironment}:${captured.userId}:editor:${props.entry?.id ?? 'new'}`,
          captured.draftId,
        );
        if (typeof route?.query.draftId === 'string')
          sessionStorage.setItem(
            `dayline:${localEnvironment}:${captured.userId}:resume:${route.query.draftId}`,
            captured.draftId,
          );
      } catch {
        /* durable draft remains reachable in its list */
      }
      if (active()) {
        persisted.value =
          baseVersion.value === captured.baseEntryVersion &&
          id.value === captured.entryId
            ? captured.inputRevision
            : -1;
        localError.value = '';
        if (
          revision.value === captured.inputRevision &&
          baseVersion.value === captured.baseEntryVersion &&
          id.value === captured.entryId
        )
          status.value = '已暂存本机，尚未提交。';
      }
    } catch {
      if (active())
        localError.value =
          '本机草稿暂存失败，输入仍在。请重试，或手动保留输入后再离开。';
    }
  })();
  storageWork = work;
  await work;
  if (storageWork === work) storageWork = null;
}
const acknowledgementLimit = ref(100),
  acknowledgement = ref<{ date: string; version: number }[] | null>(null);
watch(
  [title, startDate, endDate, categoryId],
  () => {
    saved.value = false;
    revision.value++;
    acknowledgement.value = null;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), 300);
  },
  { flush: 'sync' },
);
async function canLeave() {
  await flush();
  return (
    !dirty.value ||
    (durable && persisted.value === revision.value) ||
    window.confirm('当前输入尚未保存，确定放弃并离开？')
  );
}
onBeforeRouteLeave(canLeave);
onBeforeRouteUpdate((to, from) => (to.path === from.path ? true : canLeave()));
function leaving(event: BeforeUnloadEvent) {
  if (dirty.value && (!durable || persisted.value !== revision.value)) {
    event.preventDefault();
    event.returnValue = '';
  }
}
window.addEventListener('beforeunload', leaving);
onBeforeUnmount(() => {
  void flush();
  disposed = true;
  if (timer) clearTimeout(timer);
  window.removeEventListener('beforeunload', leaving);
});
const conflict = ref<EntryDto | null>(null),
  missing = ref(false);
const comparison = computed(() => {
  const labels = {
    title: '标题',
    startDate: '开始日期',
    endDate: '结束日期',
    categoryId: '分类',
  };
  return (['title', 'startDate', 'endDate', 'categoryId'] as const).map(
    (key) => {
      const cloud = conflict.value?.[key] ?? null,
        mine = fields()[key],
        cloudCategory = props.categories.find((c) => c.id === cloud),
        mineCategory = props.categories.find((c) => c.id === mine);
      return {
        key: labels[key],
        cloud:
          key === 'categoryId'
            ? (cloudCategory?.name ?? '原分类已删除，请重选')
            : key === 'endDate'
              ? (cloud ?? '未结束')
              : (cloud ?? '—'),
        mine:
          key === 'categoryId'
            ? (mineCategory?.name ?? '原分类已删除，请重选')
            : key === 'endDate'
              ? (mine ?? '未结束')
              : mine,
        cloudColor: key === 'categoryId' ? cloudCategory?.color : undefined,
        mineColor: key === 'categoryId' ? mineCategory?.color : undefined,
        different: cloud !== mine,
      };
    },
  );
});
async function readCurrent() {
  try {
    const result = await records.detail(id.value);
    if (!active()) return null;
    conflict.value = result.data?.entry ?? null;
    missing.value = !result.data;
    return result.data?.entry ?? null;
  } catch (cause) {
    if (active()) {
      missing.value = cause instanceof ClientError && cause.status === 404;
      error.value = missing.value
        ? '原事项已永久清理；可以保留草稿或明确另存副本。'
        : errorMessage(cause);
    }
    return null;
  }
}
function matches(entry: EntryDto, input: CreateEntryInput) {
  return (
    !entry.deletedAt &&
    entry.title === input.title &&
    entry.startDate === input.startDate &&
    entry.endDate === input.endDate &&
    entry.categoryId === input.categoryId
  );
}
async function confirmed(
  entry: EntryDto | null,
  requestRevision: number,
  input: CreateEntryInput,
) {
  if (durable && !active()) return;
  if (entry) {
    base.value = entry;
    baseVersion.value = entry.version;
  }
  original.value = JSON.stringify({
    title: input.title,
    startDate: input.startDate,
    endDate: input.endDate,
    categoryId: input.categoryId,
  });
  conflict.value = null;
  missing.value = false;
  if (revision.value === requestRevision) {
    saved.value = true;
    status.value = props.local ? '已保存到本机。' : '已保存到云端。';
    if (userId) {
      try {
        await localRepository.removeDraft(userId, draftId, requestRevision);
        if (props.draft && props.draft.entryId === id.value) {
          // Remove only the restored revision; a newer edit in another tab stays intact.
          await localRepository.removeDraft(
            userId,
            props.draft.draftId,
            props.draft.inputRevision,
          );
        }
      } catch {
        localError.value =
          '已保存到云端，但本机草稿清理失败，可稍后核对后放弃。';
      }
    }
    if (revision.value !== requestRevision) {
      saved.value = false;
      status.value = '已保存到云端，仍有未提交修改。';
      await flush();
      return;
    }
    if (!durable || active()) emit('saved');
  } else {
    status.value = '已保存到云端，仍有未提交修改。';
    await flush();
  }
}
async function submit(confirmRemoval = false) {
  if (busy.value) return;
  error.value = '';
  if (durable && !active()) {
    error.value = '账号已变化，请重新验证原账号；当前输入仍保留。';
    return;
  }
  const parsed = createEntrySchema.safeParse({ id: id.value, ...fields() });
  if (!parsed.success) {
    error.value = '请检查标题（1–100 字）、有效日期和分类。';
    return;
  }
  if (parsed.data.endDate && parsed.data.endDate < parsed.data.startDate) {
    error.value = '结束日期不能早于开始日期。';
    return;
  }
  if (durable && !navigator.onLine) {
    await flush();
    error.value = '当前离线，草稿保留；联网后请手动保存。';
    return;
  }
  const requestRevision = revision.value,
    input = parsed.data,
    requestId = id.value,
    requestBaseVersion = baseVersion.value,
    requestAcknowledgement =
      confirmRemoval && acknowledgement.value
        ? acknowledgement.value.map((f) => ({ ...f }))
        : null;
  busy.value = true;
  await flush();
  if (durable && !active()) {
    busy.value = false;
    error.value = '账号已变化，草稿已留在原账号。';
    return;
  }
  try {
    const response = await props.save(
      requestId,
      requestBaseVersion === null
        ? input
        : {
            expectedVersion: requestBaseVersion,
            title: input.title,
            startDate: input.startDate,
            endDate: input.endDate,
            categoryId: input.categoryId,
            ...(requestAcknowledgement
              ? { focusRemovalAcknowledgement: requestAcknowledgement }
              : {}),
          },
      requestBaseVersion === null,
    );
    const result = entryResultSchema.safeParse(
      typeof response === 'object' && response !== null && 'data' in response
        ? response.data
        : undefined,
    );
    if (
      result.success &&
      result.data.alreadyExists &&
      !matches(result.data.entry, input)
    ) {
      await readCurrent();
      error.value = '此稳定记录标识已存在不同内容，请核对冲突。';
      return;
    }
    await confirmed(
      result.success ? result.data.entry : null,
      requestRevision,
      input,
    );
  } catch (cause) {
    if (
      (cause instanceof ClientError || cause instanceof GuestError) &&
      cause.code === 'FOCUS_REMOVAL_CONFIRMATION_REQUIRED'
    ) {
      const details = focusRemovalDetailsSchema.safeParse(cause.details);
      acknowledgement.value = details.success
        ? details.data.affectedFocusDays
        : null;
    }
    if (
      durable &&
      cause instanceof ClientError &&
      ['NETWORK_ERROR', 'INVALID_RESPONSE'].includes(cause.code)
    ) {
      status.value = '保存结果待确认，正在读取云端核对。';
      const latest = await readCurrent();
      if (
        latest &&
        matches(latest, input) &&
        (requestBaseVersion === null || latest.version > requestBaseVersion)
      ) {
        await confirmed(latest, requestRevision, input);
        return;
      }
      error.value = '保存结果待确认；已读取可用的当前内容，请核对后手动重试。';
    } else {
      if (
        durable &&
        cause instanceof ClientError &&
        ['VERSION_CONFLICT', 'ENTRY_DELETED', 'RESOURCE_NOT_FOUND'].includes(
          cause.code,
        )
      )
        await readCurrent();
      error.value = errorMessage(cause);
    }
  } finally {
    busy.value = false;
  }
}
async function useServer() {
  if (!conflict.value || !window.confirm('放弃这份草稿修改，使用服务器内容？'))
    return;
  const e = conflict.value;
  title.value = e.title;
  startDate.value = e.startDate;
  endDate.value = e.endDate ?? '';
  categoryId.value = e.categoryId;
  base.value = e;
  baseVersion.value = e.version;
  original.value = JSON.stringify(fields());
  saved.value = true;
  conflict.value = null;
  if (userId) {
    await localRepository.removeDraft(userId, draftId);
  }
}
async function reviewedSave() {
  if (!conflict.value || conflict.value.deletedAt) return;
  if (!window.confirm('已核对服务器字段，将按当前版本保存我的修改？')) return;
  base.value = conflict.value;
  baseVersion.value = conflict.value.version;
  revision.value++;
  await flush();
  await submit();
}
async function copyEntry() {
  if (!window.confirm('将当前输入另存为一条新事项，保留原事项？')) return;
  id.value = crypto.randomUUID();
  base.value = null;
  baseVersion.value = null;
  revision.value++;
  conflict.value = null;
  missing.value = false;
  await flush();
  await submit();
}
</script>
<template>
  <section class="record-panel" aria-labelledby="editor-title">
    <div class="modal-header">
      <div>
        <span class="eyebrow">A LITTLE CHAPTER</span>
        <h2 id="editor-title">{{ entry ? '编辑事项' : '新建事项' }}</h2>
      </div>
      <button
        class="icon-btn"
        type="button"
        aria-label="关闭编辑"
        @click="emit('close')"
      >
        <PlannerIcon name="close" />
      </button>
    </div>
    <p v-if="draft" class="editor-recovery-note" role="status">
      已恢复上次未提交的修改，保存后才会上传。
    </p>
    <p v-if="status" role="status" class="notice">{{ status }}</p>
    <p v-if="localError" role="alert" class="error">{{ localError }}</p>
    <section v-if="conflict || missing" class="notice" aria-label="冲突核对">
      <h3>服务器与草稿核对</h3>
      <p v-if="conflict?.deletedAt">
        原事项在回收站，恢复须单独操作；不会自动恢复。
      </p>
      <table v-if="conflict">
        <thead>
          <tr>
            <th>字段</th>
            <th>云端当前内容</th>
            <th>我的草稿</th>
            <th>差异</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in comparison" :key="row.key">
            <th>{{ row.key }}</th>
            <td>
              <span
                v-if="row.cloudColor"
                class="category-dot"
                :style="{ backgroundColor: row.cloudColor }"
              />{{ row.cloud }}
            </td>
            <td>
              <span
                v-if="row.mineColor"
                class="category-dot"
                :style="{ backgroundColor: row.mineColor }"
              />{{ row.mine }}
            </td>
            <td>{{ row.different ? '不同' : '相同' }}</td>
          </tr>
        </tbody>
      </table>
      <button
        class="button primary"
        v-if="conflict"
        type="button"
        @click="useServer"
      >
        放弃草稿，使用服务器内容
      </button>
      <button
        class="button primary"
        v-if="conflict && !conflict.deletedAt"
        type="button"
        :disabled="busy"
        @click="reviewedSave"
      >
        核对后按当前版本保存
      </button>
      <button
        class="button primary"
        type="button"
        :disabled="busy"
        @click="copyEntry"
      >
        另存一份
      </button>
      <button
        type="button"
        class="button subtle"
        @click="
          conflict = null;
          missing = false;
        "
      >
        暂不处理
      </button>
    </section>
    <p v-if="draft" class="muted">
      原草稿仍保留；提交当前输入后，可在草稿列表核对并明确放弃原稿。
    </p>
    <form @submit.prevent="submit()" @focusout="flush">
      <label
        >标题（{{ [...title].length }} / 100 字）<input
          v-model="title"
          placeholder="例如：玩《文明 VI》、阅读《置身事内》"
          required
      /></label>
      <div class="form-grid">
        <label
          >开始日期<input
            v-model="startDate"
            type="date"
            required
            min="0001-01-01"
            max="9999-12-31" /></label
        ><label
          >结束日期（留空表示未结束）<input
            v-model="endDate"
            type="date"
            min="0001-01-01"
            max="9999-12-31"
        /></label>
      </div>
      <label
        >分类<select v-model="categoryId" required>
          <option
            v-for="category in categories"
            :key="category.id"
            :value="category.id"
          >
            {{ category.name }}
          </option>
        </select></label
      >
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <div v-if="acknowledgement" class="notice">
        <p>将取消以下日期的重点：</p>
        <ul>
          <li
            v-for="focus in acknowledgement.slice(0, acknowledgementLimit)"
            :key="focus.date"
          >
            {{ focus.date }}
          </li>
        </ul>
        <p>共 {{ acknowledgement.length }} 个重点日。</p>
        <button
          v-if="acknowledgement.length > acknowledgementLimit"
          type="button"
          class="button subtle"
          @click="acknowledgementLimit += 100"
        >
          显示更多受影响日期
        </button>
        <button
          class="button primary"
          type="button"
          :disabled="busy"
          @click="submit(true)"
        >
          确认移除这些重点并保存</button
        ><button
          type="button"
          class="button subtle"
          @click="acknowledgement = null"
        >
          取消确认
        </button>
      </div>
      <button class="button primary" type="submit" :disabled="busy">
        {{ busy ? '正在保存…' : '保存' }}</button
      ><button type="button" class="button subtle" @click="emit('close')">
        取消
      </button>
    </form>
  </section>
</template>
