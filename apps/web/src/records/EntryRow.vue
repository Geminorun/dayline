<script setup lang="ts">
import { spanLabel, entryStatus } from '@dayline/core';
import type { EntryDto } from '@dayline/contracts';
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
const emit = defineEmits<{ edit: []; finish: []; remove: []; focus: [] }>();
const statuses = { not_started: '未开始', ongoing: '进行中', ended: '已结束' };
</script>
<template>
  <li class="entry-row">
    <div>
      <h3>{{ entry.title }}</h3>
      <p>
        <span aria-hidden="true" :style="{ color: color ?? '#A0A4B3' }">●</span>
        {{ category }} · {{ entry.startDate }} →
        {{ entry.endDate ?? (entry.startDate > today ? '结束未定' : '至今') }} ·
        <template v-if="entryStatus(entry, today) !== 'not_started'"
          >{{ statuses[entryStatus(entry, today)] }} ·</template
        >
        {{ spanLabel(entry, today) }}
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
