<script setup lang="ts">
import { durationDays, entryStatus } from '@dayline/core';
import type { EntryDto } from '@dayline/contracts';
import { computed } from 'vue';
import { tr } from '../i18n';
import PlannerIcon from '../components/PlannerIcon.vue';

const props = defineProps<{
  entry: EntryDto;
  today: string;
  color: string;
  focusTotal: number;
  compact?: boolean;
  highlighted?: boolean;
  readonly?: boolean;
  busy?: boolean;
}>();
const ongoing = computed(
  () => entryStatus(props.entry, props.today) === 'ongoing',
);
const duration = computed(() =>
  props.entry.startDate > props.today
    ? tr('common.toBeStarted')
    : tr(
        ongoing.value
          ? 'timelineView.elapsedDuration'
          : 'timelineView.endedDuration',
        {
          value0: durationDays(
            ongoing.value ? { ...props.entry, endDate: null } : props.entry,
            props.today,
          ),
        },
      ),
);
const description = computed(() =>
  [
    props.entry.title,
    `${props.entry.startDate} — ${props.entry.endDate ?? tr(props.entry.startDate > props.today ? 'common.endingPending' : 'common.present')}`,
    tr(ongoing.value ? 'common.ongoing' : 'common.ended'),
    duration.value,
    tr('timelineView.cumulativeFocusDays', { value0: props.focusTotal }),
  ].join('\n'),
);
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
      <i class="category-dot" aria-hidden="true"></i>
      <button type="button" :title="description" @click="emit('view', entry)">
        {{ entry.title }}
      </button>
      <button
        v-if="!readonly && entry.startDate <= today && ongoing"
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
    <div class="gantt-row-meta">
      <span class="event-status">{{
        ongoing ? tr('common.ongoing') : tr('common.ended')
      }}</span>
      <span class="timeline-entry-duration">{{ duration }}</span>
      <span v-if="focusTotal" class="gantt-focus-total has-focus">{{
        tr('timelineView.focusSummary', { value0: focusTotal })
      }}</span>
    </div>
  </div>
</template>
