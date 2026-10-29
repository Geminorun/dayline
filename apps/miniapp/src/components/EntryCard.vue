<script setup lang="ts">
import { spanLabel, tr } from '../i18n/index';

import { entryStatus } from '@dayline/core';
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
const statuses = {
  get ongoing() {
    return tr('common.ongoing');
  },
  get ended() {
    return tr('common.ended');
  },
};
</script>
<template>
  <view class="card entry-card"
    ><text class="heading">{{ entry.title }}</text
    ><text class="text muted"
      ><text :style="{ color: color ?? '#A0A4B3' }">● </text>{{ category
      }}<text> · {{ statuses[entryStatus(entry, today)] }}</text></text
    ><text class="text"
      >{{ entry.startDate }} →
      {{
        entry.endDate ??
        (entry.startDate > today
          ? tr('common.endingPending')
          : tr('common.present'))
      }}
      · {{ spanLabel(entry, today) }}</text
    ><view class="actions"
      ><button class="secondary" :disabled="busy" @click="emit('edit')">
        {{ tr('common.detailsEdit') }}</button
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
          {{
            tr('entryCard.highlights', {
              value0: focused ? tr('common.cancel') : tr('common.mark'),
              value1: date,
            })
          }}</button
        ><button
          v-if="
            entry.startDate <= today && entryStatus(entry, today) === 'ongoing'
          "
          class="secondary"
          :disabled="busy"
          @click="emit('finish')"
        >
          {{ tr('common.endToday') }}</button
        ><button class="secondary" :disabled="busy" @click="emit('remove')">
          {{ tr('common.moveIntoTrash') }}
        </button></template
      ></view
    ></view
  >
</template>
