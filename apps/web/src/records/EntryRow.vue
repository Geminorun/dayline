<script setup lang="ts">
import { durationDays, entryStatus } from '@dayline/core';
import type { EntryDto } from '@dayline/contracts';
defineProps<{
  entry: EntryDto;
  category: string;
  today: string;
  date: string;
  focused: boolean;
  busy: boolean;
  readonly: boolean;
}>();
const emit = defineEmits<{ edit: []; finish: []; remove: []; focus: [] }>();
const statuses = { not_started: '未开始', ongoing: '进行中', ended: '已结束' };
</script>
<template>
  <li class="entry-row">
    <div>
      <h3>{{ entry.title }}</h3>
      <p>
        {{ category }} · {{ entry.startDate }} → {{ entry.endDate ?? '至今' }} ·
        {{ statuses[entryStatus(entry, today)] }} ·
        {{ durationDays(entry, today) }} 天
      </p>
    </div>
    <div v-if="!readonly" class="row-actions">
      <button
        class="secondary"
        :disabled="
          busy ||
          date > today ||
          date < entry.startDate ||
          (!!entry.endDate && date > entry.endDate)
        "
        :aria-pressed="focused"
        @click="emit('focus')"
      >
        {{ focused ? '取消' : '设为' }} {{ date }} 重点</button
      ><button class="secondary" :disabled="busy" @click="emit('edit')">
        编辑</button
      ><button
        v-if="entryStatus(entry, today) === 'ongoing'"
        class="secondary"
        :disabled="busy"
        @click="emit('finish')"
      >
        今天结束</button
      ><button class="secondary" :disabled="busy" @click="emit('remove')">
        移入回收站
      </button>
    </div>
  </li>
</template>
