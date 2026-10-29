<script setup lang="ts">
import { tickLabel } from '../../i18n';
import { tr } from '../../i18n/index';
import { computed, nextTick, ref, watch } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import {
  dateOrdinal,
  emptyFilter,
  isCalendarDate,
  selectEntries,
  shiftMonth,
  summarizeEntries,
  timelineBar,
  timelineFocusGroups,
  timelineWindow,
  visibleRows,
} from '@dayline/core';
import type { TimelineScale } from '@dayline/core';
import type { EntryDto } from '@dayline/contracts';
import { requestedDay, useWorkspace } from '../../workspace';
import Filters from '../../components/Filters.vue';
const { mode, snapshot, loading, error, notice, ensure, load } = useWorkspace();
const detailOffset = ref(0);
const filter = ref(emptyFilter()),
  scale = ref<TimelineScale>('month'),
  anchor = ref(''),
  scrollTop = ref(0),
  scrollLeft = ref(0),
  details = ref<{ entryId: string; dates: string[] } | null>(null);
const scales = computed(() => [
    tr('common.month2'),
    tr('common.quarter2'),
    tr('common.year2'),
    tr('common.allTime'),
  ]),
  scaleValues = ['month', 'quarter', 'year', 'all'] as const;
const today = computed(() => snapshot.value?.businessToday ?? '');
const filtered = computed(() =>
  snapshot.value
    ? selectEntries(snapshot.value.entries, today.value, filter.value)
    : [],
);
const window = computed(() =>
  timelineWindow(
    filtered.value,
    today.value,
    scale.value,
    anchor.value || today.value,
    700,
    true,
  ),
);
const entries = computed(() =>
  selectEntries(filtered.value, today.value, filter.value, window.value),
);
const summary = computed(() => summarizeEntries(entries.value, today.value));
const rows = computed(() =>
  visibleRows(entries.value.length, scrollTop.value, 420, 56),
);
const visible = computed(() =>
  entries.value.slice(rows.value.start, rows.value.end),
);
const groups = computed(() =>
  timelineFocusGroups(
    entries.value,
    snapshot.value?.focusDays ?? [],
    today.value,
    window.value,
  ),
);
function color(e: EntryDto) {
  return (
    snapshot.value?.categories.find((c) => c.id === e.categoryId)?.color ??
    '#7970CF'
  );
}
function bar(e: EntryDto) {
  return timelineBar(e, today.value, window.value);
}
function syncX(event: { detail: { scrollLeft: number } }) {
  if (Math.abs(scrollLeft.value - event.detail.scrollLeft) > 1)
    scrollLeft.value = event.detail.scrollLeft;
}
function move(amount: number) {
  anchor.value = shiftMonth(
    anchor.value,
    amount * (scale.value === 'year' ? 12 : scale.value === 'quarter' ? 3 : 1),
  );
}
async function locate() {
  anchor.value = today.value;
  if (scale.value === 'all' && window.value.todayX === null)
    scale.value = 'month';
  await nextTick();
  scrollLeft.value = Math.max(0, (window.value.todayX ?? 0) - 100);
}
let touchX = 0,
  touchY = 0,
  suppressUntil = 0;
