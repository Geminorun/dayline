<script setup lang="ts">
import {
  computed,
  getCurrentInstance,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
} from 'vue';
import { onShow } from '@dcloudio/uni-app';
import {
  businessToday,
  dateOrdinal,
  emptyFilter,
  entryStatus,
  focusHeatLevel,
  ordinalDate,
  packTimelineLanes,
  selectEntries,
  timelineCanvasWindow,
  timelineFocusGroups,
  TIMELINE_RECENT_POSITION,
  visibleRows,
} from '@dayline/core';
import type { TimelineFocusGroup, TimelineScale } from '@dayline/core';
import type { EntryDto } from '@dayline/contracts';
import { requestedDay, useWorkspace } from '../../workspace';
import { calendarLabel } from '../../i18n';
import { TimelineGesture } from '../../timeline/gestures';
import type { TouchPoint, CameraChange } from '../../timeline/gestures';
import PageShell from '../../components/PageShell.vue';
import SyncStatus from '../../components/SyncStatus.vue';
import IconButton from '../../components/IconButton.vue';
import Filters from '../../components/Filters.vue';
import EntryDetails from '../../components/EntryDetails.vue';
import BottomSheet from '../../components/BottomSheet.vue';
const w = useWorkspace(),
  { snapshot, busy, readonly, ensure } = w;
const filter = ref(emptyFilter()),
  scale = ref<TimelineScale>('month'),
  cameraDay = ref<number>(),
  cameraDays = ref<number>();
const detail = ref<EntryDto | null>(null),
  focus = ref<TimelineFocusGroup | null>(null),
  focusLimit = ref(50),
  selected = ref(''),
  plotTop = ref(0),
  listTop = ref(0);
const plotWidth = ref(263),
  plotLeft = ref(98),
  rowHeight = 56;
const scales = ['月', '季度', '年', '全部'],
  scaleValues = ['month', 'quarter', 'year', 'all'] as const;
const today = computed(() => snapshot.value?.businessToday ?? businessToday());
const range = computed(() =>
  timelineCanvasWindow(
    snapshot.value?.entries ?? [],
    today.value,
    scale.value,
    cameraDay.value,
    plotWidth.value,
    cameraDays.value,
  ),
);
const filtered = computed(() =>
  selectEntries(snapshot.value?.entries ?? [], today.value, filter.value),
);
const entries = computed(() =>
  selectEntries(
    filtered.value,
    today.value,
    { ...emptyFilter(), status: 'all' },
    range.value,
  ),
);
const groups = computed(() =>
  timelineFocusGroups(
    entries.value,
    snapshot.value?.focusDays ?? [],
    today.value,
    range.value,
    { position: 'dates-center', minimumDistance: 36 },
  ),
);
let previousLanes = new Map<string, number>();
const lanes = computed(() => {
  const result = packTimelineLanes(
    entries.value,
    today.value,
    range.value,
    groups.value,
    previousLanes,
  );
  previousLanes = new Map(
    result.flatMap((lane) => lane.map((p) => [p.entry.id, p.lane] as const)),
  );
  return result;
});
const plotHeight = computed(() =>
  Math.min(320, Math.max(168, lanes.value.length * rowHeight)),
);
const displayTicks = computed(() => {
  const min =
    range.value.endExclusive - range.value.start > 730
      ? 52
      : range.value.focusUnit === 'week'
        ? 34
        : 26;
  let previous = -Infinity;
  return range.value.ticks.filter((tick) => {
    if (tick.x - previous < min) return false;
    previous = tick.x;
    return true;
  });
});
const rows = computed(() =>
  visibleRows(
    lanes.value.length,
    plotTop.value,
    plotHeight.value,
    rowHeight,
    3,
  ),
);
const visibleLanes = computed(() =>
  lanes.value
    .slice(rows.value.start, rows.value.end)
    .map((items, index) => ({ index: rows.value.start + index, items })),
);
const listRows = computed(() =>
  visibleRows(
    entries.value.length,
    listTop.value,
    plotHeight.value,
    rowHeight,
    3,
  ),
);
const visibleList = computed(() =>
  entries.value.slice(listRows.value.start, listRows.value.end),
);
const rangeLabel = computed(
  () =>
    calendarLabel(ordinalDate(Math.floor(range.value.start))) +
    ' — ' +
    calendarLabel(ordinalDate(Math.ceil(range.value.endExclusive) - 1)),
);
const monthGroups = computed(() => {
  const result: { key: string; label: string; left: number; width: number }[] =
    [];
  for (const tick of range.value.ticks) {
    const date = ordinalDate(tick.day),
      key = date.slice(0, range.value.focusUnit === 'month' ? 4 : 7);
    if (result.at(-1)?.key === key) continue;
    const previous = result.at(-1);
    if (previous) previous.width = tick.x - previous.left;
    result.push({
      key,
      label:
        range.value.focusUnit === 'month'
          ? date.slice(0, 4) + '年'
          : Number(date.slice(0, 4)) + '年' + Number(date.slice(5, 7)) + '月',
      left: tick.x,
      width: range.value.width - tick.x,
    });
  }
  return result;
});
function color(entry: EntryDto) {
  return (
    snapshot.value?.categories.find((c) => c.id === entry.categoryId)?.color ??
    '#6C9BCE'
  );
}
function heat(count: number) {
  return focusHeatLevel(count);
}
function camera(value: CameraChange) {
  cameraDay.value = value.day;
  cameraDays.value = value.days;
  scale.value =
    value.days >= range.value.maxDays - 0.01
      ? 'all'
      : value.days <= 31.01
        ? 'month'
        : value.days <= 140
          ? 'quarter'
          : 'year';
}
function chooseScale(event: { detail: { value: string | number } }) {
  scale.value = scaleValues[Number(event.detail.value)] ?? 'month';
  cameraDay.value = undefined;
  cameraDays.value = undefined;
  plotTop.value = 0;
}
function move(amount: number) {
  const days = range.value.endExclusive - range.value.start;
  camera({
    day: range.value.start + days * (TIMELINE_RECENT_POSITION + amount * 0.8),
    days,
  });
}
function locate() {
  camera({
    day: dateOrdinal(today.value) + 0.5,
    days: range.value.endExclusive - range.value.start,
  });
}
function create() {
  uni.navigateTo({ url: '/pages/entry/edit' });
}
function edit(entry: EntryDto) {
  detail.value = null;
  uni.navigateTo({ url: '/pages/entry/edit?id=' + entry.id });
}
function review(date: string) {
  requestedDay.value = date;
  detail.value = null;
  focus.value = null;
  uni.switchTab({ url: '/pages/day/index' });
}
const gesture = new TimelineGesture();
let suppression = 0,
  lastPoints: TouchPoint[] = [],
  active = false;
