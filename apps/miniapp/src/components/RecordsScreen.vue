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
import EntryCard from './EntryCard.vue';
import Filters from './Filters.vue';
const props = defineProps<{ kind: 'day' | 'entries' }>();
const {
  mode,
  snapshot,
  loading,
  busy,
  error,
  notice,
  readonly,
  ensure,
  load,
  mutate,
} = useWorkspace();
const date = ref(''),
  filter = ref(emptyFilter()),
  limit = ref(30),
  confirm = ref<EntryDto | null>(null);
const today = computed(() => snapshot.value?.businessToday ?? '');
const visible = computed(() =>
  snapshot.value
    ? selectEntries(snapshot.value.entries, today.value, filter.value).filter(
        (e) =>
          props.kind === 'entries' ||
          (isCalendarDate(date.value) &&
            coversDate(e, date.value, today.value)),
      )
    : [],
);
const summary = computed(() => summarizeEntries(visible.value, today.value));
const dailyFocusCount = computed(() => {
  const ids = new Set(visible.value.map((e) => e.id));
  return (
    snapshot.value?.focusDays.filter(
      (f) => f.focused && f.date === date.value && ids.has(f.entryId),
    ).length ?? 0
  );
});
const week = computed(() =>
    isCalendarDate(date.value) ? weekDates(date.value) : [],
  ),
  weekdays = ['一', '二', '三', '四', '五', '六', '日'];
