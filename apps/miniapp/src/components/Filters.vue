<script setup lang="ts">
import { tr } from '../i18n/index';
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
const statuses = computed(() => [
    tr('common.all'),
    tr('common.ongoing'),
    tr('common.ended'),
  ]),
  statusValues = ['all', 'ongoing', 'ended'] as const;
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
      :placeholder="tr('common.searchEntryTitle')"
      :aria-label="tr('common.searchTitle')"
    /><view class="actions"
      ><picker
        :range="[tr('common.allCategories'), ...categories.map((c) => c.name)]"
        @change="category"
        ><view class="picker"
          >{{
            categories.find((c) => c.id === modelValue.categoryId)?.name ??
            tr('common.allCategories')
          }}
          ▾</view
        ></picker
      ><picker
        :range="statuses"
        :value="statusValues.indexOf(modelValue.status)"
        @change="status"
        ><view class="picker"
          >{{ statuses[statusValues.indexOf(modelValue.status)] }} ▾</view
        ></picker
      ><button
        class="secondary"
        @click="update({ sort: modelValue.sort === 'asc' ? 'desc' : 'asc' })"
      >
        {{
          modelValue.sort === 'asc'
            ? tr('common.startDateAscending')
            : tr('common.startDateDescending')
        }}</button
      ><button
        class="secondary"
        @click="emit('update:modelValue', emptyFilter())"
      >
        {{ tr('common.clearFilters') }}
      </button></view
    ></view
  >
</template>
