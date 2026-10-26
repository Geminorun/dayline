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
} from '@dayline/core';
import { recordView } from './view-state';
import type { TimelineScale } from '@dayline/core';
import type { CategoryDto, EntryDto, FocusDayDto } from '@dayline/contracts';
const props = defineProps<{
  categories?: CategoryDto[];
  entries: EntryDto[];
  focusDays: FocusDayDto[];
  today: string;
  scale: TimelineScale;
  anchor: string;
}>();
const emit = defineEmits<{ edit: [entry: EntryDto]; day: [date: string] }>();
const detailOffset = ref(0);
const viewport = ref<HTMLElement | null>(null),
  scrollTop = ref(0),
  details = ref<{ entryId: string; dates: string[] } | null>(null);
const window = computed(() =>
  timelineWindow(props.entries, props.today, props.scale, props.anchor, 900),
);
const rows = computed(() =>
  visibleRows(props.entries.length, scrollTop.value, 480, 56),
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
    props.categories?.find((c) => c.id === entry.categoryId)?.color ?? '#7970CF'
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
    const top = Math.max(0, Math.min(scrollTop.value, count * 56 - 480));
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
    class="timeline-viewport"
    tabindex="0"
    aria-label="横向时间轴，可使用滚动条浏览日期"
    @scroll="scroll"
  >
    <div class="timeline-content" :style="{ width: window.width + 220 + 'px' }">
      <div class="timeline-header">
        <span class="timeline-name">事项 / 日期</span>
        <div class="timeline-axis" :style="{ width: window.width + 'px' }">
          <span
            v-for="tick in window.ticks"
            :key="tick.day"
            class="timeline-tick"
            :style="{ left: tick.x + 'px' }"
            >{{ tick.label }}</span
          >
        </div>
      </div>
      <div :style="{ height: rows.before + 'px' }"></div>
      <div v-for="entry in visible" :key="entry.id" class="timeline-row">
        <button
          class="timeline-name secondary"
          :title="entry.title"
          :style="{ borderLeft: `4px solid ${color(entry)}` }"
          @click="emit('edit', entry)"
        >
          {{ entry.title }}
        </button>
        <div class="timeline-track" :style="{ width: window.width + 'px' }">
          <span
            v-if="window.todayX !== null"
            class="today-line"
            :style="{ left: window.todayX + 'px' }"
            aria-label="今天"
          ></span>
          <button
            v-if="bar(entry)"
            class="timeline-bar"
            :class="{ future: entry.startDate > today }"
            :style="{
              left: bar(entry)?.left + 'px',
              width: bar(entry)?.width + 'px',
              backgroundColor:
                entry.startDate > today ? '#F0EEFB' : color(entry) + '88',
              borderColor: color(entry),
            }"
            :aria-label="`${entry.title}，${entry.startDate} 至 ${entry.endDate ?? (entry.startDate > today ? '结束未定' : '今天')}，${entry.startDate > today ? '未开始' : ''}`"
            @click="emit('edit', entry)"
          >
            {{ bar(entry)?.continuesBefore ? '‹' : ''
            }}{{ bar(entry)?.continuesAfter ? '›' : '' }}
          </button>
          <button
            v-for="group in groups.filter((g) => g.entryId === entry.id)"
            :key="group.key"
            class="focus-marker"
            :style="{ left: group.left + 'px' }"
            :aria-label="`${entry.title} ${group.dates.length} 个重点日`"
            @click="
              details = group;
              detailOffset = 0;
            "
          >
            ★{{ group.dates.length > 1 ? group.dates.length : '' }}
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