interface TouchEvent {
  touches: ArrayLike<TouchPoint>;
}
let cameraTimer: ReturnType<typeof setTimeout> | undefined,
  pendingCamera: CameraChange | undefined;
function flushCamera() {
  clearTimeout(cameraTimer);
  cameraTimer = undefined;
  const next = pendingCamera;
  pendingCamera = undefined;
  if (next) camera(next);
}
function queueCamera(next: CameraChange) {
  pendingCamera = next;
  if (!cameraTimer) cameraTimer = setTimeout(flushCamera, 16);
}
function touchStart(event: TouchEvent) {
  const points = Array.from(event.touches).slice(0, 2);
  if (active) {
    flushCamera();
    gesture.rebase(points, range.value, plotTop.value);
  } else {
    gesture.start(points, range.value, plotLeft.value, 0, plotTop.value);
    active = true;
  }
  lastPoints = points;
}
function touchMove(event: TouchEvent) {
  const points = Array.from(event.touches).slice(0, 2);
  if (points.length !== lastPoints.length) {
    gesture.rebase(points, range.value, plotTop.value);
    lastPoints = points;
    return;
  }
  const change = gesture.move(points);
  if (change?.camera) queueCamera(change.camera);
  if (change?.scroll !== undefined)
    plotTop.value = Math.max(
      0,
      Math.min(
        Math.max(0, lanes.value.length * rowHeight - plotHeight.value),
        change.scroll,
      ),
    );
  lastPoints = points;
}
function touchEnd(event: TouchEvent) {
  flushCamera();
  if (gesture.moved) suppression = Date.now() + 400;
  const points = Array.from(event.touches ?? []).slice(0, 2);
  if (points.length) {
    gesture.rebase(points, range.value, plotTop.value);
    lastPoints = points;
  } else {
    gesture.end();
    active = false;
    lastPoints = [];
  }
}
function touchCancel() {
  clearTimeout(cameraTimer);
  cameraTimer = undefined;
  pendingCamera = undefined;
  gesture.end();
  active = false;
  lastPoints = [];
  suppression = Date.now() + 400;
}
function view(entry: EntryDto) {
  if (Date.now() < suppression) return;
  selected.value = entry.id;
  detail.value = entry;
}
function focusDetail(group: TimelineFocusGroup) {
  if (Date.now() < suppression) return;
  focus.value = group;
  focusLimit.value = 50;
  selected.value = group.entryId;
}
const instance = getCurrentInstance();
function measure() {
  if (typeof uni.createSelectorQuery !== 'function') return;
  let query = uni.createSelectorQuery();
  if (instance?.proxy) query = query.in(instance.proxy);
  query
    .select('.timeline-plot')
    .boundingClientRect((rect) => {
      if (!Array.isArray(rect) && rect.width && rect.width >= 240) {
        plotWidth.value = rect.width;
        plotLeft.value = rect.left ?? 0;
      }
    })
    .exec();
}
function resize() {
  void nextTick(measure);
}
if (typeof uni !== 'undefined') uni.onWindowResize?.(resize);
onBeforeUnmount(() => {
  if (typeof uni !== 'undefined') uni.offWindowResize?.(resize);
  touchCancel();
});
watch(
  () => w.spaceRevision.value,
  () => {
    filter.value = emptyFilter();
    detail.value = null;
    focus.value = null;
    selected.value = '';
    cameraDay.value = undefined;
    cameraDays.value = undefined;
    plotTop.value = 0;
    listTop.value = 0;
    previousLanes = new Map();
    touchCancel();
  },
);
watch(
  () => lanes.value.length,
  (count) => {
    plotTop.value = Math.max(
      0,
      Math.min(
        plotTop.value,
        Math.max(0, count * rowHeight - plotHeight.value),
      ),
    );
  },
);
watch(
  () => snapshot.value?.categories,
  () => {
    if (
      filter.value.categoryId &&
      !snapshot.value?.categories.some((c) => c.id === filter.value.categoryId)
    )
      filter.value.categoryId = '';
  },
);
onShow(async () => {
  await ensure();
  await nextTick();
  measure();
});
</script>
<template>
  <PageShell
    ><view class="screen-heading"
      ><view
        ><text class="eyebrow">每一段经历，都有自己的跨度</text
        ><text class="title">时间轴</text></view
      ><SyncStatus /></view
    ><view class="timeline-toolbar"
      ><picker
        :range="scales"
        :value="scaleValues.indexOf(scale)"
        @change="chooseScale"
        ><view class="scale-picker"
          >{{ scales[scaleValues.indexOf(scale)] }} ▾</view
        ></picker
      ><text class="muted">双指缩放 · 单指拖动</text
      ><IconButton
        v-if="!readonly"
        icon="plus"
        label="新建事项"
        :disabled="busy"
        @click="create" /></view
    ><Filters v-model="filter" :categories="snapshot?.categories ?? []" />
    <view class="range-controls"
      ><IconButton icon="back" label="上一段时间" @click="move(-1)" /><text>{{
        rangeLabel
      }}</text
      ><IconButton icon="arrow" label="下一段时间" @click="move(1)" /><button
        class="text-button"
        @click="locate"
      >
        今天
      </button></view
    >
    <view class="mini-timeline"
      ><view class="name-column"
        ><view class="name-heading">本屏 {{ entries.length }} 项</view
        ><scroll-view
          scroll-y
          class="name-scroll"
          :style="{ height: plotHeight + 'px' }"
          :scroll-top="listTop"
          @scroll="listTop = $event.detail.scrollTop"
          ><view :style="{ height: listRows.before + 'px' }" /><view
            v-for="entry in visibleList"
            :key="entry.id"
            class="name-row"
            :class="{ highlighted: selected === entry.id }"
            @click="view(entry)"
            ><text class="name-title"
              ><text :style="{ color: color(entry) }">● </text
              >{{ entry.title }}</text
            ><text class="name-status">{{
              entryStatus(entry, today) === 'ended' ? '已结束' : '进行中'
            }}</text></view
          ><view :style="{ height: listRows.after + 'px' }" /></scroll-view
      ></view>
      <view
        class="timeline-plot"
        @touchstart="touchStart"
        @touchmove.stop.prevent="touchMove"
        @touchend="touchEnd"
        @touchcancel="touchCancel"
        ><view class="date-header"
          ><view
            v-for="month in monthGroups"
            :key="month.key"
            class="month-heading"
            :style="{ left: month.left + 'px', width: month.width + 'px' }"
            >{{ month.label }}</view
          ><view
            v-for="tick in displayTicks"
            :key="tick.day"
            class="tick"
            :style="{ left: tick.x + 'px' }"
            >{{ tick.label }}</view
          ></view
        ><view class="timeline-body" :style="{ height: plotHeight + 'px' }"
          ><view
            class="lane-canvas"
            :style="{
              height: Math.max(plotHeight, lanes.length * rowHeight) + 'px',
              transform: 'translateY(-' + plotTop + 'px)',
            }"
            ><view
              v-if="range.todayX !== null"
              class="today-line"
              :style="{ left: range.todayX + 'px' }" /><view
              v-for="lane in visibleLanes"
              :key="lane.index"
              class="timeline-lane"
              :style="{ top: lane.index * rowHeight + 'px' }"
              ><view
                v-for="p in lane.items"
                :key="p.entry.id"
                class="timeline-item"
                :class="{ highlighted: selected === p.entry.id }"
                :data-entry-id="p.entry.id"
                ><view
                  class="bar-hit"
                  role="button"
                  :aria-label="
                    p.entry.title +
                    '，' +
                    p.entry.startDate +
                    ' 至 ' +
                    (p.entry.endDate || '今天')
                  "
                  :style="{
                    left: p.hitLeft + 'px',
                    width: p.hitWidth + 'px',
                  }"
                  @click="view(p.entry)"
                  ><view
                    class="bar"
                    :style="{
                      left: p.bar.left - p.hitLeft + 'px',
                      width: p.bar.width + 'px',
                      borderColor: color(p.entry),
                      backgroundColor: color(p.entry) + '22',
                    }"
                    ><text
                      >{{ p.bar.continuesBefore ? '‹ ' : ''
                      }}{{ p.entry.title }}</text
                    ><text v-if="!p.entry.endDate" class="ongoing-badge">{{
                      p.entry.startDate > today ? '未结束' : '至今'
                    }}</text></view
                  ></view
                ><view
                  v-for="group in p.groups"
                  :key="group.key"
                  class="focus-marker"
                  role="button"
                  :aria-label="
                    p.entry.title + ' · ' + group.dates.length + ' 个重点日'
                  "
                  :style="{ left: group.left - 16 + 'px' }"
                  @click.stop="focusDetail(group)"
                  ><view
                    class="focus-cell"
                    :class="
                      'heat-' + heat(group.dates.length)
                    " /></view></view></view></view
          ><view v-if="!entries.length" class="timeline-empty">{{
            w.loading.value ? '正在更新…' : '这段时间没有匹配的记录'
          }}</view></view
        ></view
      ></view
    >
    <view class="timeline-footer"
      ><text>重点日</text
      ><view class="heat-legend"
        ><text>少</text
        ><view
          v-for="level in [1, 2, 3, 4]"
          :key="level"
          class="focus-cell"
          :class="'heat-' + level"
        /><text>多</text></view
      ><text>{{ entries.length }} 项 · {{ lanes.length }} 行</text></view
    >
    <text class="text muted timeline-note"
      >点击事项查看详情；点击色块回看重点日期。未结束的事项延续到今天。</text
    >
    <EntryDetails
      v-if="detail && snapshot"
      :entry="detail"
      :categories="snapshot.categories"
      :focus-days="snapshot.focusDays"
      :today="today"
      :readonly="readonly"
      @close="detail = null"
      @edit="edit(detail)"
      @day="review"
    />
    <BottomSheet
      v-if="focus"
      :title="entries.find((e) => e.id === focus?.entryId)?.title ?? '重点日期'"
      @close="focus = null"
      ><text class="text">本色块包含 {{ focus.dates.length }} 个重点日</text
      ><view class="focus-date-list"
        ><button
          v-for="date in focus.dates.slice(0, focusLimit)"
          :key="date"
          class="date-chip"
          @click="review(date)"
        >
          {{ date }}
        </button></view
      ><button
        v-if="focus.dates.length > focusLimit"
        class="secondary"
        @click="focusLimit += 50"
      >
        显示更多日期</button
      ><text class="text muted">点击日期进入每日回看。</text></BottomSheet
    >
  </PageShell>
