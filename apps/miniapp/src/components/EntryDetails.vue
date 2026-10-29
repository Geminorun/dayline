<script setup lang="ts">
import { computed, ref } from 'vue';
import { durationDays, entryStatus } from '@dayline/core';
import type { EntryDto, CategoryDto, FocusDayDto } from '@dayline/contracts';
import BottomSheet from './BottomSheet.vue';
import IconButton from './IconButton.vue';
const props = defineProps<{
  entry: EntryDto;
  categories: CategoryDto[];
  focusDays: FocusDayDto[];
  today: string;
  readonly?: boolean;
}>();
defineEmits<{ close: []; edit: []; day: [date: string] }>();
const showDates = ref(false),
  limit = ref(50);
const dates = computed(() =>
  props.focusDays
    .filter(
      (f) =>
        f.entryId === props.entry.id &&
        f.focused &&
        f.date <= props.today &&
        f.date >= props.entry.startDate &&
        (!props.entry.endDate || f.date <= props.entry.endDate),
    )
    .map((f) => f.date)
    .sort()
    .reverse(),
);
const category = computed(() =>
  props.categories.find((c) => c.id === props.entry.categoryId),
);
</script>
<template>
  <BottomSheet title="事项详情" @close="$emit('close')"
    ><view class="detail-heading"
      ><view class="detail-title"
        ><text class="muted"
          ><text :style="{ color: category?.color }">● </text
          >{{ category?.name }}</text
        ><text class="title">{{ entry.title }}</text
        ><text class="muted">{{
          entryStatus(entry, today) === 'ended' ? '已结束' : '进行中'
        }}</text></view
      ><IconButton
        v-if="!readonly"
        icon="edit"
        label="编辑事项"
        @click="$emit('edit')" /></view
    ><view class="sheet-details"
      ><view
        ><text class="muted">开始日期</text
        ><text>{{ entry.startDate }}</text></view
      ><view
        ><text class="muted">结束日期</text
        ><text>{{ entry.endDate || '至今' }}</text></view
      ><view
        ><text class="muted">{{
          entry.startDate > today
            ? '开始时间'
            : entry.endDate
              ? '跨度'
              : '已持续'
        }}</text
        ><text>{{
          entry.startDate > today
            ? entry.startDate
            : durationDays(entry, today) + ' 天'
        }}</text></view
      ><view
        ><text class="muted">重点日期</text
        ><text>{{ dates.length }} 天</text></view
      ></view
    ><button
      v-if="dates.length"
      class="text-button"
      @click="showDates = !showDates"
    >
      {{ showDates ? '收起重点日期' : '查看重点日期' }}</button
    ><view v-if="showDates" class="focus-date-list"
      ><button
        v-for="date in dates.slice(0, limit)"
        :key="date"
        class="date-chip"
        @click="$emit('day', date)"
      >
        {{ date }}</button
      ><button
        v-if="dates.length > limit"
        class="text-button"
        @click="limit += 50"
      >
        显示更多
      </button></view
    ></BottomSheet
  >
</template>
<style scoped>
.detail-heading {
  display: flex;
  justify-content: space-between;
  gap: 20rpx;
}
.detail-title {
  min-width: 0;
}
.detail-title .title {
  font-size: 36rpx;
  margin-top: 12rpx;
}
.focus-date-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10rpx;
}
.date-chip {
  background: var(--surface-subtle);
  color: var(--ink);
  font-size: 24rpx;
  margin: 0;
  padding: 14rpx 18rpx;
}
</style>
