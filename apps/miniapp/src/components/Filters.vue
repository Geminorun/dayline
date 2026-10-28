<script setup lang="ts">
import { computed } from 'vue';
import type { CategoryDto } from '@dayline/contracts';
import { emptyFilter } from '@dayline/core';
import type { EntryFilter } from '@dayline/core';
const props = defineProps<{
  modelValue: EntryFilter;
  categories: CategoryDto[];
}>();
const emit = defineEmits<{ 'update:modelValue': [value: EntryFilter] }>();
const search = computed({
  get: () => props.modelValue.search,
  set: (value: string) => update({ search: value }),
});
const statuses = ['进行中', '已结束'],
  statusValues = ['ongoing', 'ended'] as const;
function update(patch: Partial<EntryFilter>) {
  emit('update:modelValue', { ...props.modelValue, ...patch });
}
function category(event: { detail: { value: unknown } }) {
  const index = Number(event.detail.value);
  update({ categoryId: index ? (props.categories[index - 1]?.id ?? '') : '' });
}
function status(event: { detail: { value: unknown } }) {
  update({ status: statusValues[Number(event.detail.value)] ?? 'ongoing' });
}
</script>
<template>
  <view class="card filters"
    ><input
      v-model="search"
      placeholder="搜索事项标题"
      aria-label="搜索标题"
    /><view class="actions"
      ><picker
        :range="['全部分类', ...categories.map((c) => c.name)]"
        @change="category"
        ><view class="picker"
          >{{
            categories.find((c) => c.id === modelValue.categoryId)?.name ??
            '全部分类'
          }}
          ▾</view
        ></picker
      ><picker
        :range="statuses"
        :value="modelValue.status === 'ended' ? 1 : 0"
        @change="status"
        ><view class="picker"
          >{{ statuses[modelValue.status === 'ended' ? 1 : 0] }} ▾</view
        ></picker
      ><button
        class="secondary"
        @click="update({ sort: modelValue.sort === 'asc' ? 'desc' : 'asc' })"
      >
        {{
          modelValue.sort === 'asc' ? '开始日期升序' : '开始日期降序'
        }}</button
      ><button
        class="secondary"
        @click="emit('update:modelValue', emptyFilter())"
      >
        清除筛选
      </button></view
    ></view
  >
</template>
