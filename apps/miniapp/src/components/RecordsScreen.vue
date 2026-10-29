<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import {
  coversDate,
  dateOrdinal,
  emptyFilter,
  isCalendarDate,
  selectEntries,
  shiftDate,
  summarizeEntries,
  weekDates,
} from '@dayline/core';
import type { EntryDto, GuestMutation } from '@dayline/contracts';
import { requestedDay, useWorkspace, records, message } from '../workspace';
import { calendarLabel } from '../i18n';
import PageShell from './PageShell.vue';
import SyncStatus from './SyncStatus.vue';
import IconButton from './IconButton.vue';
import EntryCard from './EntryCard.vue';
import EntryDetails from './EntryDetails.vue';
import BottomSheet from './BottomSheet.vue';
import Filters from './Filters.vue';
defineProps<{ kind?: 'day' }>();
const w = useWorkspace(),
  { mode, snapshot, busy, error, notice, readonly, ensure, mutate } = w;
const date = ref(''),
  filter = ref(emptyFilter()),
  focusOnly = ref(false),
  limit = ref(30),
  confirm = ref<EntryDto | null>(null),
  detail = ref<EntryDto | null>(null),
  statsOpen = ref(false);
const today = computed(() => snapshot.value?.businessToday ?? '');
const dayEntries = computed(() =>
  snapshot.value && isCalendarDate(date.value)
    ? snapshot.value.entries.filter((e) =>
        coversDate(e, date.value, today.value),
      )
    : [],
);
const focusedIds = computed(
  () =>
    new Set(
      snapshot.value?.focusDays
        .filter((f) => f.focused && f.date === date.value)
        .map((f) => f.entryId) ?? [],
    ),
);
const dailyFocusCount = computed(
  () => dayEntries.value.filter((e) => focusedIds.value.has(e.id)).length,
);
const visible = computed(() =>
  selectEntries(dayEntries.value, today.value, filter.value)
    .filter((e) => !focusOnly.value || focusedIds.value.has(e.id))
    .sort(
      (a, b) =>
        Number(focusedIds.value.has(b.id)) - Number(focusedIds.value.has(a.id)),
    ),
);
const summary = computed(() => summarizeEntries(dayEntries.value, today.value));
const distribution = computed(
  () =>
    snapshot.value?.categories.flatMap((c) => {
      const count = summary.value.categories[c.id] ?? 0;
      return count
        ? [
            {
              ...c,
              count,
              percent: Math.round(
                (count / Math.max(1, summary.value.count)) * 100,
              ),
            },
          ]
        : [];
    }) ?? [],
);
const ring = computed(() => {
  let offset = 0;
  return (
    distribution.value
      .map((c) => {
        const start = offset;
        offset += (c.count / Math.max(1, summary.value.count)) * 100;
        return `${c.color} ${start}% ${offset}%`;
      })
      .join(',') || 'var(--line) 0% 100%'
  );
});
const week = computed(() =>
    isCalendarDate(date.value) ? weekDates(date.value) : [],
  ),
  weekdays = ['一', '二', '三', '四', '五', '六', '日'];
