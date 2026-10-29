<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  useId,
} from 'vue';
import {
  packTimelineLanes,
  timelineFocusGroups,
  validFocusDays,
  timelineCanvasWindow,
  TIMELINE_RECENT_POSITION,
  visibleRows,
  durationDays,
  entryStatus,
  ordinalDate,
  dateOrdinal,
} from '@dayline/core';
import { recordView } from './view-state';
import { focusHeatLevel } from './focus-heat';
import IconButton from '../components/IconButton.vue';
import PlannerIcon from '../components/PlannerIcon.vue';
import type {
  TimelineCanvasWindow,
  TimelineScale,
  TimelineFocusGroup,
  TimelinePlacement,
} from '@dayline/core';
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
  range?: TimelineCanvasWindow;
}>();
const emit = defineEmits<{
  view: [entry: EntryDto];
  camera: [value: { day: number; days: number }];
  finish: [entry: EntryDto];
  day: [date: string];
}>();
const detailOffset = ref(0);
const viewport = ref<HTMLElement | null>(null),
  scrollTop = ref(0),
  selection = ref<string | null>(null);
const listViewport = ref<HTMLElement | null>(null);
const listScrollTop = ref(0);
const highlighted = ref<string | null>(null);
const laneHeight = 56,
  listRowHeight = 56;
const panelId = useId();
const focusPanel = ref<HTMLElement | null>(null);
const focusOpen = ref(false);
const focusPosition = ref({ left: '0px', top: '0px' });
const tipId = panelId + '-tip';
const tipPanel = ref<HTMLElement | null>(null);
const tipKey = ref<string | null>(null);
const tipPosition = ref({ left: '0px', top: '0px' });
const tipGroup = computed(() =>
  groups.value.find((group) => group.key === tipKey.value),
);
let tipTimer: ReturnType<typeof setTimeout> | undefined;
let tipHideTimer: ReturnType<typeof setTimeout> | undefined;
let tipRequest = 0;
let focusTrigger: HTMLButtonElement | null = null;
const plotWidth = ref(900);
const sourceWindow = computed(
  () =>
    props.range ??
    timelineCanvasWindow(props.entries, props.today, props.scale),
);
const window = computed(() => {
  const source = sourceWindow.value,
    width = plotWidth.value;
  const ratio = width / source.width;
  return {
    ...source,
    width,
    pixelsPerDay: source.pixelsPerDay * ratio,
    todayX: source.todayX === null ? null : source.todayX * ratio,
    ticks: source.ticks.map((t) => ({ ...t, x: t.x * ratio })),
  };
});
let observer: ResizeObserver | undefined;
let drag: {
  pointer: number;
  x: number;
  start: number;
  days: number;
  moved: boolean;
} | null = null;
let suppressClick = false,
  wheelDelta = 0;
