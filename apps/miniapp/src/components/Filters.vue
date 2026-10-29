<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { CategoryDto } from '@dayline/contracts';
import { emptyFilter } from '@dayline/core';
import type { EntryFilter } from '@dayline/core';
import IconButton from './IconButton.vue';
const props = defineProps<{
  modelValue: EntryFilter;
  categories: CategoryDto[];
  focusOnly?: boolean;
  focusCount?: number;
  showFocus?: boolean;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: EntryFilter];
  'update:focusOnly': [value: boolean];
}>();
const draft = ref(props.modelValue.search),
  composing = ref(false);
const statuses = [
  { id: 'all', label: '全部' },
  { id: 'ongoing', label: '进行中' },
  { id: 'ended', label: '已结束' },
] as const;
let timer: ReturnType<typeof setTimeout> | undefined;
function update(patch: Partial<EntryFilter>) {
  emit('update:modelValue', { ...props.modelValue, ...patch });
}
watch(
  () => props.modelValue.search,
  (value) => {
    if (value !== draft.value) draft.value = value;
  },
);
function input(event: unknown) {
  if (!event || typeof event !== 'object') return;
  const detail = 'detail' in event ? event.detail : null,
    target = 'target' in event ? event.target : null;
  const value =
    detail && typeof detail === 'object' && 'value' in detail
      ? detail.value
      : target && typeof target === 'object' && 'value' in target
        ? target.value
        : '';
  draft.value = typeof value === 'string' ? value : '';
  clearTimeout(timer);
  if (!composing.value && !('isComposing' in event && event.isComposing))
    timer = setTimeout(() => update({ search: draft.value }), 160);
}
function compositionStart() {
  composing.value = true;
  clearTimeout(timer);
}
function commit(event?: unknown) {
  if (event && typeof event === 'object') {
    const detail = 'detail' in event ? event.detail : null,
      target = 'target' in event ? event.target : null;
    const value =
      detail && typeof detail === 'object' && 'value' in detail
        ? detail.value
        : target && typeof target === 'object' && 'value' in target
          ? target.value
          : undefined;
    if (typeof value === 'string') draft.value = value;
  }
  composing.value = false;
  clearTimeout(timer);
  update({ search: draft.value });
}
function manage() {
  uni.navigateTo({ url: '/pages/categories/index' });
}
function clear() {
  clearTimeout(timer);
  draft.value = '';
  emit('update:modelValue', emptyFilter());
  emit('update:focusOnly', false);
}
const active = computed(
  () =>
    props.modelValue.search ||
    props.modelValue.categoryId ||
    props.modelValue.status !== 'ongoing' ||
    props.focusOnly,
);
onBeforeUnmount(() => clearTimeout(timer));
</script>
<template>
  <view class="filters"
    ><view class="search-row"
      ><input
        class="search-input"
        :value="draft"
        placeholder="搜索事项"
        aria-label="搜索事项标题"
        confirm-type="search"
        @input="input"
        @compositionstart="compositionStart"
        @compositionend="commit"
        @confirm="commit" /><IconButton
        icon="sliders"
        label="管理分类"
        @click="manage" /></view
    ><scroll-view scroll-x class="category-strip"
      ><view class="category-pills"
        ><button
          class="pill"
          :class="{ selected: !modelValue.categoryId }"
          @click="update({ categoryId: '' })"
        >
          全部分类</button
        ><button
          v-for="c in categories"
          :key="c.id"
          class="pill"
          :class="{ selected: modelValue.categoryId === c.id }"
          @click="update({ categoryId: c.id })"
        >
          <text :style="{ color: c.color }">●</text>{{ c.name }}
        </button></view
      ></scroll-view
    ><view class="filter-bottom"
      ><view class="status-tabs"
        ><button
          v-for="s in statuses"
          :key="s.id"
          :class="{ active: modelValue.status === s.id }"
          :aria-pressed="modelValue.status === s.id"
          @click="update({ status: s.id })"
        >
          {{ s.label }}
        </button></view
      ><view class="filter-tools"
        ><IconButton
          v-if="showFocus"
          icon="star"
          :label="focusOnly ? '显示全部事项' : '只看重点事项'"
          :active="focusOnly"
          @click="$emit('update:focusOnly', !focusOnly)" /><IconButton
          icon="arrow"
          :label="
            modelValue.sort === 'asc'
              ? '开始日期升序，点击切换'
              : '开始日期降序，点击切换'
          "
          @click="
            update({ sort: modelValue.sort === 'asc' ? 'desc' : 'asc' })
          " /><IconButton
          v-if="active"
          icon="close"
          label="清除筛选"
          @click="clear" /></view></view
  ></view>
</template>
<style scoped>
.filters {
  margin: 20rpx 0;
}
.search-row {
  display: flex;
  align-items: center;
  gap: 12rpx;
}
.search-input {
  flex: 1;
  background: var(--surface);
}
.category-strip {
  white-space: nowrap;
  width: 100%;
}
.category-pills {
  display: inline-flex;
  gap: 12rpx;
  padding: 8rpx 0;
}
.pill {
  display: inline-flex;
  flex-shrink: 0;
  gap: 8rpx;
  background: var(--surface);
  color: var(--muted);
  border: 1px solid var(--line);
  font-size: 24rpx;
  min-height: 38px;
  margin: 0;
  padding: 12rpx 20rpx;
  border-radius: 12rpx;
}
.pill.selected {
  background: var(--accent-soft);
  border-color: var(--accent-soft);
  color: var(--accent-ink);
}
.filter-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8rpx;
}
.status-tabs {
  display: flex;
  gap: 20rpx;
}
.status-tabs button {
  font-size: 24rpx;
  background: transparent;
  color: var(--muted);
  margin: 0;
  padding: 14rpx 0;
  border-radius: 0;
  border-bottom: 2px solid transparent;
}
.status-tabs button.active {
  color: var(--accent-ink);
  border-bottom-color: var(--accent-ink);
}
.filter-tools {
  display: flex;
}
</style>