function touchStart(event: {
  touches: { readonly [index: number]: { clientX: number; clientY: number } };
}) {
  touchX = event.touches[0]?.clientX ?? 0;
  touchY = event.touches[0]?.clientY ?? 0;
}
function touchMove(event: {
  touches: { readonly [index: number]: { clientX: number; clientY: number } };
}) {
  if (
    Math.abs((event.touches[0]?.clientX ?? 0) - touchX) > 8 ||
    Math.abs((event.touches[0]?.clientY ?? 0) - touchY) > 8
  )
    suppressUntil = Date.now() + 350;
}
function edit(entry: EntryDto) {
  if (Date.now() < suppressUntil) return;
  uni.navigateTo({ url: '/pages/entry/edit?id=' + entry.id });
}
function focusDetail(group: { entryId: string; dates: string[] }) {
  if (Date.now() >= suppressUntil) {
    details.value = group;
    detailOffset.value = 0;
  }
}
function create() {
  uni.navigateTo({ url: '/pages/entry/edit' });
}
function day(date: string) {
  requestedDay.value = date;
  uni.switchTab({ url: '/pages/day/index' });
}
watch(
  () => [scale.value, anchor.value],
  () => {
    scrollTop.value = 0;
    scrollLeft.value = 0;
  },
);
watch(
  () => entries.value.length,
  (count) =>
    (scrollTop.value = Math.max(
      0,
      Math.min(scrollTop.value, count * 56 - 420),
    )),
);
watch(
  () => snapshot.value?.userId,
  () => {
    filter.value = emptyFilter();
  },
);
watch(mode, () => {
  filter.value = emptyFilter();
  details.value = null;
});
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
  if (!anchor.value) anchor.value = today.value;
});
</script>
<template>
  <view class="page timeline-page"
    ><text class="subtitle"
      >DAYLINE ·
      {{
        mode === 'guest'
          ? tr('recordsScreen.guestSaveLocallyOnly')
          : tr('common.cloudRecording')
      }}</text
    ><text class="title">{{ tr('common.completeTimeline') }}</text
    ><text v-if="loading" class="text">{{ tr('common.loadingRecords2') }}</text
    ><text v-if="error" class="text error">{{ error }}</text
    ><text v-if="notice" class="text notice">{{ notice }}</text
    ><button class="secondary" @click="load">
      {{ tr('common.completeReadAgain') }}</button
    ><template v-if="snapshot"
      ><button @click="create">{{ tr('common.createNewEntry') }}</button
      ><Filters v-model="filter" :categories="snapshot.categories" /><view
        class="card"
        ><picker
          :range="scales"
          @change="scale = scaleValues[Number($event.detail.value)] ?? 'month'"
          ><view class="picker"
            >{{ scales[scaleValues.indexOf(scale)] }} ▾</view
          ></picker
        ><text class="text">{{ tr('common.dateToView') }}</text
        ><input
          v-model="anchor"
          :aria-label="tr('mini.timelineAnchorYyyyMmDd')"
          placeholder="YYYY-MM-DD"
        /><text v-if="!isCalendarDate(anchor)" class="text error">{{
          tr('common.pleaseEnterAValidDate')
        }}</text
        ><view class="actions"
          ><button
            class="secondary"
            :disabled="
              scale === 'all' ||
              !isCalendarDate(anchor) ||
              anchor === '0001-01-01'
            "
            @click="move(-1)"
          >
            {{ tr('common.previousPeriod') }}</button
          ><button class="secondary" @click="locate">
            {{ tr('common.goToToday') }}</button
          ><button
            class="secondary"
            :disabled="
              scale === 'all' ||
              !isCalendarDate(anchor) ||
              anchor.slice(0, 4) === '9999'
            "
            @click="move(1)"
          >
            {{ tr('common.nextPeriod') }}
          </button></view
        ><text class="text muted">{{
          tr('mini.slideTheDateHorizontallyAndBrowseThe')
        }}</text
        ><text class="text">{{
          tr('mini.selectedEntireRangeEntryStillInProgress', {
            value0: summary.count,
            value1: summary.ongoing,
            value2: summary.categoryCount,
          })
        }}</text
        ><text class="text muted">{{
          tr('recordsScreen.categoryDistributionByNumberOfEntries')
        }}</text
        ><text v-for="(count, id) in summary.categories" :key="id" class="text"
          >{{ snapshot.categories.find((c) => c.id === id)?.name }}
          {{ count }}</text
        ></view
      ><text v-if="!entries.length" class="text empty">{{
        filter.search || filter.categoryId || filter.status !== 'all'
          ? tr('recordsScreen.noResultsAfterFilteringPleaseAdjustOr')
          : tr('mini.thereIsNoEntryInTheCurrent')
      }}</text>
      <view
        v-if="isCalendarDate(anchor)"
        class="mini-timeline"
        @touchstart="touchStart"
        @touchmove="touchMove"
        ><view class="timeline-head"
          ><view class="name-heading">{{ tr('common.entryDate') }}</view
          ><scroll-view
            scroll-x
            :scroll-left="scrollLeft"
            class="date-header"
            @scroll="syncX"
            ><view class="axis" :style="{ width: window.width + 'px' }"
              ><text
                v-for="tick in window.ticks"
                :key="tick.day"
                class="tick"
                :style="{ left: tick.x + 'px' }"
                >{{ tickLabel(tick.label) }}</text
              ></view
            ></scroll-view
          ></view
        >
        <scroll-view
          scroll-y
          class="timeline-body"
          :scroll-top="scrollTop"
          @scroll="scrollTop = $event.detail.scrollTop"
          ><view class="timeline-columns"
            ><view class="name-column"
              ><view :style="{ height: rows.before + 'px' }"></view
              ><view
                v-for="entry in visible"
                :key="entry.id"
                class="name-row"
                :style="{ borderLeft: `4px solid ${color(entry)}` }"
                role="button"
                @click="edit(entry)"
                >{{ entry.title }}</view
              ><view :style="{ height: rows.after + 'px' }"></view></view
            ><scroll-view
              scroll-x
              :scroll-left="scrollLeft"
              class="date-body"
              :style="{ height: entries.length * 56 + 'px' }"
              @scroll="syncX"
              ><view :style="{ width: window.width + 'px' }"
                ><view :style="{ height: rows.before + 'px' }"></view
                ><view
                  v-for="entry in visible"
                  :key="entry.id"
                  class="track"
                  :style="{ width: window.width + 'px' }"
                  ><view
                    v-if="window.todayX !== null"
                    class="today-line"
                    :style="{ left: window.todayX + 'px' }"
                  ></view
                  ><view
                    v-if="bar(entry)"
                    class="bar"
                    :class="{ future: entry.startDate > today }"
                    :style="{
                      left: bar(entry)?.left + 'px',
                      width: bar(entry)?.width + 'px',
                      backgroundColor:
                        entry.startDate > today
                          ? '#F0EEFB'
                          : color(entry) + '88',
                      borderColor: color(entry),
                    }"
                    role="button"
                    :aria-label="
                      tr('mini.to', {
                        value0: entry.title,
                        value1: entry.startDate,
                        value2:
                          entry.endDate ??
                          (entry.startDate > today
                            ? tr('common.endingPending')
                            : tr('common.today')),
                      })
                    "
                    @click="edit(entry)"
                    ><text
                      >{{ bar(entry)?.continuesBefore ? '‹' : ''
                      }}{{ bar(entry)?.continuesAfter ? '›' : ''
                      }}{{
                        entry.startDate > today ? tr('common.notStarted') : ''
                      }}</text
                    ></view
                  ><view
                    v-for="group in groups.filter(
                      (g) => g.entryId === entry.id,
                    )"
                    :key="group.key"
                    class="focus"
                    :style="{ left: group.left + 'px' }"
                    role="button"
                    :aria-label="
                      tr('timelineView.focusDays2', {
                        value0: group.dates.length,
                      })
                    "
                    @click.stop="focusDetail(group)"
                    >★{{
                      group.dates.length > 1 ? group.dates.length : ''
                    }}</view
                  ></view
                ><view
                  :style="{ height: rows.after + 'px' }"
                ></view></view></scroll-view></view></scroll-view
      ></view>
      <view v-if="details" class="card"
        ><text class="heading">{{
          tr('mini.focusDays', {
            value0: entries.find((e) => e.id === details?.entryId)?.title,
            value1: details.dates.length,
          })
        }}</text
        ><scroll-view scroll-y class="dates-scroll"
          ><button
            v-for="date in details.dates.slice(
              detailOffset,
              detailOffset + 100,
            )"
            :key="date"
            class="secondary"
            @click="day(date)"
          >
            {{ tr('mini.review', { value0: date }) }}
          </button></scroll-view
        ><text class="text">{{
          tr('mini.page', {
            value0: Math.floor(detailOffset / 100) + 1,
            value1: Math.ceil(details.dates.length / 100),
          })
        }}</text
        ><view class="actions"
          ><button
            class="secondary"
            :disabled="detailOffset === 0"
            @click="detailOffset -= 100"
          >
            {{ tr('common.previousPageFocusDates') }}</button
          ><button
            class="secondary"
            :disabled="detailOffset + 100 >= details.dates.length"
            @click="detailOffset += 100"
          >
            {{ tr('common.nextPageFocusDates') }}
          </button></view
        ><button class="secondary" @click="details = null">
          {{ tr('common.closeKeyDetails') }}
        </button></view
      >
      <view class="card"
        ><text class="heading">{{ tr('common.dateAndSpanDetails') }}</text
        ><text class="text muted">{{
          tr('mini.equivalentInformationOutsideTheChartClickTo')
        }}</text
        ><view
          v-for="entry in visible"
          :key="entry.id"
          class="text"
          role="button"
          @click="edit(entry)"
          >{{ entry.title }} · {{ entry.startDate }} →
          {{
            entry.endDate ??
            (entry.startDate > today
              ? tr('common.endingPending')
              : tr('common.present'))
          }}
          ·
          {{
            entry.startDate > today
              ? tr('common.notStarted')
              : dateOrdinal(entry.endDate ?? today) -
                dateOrdinal(entry.startDate) +
                1 +
                tr('common.days')
          }}</view
        ></view
      ></template
    ></view
  >