let wheelTimer: ReturnType<typeof setTimeout> | undefined;
function measure() {
  const el = viewport.value;
  if (!el) return;
  plotWidth.value = Math.max(80, el.clientWidth);
}
function camera(start: number, days: number) {
  emit('camera', { day: start + days * TIMELINE_RECENT_POSITION, days });
}
function wheel(event: WheelEvent) {
  const el = viewport.value;
  if (!el) return;
  // Leave browser page zoom and horizontal trackpad scrolling alone.
  if (
    event.ctrlKey ||
    event.metaKey ||
    Math.abs(event.deltaX) > Math.abs(event.deltaY)
  )
    return;
  event.preventDefault();
  const current = window.value;
  const delta =
    event.deltaY *
    (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 500 : 1);
  wheelDelta += delta;
  if (Math.abs(wheelDelta) < 4) return;
  const ratio = Math.max(
    0,
    Math.min(
      1,
      (event.clientX - el.getBoundingClientRect().left) / current.width,
    ),
  );
  const days = current.endExclusive - current.start;
  const nextDays = Math.max(
    31,
    Math.min(
      current.maxDays,
      days * Math.exp(Math.max(-200, Math.min(200, wheelDelta)) * 0.003),
    ),
  );
  wheelDelta = 0;
  if (Math.abs(days - nextDays) < 0.001) return;
  camera(current.start + ratio * (days - nextDays), nextDays);
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => {
    wheelDelta = 0;
  }, 150);
}
function pointerDown(event: PointerEvent) {
  suppressClick = false;
  if (
    event.button !== 0 ||
    !(event.target instanceof Element) ||
    event.target.closest('button,a,input,select,.timeline-name')
  )
    return;
  const current = window.value;
  drag = {
    pointer: event.pointerId,
    x: event.clientX,
    start: current.start,
    days: current.endExclusive - current.start,
    moved: false,
  };
  viewport.value?.setPointerCapture(event.pointerId);
}
function pointerMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointer) return;
  const delta = event.clientX - drag.x;
  if (!drag.moved && Math.abs(delta) < 4) return;
  drag.moved = true;
  dragging.value = true;
  camera(drag.start - (delta / plotWidth.value) * drag.days, drag.days);
}
const dragging = ref(false);
function pointerEnd(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointer) return;
  suppressClick = drag.moved && event.type !== 'pointercancel';
  if (viewport.value?.hasPointerCapture(event.pointerId))
    viewport.value.releasePointerCapture(event.pointerId);
  drag = null;
  dragging.value = false;
}
function click(event: MouseEvent) {
  if (suppressClick) {
    event.preventDefault();
    event.stopPropagation();
    suppressClick = false;
  }
}
function keydown(event: KeyboardEvent) {
  if (
    event.target !== viewport.value ||
    !['ArrowLeft', 'ArrowRight'].includes(event.key)
  )
    return;
  event.preventDefault();
  const current = window.value,
    days = current.endExclusive - current.start;
  camera(current.start + days * (event.key === 'ArrowLeft' ? -0.2 : 0.2), days);
}
const displayTicks = computed(() => {
  const ticks = window.value.ticks;
  const budget = Math.max(
    2,
    Math.floor(plotWidth.value / (window.value.focusUnit === 'day' ? 24 : 58)),
  );
  const step = Math.max(1, Math.ceil(ticks.length / budget));
  return ticks.filter((_, index) => index % step === 0);
});
const axisGroups = computed(() => {
  const yearOnly = window.value.focusUnit === 'month';
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
const groups = computed(() =>
  timelineFocusGroups(
    props.entries,
    props.focusDays,
    props.today,
    window.value,
    { minimumDistance: 28, position: 'dates-center' },
  ),
);
let previousLanes: ReadonlyMap<string, number> = new Map();
const lanes = computed(() =>
  packTimelineLanes(
    props.entries,
    props.today,
    window.value,
    groups.value,
    previousLanes,
  ),
);
watch(
  lanes,
  (value) => {
    previousLanes = new Map(
      value.flatMap((lane) => lane.map((p) => [p.entry.id, p.lane])),
    );
  },
  { immediate: true },
);
const bodyHeight = computed(() =>
  Math.min(336, Math.max(168, lanes.value.length * laneHeight)),
);
const rows = computed(() =>
  visibleRows(
    lanes.value.length,
    scrollTop.value,
    bodyHeight.value,
    laneHeight,
    3,
  ),
);
const visibleLanes = computed(() =>
  lanes.value.slice(rows.value.start, rows.value.end),
);
const listRows = computed(() =>
  visibleRows(
    props.entries.length,
    listScrollTop.value,
    bodyHeight.value,
    listRowHeight,
    3,
  ),
);
const visibleEntries = computed(() =>
  props.entries.slice(listRows.value.start, listRows.value.end),
);
const placementsById = computed(
  () =>
    new Map(lanes.value.flatMap((lane) => lane.map((p) => [p.entry.id, p]))),
);
const listIndices = computed(
  () => new Map(props.entries.map((entry, index) => [entry.id, index])),
);
function highlight(id: string, source: 'list' | 'plot') {
  highlighted.value = id;
  const el = source === 'list' ? viewport.value : listViewport.value;
  const index =
    source === 'list'
      ? placementsById.value.get(id)?.lane
      : listIndices.value.get(id);
  if (!el || index === undefined) return;
  const height = source === 'list' ? laneHeight : listRowHeight;
  const top = index * height;
  const current = source === 'list' ? scrollTop.value : listScrollTop.value;
  const next =
    top < current
      ? top
      : top + height > current + bodyHeight.value
        ? top + height - bodyHeight.value
        : current;
  if (next === current) return;
  el.scrollTop = next;
  if (source === 'list') scrollTop.value = next;
  else listScrollTop.value = next;
}
const focusTotals = computed(() => {
  const counts = new Map<string, number>();
  for (const focus of validFocusDays(
    props.entries,
    props.focusDays,
    props.today,
  ))
    counts.set(focus.entryId, (counts.get(focus.entryId) ?? 0) + 1);
  return counts;
});
const details = computed(
  () => groups.value.find((group) => group.key === selection.value) ?? null,
);
const focusTitle = computed(
  () => props.entries.find((e) => e.id === details.value?.entryId)?.title ?? '',
);
function focusLabel(group: TimelineFocusGroup) {
  const title = props.entries.find((e) => e.id === group.entryId)?.title ?? '';
  return group.dates.length === 1
    ? `${title} · ${group.dates[0]} · 重点日`
    : `${title} · ${group.dates.length} 个重点日 · ${group.dates.slice(0, 3).join('、')}${group.dates.length > 3 ? '…' : ''}`;
}
async function openFocus(group: TimelineFocusGroup, event: MouseEvent) {
  if (!(event.currentTarget instanceof HTMLButtonElement)) return;
  hideTip();
  focusTrigger = event.currentTarget;
  selection.value = group.key;
  detailOffset.value = 0;
  const rect = focusTrigger.getBoundingClientRect();
  placeFocus(rect, 360);
  await nextTick();
  if (selection.value !== group.key || !focusTrigger?.isConnected) return;
  focusPanel.value?.showPopover?.();
  placeFocus(rect, focusPanel.value?.getBoundingClientRect().height || 360);
  focusOpen.value = true;
  focusPanel.value
    ?.querySelector<HTMLButtonElement>('[data-focus-date]')
    ?.focus({ preventScroll: true });
}
function placeFocus(rect: DOMRect, panelHeight: number) {
  const width = Math.min(320, globalThis.innerWidth - 24);
  focusPosition.value = panelPosition(rect, width, panelHeight);
}
function panelPosition(rect: DOMRect, width: number, panelHeight: number) {
  const height = Math.min(panelHeight, globalThis.innerHeight - 24);
  return {
    left: `${Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, globalThis.innerWidth - width - 12))}px`,
    top: `${Math.max(12, rect.bottom + height + 8 <= globalThis.innerHeight ? rect.bottom + 8 : Math.min(rect.top - height - 8, globalThis.innerHeight - height - 12))}px`,
  };
}
function hideTip() {
  tipRequest++;
  clearTimeout(tipTimer);
  clearTimeout(tipHideTimer);
  tipPanel.value?.hidePopover?.();
  tipKey.value = null;
}
function scheduleTipHide() {
  clearTimeout(tipHideTimer);
  tipHideTimer = setTimeout(hideTip, 100);
}
function keepTip() {
  clearTimeout(tipHideTimer);
}
function showTip(group: TimelineFocusGroup, event: Event, immediate = false) {
  hideTip();
  if (focusOpen.value || !(event.currentTarget instanceof HTMLButtonElement))
    return;
  const target = event.currentTarget,
    request = tipRequest;
  const reveal = async () => {
    tipKey.value = group.key;
    await nextTick();
    if (request !== tipRequest || !target.isConnected) return;
    const rect = target.getBoundingClientRect();
    tipPosition.value = panelPosition(
      rect,
      Math.min(260, globalThis.innerWidth - 24),
      100,
    );
    tipPanel.value?.showPopover?.();
    const bounds = tipPanel.value?.getBoundingClientRect();
    tipPosition.value = panelPosition(
      rect,
      bounds?.width || Math.min(260, globalThis.innerWidth - 24),
      bounds?.height || 100,
    );
  };
  if (immediate) void reveal();
  else
    tipTimer = setTimeout(() => {
      void reveal();
    }, 180);
}
function pageFocus(amount: number) {
  detailOffset.value += amount * 50;
  const list = focusPanel.value?.querySelector('.focus-date-list');
  if (list instanceof HTMLElement) list.scrollTop = 0;
}
function closeFocus(returnFocus = false) {
  hideTip();
  focusPanel.value?.hidePopover?.();
  focusOpen.value = false;
  selection.value = null;
  if (returnFocus && focusTrigger?.isConnected)
    focusTrigger.focus({ preventScroll: true });
}
function focusToggle(event: Event) {
  if (
    event.currentTarget instanceof HTMLElement &&
    typeof event.currentTarget.showPopover === 'function'
  )
    focusOpen.value = event.currentTarget.matches(':popover-open');
}
function visitFocus(date: string) {
  closeFocus();
  emit('day', date);
}
watch(
  [
    () => window.value.start,
    () => window.value.endExclusive,
    () => window.value.width,
    () => scrollTop.value,
  ],
  () => closeFocus(),
);
watch(
  () =>
    lanes.value.map((lane) => lane.map((p) => p.entry.id).join('|')).join(';'),
  () => closeFocus(),
);
watch(
  () => details.value?.dates.join('|'),
  (value) => {
    detailOffset.value = 0;
    if (!value) closeFocus();
  },
);
watch(
  () => tipGroup.value?.dates.join('|'),
  (value, previous) => {
    if (previous !== undefined && value !== previous) hideTip();
  },
);
function color(entry: EntryDto) {
  return (
    props.categories?.find((c) => c.id === entry.categoryId)?.color ?? '#315C4D'
  );
}
function barStyle(placement: TimelinePlacement<EntryDto>) {
  const { bar, hitLeft, hitWidth, entry } = placement;
  return {
    left: hitLeft - placement.left + 'px',
    width: hitWidth + 'px',
    '--bar-width': bar.width + 'px',
    '--bar-offset': bar.left - hitLeft + 'px',
    '--category-color': color(entry),
    borderColor: color(entry),
  };
}
function scroll(event: Event) {
  if (event.target instanceof HTMLElement)
    scrollTop.value = event.target.scrollTop;
}
function locateToday() {
  const el = viewport.value;
  if (el)
    camera(
      dateOrdinal(props.today) +
        0.5 -
        (window.value.endExclusive - window.value.start) *
          TIMELINE_RECENT_POSITION,
      window.value.endExclusive - window.value.start,
    );
}
watch(
  [() => lanes.value.length, () => props.entries.length, bodyHeight],
  async () => {
    const top = Math.max(
      0,
      Math.min(
        scrollTop.value,
        lanes.value.length * laneHeight - bodyHeight.value,
      ),
    );
    const listTop = Math.max(
      0,
      Math.min(
        listScrollTop.value,
        props.entries.length * listRowHeight - bodyHeight.value,
      ),
    );
    scrollTop.value = top;
    listScrollTop.value = listTop;
    await nextTick();
    if (viewport.value) viewport.value.scrollTop = top;
    if (listViewport.value) listViewport.value.scrollTop = listTop;
  },
);
onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && viewport.value) {
    observer = new ResizeObserver(measure);
    observer.observe(viewport.value);
  }
  viewport.value?.addEventListener('wheel', wheel, { passive: false });
  globalThis.addEventListener('resize', dismissFocus);
  globalThis.addEventListener('keydown', dismissTipKey);
  globalThis.addEventListener('scroll', dismissFocus, true);
  if (viewport.value) {
    const top = Math.max(
      0,
      Math.min(
        recordView.timelineTop,
        lanes.value.length * laneHeight - bodyHeight.value,
      ),
    );
    viewport.value.scrollTop = top;
    scrollTop.value = top;
  }
  if (listViewport.value) {
    const top = Math.max(
      0,
      Math.min(
        recordView.timelineListTop,
        props.entries.length * listRowHeight - bodyHeight.value,
      ),
    );
    listViewport.value.scrollTop = top;
    listScrollTop.value = top;
  }
});
function dismissFocus(event: Event) {
  // Scrolling the independent list does not move a marker's plot anchor.
  if (event.type === 'scroll' && event.target === listViewport.value) return;
  if (event.target instanceof Node && focusPanel.value?.contains(event.target))
    return;
  closeFocus();
}
function dismissTipKey(event: KeyboardEvent) {
  if (event.key === 'Escape') hideTip();
}
onBeforeUnmount(() => {
  hideTip();
  globalThis.removeEventListener('resize', dismissFocus);
  globalThis.removeEventListener('keydown', dismissTipKey);
  globalThis.removeEventListener('scroll', dismissFocus, true);
  observer?.disconnect();
  clearTimeout(wheelTimer);
  viewport.value?.removeEventListener('wheel', wheel);
  recordView.timelineTop = viewport.value?.scrollTop ?? 0;
  recordView.timelineListTop = listViewport.value?.scrollTop ?? 0;
});
defineExpose({ locateToday });
</script>
<template>
  <div
    class="packed-timeline"
    :style="{ '--timeline-body-height': bodyHeight + 'px' }"
    @pointerleave="highlighted = null"
  >
    <aside class="timeline-entry-column" aria-label="当前范围事项">
      <div class="gantt-heading-label">
        <strong
          >事项 <span>{{ entries.length }}</span></strong
        >
        <small
          >当前范围 · 按开始日期{{
            sort === 'asc' ? '从早到晚' : '从晚到早'
          }}</small
        >
      </div>
      <div
        ref="listViewport"
        class="timeline-entry-list"
        tabindex="0"
        aria-label="滚动浏览事项列表"
        @scroll="listScrollTop = listViewport?.scrollTop ?? 0"
      >
        <div :style="{ height: listRows.before + 'px' }"></div>
        <div
          v-for="entry in visibleEntries"
          :key="entry.id"
          class="gantt-row-label timeline-list-entry"
          :class="{ 'is-highlighted': highlighted === entry.id }"
          :data-entry-id="entry.id"
          :style="{ '--category-color': color(entry) }"
          @pointerenter="highlight(entry.id, 'list')"
          @focusin="highlight(entry.id, 'list')"
        >
          <div class="gantt-row-title">
            <i class="category-dot"></i>
            <button :title="entry.title" @click="emit('view', entry)">
              {{ entry.title }}
            </button>
            <button
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
            <span class="event-status">{{
              entryStatus(entry, today) === 'ongoing' ? '进行中' : '已结束'
            }}</span>
            <span>{{ durationDays(entry, today) }} 天</span>
            <span
              class="gantt-focus-total"
              :class="{ 'has-focus': focusTotals.get(entry.id) }"
              >累计重点 {{ focusTotals.get(entry.id) ?? 0 }} 天</span
            >
          </div>
        </div>
        <div :style="{ height: listRows.after + 'px' }"></div>
      </div>
    </aside>
    <div
      ref="viewport"
      class="timeline-viewport gantt-scroll"
      :class="{ 'is-dragging': dragging }"
      tabindex="0"
      aria-label="时间轴，滚轮缩放，拖动空白区域或方向键左右浏览"
      @pointerdown="pointerDown"
      @pointermove="pointerMove"
      @pointerup="pointerEnd"
      @pointercancel="pointerEnd"
      @click.capture="click"
      @keydown="keydown"
      @scroll="scroll"
    >
      <div class="timeline-content" :style="{ width: window.width + 'px' }">
        <div class="timeline-header">
          <div class="timeline-axis" :style="{ width: window.width + 'px' }">
            <span
              v-for="group in axisGroups.filter((group) => group.width >= 40)"
              :key="group.key"
              class="gantt-month"
              :style="{ left: group.left + 'px', width: group.width + 'px' }"
              >{{ group.label }}</span
            >
            <div class="gantt-ticks">
              <span
                v-for="(tick, index) in displayTicks"
                :key="tick.day"
                class="timeline-tick gantt-tick"
                :class="{
                  today: tick.day === dateOrdinal(today),
                  weekend:
                    window.focusUnit === 'day' && (tick.day - 1) % 7 >= 5,
                }"
                :style="{
                  left: tick.x + 'px',
                  width:
                    (displayTicks[index + 1]?.x ?? window.width) -
                    tick.x +
                    'px',
                }"
              >
                <b>{{
                  window.focusUnit === 'day'
                    ? Number(ordinalDate(tick.day).slice(8))
                    : tick.label
                }}</b>
                <small v-if="window.focusUnit === 'day'">{{
                  ['一', '二', '三', '四', '五', '六', '日'][(tick.day - 1) % 7]
                }}</small>
              </span>
            </div>
          </div>
        </div>
        <div class="timeline-lanes" :style="{ minHeight: bodyHeight + 'px' }">
          <span
            v-if="window.todayX !== null"
            class="today-line"
            :style="{ left: window.todayX + 'px' }"
            aria-label="今天"
          ></span>
          <div :style="{ height: rows.before + 'px' }"></div>
          <div
            v-for="(lane, index) in visibleLanes"
            :key="rows.start + index"
            class="timeline-row timeline-track timeline-lane"
            :data-lane="rows.start + index"
          >
            <div
              v-for="placement in lane"
              :key="placement.entry.id"
              class="timeline-packed-item"
              :data-entry-id="placement.entry.id"
              :class="{ 'is-highlighted': highlighted === placement.entry.id }"
              :style="{
                left: placement.left + 'px',
                width: placement.right - placement.left + 'px',
              }"
              @pointerenter="highlight(placement.entry.id, 'plot')"
              @focusin="highlight(placement.entry.id, 'plot')"
            >
              <button
                class="timeline-bar gantt-bar"
                :class="{
                  future: placement.entry.startDate > today,
                  ongoing: !placement.entry.endDate,
                  'is-short': placement.bar.width < 24,
                }"
                :style="barStyle(placement)"
                :title="`${placement.entry.title} · ${placement.entry.startDate} — ${placement.entry.endDate ?? (placement.entry.startDate > today ? '结束未定' : '至今')}`"
                :aria-label="`${placement.entry.title}，${placement.entry.startDate} 至 ${placement.entry.endDate ?? (placement.entry.startDate > today ? '结束未定' : '今天')}，${entryStatus(placement.entry, today) === 'ongoing' ? '进行中' : '已结束'}`"
                @click="emit('view', placement.entry)"
              >
                <span class="gantt-bar-title"
                  >{{ placement.bar.continuesBefore ? '‹ ' : ''
                  }}{{ placement.entry.title }}</span
                >
                <span v-if="!placement.entry.endDate" class="gantt-bar-live"
                  >至今</span
                >{{ placement.bar.continuesAfter ? '›' : '' }}
              </button>
              <button
                v-for="group in placement.groups"
                :key="group.key"
                type="button"
                class="focus-marker timeline-focus-marker"
                :style="{ left: group.left - placement.left + 'px' }"
                :aria-label="focusLabel(group)"
                :aria-describedby="tipKey === group.key ? tipId : undefined"
                :aria-controls="panelId"
                :aria-expanded="focusOpen && selection === group.key"
                @pointerenter="showTip(group, $event)"
                @pointerleave="scheduleTipHide"
                @focus="showTip(group, $event, true)"
                @blur="hideTip"
                @keydown.esc="hideTip"
                @click="openFocus(group, $event)"
              >
                <span
                  class="focus-heat-cell"
                  :data-level="focusHeatLevel(group.dates.length)"
                  aria-hidden="true"
                ></span>
              </button>
            </div>
          </div>
          <div :style="{ height: rows.after + 'px' }"></div>
        </div>
      </div>
    </div>
  </div>
  <Teleport to="body">
    <div
      v-if="tipGroup"
      :id="tipId"
      ref="tipPanel"
      popover="manual"
      class="timeline-focus-tip"
      role="tooltip"
      :style="tipPosition"
      @pointerenter="keepTip"
      @pointerleave="hideTip"
    >
      <strong>{{ tipGroup.dates.length }} 个重点日</strong>
      <span
        >{{ tipGroup.dates.slice(0, 3).join('、')
        }}{{ tipGroup.dates.length > 3 ? '…' : '' }}</span
      >
      <small>点击色块查看日期</small>
    </div>
    <div
      :id="panelId"
      ref="focusPanel"
      popover="auto"
      class="timeline-focus-popover"
      :style="focusPosition"
      role="dialog"
      :aria-labelledby="panelId + '-heading'"
      @toggle="focusToggle"
      @keydown.esc="closeFocus(true)"
    >
      <template v-if="details">
        <div class="focus-popover-heading">
          <div>
            <h2 :id="panelId + '-heading'">
              重点日期 · {{ details.dates.length }} 天
            </h2>
            <p>{{ focusTitle }}</p>
          </div>
          <IconButton
            icon="close"
            label="关闭重点详情"
            @click="closeFocus(true)"
          />
        </div>
        <p class="focus-popover-hint">当前标记包含的日期，点击进入每日回看。</p>
        <div class="date-list focus-date-list">
          <button
            v-for="date in details.dates.slice(detailOffset, detailOffset + 50)"
            :key="date"
            type="button"
            data-focus-date
            :aria-label="`回看 ${date}`"
            @click="visitFocus(date)"
          >
            <span class="focus-date-dot" aria-hidden="true"></span
            ><span>{{ date }}</span
            ><PlannerIcon name="chevron" />
          </button>
        </div>
        <div v-if="details.dates.length > 50" class="focus-popover-pages">
          <IconButton
            icon="chevron"
            class="flip"
            label="上一页重点日期"
            :disabled="detailOffset === 0"
            @click="pageFocus(-1)"
          /><span
            >{{ Math.floor(detailOffset / 50) + 1 }} /
            {{ Math.ceil(details.dates.length / 50) }}</span
          ><IconButton
            icon="chevron"
            label="下一页重点日期"
            :disabled="detailOffset + 50 >= details.dates.length"
            @click="pageFocus(1)"
          />
        </div>
      </template>
    </div>
  </Teleport>
</template>
