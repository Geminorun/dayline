<script setup lang="ts">
import { entryStatus } from '@dayline/core';
import { spanLabel } from '../i18n';
import type { EntryDto } from '@dayline/contracts';
import IconButton from './IconButton.vue';
defineProps<{
  entry: EntryDto;
  category: string;
  color?: string;
  today: string;
  date: string;
  focused: boolean;
  busy: boolean;
  readonly: boolean;
}>();
defineEmits<{ view: []; edit: []; focus: []; finish: []; remove: [] }>();
</script>
<template>
  <view class="card entry-card" :style="{ borderLeftColor: color }"
    ><view class="entry-top"
      ><view class="entry-main" role="button" @click="$emit('view')"
        ><text class="entry-category"
          ><text :style="{ color }">● </text>{{ category }}</text
        ><text class="entry-title">{{ entry.title }}</text></view
      ><text class="entry-state">{{
        entryStatus(entry, today) === 'ended' ? '已结束' : '进行中'
      }}</text></view
    ><text class="entry-span"
      >{{ entry.startDate }} — {{ entry.endDate || '至今' }} ·
      {{ spanLabel(entry, today) }}</text
    ><view class="entry-actions"
      ><text v-if="focused" class="focus-label">当日重点</text
      ><view class="entry-tools"
        ><template v-if="!readonly"
          ><IconButton
            v-if="date"
            icon="star"
            :active="focused"
            :label="(focused ? '取消' : '标记') + ' ' + date + ' 重点'"
            :disabled="
              busy ||
              date > today ||
              date < entry.startDate ||
              (!!entry.endDate && date > entry.endDate)
            "
            @click="$emit('focus')" /><IconButton
            v-if="
              entryStatus(entry, today) === 'ongoing' &&
              entry.startDate <= today
            "
            icon="check"
            label="今天结束"
            :disabled="busy"
            @click="$emit('finish')" /><IconButton
            icon="edit"
            label="编辑事项"
            :disabled="busy"
            @click="$emit('edit')" /><IconButton
            icon="trash"
            label="移入回收站"
            :disabled="busy"
            @click="$emit('remove')" /></template></view></view
  ></view>
</template>
<style scoped>
.entry-card {
  padding: 22rpx 24rpx 8rpx;
  border-left: 3px solid;
  margin: 16rpx 0;
}
.entry-top {
  display: flex;
  justify-content: space-between;
  gap: 16rpx;
}
.entry-main {
  flex: 1;
  min-width: 0;
}
.entry-category {
  display: block;
  font-size: 22rpx;
  color: var(--muted);
}
.entry-title {
  display: block;
  font-size: 30rpx;
  font-weight: 600;
  line-height: 1.5;
  margin-top: 6rpx;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.entry-state {
  font-size: 22rpx;
  color: var(--muted);
  white-space: nowrap;
  padding-top: 6rpx;
}
.entry-span {
  display: block;
  font-size: 22rpx;
  color: var(--muted);
  margin-top: 12rpx;
}
.entry-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 44px;
}
.entry-tools {
  display: flex;
  margin-left: auto;
}
.focus-label {
  color: var(--warning);
  font-size: 22rpx;
}
</style>
