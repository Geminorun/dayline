<script setup lang="ts">
import { computed } from 'vue';
import {
  spanLabel,
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
const statuses = { not_started: '未开始', ongoing: '进行中', ended: '已结束' };
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
      ><span class="rail-day">第{{ dayNumber }}天</span>
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
            :aria-label="`${date} ${entry.title} ${focused ? '取消' : '设为'}当天重点`"
            @click="emit('focus')"
          >
            <PlannerIcon name="star" /><span>{{
              focused ? '当天重点' : '设为重点'
            }}</span>
          </button>
          <span class="event-status" :class="{ live: status === 'ongoing' }">{{
            statuses[status]
          }}</span>
        </div>
      </div>
      <h3 class="event-title">{{ entry.title }}</h3>
      <div class="record-range">
        <PlannerIcon name="calendar" /><span>{{
          entry.startDate.replaceAll('-', '.')
        }}</span
        ><span class="range-dash">—</span
        ><span :class="{ 'ongoing-date': !entry.endDate }">{{
          entry.endDate?.replaceAll('-', '.') ??
          (entry.startDate > today ? '结束未定' : '至今')
        }}</span
        ><span class="duration-pill"
          >{{ entry.endDate ? '共' : '已持续' }}
          {{ durationDays(entry, today) }} 天</span
        >
      </div>
      <div class="record-actions">
        <div class="record-notes">
          <span class="focus-total" :class="{ empty: !focusCount }"
            ><PlannerIcon name="star" />重点{{ focusCount ?? 0 }}天</span
          ><span class="record-note">{{
            entry.endDate
              ? '含开始和结束当天'
              : entry.startDate > today
                ? '将在开始日期后持续记录'
                : '每天自动延续，直到结束'
          }}</span
          ><span class="sr-only">{{ spanLabel(entry, today) }}</span>
        </div>
        <div v-if="!readonly" class="event-actions">
          <button
            v-if="status === 'ongoing'"
            class="finish-event"
            :disabled="busy"
            @click="emit('finish')"
          >
            <PlannerIcon name="check" />结束</button
          ><button
            class="icon-btn"
            :disabled="busy"
            :aria-label="`编辑${entry.title}`"
            title="编辑"
            @click="emit('edit')"
          >
            <PlannerIcon name="edit" /><span class="sr-only">编辑</span></button
          ><button
            class="icon-btn"
            :disabled="busy"
            :aria-label="`删除${entry.title}`"
            title="移入回收站"
            @click="emit('remove')"
          >
            <PlannerIcon name="trash" /><span class="sr-only">移入回收站</span>
          </button>
        </div>
      </div>
    </div>
  </li>
</template>
