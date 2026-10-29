<script setup lang="ts">
import { tr } from '../i18n/index';
import { msg } from '@dayline/locales';
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
  weekdays = computed(() => [
    tr('common.mon'),
    tr('common.tue'),
    tr('common.wed'),
    tr('common.thu'),
    tr('common.fri'),
    tr('common.sat'),
    tr('common.sun'),
  ]);
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
      notice.value = msg('recordsScreen.theCategoryHasChangedAndTheFilter');
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
      >DAYLINE ·
      {{
        mode === 'guest'
          ? tr('recordsScreen.guestSaveLocallyOnly')
          : tr('common.cloudRecording')
      }}</text
    ><text class="title">{{
      kind === 'day' ? tr('common.dailyReview') : tr('common.allRecords')
    }}</text
    ><text v-if="loading" class="text">{{
      tr('recordsScreen.readingCompleteRecord')
    }}</text
    ><text v-if="error" class="text error" role="alert">{{ error }}</text
    ><text v-if="notice" class="text notice">{{ notice }}</text
    ><button class="secondary" :disabled="busy || loading" @click="load">
      {{ tr('common.completeReadAgain') }}</button
    ><template v-if="snapshot"
      ><text class="text muted">{{
        tr('recordsScreen.beijingTime', {
          value0:
            mode === 'guest'
              ? tr('recordsScreen.onlySavedOnThisDeviceCanBe')
              : tr('recordsScreen.saveOnlineUnsavedInputOnlyRemainsOn'),
          value1: today,
        })
      }}</text
      ><button v-if="!readonly" :disabled="busy" @click="edit()">
        {{ tr('common.createNewEntry') }}</button
      ><view class="card"
        ><text class="text">{{
          kind === 'day'
            ? tr('common.lookBackDate')
            : tr('common.keyOperationDate')
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
          :aria-label="tr('recordsScreen.dateYyyyMmDd')"
          placeholder="YYYY-MM-DD（0001–9999）"
        /><text v-if="!isCalendarDate(date)" class="text error">{{
          tr('recordsScreen.pleaseEnterAValidYyyyMmDd')
        }}</text
        ><view class="actions"
          ><button
            class="secondary"
            :disabled="!isCalendarDate(date) || date === '0001-01-01'"
            @click="date = shiftDate(date, -1)"
          >
            {{ tr('common.theDayBefore') }}</button
          ><button class="secondary" @click="date = today">
            {{ tr('common.today') }}</button
          ><button
            class="secondary"
            :disabled="!isCalendarDate(date) || date === '9999-12-31'"
            @click="date = shiftDate(date, 1)"
          >
            {{ tr('common.theNextDay') }}
          </button></view
        ><view v-if="kind === 'day'" class="week-strip"
          ><view
            v-for="day in week"
            :key="day"
            class="week-day"
            :class="{ selected: day === date }"
            role="button"
            @click="date = day"
            ><text>{{
              tr('recordsScreen.week', {
                value0: weekdays[(dateOrdinal(day) - 1) % 7],
              })
            }}</text
            ><text>{{ day.slice(5) }}</text></view
          ></view
        ><text v-if="date > today" class="text muted">{{
          tr('recordsScreen.futureDatesCanOnlyBeViewedWithin')
        }}</text></view
      ><Filters v-model="filter" :categories="snapshot.categories" /><view
        class="card"
        ><text class="heading">{{
          tr('recordsScreen.stillInProgressTodayRelatingToCategory', {
            value0:
              kind === 'day'
                ? tr('common.selectedDateEntry')
                : tr('common.allEntriesAfterFiltering'),
            value1: summary.count,
            value2: summary.ongoing,
            value3: summary.categoryCount,
          })
        }}</text
        ><text v-if="kind === 'day'" class="text">{{
          tr('recordsScreen.selectedDayFocus', { value0: dailyFocusCount })
        }}</text
        ><text class="text muted">{{
          tr('recordsScreen.categoryDistributionByNumberOfEntries')
        }}</text
        ><text v-for="(count, id) in summary.categories" :key="id" class="text"
          >{{ snapshot.categories.find((c) => c.id === id)?.name }}
          {{ count }}（{{ Math.round((count / summary.count) * 100) }}%）</text
        ></view
      ><text v-if="!visible.length" class="text empty">{{
        filter.search || filter.categoryId || filter.status !== 'all'
          ? tr('recordsScreen.noResultsAfterFilteringPleaseAdjustOr')
          : !snapshot.entries.length
            ? tr('recordsScreen.thereIsNoEntryInTheCurrent')
            : tr('recordsScreen.thereAreNoCoveredEntriesOnThis')
      }}</text
      ><EntryCard
        v-for="entry in visible.slice(0, limit)"
        :key="entry.id"
        :entry="entry"
        :category="
          snapshot.categories.find((c) => c.id === entry.categoryId)?.name ??
          tr('common.categoryHasChanged')
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
        {{
          tr('recordsScreen.showMore', {
            value0: Math.min(limit, visible.length),
            value1: visible.length,
          })
        }}
      </button></template
    ><view v-if="confirm" class="card confirmation"
      ><text class="text">{{
        tr('recordsScreen.moveAndEmphasisToTrashAndKeep', {
          value0: confirm.title,
        })
      }}</text
      ><button :disabled="busy" @click="remove">
        {{ tr('common.confirmMoveIntoTrash') }}</button
      ><button class="secondary" :disabled="busy" @click="confirm = null">
        {{ tr('common.cancel') }}
      </button></view
    ></view
  >
</template>
