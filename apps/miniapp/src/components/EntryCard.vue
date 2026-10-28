<script setup lang="ts">
import { entryStatus, spanLabel } from '@dayline/core';
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
const emit = defineEmits<{ edit: []; focus: []; finish: []; remove: [] }>();
const statuses = { ongoing: '进行中', ended: '已结束' };
</script>
<template>
  <view class="card entry-card"
    ><text class="heading">{{ entry.title }}</text
    ><text class="text muted"
      ><text :style="{ color: color ?? '#A0A4B3' }">● </text>{{ category
      }}<text> · {{ statuses[entryStatus(entry, today)] }}</text></text
    ><text class="text"
      >{{ entry.startDate }} →
      {{ entry.endDate ?? (entry.startDate > today ? '结束未定' : '至今') }} ·
      {{ spanLabel(entry, today) }}</text
    ><view class="actions"
      ><button class="secondary" :disabled="busy" @click="emit('edit')">
        详情 / 编辑</button
      ><template v-if="!readonly"
        ><button
          v-if="date"
          class="secondary"
          :disabled="
            busy ||
            date > today ||
            date < entry.startDate ||
            (!!entry.endDate && date > entry.endDate)
          "
          @click="emit('focus')"
        >
          {{ focused ? '取消' : '标记' }} {{ date }} 重点</button
        ><button
          v-if="
            entry.startDate <= today && entryStatus(entry, today) === 'ongoing'
          "
          class="secondary"
          :disabled="busy"
          @click="emit('finish')"
        >
          今天结束</button
        ><button class="secondary" :disabled="busy" @click="emit('remove')">
          移入回收站
        </button></template
      ></view
    ></view
  >
</template>