</template>
<style scoped>
.timeline-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rpx;
}
.scale-picker {
  font-size: 25rpx;
  padding: 12rpx 20rpx;
  border: 1px solid var(--line);
  border-radius: 10rpx;
  background: var(--surface);
}
.timeline-toolbar > .muted {
  font-size: 22rpx;
}
.range-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0;
  margin: 8rpx -12rpx;
}
.range-controls > text {
  font-size: 19rpx;
  color: var(--muted);
  flex: 1;
  text-align: center;
}
.range-controls .icon-button {
  width: 30px;
  min-width: 30px;
  padding: 7px;
}
.range-controls .text-button {
  font-size: 22rpx;
  padding: 8rpx;
}
.mini-timeline {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 14rpx;
  overflow: hidden;
}
.name-column {
  border-right: 1px solid var(--line);
  min-width: 0;
}
.name-heading {
  height: 56px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  padding: 0 10rpx;
  font-size: 22rpx;
  font-weight: 600;
  border-bottom: 1px solid var(--line);
}
.name-scroll {
  height: 320px;
}
.name-row {
  height: 56px;
  box-sizing: border-box;
  padding: 8rpx 10rpx;
  border-bottom: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6rpx;
}
.name-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 22rpx;
}
.name-status {
  font-size: 18rpx;
  color: var(--muted);
}
.name-row.highlighted {
  background: var(--accent-soft);
}
.timeline-plot {
  min-width: 0;
  overflow: hidden;
  touch-action: none;
}
.date-header {
  height: 56px;
  position: relative;
  border-bottom: 1px solid var(--line);
  box-sizing: border-box;
  overflow: hidden;
  background: var(--surface-subtle);
}
.month-heading {
  position: absolute;
  top: 0;
  height: 28px;
  display: flex;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
  font-size: 18rpx;
  color: var(--muted);
  padding-left: 6rpx;
  box-sizing: border-box;
  border-right: 1px solid var(--line);
}
.tick {
  position: absolute;
  top: 28px;
  display: flex;
  align-items: center;
  height: 28px;
  padding-left: 4rpx;
  font-size: 18rpx;
  color: var(--muted);
  border-left: 1px solid var(--line);
}
.timeline-body {
  height: 320px;
  position: relative;
  overflow: hidden;
}
.lane-canvas {
  position: relative;
  width: 100%;
}
.timeline-lane {
  height: 56px;
  position: absolute;
  width: 100%;
  box-sizing: border-box;
  border-bottom: 1px solid var(--line);
}
.timeline-item {
  position: static;
}
.bar-hit {
  position: absolute;
  top: 4px;
  height: 26px;
}
.bar-hit .bar {
  top: 0;
}
.bar {
  position: absolute;
  top: 4px;
  height: 26px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 4rpx;
  padding: 0 8rpx;
  border: 1px solid;
  border-left-width: 3px;
  border-radius: 5px;
  overflow: hidden;
  font-size: 21rpx;
}
.bar > text:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}
.ongoing-badge {
  font-size: 16rpx;
  white-space: nowrap;
  background: var(--surface);
  border-radius: 2px;
  padding: 0 3rpx;
  color: var(--muted);
}
.highlighted .bar {
  box-shadow: 0 0 0 1px var(--accent-ink);
}
.today-line {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px dashed var(--muted);
  opacity: 0.4;
  pointer-events: none;
}
.focus-marker {
  position: absolute;
  top: 28px;
  width: 32px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.focus-cell {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: var(--accent-ink);
}
.heat-1 {
  opacity: 0.25;
}
.heat-2 {
  opacity: 0.45;
}
.heat-3 {
  opacity: 0.7;
}
.heat-4 {
  opacity: 1;
}
.timeline-footer {
  display: flex;
  align-items: center;
  gap: 12rpx;
  padding: 20rpx 0;
  font-size: 20rpx;
  color: var(--muted);
}
.timeline-footer > text:last-child {
  margin-left: auto;
}
.heat-legend {
  display: flex;
  align-items: center;
  gap: 7rpx;
}
.timeline-empty {
  position: absolute;
  top: 70px;
  left: 12px;
  right: 12px;
  text-align: center;
  font-size: 25rpx;
  color: var(--muted);
}
.timeline-note {
  font-size: 22rpx;
}
.focus-date-list {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
}
.date-chip {
  background: var(--surface-subtle);
  color: var(--ink);
  font-size: 24rpx;
  margin: 0;
  padding: 14rpx;
}
@media (max-width: 350px) {
  .mini-timeline {
    grid-template-columns: minmax(0, 1fr);
  }
  .name-column {
    display: none;
  }
}
</style>
