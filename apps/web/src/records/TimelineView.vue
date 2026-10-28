<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import {
  timelineBar,
  timelineFocusGroups,
  timelineWindow,
  visibleRows,
  durationDays,
  entryStatus,
  ordinalDate,
  dateOrdinal,
} from '@dayline/core';
import { recordView } from './view-state';
import PlannerIcon from '../components/PlannerIcon.vue';
import type { TimelineScale } from '@dayline/core';
import type { CategoryDto, EntryDto, FocusDayDto } from '@dayline/contracts';
const props = defineProps<{
  categories?: CategoryDto[];
  entries: EntryDto[];
  focusDays: FocusDayDto[];
  today: string;
  scale: TimelineScale;
  anchor: string;
  sort?: 'asc' | 'desc';
  readonly?: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{
  edit: [entry: EntryDto];
  finish: [entry: EntryDto];
  day: [date: string];
}>();
const detailOffset = ref(0);
const viewport = ref<HTMLElement | null>(null),
  scrollTop = ref(0),
  details = ref<{ entryId: string; dates: string[] } | null>(null);
const window = computed(() =>
  timelineWindow(props.entries, props.today, props.scale, props.anchor, 900),
);
const axisGroups = computed(() => {
  const yearOnly = window.value.endExclusive - window.value.start > 730;
  const groups: { key: string; label: string; left: number; width: number }[] =
    [];
  for (const tick of window.value.ticks) {
    const date = ordinalDate(tick.day);
    const key = date.slice(0, yearOnly ? 4 : 7);
    if (groups.at(-1)?.key === key) continue;
    const previous = groups.at(-1);
    if (previous) previous.width = tick.x - previous.left;
    groups.push({
      key,
      label: yearOnly
        ? `${Number(key)}年`
        : `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月`,
      left: tick.x,
      width: window.value.width - tick.x,
    });
  }
  return groups;
});
const rows = computed(() =>
  visibleRows(props.entries.length, scrollTop.value, 480, 78),
);
const visible = computed(() =>
  props.entries.slice(rows.value.start, rows.value.end),
);
const groups = computed(() =>
  timelineFocusGroups(
    props.entries,
    props.focusDays,
    props.today,
    window.value,
  ),
);
function color(entry: EntryDto) {
  return (
    props.categories?.find((c) => c.id === entry.categoryId)?.color ?? '#315C4D'
  );
}
function bar(entry: EntryDto) {
  return timelineBar(entry, props.today, window.value);
}
function scroll(event: Event) {
  if (event.target instanceof HTMLElement)
    scrollTop.value = event.target.scrollTop;
}
function locateToday() {
  const el = viewport.value;
  if (el && window.value.todayX !== null)
    el.scrollLeft = Math.max(0, window.value.todayX - 250);
}
watch(
  () => [props.scale, props.anchor],
  async () => {
    scrollTop.value = 0;
    await nextTick();
    if (viewport.value) {
      viewport.value.scrollTop = 0;
      viewport.value.scrollLeft = 0;
    }
  },
);
watch(
  () => props.entries.length,
  async (count) => {
    const top = Math.max(0, Math.min(scrollTop.value, count * 78 - 480));
    scrollTop.value = top;
    await nextTick();
    if (viewport.value) viewport.value.scrollTop = top;
  },
);
onMounted(() => {
  if (viewport.value) {
    viewport.value.scrollTop = recordView.timelineTop;
    viewport.value.scrollLeft = recordView.timelineLeft;
    scrollTop.value = recordView.timelineTop;
  }
});
onBeforeUnmount(() => {
  recordView.timelineTop = viewport.value?.scrollTop ?? 0;
  recordView.timelineLeft = viewport.value?.scrollLeft ?? 0;
});
defineExpose({ locateToday });
</script>
<template>
  <div
    ref="viewport"
    class="timeline-viewport gantt-scroll"
    tabindex="0"
    aria-label="横向时间轴，可使用滚动条浏览日期"
    @scroll="scroll"
  >
    <div
      class="timeline-content"
      :style="{
        width: `calc(${window.width}px + var(--timeline-label-width, 240px))`,
      }"
    >
      <div class="timeline-header">
        <span class="timeline-name gantt-heading-label"
          ><strong
            >事项 <span>{{ entries.length }}</span></strong
          ><small
            >按开始日期{{ sort === 'asc' ? '从早到晚' : '从晚到早' }}</small
          ></span
        >
        <div class="timeline-axis" :style="{ width: window.width + 'px' }">
          <span
            v-for="group in axisGroups"
            :key="group.key"
            class="gantt-month"
            :style="{ left: group.left + 'px', width: group.width + 'px' }"
            >{{ group.label }}</span
          >
          <div class="gantt-ticks">
            <span
              v-for="(tick, index) in window.ticks"
              :key="tick.day"
              class="timeline-tick gantt-tick"
              :class="{
                today: tick.day === dateOrdinal(today),
                weekend: window.focusUnit === 'day' && (tick.day - 1) % 7 >= 5,
              }"
              :style="{
                left: tick.x + 'px',
                width:
                  (window.ticks[index + 1]?.x ?? window.width) - tick.x + 'px',
              }"
              ><b>{{
                window.focusUnit === 'day'
                  ? Number(ordinalDate(tick.day).slice(8))
                  : tick.label
              }}</b
              ><small v-if="window.focusUnit === 'day'">{{
                ['一', '二', '三', '四', '五', '六', '日'][(tick.day - 1) % 7]
              }}</small></span
            >
          </div>
        </div>
      </div>
      <div :style="{ height: rows.before + 'px' }"></div>
      <div v-for="entry in visible" :key="entry.id" class="timeline-row">
        <div
          class="timeline-name gantt-row-label"
          :style="{ '--category-color': color(entry) }"
        >
          <div class="gantt-row-title">
            <i class="category-dot"></i
            ><button :title="entry.title" @click="emit('edit', entry)">
              {{ entry.title }}</button
            ><button
              v-if="
                !readonly &&
                entry.startDate <= today &&
                entryStatus(entry, today) === 'ongoing'
              "
              class="gantt-finish icon-btn"
              :disabled="busy"
              :aria-label="`结束${entry.title}`"
              title="结束于今天"
              @click="emit('finish', entry)"
            >
              <PlannerIcon name="check" />
            </button>
          </div>
          <div class="gantt-row-meta">
            <span>{{
              categories?.find((category) => category.id === entry.categoryId)
                ?.name
            }}</span
            ><span
              class="event-status"
              :class="{ live: entryStatus(entry, today) === 'ongoing' }"
              >{{
                { ongoing: '进行中', ended: '已结束' }[
                  entryStatus(entry, today)
                ]
              }}</span
            ><span>{{ durationDays(entry, today) }}天</span
            ><span
              >★{{
                focusDays.filter(
                  (focus) => focus.entryId === entry.id && focus.focused,
                ).length
              }}天</span
            >
          </div>
        </div>
        <div
          class="timeline-track gantt-row-plot"
          :style="{ width: window.width + 'px' }"
        >
          <span
            v-if="window.todayX !== null"
            class="today-line"
            :style="{ left: window.todayX + 'px' }"
            aria-label="今天"
          ></span>
          <button
            v-if="bar(entry)"
            class="timeline-bar gantt-bar"
            :class="{
              future: entry.startDate > today,
              ongoing: !entry.endDate,
            }"
            :style="{
              left: bar(entry)?.left + 'px',
              width: bar(entry)?.width + 'px',
              '--category-color': color(entry),
              borderColor: color(entry),
            }"
            :aria-label="`${entry.title}，${entry.startDate} 至 ${entry.endDate ?? (entry.startDate > today ? '结束未定' : '今天')}，${entry.startDate > today ? '未开始' : ''}`"
            @click="emit('edit', entry)"
          >
            <span class="gantt-bar-title"
              >{{ bar(entry)?.continuesBefore ? '‹ ' : ''
              }}{{ entry.title }}</span
            ><span v-if="!entry.endDate" class="gantt-bar-live">至今</span
            >{{ bar(entry)?.continuesAfter ? '›' : '' }}
          </button>
          <button
            v-for="group in groups.filter((g) => g.entryId === entry.id)"
            :key="group.key"
            class="focus-marker gantt-focus-mark"
            :class="{
              'focus-day':
                window.focusUnit === 'day' && group.dates.length === 1,
              'focus-group':
                window.focusUnit !== 'day' || group.dates.length > 1,
            }"
            :style="{
              left: group.left + 'px',
              width:
                (window.focusUnit === 'day' && group.dates.length === 1
                  ? Math.max(5, Math.min(28, window.pixelsPerDay - 8))
                  : 30) + 'px',
            }"
            :aria-label="`${entry.title} ${group.dates.length} 个重点日`"
            @click="
              details = group;
              detailOffset = 0;
            "
          >
            <template
              v-if="window.focusUnit !== 'day' || group.dates.length > 1"
              >★{{ group.dates.length }}</template
            >
          </button>
        </div>
      </div>
      <div :style="{ height: rows.after + 'px' }"></div>
    </div>
  </div>
  <section v-if="details" class="record-panel" aria-label="重点日期详情">
    <h2>重点日期 · {{ details.dates.length }} 天</h2>
    <div class="date-list">
      <button
        v-for="date in details.dates.slice(detailOffset, detailOffset + 100)"
        :key="date"
        class="secondary"
        @click="emit('day', date)"
      >
        {{ date }} · 回看
      </button>
    </div>
    <p>
      第 {{ Math.floor(detailOffset / 100) + 1 }} /
      {{ Math.ceil(details.dates.length / 100) }} 页
    </p>
    <button
      class="secondary"
      :disabled="detailOffset === 0"
      @click="detailOffset -= 100"
    >
      上一页重点日期</button
    ><button
      class="secondary"
      :disabled="detailOffset + 100 >= details.dates.length"
      @click="detailOffset += 100"
    >
      下一页重点日期
    </button>
    <button class="secondary" @click="details = null">关闭重点详情</button>
  </section>
</template>
