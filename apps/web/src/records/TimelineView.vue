<script setup lang="ts">
import { locale, monthYearLabel, tickLabel } from '../i18n';
import { tr } from '../i18n/index';
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
  timelineEntryLanes,
  projectTimelineLanes,
  timelineFocusGroups,
  validFocusDays,
  timelineCanvasWindow,
  TIMELINE_RECENT_POSITION,
  visibleRows,
  entryStatus,
  ordinalDate,
  dateOrdinal,
} from '@dayline/core';
import { recordView } from './view-state';
import { focusHeatLevel } from './focus-heat';
import IconButton from '../components/IconButton.vue';
import PlannerIcon from '../components/PlannerIcon.vue';
import TimelineEntryLabel from './TimelineEntryLabel.vue';
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
const highlighted = ref<string | null>(null);
const laneHeight = 56;
const bodyHeight = ref(336);
const navigating = ref(false);
const navigationTracks = ref<string[]>([]);
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
  bodyHeight.value = Math.max(
    168,
    Math.min(
      336,
      Math.floor((globalThis.innerHeight * 0.45) / laneHeight) * laneHeight,
    ),
  );
}
function beginNavigation() {
  if (!navigating.value)
    navigationTracks.value = tracks.value.map((track) => track.key);
  navigating.value = true;
  clearTimeout(wheelTimer);
}
function finishNavigation() {
  clearTimeout(wheelTimer);
  wheelDelta = 0;
  navigating.value = false;
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
  beginNavigation();
  camera(current.start + ratio * (days - nextDays), nextDays);
  wheelTimer = setTimeout(finishNavigation, 180);
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
  beginNavigation();
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
  finishNavigation();
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
        ? locale.value === 'en'
          ? String(Number(key))
          : Number(key) + '年'
        : monthYearLabel(Number(date.slice(0, 4)), Number(date.slice(5, 7))),
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
const entryLanes = computed(() =>
  timelineEntryLanes(props.entries, props.today).sort((a, b) => {
    const first = props.sort === 'asc' ? a[0] : a.at(-1);
    const second = props.sort === 'asc' ? b[0] : b.at(-1);
    return (
      (props.sort === 'asc' ? 1 : -1) *
        (first?.startDate ?? '').localeCompare(second?.startDate ?? '') ||
      (first?.id ?? '').localeCompare(second?.id ?? '')
    );
  }),
);
const projected = computed(() =>
  projectTimelineLanes(
    entryLanes.value,
    props.today,
    window.value,
    groups.value,
  ),
);
const visibleEntryCount = computed(() =>
  projected.value.reduce((count, lane) => count + lane.length, 0),
);
const tracks = computed(() => {
  const all = entryLanes.value.map((entries, index) => ({
    key: entries[0]?.id ?? String(index),
    items: projected.value[index] ?? [],
  }));
  if (!navigating.value) return all.filter((track) => track.items.length);
  const byKey = new Map(all.map((track) => [track.key, track]));
  return navigationTracks.value.flatMap((key) => {
    const track = byKey.get(key);
    return track ? [track] : [];
  });
});
const rows = computed(() =>
  visibleRows(
    tracks.value.length,
    scrollTop.value,
    bodyHeight.value,
    laneHeight,
    3,
  ),
);
const visibleLanes = computed(() =>
  tracks.value.slice(rows.value.start, rows.value.end),
);
function highlight(id: string) {
  highlighted.value = id;
}
const lanePanelId = panelId + '-lane';
const lanePanel = ref<HTMLElement | null>(null);
const expandedLane = ref<string | null>(null);
const lanePosition = ref({ left: '0px', top: '0px' });
const expandedItems = computed(
  () =>
    tracks.value.find((track) => track.key === expandedLane.value)?.items ?? [],
);
let laneTrigger: HTMLButtonElement | null = null;
async function openLane(key: string, event: MouseEvent) {
  if (!(event.currentTarget instanceof HTMLButtonElement)) return;
  closeFocus();
  laneTrigger = event.currentTarget;
  expandedLane.value = key;
  const rect = laneTrigger.getBoundingClientRect();
  lanePosition.value = panelPosition(
    rect,
    Math.min(320, globalThis.innerWidth - 24),
    300,
  );
  await nextTick();
  if (expandedLane.value !== key || !laneTrigger.isConnected) return;
  lanePanel.value?.showPopover?.();
  lanePosition.value = panelPosition(
    rect,
    Math.min(320, globalThis.innerWidth - 24),
    lanePanel.value?.getBoundingClientRect().height || 300,
  );
  lanePanel.value
    ?.querySelector<HTMLButtonElement>('.timeline-list-entry button')
    ?.focus({ preventScroll: true });
}
function closeLane(returnFocus = false) {
  lanePanel.value?.hidePopover?.();
  expandedLane.value = null;
  if (returnFocus && laneTrigger?.isConnected)
    laneTrigger.focus({ preventScroll: true });
}
function laneToggle(event: Event) {
  if (
    event.currentTarget instanceof HTMLElement &&
    event.currentTarget === lanePanel.value &&
    typeof event.currentTarget.showPopover === 'function' &&
    !event.currentTarget.matches(':popover-open')
  )
    expandedLane.value = null;
}
function viewFromLane(entry: EntryDto) {
  closeLane();
  emit('view', entry);
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
    ? tr('timelineView.focusDay', { value0: title, value1: group.dates[0] })
    : tr('timelineView.focusDays', {
        value0: title,
        value1: group.dates.length,
        value2: group.dates.slice(0, 3).join('、'),
        value3: group.dates.length > 3 ? '…' : '',
      });
}
async function openFocus(group: TimelineFocusGroup, event: MouseEvent) {
  if (!(event.currentTarget instanceof HTMLButtonElement)) return;
  hideTip();
  closeLane();
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
  () => {
    closeFocus();
    closeLane();
  },
);
watch(
  () =>
    tracks.value
      .map((track) => track.items.map((p) => p.entry.id).join('|'))
      .join(';'),
  () => {
    closeFocus();
    closeLane();
  },
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
function markerStyle(
  group: TimelineFocusGroup,
  placement: TimelinePlacement<EntryDto>,
) {
  const width = Math.min(28, placement.hitWidth);
  const left = Math.max(
    placement.left + width / 2,
    Math.min(group.left, placement.right - width / 2),
  );
  return {
    left: left - placement.left + 'px',
    width: width + 'px',
    '--focus-cell-width': Math.min(10, width) + 'px',
  };
}
function setScrollTop(value: number) {
  const top = Math.max(
    0,
    Math.min(value, tracks.value.length * laneHeight - bodyHeight.value),
  );
  scrollTop.value = top;
  for (const el of [viewport.value, listViewport.value]) {
    if (el && el.scrollTop !== top) el.scrollTop = top;
  }
}
function scroll(event: Event) {
  if (event.target instanceof HTMLElement) setScrollTop(event.target.scrollTop);
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
  () => tracks.value.map((track) => track.key),
  async (keys, previous) => {
    const previousIndex = Math.floor(scrollTop.value / laneHeight);
    const nextKeys = new Set(keys);
    const anchor = previous
      ?.slice(previousIndex)
      .find((key) => nextKeys.has(key));
    const top = anchor
      ? keys.indexOf(anchor) * laneHeight + (scrollTop.value % laneHeight)
      : scrollTop.value;
    scrollTop.value = Math.max(
      0,
      Math.min(top, tracks.value.length * laneHeight - bodyHeight.value),
    );
    await nextTick();
    setScrollTop(scrollTop.value);
  },
);
watch(bodyHeight, () => setScrollTop(scrollTop.value));
onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && viewport.value) {
    observer = new ResizeObserver(measure);
    observer.observe(viewport.value);
  }
  viewport.value?.addEventListener('wheel', wheel, { passive: false });
  globalThis.addEventListener('resize', measure);
  globalThis.addEventListener('resize', dismissFocus);
  globalThis.addEventListener('keydown', dismissTipKey);
  globalThis.addEventListener('scroll', dismissFocus, true);
  setScrollTop(recordView.timelineTop);
});
function dismissFocus(event: Event) {
  if (
    event.type === 'scroll' &&
    (event.target === listViewport.value || event.target === viewport.value)
  )
    return;
  if (
    !(event.target instanceof Node) ||
    !lanePanel.value?.contains(event.target)
  )
    closeLane();
  if (event.target instanceof Node && focusPanel.value?.contains(event.target))
    return;
  closeFocus();
}
function dismissTipKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    hideTip();
    closeLane(true);
  }
}
onBeforeUnmount(() => {
  hideTip();
  closeLane();
  globalThis.removeEventListener('resize', measure);
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
    <aside
      class="timeline-entry-column"
      :aria-label="tr('common.currentScopeEntry')"
    >
      <div class="gantt-heading-label">
        <strong
          >{{ tr('common.entry') }}<span>{{ visibleEntryCount }}</span></strong
        >
        <small>{{
          tr('timelineView.currentScopeByStartDate', {
            value0:
              sort === 'asc'
                ? tr('common.fromMorningToNight')
                : tr('common.fromNightToMorning'),
          })
        }}</small>
      </div>
      <div
        ref="listViewport"
        class="timeline-entry-list"
        tabindex="0"
        :aria-label="tr('common.scrollThroughEntryList')"
        @scroll="scroll"
      >
        <div :style="{ height: rows.before + 'px' }"></div>
        <div
          v-for="(track, index) in visibleLanes"
          :key="track.key"
          class="timeline-list-lane"
          :class="{
            'is-highlighted': track.items.some(
              (item) => item.entry.id === highlighted,
            ),
            'has-many': track.items.length > 2,
          }"
          :data-lane="rows.start + index"
        >
          <TimelineEntryLabel
            v-for="placement in track.items.slice(0, 2)"
            :key="placement.entry.id"
            :entry="placement.entry"
            :today="today"
            :color="color(placement.entry)"
            :focus-total="focusTotals.get(placement.entry.id) ?? 0"
            :compact="track.items.length > 1"
            :highlighted="highlighted === placement.entry.id"
            :readonly="readonly"
            :busy="busy"
            @highlight="highlight"
            @view="emit('view', $event)"
            @finish="emit('finish', $event)"
          />
          <button
            v-if="track.items.length > 2"
            type="button"
            class="timeline-lane-more"
            :aria-label="
              tr('timelineView.moreEntries', { count: track.items.length - 2 })
            "
            :title="
              tr('timelineView.moreEntries', { count: track.items.length - 2 })
            "
            :aria-controls="lanePanelId"
            :aria-expanded="expandedLane === track.key"
            @click="openLane(track.key, $event)"
          >
            +{{ track.items.length - 2 }}
          </button>
        </div>
        <div :style="{ height: rows.after + 'px' }"></div>
      </div>
    </aside>
    <div
      ref="viewport"
      class="timeline-viewport gantt-scroll"
      :class="{ 'is-dragging': dragging }"
      tabindex="0"
      :aria-label="tr('timelineView.timelineScrollWheelToZoomDragThe')"
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
                    : tickLabel(tick.label)
                }}</b>
                <small v-if="window.focusUnit === 'day'">{{
                  [
                    tr('common.mon'),
                    tr('common.tue'),
                    tr('common.wed'),
                    tr('common.thu'),
                    tr('common.fri'),
                    tr('common.sat'),
                    tr('common.sun'),
                  ][(tick.day - 1) % 7]
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
            :aria-label="tr('common.today')"
          ></span>
          <div :style="{ height: rows.before + 'px' }"></div>
          <div
            v-for="(track, index) in visibleLanes"
            :key="track.key"
            class="timeline-row timeline-track timeline-lane"
            :data-lane="rows.start + index"
          >
            <div
              v-for="placement in track.items"
              :key="placement.entry.id"
              class="timeline-packed-item"
              :data-entry-id="placement.entry.id"
              :class="{ 'is-highlighted': highlighted === placement.entry.id }"
              :style="{
                left: placement.left + 'px',
                width: placement.right - placement.left + 'px',
              }"
              @pointerenter="highlight(placement.entry.id)"
              @focusin="highlight(placement.entry.id)"
            >
              <button
                class="timeline-bar gantt-bar"
                :class="{
                  future: placement.entry.startDate > today,
                  ongoing: !placement.entry.endDate,
                  'is-short': placement.bar.width < 24,
                }"
                :style="barStyle(placement)"
                :title="`${placement.entry.title} · ${placement.entry.startDate} — ${placement.entry.endDate ?? (placement.entry.startDate > today ? tr('common.endingPending') : tr('common.present'))}`"
                :aria-label="
                  tr('timelineView.to', {
                    value0: placement.entry.title,
                    value1: placement.entry.startDate,
                    value2:
                      placement.entry.endDate ??
                      (placement.entry.startDate > today
                        ? tr('common.endingPending')
                        : tr('common.today')),
                    value3:
                      entryStatus(placement.entry, today) === 'ongoing'
                        ? tr('common.ongoing')
                        : tr('common.ended'),
                  })
                "
                @click="emit('view', placement.entry)"
              >
                <span class="gantt-bar-title"
                  >{{ placement.bar.continuesBefore ? '‹ ' : ''
                  }}{{ placement.entry.title }}</span
                >
                <span v-if="!placement.entry.endDate" class="gantt-bar-live">{{
                  tr('common.present')
                }}</span
                >{{ placement.bar.continuesAfter ? '›' : '' }}
              </button>
              <button
                v-for="group in placement.groups"
                :key="group.key"
                type="button"
                class="focus-marker timeline-focus-marker"
                :style="markerStyle(group, placement)"
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
    <div v-if="!visibleEntryCount" class="timeline-empty-overlay">
      <slot name="empty"></slot>
    </div>
  </div>
  <Teleport to="body">
    <div
      v-if="expandedLane && expandedItems.length"
      :id="lanePanelId"
      ref="lanePanel"
      popover="auto"
      class="timeline-focus-popover timeline-lane-popover"
      :style="lanePosition"
      role="dialog"
      :aria-labelledby="lanePanelId + '-heading'"
      @toggle="laneToggle"
      @keydown.esc="closeLane(true)"
    >
      <div class="focus-popover-heading">
        <h2 :id="lanePanelId + '-heading'">
          {{ tr('timelineView.trackEntries', { count: expandedItems.length }) }}
        </h2>
        <IconButton
          icon="close"
          :label="tr('timelineView.closeTrackEntries')"
          @click="closeLane(true)"
        />
      </div>
      <div class="timeline-lane-entry-list">
        <TimelineEntryLabel
          v-for="placement in expandedItems"
          :key="placement.entry.id"
          :entry="placement.entry"
          :today="today"
          :color="color(placement.entry)"
          :focus-total="focusTotals.get(placement.entry.id) ?? 0"
          :highlighted="highlighted === placement.entry.id"
          :readonly="readonly"
          :busy="busy"
          @highlight="highlight"
          @view="viewFromLane"
          @finish="emit('finish', $event)"
        />
      </div>
    </div>
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
      <strong>{{
        tr('timelineView.focusDays2', { value0: tipGroup.dates.length })
      }}</strong>
      <span
        >{{ tipGroup.dates.slice(0, 3).join('、')
        }}{{ tipGroup.dates.length > 3 ? '…' : '' }}</span
      >
      <small>{{ tr('common.clickOnTheColorBlockToView') }}</small>
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
              {{
                tr('timelineView.focusDatesDays', {
                  value0: details.dates.length,
                })
              }}
            </h2>
            <p>{{ focusTitle }}</p>
          </div>
          <IconButton
            icon="close"
            :label="tr('common.closeKeyDetails')"
            @click="closeFocus(true)"
          />
        </div>
        <p class="focus-popover-hint">
          {{ tr('timelineView.theDateContainedInTheCurrentMark') }}
        </p>
        <div class="date-list focus-date-list">
          <button
            v-for="date in details.dates.slice(detailOffset, detailOffset + 50)"
            :key="date"
            type="button"
            data-focus-date
            :aria-label="tr('timelineView.review', { value0: date })"
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
            :label="tr('common.previousPageFocusDates')"
            :disabled="detailOffset === 0"
            @click="pageFocus(-1)"
          /><span
            >{{ Math.floor(detailOffset / 50) + 1 }} /
            {{ Math.ceil(details.dates.length / 50) }}</span
          ><IconButton
            icon="chevron"
            :label="tr('common.nextPageFocusDates')"
            :disabled="detailOffset + 50 >= details.dates.length"
            @click="pageFocus(1)"
          />
        </div>
      </template>
    </div>
  </Teleport>
</template>
