<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type {
  CategoryDto,
  EntryDto,
  CreateEntryInput,
  PatchEntryInput,
} from '@dayline/contracts';
import {
  createEntrySchema,
  focusRemovalDetailsSchema,
} from '@dayline/contracts';
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import { ClientError } from '@dayline/api-client';
import { GuestError } from '@dayline/contracts';
import { errorMessage } from './record-service';
const props = defineProps<{
  entry: EntryDto | null;
  categories: CategoryDto[];
  today: string;
  local?: boolean;
  save: (
    id: string,
    input: CreateEntryInput | PatchEntryInput,
    creating: boolean,
  ) => Promise<void>;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
// Stable for this editor's lifetime, including failed requests and lost responses.
const id = props.entry?.id ?? crypto.randomUUID();
const baseVersion = props.entry?.version;
const title = ref(props.entry?.title ?? '');
const startDate = ref(props.entry?.startDate ?? props.today);
const endDate = ref(props.entry?.endDate ?? '');
const categoryId = ref(
  props.entry?.categoryId ?? props.categories[0]?.id ?? '',
);
const error = ref('');
const original = {
  title: title.value,
  startDate: startDate.value,
  endDate: endDate.value,
  categoryId: categoryId.value,
};
const saved = ref(false);
const dirty = computed(
  () =>
    !saved.value &&
    (title.value !== original.title ||
      startDate.value !== original.startDate ||
      endDate.value !== original.endDate ||
      categoryId.value !== original.categoryId),
);
onBeforeRouteUpdate(
  (to, from) =>
    to.path === from.path ||
    !dirty.value ||
    window.confirm('当前输入尚未保存，确定放弃并离开？'),
);
onBeforeRouteLeave(
  () => !dirty.value || window.confirm('当前输入尚未保存，确定放弃并离开？'),
);
function leaving(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
window.addEventListener('beforeunload', leaving);
onBeforeUnmount(() => window.removeEventListener('beforeunload', leaving));
const busy = ref(false);
const acknowledgementLimit = ref(100);
const acknowledgement = ref<{ date: string; version: number }[] | null>(null);
watch([title, startDate, endDate, categoryId], () => {
  acknowledgement.value = null;
});
async function submit(confirmRemoval = false) {
  if (busy.value) return;
  error.value = '';
  const parsed = createEntrySchema.safeParse({
    id,
    title: title.value,
    startDate: startDate.value,
    endDate: endDate.value || null,
    categoryId: categoryId.value,
  });
  if (!parsed.success) {
    error.value = '请检查标题（1–100 字）、有效日期和分类。';
    return;
  }
  if (
    parsed.data.endDate !== null &&
    parsed.data.endDate < parsed.data.startDate
  ) {
    error.value = '结束日期不能早于开始日期。';
    return;
  }
  busy.value = true;
  try {
    if (baseVersion === undefined) await props.save(id, parsed.data, true);
    else
      await props.save(
        id,
        {
          expectedVersion: baseVersion,
          title: parsed.data.title,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate,
          categoryId: parsed.data.categoryId,
          ...(confirmRemoval && acknowledgement.value
            ? { focusRemovalAcknowledgement: acknowledgement.value }
            : {}),
        },
        false,
      );
    saved.value = true;
    emit('saved');
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
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="record-panel" aria-labelledby="editor-title">
    <h2 id="editor-title">{{ entry ? '编辑事项' : '新建事项' }}</h2>
    <p>
      {{
        local
          ? '游客记录仅在本机保存；存储成功后才会显示在正式列表。'
          : '点击保存后发送到服务器。离开本页前请保存；当前输入尚未持久化。'
      }}
    </p>
    <form @submit.prevent="submit()">
      <label
        >标题（{{ [...title].length }} / 100 字）<input
          v-model="title"
          required
          :disabled="busy"
      /></label>
      <div class="form-grid">
        <label
          >开始日期<input
            v-model="startDate"
            type="date"
            required
            min="0001-01-01"
            max="9999-12-31"
            :disabled="busy" /></label
        ><label
          >结束日期（留空表示未结束）<input
            v-model="endDate"
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            :disabled="busy"
        /></label>
      </div>
      <label
        >分类<select v-model="categoryId" :disabled="busy" required>
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
          class="secondary"
          @click="acknowledgementLimit += 100"
        >
          显示更多受影响日期
        </button>
        <button type="button" :disabled="busy" @click="submit(true)">
          确认移除这些重点并保存</button
        ><button
          type="button"
          class="secondary"
          :disabled="busy"
          @click="acknowledgement = null"
        >
          取消确认
        </button>
      </div>
      <button type="submit" :disabled="busy">
        {{ busy ? '正在保存…' : local ? '保存到本机' : '保存到服务器' }}</button
      ><button
        type="button"
        class="secondary"
        :disabled="busy"
        @click="emit('close')"
      >
        关闭编辑
      </button>
    </form>
  </section>
</template>
