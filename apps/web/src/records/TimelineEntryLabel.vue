<script setup lang="ts">
import { durationDays, entryStatus } from '@dayline/core';
import type { EntryDto } from '@dayline/contracts';
import { tr } from '../i18n';
import PlannerIcon from '../components/PlannerIcon.vue';

defineProps<{
  entry: EntryDto;
  today: string;
  color: string;
  focusTotal: number;
  compact?: boolean;
  highlighted?: boolean;
  readonly?: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{
  view: [entry: EntryDto];
  finish: [entry: EntryDto];
  highlight: [id: string];
}>();
</script>

<template>
  <div
    class="gantt-row-label timeline-list-entry"
    :class="{ 'is-highlighted': highlighted, 'is-compact': compact }"
    :data-entry-id="entry.id"
    :style="{ '--category-color': color }"
    @pointerenter="emit('highlight', entry.id)"
    @focusin="emit('highlight', entry.id)"
  >
    <div class="gantt-row-title">
      <i class="category-dot"></i>
      <button type="button" :title="entry.title" @click="emit('view', entry)">
        {{ entry.title }}
      </button>
      <button
        v-if="
          !readonly &&
          entry.startDate <= today &&
          entryStatus(entry, today) === 'ongoing'
        "
        type="button"
        class="gantt-finish icon-btn"
        :disabled="busy"
        :aria-label="tr('timelineView.end', { value0: entry.title })"
        :title="tr('common.endsToday')"
        @click="emit('finish', entry)"
      >
        <PlannerIcon name="check" />
      </button>
    </div>
    <div v-if="!compact" class="gantt-row-meta">
      <span class="event-status">{{
        entryStatus(entry, today) === 'ongoing'
          ? tr('common.ongoing')
          : tr('common.ended')
      }}</span>
      <span>{{ tr('data.days', { value0: durationDays(entry, today) }) }}</span>
      <span class="gantt-focus-total" :class="{ 'has-focus': focusTotal }">{{
        tr('timelineView.cumulativeFocusDays', { value0: focusTotal })
      }}</span>
    </div>
  </div>
</template>