</template>
<style scoped>
.mini-timeline {
  background: white;
  border: 1px solid #eef0f5;
  border-radius: 12px;
  overflow: hidden;
}
.timeline-head,
.timeline-columns {
  display: flex;
}
.name-heading,
.name-column {
  width: 112px;
  flex-shrink: 0;
}
.name-heading {
  height: 52px;
  box-sizing: border-box;
  padding: 16px 8px;
  background: #f0eefb;
  font-size: 13px;
}
.date-header,
.date-body {
  flex: 1;
  min-width: 0;
}
.axis {
  height: 52px;
  position: relative;
  background: #f7f8fc;
}
.tick {
  position: absolute;
  top: 18px;
  font-size: 10px;
  border-left: 1px solid #daddea;
  white-space: nowrap;
  padding-left: 3px;
  color: #687086;
}
.timeline-body {
  height: 420px;
}
.name-row,
.track {
  height: 56px;
  box-sizing: border-box;
  border-bottom: 1px solid #eef0f5;
}
.name-row {
  padding: 9px 8px;
  font-size: 13px;
  line-height: 19px;
  overflow: hidden;
  background: white;
  border-right: 1px solid #eef0f5;
}
.track {
  position: relative;
}
.bar {
  position: absolute;
  top: 22px;
  height: 24px;
  background: #c5bff0;
  border-radius: 4px;
  font-size: 10px;
  color: #51408a;
  min-width: 4px;
}
.bar.future {
  background: #f0eefb;
  border: 1px dashed #7970cf;
}
.today-line {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 2px solid #c47982;
}
.focus {
  position: absolute;
  top: 0;
  width: 44px;
  height: 44px;
  background: #f0eefb;
  border-radius: 4px;
  color: #6550a1;
  font-size: 12px;

  text-align: center;
  line-height: 44px;
  transform: translateX(-50%);
}
</style>