function edit(entry?: EntryDto) {
  uni.navigateTo({ url: `/pages/entry/edit${entry ? '?id=' + entry.id : ''}` });
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
async function finishEntry(e: EntryDto) {
  await action({ kind: 'finish', id: e.id, expectedVersion: e.version }, () =>
    records.finish(e.id, e.version),
  );
}
async function remove() {
  const e = confirm.value;
  if (!e) return;
  await action({ kind: 'remove', id: e.id, expectedVersion: e.version }, () =>
    records.remove(e.id, e.version),
  );
  confirm.value = null;
}
watch(filter, () => (limit.value = 30), { deep: true });
watch(today, (value) => {
  if (!date.value) date.value = value;
});
onMounted(ensure);
watch(
  () => snapshot.value?.userId,
  () => {
    filter.value = emptyFilter();
  },
);
watch(mode, () => {
  filter.value = emptyFilter();
  confirm.value = null;
});
watch(
  () => snapshot.value?.categories,
  () => {
    if (
      filter.value.categoryId &&
      !snapshot.value?.categories.some((c) => c.id === filter.value.categoryId)
    ) {
      filter.value.categoryId = '';
      notice.value = '分类已变化，筛选已清除。';
    }
  },
);
onShow(async () => {
  await ensure();
  if (!date.value) date.value = today.value;
  const requested = requestedDay.value;
  if (
    props.kind === 'day' &&
    typeof requested === 'string' &&
    isCalendarDate(requested)
  ) {
    date.value = requested;
    requestedDay.value = '';
  }
});
</script>
<template>
  <view class="page"
    ><text class="subtitle"
      >DAYLINE · {{ mode === 'guest' ? '游客 · 仅本机保存' : '云端记录' }}</text
    ><text class="title">{{ kind === 'day' ? '每日回看' : '全部记录' }}</text
    ><text v-if="loading" class="text">正在完整读取记录…</text
    ><text v-if="error" class="text error" role="alert">{{ error }}</text
    ><text v-if="notice" class="text notice">{{ notice }}</text
    ><button class="secondary" :disabled="busy || loading" @click="load">
      重新完整读取</button
    ><template v-if="snapshot"
      ><text class="text muted"
        >{{
          mode === 'guest'
            ? '仅保存在此设备，登录后可同步。'
            : '在线保存，未保存输入仅保留在当前页面。'
        }}
        北京时间 {{ today }}</text
      ><button v-if="!readonly" :disabled="busy" @click="edit()">
        ＋ 新建事项</button
      ><view class="card"
        ><text class="text">{{
          kind === 'day' ? '回看日期' : '重点操作日期'
        }}</text
        ><picker
          mode="date"
          :value="date"
          start="0001-01-01"
          end="9999-12-31"
          @change="date = $event.detail.value"
          ><view class="picker">{{ date }} ▾</view></picker
        ><input
          v-model="date"
          aria-label="日期 YYYY-MM-DD"
          placeholder="YYYY-MM-DD（0001–9999）"
        /><text v-if="!isCalendarDate(date)" class="text error"
          >请输入合法 YYYY-MM-DD 日期。</text
        ><view class="actions"
          ><button
            class="secondary"
            :disabled="!isCalendarDate(date) || date === '0001-01-01'"
            @click="date = shiftDate(date, -1)"
          >
            前一天</button
          ><button class="secondary" @click="date = today">今天</button
          ><button
            class="secondary"
            :disabled="!isCalendarDate(date) || date === '9999-12-31'"
            @click="date = shiftDate(date, 1)"
          >
            后一天
          </button></view
        ><view v-if="kind === 'day'" class="week-strip"
          ><view
            v-for="day in week"
            :key="day"
            class="week-day"
            :class="{ selected: day === date }"
            role="button"
            @click="date = day"
            ><text>周{{ weekdays[(dateOrdinal(day) - 1) % 7] }}</text
            ><text>{{ day.slice(5) }}</text></view
          ></view
        ><text v-if="date > today" class="text muted"
          >未来日期仅浏览计划范围，不可标记重点。</text
        ></view
      ><Filters v-model="filter" :categories="snapshot.categories" /><view
        class="card"
        ><text class="heading"
          >{{ kind === 'day' ? '选定日事项' : '筛选后全部事项' }}
          {{ summary.count }} · 今天仍在进行 {{ summary.ongoing }} · 涉及分类
          {{ summary.categoryCount }}</text
        ><text v-if="kind === 'day'" class="text"
          >选定日重点 {{ dailyFocusCount }}</text
        ><text class="text muted">分类分布 · 按事项数量</text
        ><text v-for="(count, id) in summary.categories" :key="id" class="text"
          >{{ snapshot.categories.find((c) => c.id === id)?.name }}
          {{ count }}（{{ Math.round((count / summary.count) * 100) }}%）</text
        ></view
      ><text v-if="!visible.length" class="text empty">{{
        filter.search || filter.categoryId || filter.status !== 'all'
          ? '筛选后无结果，请调整或清除筛选。'
          : !snapshot.entries.length
            ? '当前空间还没有事项，开始记录自己的经历。'
            : '这一天没有覆盖的事项。'
      }}</text
      ><EntryCard
        v-for="entry in visible.slice(0, limit)"
        :key="entry.id"
        :entry="entry"
        :category="
          snapshot.categories.find((c) => c.id === entry.categoryId)?.name ??
          '分类已变化'
        "
        :color="
          snapshot.categories.find((c) => c.id === entry.categoryId)?.color ??
          '#A0A4B3'
        "
        :today="today"
        :date="isCalendarDate(date) ? date : ''"
        :focused="
          snapshot.focusDays.some(
            (f) => f.entryId === entry.id && f.date === date && f.focused,
          )
        "
        :busy="busy"
        :readonly="readonly"
        @edit="edit(entry)"
        @focus="focus(entry)"
        @finish="finishEntry(entry)"
        @remove="confirm = { ...entry }"
      /><button
        v-if="visible.length > limit"
        class="secondary"
        @click="limit += 30"
      >
        显示更多（{{ Math.min(limit, visible.length) }} / {{ visible.length }}）
      </button></template
    ><view v-if="confirm" class="card confirmation"
      ><text class="text"
        >将“{{ confirm.title }}”及重点移入回收站，保留 30 天？</text
      ><button :disabled="busy" @click="remove">确认移入回收站</button
      ><button class="secondary" :disabled="busy" @click="confirm = null">
        取消
      </button></view
    ></view
  >
</template>
