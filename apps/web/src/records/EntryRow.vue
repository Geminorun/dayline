<script setup lang="ts">
import { spanLabel, tr } from '../i18n/index';

import { computed } from 'vue';
import {
  entryStatus,
  durationDays,
  dateOrdinal,
  isCalendarDate,
} from '@dayline/core';
import type { EntryDto } from '@dayline/contracts';
import PlannerIcon from '../components/PlannerIcon.vue';
const props = defineProps<{
  entry: EntryDto;
  category: string;
  color?: string;
  today: string;
  date: string;
  focused: boolean;
  focusCount?: number;
  busy: boolean;
  readonly: boolean;
}>();
const emit = defineEmits<{ edit: []; finish: []; remove: []; focus: [] }>();
const statuses = {
  get ongoing() {
    return tr('common.ongoing');
  },
  get ended() {
    return tr('common.ended');
  },
};
const status = computed(() => entryStatus(props.entry, props.today));
const dayNumber = computed(() =>
  isCalendarDate(props.date)
    ? Math.max(
        0,
        dateOrdinal(props.date) - dateOrdinal(props.entry.startDate) + 1,
      )
    : 0,
);
</script>
<template>
  <li
    class="entry-row timeline-item date-record"
    :class="{ 'is-daily-focus': focused }"
    :style="{ '--category-color': color ?? '#A0A4B3' }"
  >
    <div class="time-rail">
      {{ entry.startDate.slice(5).replace('-', '.')
      }}<small>{{ entry.startDate.slice(0, 4) }}</small
      ><span class="rail-day">{{
        tr('entryRow.day', { value0: dayNumber })
      }}</span>
    </div>
    <div class="event-card">
      <div class="event-top">
        <span class="category-badge"
          ><i class="category-dot"></i>{{ category }}</span
        >
        <div class="event-top-right">
          <button
            v-if="!readonly"
            class="focus-toggle"
            :class="{ selected: focused }"
            :disabled="
              busy ||
              date > today ||
              date < entry.startDate ||
              (!!entry.endDate && date > entry.endDate)
            "
            :aria-pressed="focused"
            :title="
              tr('entryRow.cumulativeFocusDays', {
                value0: focused
                  ? tr('common.cancelTheHighlightOfTheDay')
                  : tr('common.setAsTheHighlightOfTheDay'),
                value1: focusCount ?? 0,
              })
            "
            :aria-label="
              tr('entryRow.highlightsOfTheDay', {
                value0: date,
                value1: entry.title,
                value2: focused ? tr('common.cancel') : tr('common.setTo'),
              })
            "
            @click="emit('focus')"
          >
            <PlannerIcon name="star" />
          </button>
          <span class="event-status" :class="{ live: status === 'ongoing' }">{{
            statuses[status]
          }}</span>
        </div>
      </div>
      <h3 class="event-title">{{ entry.title }}</h3>
      <div class="record-actions">
        <div class="record-range">
          <PlannerIcon name="calendar" /><span>{{
            entry.startDate.replaceAll('-', '.')
          }}</span
          ><span class="range-dash">—</span
          ><span :class="{ 'ongoing-date': !entry.endDate }">{{
            entry.endDate?.replaceAll('-', '.') ??
            (entry.startDate > today
              ? tr('common.endingPending')
              : tr('common.present'))
          }}</span
          ><span class="duration-pill">{{
            tr('entryRow.days', {
              value0: entry.endDate
                ? tr('common.total')
                : tr('common.duration2'),
              value1: durationDays(entry, today),
            })
          }}</span>
        </div>

        <span class="sr-only">{{ spanLabel(entry, today) }}</span>
        <div v-if="!readonly" class="event-actions">
          <button
            v-if="status === 'ongoing' && entry.startDate <= today"
            class="finish-event"
            :disabled="busy"
            @click="emit('finish')"
          >
            <PlannerIcon name="check" />{{ tr('common.end') }}</button
          ><button
            class="icon-btn"
            :disabled="busy"
            :aria-label="tr('entryRow.edit', { value0: entry.title })"
            :title="tr('common.edit')"
            @click="emit('edit')"
          >
            <PlannerIcon name="edit" /><span class="sr-only">{{
              tr('common.edit')
            }}</span></button
          ><button
            class="icon-btn"
            :disabled="busy"
            :aria-label="tr('entryRow.delete', { value0: entry.title })"
            :title="tr('common.moveIntoTrash')"
            @click="emit('remove')"
          >
            <PlannerIcon name="trash" /><span class="sr-only">{{
              tr('common.moveIntoTrash')
            }}</span>
          </button>
        </div>
      </div>
    </div>
  </li>
</template>