function dayCount(day: string) {
  return (
    snapshot.value?.entries.filter((e) => coversDate(e, day, today.value))
      .length ?? 0
  );
}
function focusedCount(day: string) {
  return (
    snapshot.value?.focusDays.filter((f) => f.focused && f.date === day)
      .length ?? 0
  );
}
function edit(entry?: EntryDto) {
  detail.value = null;
  uni.navigateTo({
    url: entry
      ? `/pages/entry/edit?id=${entry.id}`
      : `/pages/entry/edit?date=${date.value}&categoryId=${filter.value.categoryId}`,
  });
}
function selectDay(value: string) {
  date.value = value;
  detail.value = null;
}
async function action(mutation: GuestMutation, cloud: () => Promise<unknown>) {
  try {
    await mutate(mutation, cloud);
  } catch (cause) {
    error.value = message(cause);
  }
}
async function focus(entry: EntryDto) {
  const existing = snapshot.value?.focusDays.find(
      (f) => f.entryId === entry.id && f.date === date.value,
    ),
    input = {
      focused: !existing?.focused,
      expectedEntryVersion: entry.version,
      expectedFocusVersion: existing?.version ?? 0,
    };
  await action({ kind: 'focus', id: entry.id, date: date.value, input }, () =>
    records.focus(entry.id, date.value, input),
  );
}
async function finish(entry: EntryDto) {
  await action(
    { kind: 'finish', id: entry.id, expectedVersion: entry.version },
    () => records.finish(entry.id, entry.version),
  );
}
async function remove() {
  const entry = confirm.value;
  if (!entry) return;
  try {
    await mutate(
      { kind: 'remove', id: entry.id, expectedVersion: entry.version },
      () => records.remove(entry.id, entry.version),
    );
    confirm.value = null;
  } catch (cause) {
    error.value = message(cause);
  }
}
watch(
  [filter, focusOnly, date],
  () => {
    limit.value = 30;
  },
  { deep: true },
);
watch(today, (value) => {
  if (!date.value) date.value = value;
});
watch(
  () => `${mode.value}:${snapshot.value?.userId}`,
  () => {
    filter.value = emptyFilter();
    focusOnly.value = false;
    confirm.value = null;
    detail.value = null;
  },
);
watch(
  () => snapshot.value?.categories,
  () => {
    if (
      filter.value.categoryId &&
      !snapshot.value?.categories.some((c) => c.id === filter.value.categoryId)
    ) {
      filter.value.categoryId = '';
      notice.value = '分类已更新，已清除失效筛选。';
    }
  },
);
onMounted(ensure);
onShow(async () => {
  await ensure();
  if (!date.value) date.value = today.value;
  if (isCalendarDate(requestedDay.value)) {
    date.value = requestedDay.value;
    requestedDay.value = '';
  }
});
</script>
<template>
  <PageShell
    ><view class="screen-heading"
      ><view
        ><text class="eyebrow"
          >DAYLINE · {{ mode === 'guest' ? '游客' : '我的空间' }}</text
        ><text class="title">每日回看</text></view
      ><SyncStatus
    /></view>
    <view v-if="snapshot" class="daily-workspace">
      <view class="card calendar-card"
        ><view class="section-heading"
          ><picker
            mode="date"
            :value="date"
            start="0001-01-01"
            end="9999-12-31"
            @change="selectDay($event.detail.value)"
            ><view class="date-label">{{ calendarLabel(date) }} ▾</view></picker
          ><button class="text-button" @click="date = today">今天</button></view
        ><view class="week-nav"
          ><IconButton
            icon="back"
            label="上一周"
            :disabled="date === '0001-01-01'"
            @click="date = shiftDate(date, -7)" /><view class="week-strip"
            ><button
              v-for="day in week"
              :key="day"
              class="week-day"
              :class="{ selected: day === date }"
              :aria-label="day"
              @click="date = day"
            >
              <text class="week-label">{{
                weekdays[(dateOrdinal(day) - 1) % 7]
              }}</text
              ><text class="week-number">{{ Number(day.slice(8)) }}</text
              ><view class="week-dots"
                ><text v-if="dayCount(day)">{{ dayCount(day) }} 项</text
                ><text v-if="focusedCount(day)" class="focus-dot">●</text></view
              >
            </button></view
          ><IconButton
            icon="arrow"
            label="下一周"
            :disabled="date === '9999-12-31'"
            @click="date = shiftDate(date, 7)" /></view
      ></view>
      <view class="daily-summary"
        ><view
          ><text class="heading">这一天，正在做的事</text
          ><text class="muted"
            >{{ dayEntries.length }} 项经历 · {{ dailyFocusCount }} 项重点</text
          ></view
        ><button
          class="distribution-trigger"
          aria-label="查看分类分布"
          @click="statsOpen = true"
        >
          <view
            class="mini-donut"
            :style="{ background: 'conic-gradient(' + ring + ')' }"
            ><view>{{ summary.count }}</view></view
          >
        </button></view
      >
      <Filters
        v-model="filter"
        v-model:focus-only="focusOnly"
        :categories="snapshot.categories"
        :focus-count="dailyFocusCount"
        show-focus
      />
      <view class="section-heading"
        ><text class="muted"
          >{{ focusOnly ? '当日重点' : '事项' }} · {{ visible.length }} 项</text
        ><button
          class="text-button"
          :disabled="readonly || busy"
          @click="edit()"
        >
          ＋ 新建事项
        </button></view
      >
      <view v-if="!visible.length" class="empty"
        ><text class="heading">{{
          focusOnly ? '这一天还没有重点事项' : '这里还没有匹配的记录'
        }}</text
        ><text class="text muted">{{
          focusOnly
            ? '点击事项上的星标，留下这一天的重点。'
            : '试试其他分类和状态，或者记录一段经历。'
        }}</text></view
      >
      <EntryCard
        v-for="entry in visible.slice(0, limit)"
        :key="entry.id"
        :entry="entry"
        :category="
          snapshot.categories.find((c) => c.id === entry.categoryId)?.name ??
          '分类已变更'
        "
        :color="
          snapshot.categories.find((c) => c.id === entry.categoryId)?.color ??
          '#A0A4B3'
        "
        :today="today"
        :date="date"
        :focused="focusedIds.has(entry.id)"
        :busy="busy"
        :readonly="readonly"
        @view="detail = entry"
        @edit="edit(entry)"
        @focus="focus(entry)"
        @finish="finish(entry)"
        @remove="confirm = { ...entry }"
      />
      <button
        v-if="visible.length > limit"
        class="secondary"
        @click="limit += 30"
      >
        显示更多（{{ Math.min(limit, visible.length) }} / {{ visible.length }}）
      </button>
    </view>
    <view v-else class="empty"
      >{{ w.loading.value ? '正在读取记录…' : error || '准备记录你的生活' }}
    </view>
    <EntryDetails
      v-if="detail && snapshot"
      :entry="detail"
      :categories="snapshot.categories"
      :focus-days="snapshot.focusDays"
      :today="today"
      :readonly="readonly"
      @close="detail = null"
      @edit="edit(detail)"
      @day="selectDay"
    />
    <BottomSheet v-if="confirm" title="移入回收站？" @close="confirm = null"
      ><text class="text"
        >“{{ confirm.title }}”及其重点日期将保留 30 天，期间可以恢复。</text
      ><button class="danger" :disabled="busy" @click="remove">
        确认移入回收站</button
      ><button class="secondary" :disabled="busy" @click="confirm = null">
        取消
      </button></BottomSheet
    >
    <BottomSheet v-if="statsOpen" title="分类分布" @close="statsOpen = false"
      ><text class="text muted"
        >{{ date }} · {{ summary.count }} 项经历，每项计数一次。</text
      ><view v-for="c in distribution" :key="c.id" class="distribution-row"
        ><text :style="{ color: c.color }">●</text><text>{{ c.name }}</text
        ><view class="distribution-bar"
          ><view
            :style="{
              width: c.percent + '%',
              backgroundColor: c.color,
            }" /></view
        ><text>{{ c.count }} 项 · {{ c.percent }}%</text></view
      ><text v-if="!distribution.length" class="muted"
        >这一天还没有记录。</text
      ></BottomSheet
    >
  </PageShell>
</template>
<style scoped>
.calendar-card {
  padding: 16rpx 12rpx;
  margin-top: 0;
}
.date-label {
  font-size: 27rpx;
  font-weight: 600;
  padding: 12rpx;
}
.week-nav {
  display: flex;
  align-items: center;
}
.week-nav > .icon-button {
  min-width: 28px;
  width: 28px;
  padding: 4px;
}
.week-strip {
  flex: 1;
  min-width: 0;
  gap: 2rpx;
}
.week-day {
  background: transparent;
  color: var(--muted);
  margin: 0;
  padding: 10rpx 0;
  min-width: 0;
  min-height: 86px;
}
.week-day.selected {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.week-number {
  font-size: 32rpx;
  margin: 8rpx 0;
}
.week-label {
  font-size: 21rpx;
}
.week-dots {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3rpx;
  font-size: 17rpx;
  height: 18rpx;
  white-space: nowrap;
}
.focus-dot {
  color: var(--warning);
  font-size: 14rpx;
}
.daily-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 28rpx 0 8rpx;
  gap: 20rpx;
}
.daily-summary .muted {
  display: block;
  margin-top: 8rpx;
}
.distribution-trigger {
  background: transparent;
  padding: 6rpx;
  margin: 0;
  flex-shrink: 0;
}
.mini-donut {
  width: 88rpx;
  height: 88rpx;
  padding: 10rpx;
  border-radius: 50%;
  box-sizing: border-box;
}
.mini-donut view {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  height: 100%;
  width: 100%;
  background: var(--canvas);
  font-size: 26rpx;
  color: var(--ink);
}
.distribution-row {
  display: flex;
  align-items: center;
  gap: 14rpx;
  font-size: 24rpx;
  margin: 24rpx 0;
}
.distribution-row > text:last-child {
  white-space: nowrap;
  color: var(--muted);
  font-size: 22rpx;
}
.distribution-bar {
  flex: 1;
  height: 8rpx;
  border-radius: 4rpx;
  background: var(--line);
}
.distribution-bar view {
  height: 100%;
  border-radius: 4rpx;
}
</style>
