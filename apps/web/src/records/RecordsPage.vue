<script setup lang="ts">
import { calendarLabel } from '../i18n';
import { formatBeijingTime, spanLabel, tr } from '../i18n/index';

import { msg } from '@dayline/locales';
import IconButton from '../components/IconButton.vue';

import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  toRefs,
  watch,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  coversDate,
  emptyFilter,
  isCalendarDate,
  selectEntries,
  shiftDate,
  summarizeEntries,
  timelineCanvasWindow,
  TIMELINE_RECENT_POSITION,
  weekDates,
  dateOrdinal,
  ordinalDate,
} from '@dayline/core';

import type {
  CreateEntryInput,
  EntryDto,
  GuestMutation,
  PatchEntryInput,
  EntryDraft,
} from '@dayline/contracts';
import { useWorkspace } from './workspace';
import { records, errorMessage } from './record-service';
import EntryEditor from './EntryEditor.vue';
import EntryDetails from './EntryDetails.vue';
import EntryRow from './EntryRow.vue';
import CategoryManager from './CategoryManager.vue';
import TimelineView from './TimelineView.vue';
import PlannerIcon from '../components/PlannerIcon.vue';
import PlannerDialog from '../components/PlannerDialog.vue';
import FileTools from '../components/FileTools.vue';
import CategoryTabs from '../components/CategoryTabs.vue';
import InlineSearch from '../components/InlineSearch.vue';
import FocusHelp from '../components/FocusHelp.vue';
import {
  localEnvironment,
  localRepository,
} from '../adapters/local-repository';
import { useAccount } from '../account';
import { recordView } from './view-state';
import { FOCUS_HEAT_STEPS } from './focus-heat';
const route = useRoute(),
  router = useRouter();
const {
  mode,
  identityState,
  snapshot,
  loading,
  busy,
  error,
  notice,
  serverTime,
  readonly,
  ensure,
  mutate,
} = useWorkspace();
const { loading: accountLoading } = useAccount();
const { selectedDate, filter, scale, anchor, limit } = toRefs(recordView);
const timeline = ref<InstanceType<typeof TimelineView> | null>(null);
const editor = ref<{
    entry: EntryDto | null;
    key: string;
    draft?: EntryDraft;
  } | null>(null),
  confirm = ref<
    | { kind: 'delete' | 'purge'; entry: EntryDto }
    | { kind: 'clear'; dataVersion: string }
    | null
  >(null);
const categoryReturnPath = ref('/day');
const view = computed(() =>
  route.path.startsWith('/timeline')
    ? 'timeline'
    : route.path === '/trash'
      ? 'trash'
      : route.path === '/categories'
        ? 'categories'
        : route.path.startsWith('/entries/')
          ? 'editor'
          : 'day',
);
const contentView = computed(() =>
  view.value === 'editor' || view.value === 'categories'
    ? recordView.activeView
    : view.value,
);
const today = computed(() => snapshot.value?.businessToday ?? '');
const filtered = computed(() =>
  snapshot.value
    ? selectEntries(snapshot.value.entries, today.value, filter.value)
    : [],
);
const range = computed(() =>
  timelineCanvasWindow(
    snapshot.value?.entries ?? [],
    today.value,
    scale.value,
    recordView.timelineCameraDay ?? undefined,
    900,
    recordView.timelineCameraDays ?? undefined,
  ),
);
const visible = computed(() => {
  if (!snapshot.value) return [];
  if (contentView.value === 'day') {
    const focused = new Set(
      snapshot.value.focusDays
        .filter((day) => day.date === selectedDate.value && day.focused)
        .map((day) => day.entryId),
    );
    return filtered.value
      .filter(
        (entry) =>
          isCalendarDate(selectedDate.value) &&
          coversDate(entry, selectedDate.value, today.value) &&
          (!recordView.focusOnly || focused.has(entry.id)),
      )
      .sort((a, b) => Number(focused.has(b.id)) - Number(focused.has(a.id)));
  }
  if (contentView.value === 'timeline')
    return selectEntries(
      filtered.value,
      today.value,
      { ...emptyFilter(), status: 'all' },
      range.value,
    ).sort((a, b) =>
      filter.value.sort === 'asc'
        ? a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id)
        : b.startDate.localeCompare(a.startDate) || a.id.localeCompare(b.id),
    );
  return filtered.value;
});
const summaryEntries = computed(() =>
  contentView.value === 'day' && snapshot.value
    ? snapshot.value.entries.filter(
        (entry) =>
          isCalendarDate(selectedDate.value) &&
          coversDate(entry, selectedDate.value, today.value),
      )
    : visible.value,
);
const summary = computed(() =>
  summarizeEntries(summaryEntries.value, today.value),
);
const dailyFocusCount = computed(() => {
  const ids = new Set(summaryEntries.value.map((e) => e.id));
  return (
    snapshot.value?.focusDays.filter(
      (f) => f.focused && f.date === selectedDate.value && ids.has(f.entryId),
    ).length ?? 0
  );
});
const week = computed(() =>
  isCalendarDate(selectedDate.value) ? weekDates(selectedDate.value) : [],
);
const weekSummary = computed(() =>
  week.value.map((date) => {
    const entries =
      snapshot.value?.entries.filter((entry) =>
        coversDate(entry, date, today.value),
      ) ?? [];
    const ids = new Set(entries.map((entry) => entry.id));
    const count =
      snapshot.value?.focusDays.filter(
        (f) => f.date === date && f.focused && ids.has(f.entryId),
      ).length ?? 0;
    const categoryIds = new Set(entries.map((entry) => entry.categoryId));
    return {
      date,
      count: entries.length,
      focused: count,
      categories:
        snapshot.value?.categories
          .filter((c) => categoryIds.has(c.id))
          .slice(0, 3) ?? [],
    };
  }),
);
const selectedFocusTitles = computed(() => {
  const ids = new Set(
    snapshot.value?.focusDays
      .filter((f) => f.focused && f.date === selectedDate.value)
      .map((f) => f.entryId),
  );
  return (
    snapshot.value?.entries
      .filter(
        (e) => ids.has(e.id) && coversDate(e, selectedDate.value, today.value),
      )
      .map((e) => e.title) ?? []
  );
});
const allEntries = computed(() => [
  ...(snapshot.value?.entries ?? []),
  ...(snapshot.value?.trashEntries ?? []),
]);
const hasFilter = computed(
  () =>
    !!filter.value.search.trim() ||
    !!filter.value.categoryId ||
    filter.value.status !== 'ongoing' ||
    (contentView.value === 'day' && recordView.focusOnly),
);
const weekdays = computed(() => [
  tr('common.mon2'),
  tr('common.tue2'),
  tr('common.wed2'),
  tr('common.thu2'),
  tr('common.fri2'),
  tr('common.sat2'),
  tr('common.sun2'),
]);
const editing = computed(
  () =>
    route.path === '/entries/new' ||
    route.query.edit === '1' ||
    typeof route.query.draftId === 'string',
);
function resetFilters() {
  filter.value = emptyFilter();
  recordView.focusOnly = false;
}
function open(entry: EntryDto | null, edit = true) {
  recordView.returnPath = route.fullPath;
  recordView.scrollTop = window.scrollY;
  void router.push(
    entry
      ? { path: `/entries/${entry.id}`, query: edit ? { edit: '1' } : {} }
      : '/entries/new',
  );
}
async function closeEditor() {
  await router.push(
    recordView.returnPath.startsWith('/entries/')
      ? '/day'
      : recordView.returnPath,
  );
  await nextTick();
  window.scrollTo(0, recordView.scrollTop);
}
async function syncEditor() {
  if (!snapshot.value || view.value !== 'editor') return;
  const id = route.params.id;
  let draftId = route.query.draftId;
  const user = useAccount().current.value?.id;
  if (typeof draftId === 'string' && user && mode.value === 'account') {
    try {
      draftId =
        sessionStorage.getItem(
          `dayline:${localEnvironment}:${user}:resume:${draftId}`,
        ) ?? draftId;
    } catch {
      /* original durable draft remains accessible */
    }
  }

  if (!editing.value) {
    const found = snapshot.value.entries.find((e) => e.id === id);
    editor.value = found ? { entry: found, key: found.id } : null;
    return;
  }
  if (!draftId && user && mode.value === 'account') {
    try {
      draftId =
        sessionStorage.getItem(
          `dayline:${localEnvironment}:${user}:editor:${typeof id === 'string' ? id : 'new'}`,
        ) ?? undefined;
    } catch {
      /* draft list remains available */
    }
  }
  if (typeof draftId === 'string' && user && mode.value === 'account') {
    const generation = useWorkspace().generation();
    try {
      const draft = await localRepository.draft(user, draftId);
      if (generation !== useWorkspace().generation()) return;
      if (draft) {
        editor.value = { entry: draft.baseEntry, key: draft.draftId, draft };
        return;
      }
    } catch {
      error.value = msg('records.unableToReadOriginalDraftOriginalContent');
      return;
    }
  }
  if (route.path === '/entries/new')
    editor.value = { entry: null, key: crypto.randomUUID() };
  else {
    const found = snapshot.value.entries.find((e) => e.id === id);
    editor.value = found ? { entry: { ...found }, key: found.id } : null;
  }
}
watch(
  () => route.fullPath,
  () => {
    const path = route.path;
    if (path === '/categories')
      categoryReturnPath.value =
        recordView.activeView === 'timeline' ? '/timeline' : '/day';
    void syncEditor();
  },
);
onBeforeUnmount(() => {
  recordView.scrollTop = window.scrollY;
});
watch(
  () => route.query.date,
  (value) => {
    if (typeof value === 'string' && isCalendarDate(value))
      selectedDate.value = value;
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
      notice.value = msg('records.theCategoryHasChangedAndTheInvalid');
    }
  },
);
watch(mode, () => {
  filter.value = emptyFilter();
  editor.value = null;
  confirm.value = null;
});
watch(
  filter,
  () => {
    limit.value = 40;
  },
  { deep: true },
);
async function reorderCategories(categoryIds: string[]) {
  const current = snapshot.value;
  if (!current) return;
  const input = { expectedDataVersion: current.dataVersion, categoryIds };
  await mutate({ kind: 'reorderCategories', input }, () =>
    records.reorderCategories(input),
  );
}
async function action(mutation: GuestMutation, cloud: () => Promise<unknown>) {
  try {
    await mutate(mutation, cloud);
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
async function save(
  id: string,
  input: CreateEntryInput | PatchEntryInput,
  creating: boolean,
) {
  if (creating && 'id' in input)
    return await mutate({ kind: 'create', input }, () => records.create(input));
  else if ('expectedVersion' in input)
    return await mutate({ kind: 'update', id, input }, () =>
      records.update(id, input),
    );
}
async function focus(entry: EntryDto) {
  const existing = snapshot.value?.focusDays.find(
    (f) => f.entryId === entry.id && f.date === selectedDate.value,
  );
  const input = {
    focused: !existing?.focused,
    expectedEntryVersion: entry.version,
    expectedFocusVersion: existing?.version ?? 0,
  };
  await action(
    { kind: 'focus', id: entry.id, date: selectedDate.value, input },
    () => records.focus(entry.id, selectedDate.value, input),
  );
}
async function finishEntry(entry: EntryDto) {
  await action(
    { kind: 'finish', id: entry.id, expectedVersion: entry.version },
    () => records.finish(entry.id, entry.version),
  );
}
async function restoreEntry(entry: EntryDto) {
  await action(
    { kind: 'restore', id: entry.id, expectedVersion: entry.version },
    () => records.restore(entry.id, entry.version),
  );
}
async function confirmed() {
  const c = confirm.value;
  if (!c) return;
  try {
    if (c.kind === 'clear') {
      const input = { expectedDataVersion: c.dataVersion };
      await mutate({ kind: 'purge', input }, () => records.purge(input));
    } else if (c.kind === 'purge') {
      const input = {
        entries: [{ id: c.entry.id, expectedVersion: c.entry.version }],
      };
      await mutate({ kind: 'purge', input }, () => records.purge(input));
    } else
      await mutate(
        { kind: 'remove', id: c.entry.id, expectedVersion: c.entry.version },
        () => records.remove(c.entry.id, c.entry.version),
      );
    confirm.value = null;
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}
function categoryName(id: string) {
  return (
    snapshot.value?.categories.find((c) => c.id === id)?.name ??
    tr('common.categoryHasChanged')
  );
}
function changeDate(date: string) {
  if (isCalendarDate(date)) {
    selectedDate.value = date;
    void router.replace({ query: { date } });
  }
}
function updateCamera(camera: { day: number; days: number }) {
  recordView.timelineCameraDay = camera.day;
  recordView.timelineCameraDays = camera.days;
  scale.value =
    camera.days >= range.value.maxDays - 0.01
      ? 'all'
      : camera.days <= 31.01
        ? 'month'
        : camera.days <= 140
          ? 'quarter'
          : 'year';
}
function changeScale(event: Event) {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const value = event.target.value;
  if (
    value !== 'month' &&
    value !== 'quarter' &&
    value !== 'year' &&
    value !== 'all'
  )
    return;
  scale.value = value;
  recordView.timelineCameraDay = null;
  recordView.timelineCameraDays = null;
}
function move(amount: number) {
  const days = range.value.endExclusive - range.value.start;
  updateCamera({
    day: range.value.start + days * (TIMELINE_RECENT_POSITION + amount * 0.8),
    days,
  });
}
function locate() {
  const days = range.value.endExclusive - range.value.start;
  updateCamera({ day: dateOrdinal(today.value) + 0.5, days });
}
onMounted(async () => {
  await ensure();
  if (snapshot.value) {
    selectedDate.value =
      typeof route.query.date === 'string' && isCalendarDate(route.query.date)
        ? route.query.date
        : selectedDate.value || today.value;
    anchor.value = anchor.value || today.value;
    syncEditor();
  }
});
const dateInput = ref<HTMLInputElement | null>(null);
const statuses = [
  {
    value: 'all',
    get label() {
      return tr('common.all');
    },
  },
  {
    value: 'ongoing',
    get label() {
      return tr('common.ongoing');
    },
  },
  {
    value: 'ended',
    get label() {
      return tr('common.ended');
    },
  },
] as const;
function dateLabel(date: string) {
  return isCalendarDate(date) ? calendarLabel(date) : tr('common.selectDate');
}

const selectedWeekday = computed(() =>
  isCalendarDate(selectedDate.value)
    ? [
        tr('common.monday'),
        tr('common.tuesday'),
        tr('common.wednesday'),
        tr('common.thursday'),
        tr('common.friday'),
        tr('common.saturday'),
        tr('common.sunday'),
      ][(dateOrdinal(selectedDate.value) - 1) % 7]
    : '',
);
const distribution = computed(() =>
  (snapshot.value?.categories ?? [])
    .map((category) => ({
      ...category,
      count: summary.value.categories[category.id] ?? 0,
    }))
    .filter((category) => category.count > 0)
    .sort((a, b) => b.count - a.count),
);
const donutBackground = computed(() => {
  if (!summary.value.count) return 'var(--line)';
  let end = 0;
  return `conic-gradient(${distribution.value
    .map((category) => {
      const start = end;
      end += (category.count / summary.value.count) * 100;
      return `${category.color} ${start}% ${end}%`;
    })
    .join(',')})`;
});
const recent = computed(
  () =>
    [...(snapshot.value?.entries ?? [])]
      .filter((entry) => entry.startDate <= today.value)
      .sort((a, b) => b.startDate.localeCompare(a.startDate))[0],
);
</script>
<template>
  <section class="records-page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">A LITTLE RECORD OF YOUR DAYS</div>
        <h1>
          {{
            contentView === 'timeline'
              ? tr('common.timeline')
              : view === 'trash'
                ? tr('common.trash')
                : tr('common.myRecords')
          }}<span class="heading-dot">.</span>
        </h1>
        <p>{{ tr('records.recordWhatYouAreDoingDuringThese') }}</p>
      </div>
      <button
        v-if="!readonly && view !== 'editor'"
        class="button primary"
        :disabled="busy"
        @click="open(null)"
      >
        <PlannerIcon name="plus" />{{ tr('common.newEntry2') }}
      </button>
    </div>
    <section
      v-if="mode === 'guest' && identityState === 'guest'"
      class="account-panel"
      :aria-label="tr('common.recordKeepingMethod')"
    >
      <div>
        <strong>{{ tr('common.guestMode') }}</strong>
        <p>{{ tr('records.entriesCategoriesAndDailyHighlightsAreOnly') }}</p>
      </div>
    </section>
    <div
      v-if="!snapshot && (loading || accountLoading)"
      class="records-skeleton"
      role="status"
      :aria-label="tr('common.loadingRecords')"
    >
      <div class="skeleton-date"></div>
      <div class="skeleton-stats"><i></i><i></i><i></i></div>
      <div class="skeleton-content"></div>
    </div>
    <template v-if="snapshot">
      <p v-if="readonly" class="notice">
        {{ tr('records.theAccountIsRestrictedAndCanOnly') }}
      </p>
      <template v-if="contentView === 'day' || contentView === 'timeline'">
        <section
          v-if="contentView !== 'timeline'"
          class="date-panel"
          :aria-label="tr('common.selectDate')"
        >
          <div class="date-toolbar">
            <div class="date-heading">
              <button
                class="date-picker-label"
                @click="dateInput?.showPicker?.()"
              >
                <span>{{ dateLabel(selectedDate) }}</span
                ><PlannerIcon name="chevron" />
              </button>
              <input
                ref="dateInput"
                :value="selectedDate"
                type="date"
                :aria-label="tr('common.selectDate')"
                min="0001-01-01"
                max="9999-12-31"
                @change="changeDate(($event.target as HTMLInputElement).value)"
              />
              <span class="weekday">{{ selectedWeekday }}</span>
            </div>
            <div
              class="calendar-focus-line"
              :title="selectedFocusTitles.join('、')"
            >
              <PlannerIcon name="star" /><span>{{
                selectedFocusTitles.length
                  ? selectedFocusTitles.join('、')
                  : selectedDate > today
                    ? tr('common.thereIsNoFocusOnThisDay')
                    : tr('records.chooseOneMemorableEventForThisDay')
              }}</span>
            </div>
            <div class="date-controls">
              <button
                class="icon-btn"
                :aria-label="tr('common.theDayBefore')"
                :disabled="
                  !isCalendarDate(selectedDate) || selectedDate === '0001-01-01'
                "
                @click="changeDate(shiftDate(selectedDate, -1))"
              >
                <PlannerIcon class="flip" name="chevron" /></button
              ><button class="today-btn" @click="changeDate(today)">
                {{ tr('common.today') }}</button
              ><button
                class="icon-btn"
                :aria-label="tr('common.theNextDay')"
                :disabled="
                  !isCalendarDate(selectedDate) || selectedDate === '9999-12-31'
                "
                @click="changeDate(shiftDate(selectedDate, 1))"
              >
                <PlannerIcon name="chevron" />
              </button>
            </div>
          </div>
          <div class="week-strip">
            <button
              v-for="(
                { date, count, focused, categories }, index
              ) in weekSummary"
              :key="date"
              class="week-day"
              :class="{
                selected: date === selectedDate,
                'has-event': snapshot.entries.some((entry) =>
                  coversDate(entry, date, today),
                ),
              }"
              :aria-label="date"
              :aria-pressed="date === selectedDate"
              @click="changeDate(date)"
            >
              <span class="day-name">{{ weekdays[index] }}</span
              ><span class="day-num-wrap"
                ><span class="day-number">{{ Number(date.slice(8)) }}</span
                ><span v-if="date === today" class="today-tag">{{
                  tr('common.today2')
                }}</span></span
              ><span
                class="week-activity"
                :aria-label="
                  tr('records.itemsItemsFocus', {
                    value0: count,
                    value1: focused,
                  })
                "
              >
                <span v-if="count" class="week-colors" aria-hidden="true"
                  ><i
                    v-for="category in categories"
                    :key="category.id"
                    :style="{ background: category.color }"
                  ></i
                ></span>
                <span>{{
                  count ? tr('records.item', { value0: count }) : '—'
                }}</span
                ><span v-if="focused" class="week-focus">★{{ focused }}</span>
              </span>
            </button>
          </div>
        </section>
        <section
          v-if="contentView === 'timeline'"
          class="timeline-panel"
          :aria-label="tr('common.entrytimeline')"
        >
          <div class="timeline-toolbar">
            <div class="timeline-heading">
              <h2>{{ tr('records.everyExperienceHasItsOwnSpan') }}</h2>
              <p>{{ tr('records.scrollEntryOnTheLeftZoomAnd') }}</p>
            </div>
            <div class="timeline-controls">
              <select v-model="filter.sort" :aria-label="tr('common.sortBy')">
                <option value="asc">{{ tr('common.startDate2') }}</option>
                <option value="desc">{{ tr('common.startDate3') }}</option>
              </select>
              <select
                :value="scale"
                :aria-label="tr('common.timelineRange')"
                @change="changeScale"
              >
                <option value="month">{{ tr('common.month') }}</option>
                <option value="quarter">{{ tr('common.quarter') }}</option>
                <option value="year">{{ tr('common.year') }}</option>
                <option value="all">{{ tr('common.allTime') }}</option>
              </select>
            </div>
          </div>
          <div class="timeline-filters">
            <CategoryTabs
              :key="snapshot.userId"
              :categories="snapshot.categories"
              :selected="filter.categoryId"
              :disabled="busy || readonly"
              :reorder="reorderCategories"
              @select="filter.categoryId = $event"
            />
            <InlineSearch v-model="filter.search" />
            <FileTools />
          </div>
          <div class="timeline-range-toolbar">
            <div
              class="timeline-state-tabs"
              role="group"
              :aria-label="tr('common.timelineStatusFilter')"
            >
              <button
                v-for="status in statuses"
                :key="status.value"
                class="state-tab"
                :class="{ active: filter.status === status.value }"
                :aria-pressed="filter.status === status.value"
                @click="filter.status = status.value"
              >
                {{ status.label }}
              </button>
            </div>
            <div class="timeline-range-controls">
              <button
                class="icon-btn"
                :aria-label="tr('common.previousTimeRange')"
                :disabled="range.start <= 1"
                @click="move(-1)"
              >
                <PlannerIcon class="flip" name="chevron" /></button
              ><strong
                >{{ dateLabel(ordinalDate(Math.floor(range.start))) }} —
                {{
                  dateLabel(ordinalDate(Math.ceil(range.endExclusive) - 1))
                }}</strong
              ><button
                class="icon-btn"
                :aria-label="tr('common.nextTimeRange')"
                :disabled="range.endExclusive >= 3652060"
                @click="move(1)"
              >
                <PlannerIcon name="chevron" /></button
              ><button class="today-btn" @click="locate">
                {{ tr('common.today') }}
              </button>
            </div>
          </div>
          <TimelineView
            v-if="isCalendarDate(anchor)"
            ref="timeline"
            :entries="visible"
            :range="range"
            :focus-days="snapshot.focusDays"
            :categories="snapshot.categories"
            :today="today"
            :scale="scale"
            :anchor="anchor"
            :sort="filter.sort"
            :readonly="readonly"
            :busy="busy"
            @view="(entry) => open(entry, false)"
            @camera="updateCamera"
            @finish="finishEntry"
            @day="(date) => router.push({ path: '/day', query: { date } })"
          />
          <div v-if="!visible.length" class="timeline-empty">
            {{
              hasFilter
                ? tr('records.thereAreNoMatchingRecordsHereTry')
                : tr('records.theTimelineIsStillEmptyLetS')
            }}
          </div>
          <footer class="timeline-footer">
            <span
              ><i></i
              >{{
                tr('records.theUnfinishedEntryIsAutomaticallyExtendedTo')
              }}</span
            ><span class="focus-legend"
              >{{ tr('common.focusDays')
              }}<span aria-hidden="true">{{ tr('common.less') }}</span>
              <span
                class="focus-legend-ramp"
                role="img"
                :aria-label="tr('records.colorFromLightToDark1Day')"
              >
                <i
                  v-for="step in FOCUS_HEAT_STEPS"
                  :key="step.level"
                  class="focus-heat-cell"
                  :data-level="step.level"
                  :title="step.label"
                  aria-hidden="true"
                ></i> </span
              ><span aria-hidden="true">{{ tr('common.more') }}</span></span
            ><span>{{ tr('records.entry', { value0: visible.length }) }}</span>
          </footer>
        </section>
        <div v-else class="content-grid">
          <section class="schedule-panel">
            <div class="panel-header">
              <div class="section-title">
                <h2>
                  {{
                    filter.status === 'ended'
                      ? tr('records.thisDayIsOver')
                      : filter.status === 'all'
                        ? tr('common.onThisDayWhatIRecorded')
                        : tr('records.whatYouAreDoingOnThisDay')
                  }}
                </h2>
                <span>{{ visible.length }}</span>
              </div>
            </div>
            <div class="schedule-tools">
              <CategoryTabs
                :key="snapshot.userId"
                :categories="snapshot.categories"
                :selected="filter.categoryId"
                :disabled="busy || readonly"
                :reorder="reorderCategories"
                @select="filter.categoryId = $event"
              />
              <InlineSearch v-model="filter.search" /><FocusHelp
                :date="selectedDate"
                :count="dailyFocusCount"
                :future="selectedDate > today"
                :selected="recordView.focusOnly"
                @toggle="recordView.focusOnly = !recordView.focusOnly"
              /><FileTools />
            </div>
            <div
              class="state-filters"
              role="group"
              :aria-label="tr('common.filterRecordStatus')"
            >
              <button
                v-for="status in statuses"
                :key="status.value"
                class="state-tab"
                :class="{ active: filter.status === status.value }"
                :aria-pressed="filter.status === status.value"
                @click="filter.status = status.value"
              >
                {{ status.label }}</button
              ><button v-if="hasFilter" class="state-tab" @click="resetFilters">
                {{ tr('common.clearFilters') }}
              </button>
            </div>
            <div class="event-area">
              <div v-if="!visible.length" class="empty-state">
                <div class="empty-art" aria-hidden="true">
                  <div class="empty-paper"><i></i><i></i><i></i></div>
                  <div class="empty-sun"><PlannerIcon name="sun" /></div>
                </div>
                <h3>
                  {{
                    hasFilter
                      ? tr('records.thereIsNoMatchingRecordHereYet')
                      : snapshot.entries.length
                        ? tr('records.thereAreNoEntriesInProgressOn')
                        : tr('records.recordAnExperienceStartingToday')
                  }}
                </h3>
                <p v-if="hasFilter">
                  {{ tr('records.tryOtherCategoriesOrStatusesOrChange') }}
                </p>
                <p v-else-if="snapshot.entries.length">
                  {{ tr('records.switchToTheEndedEntryOrSelect') }}
                </p>
                <p v-else>
                  {{ tr('records.aBookIVeBeenReadingFor') }}<br />{{
                    tr('records.youCanAllStayHereAndSlowly')
                  }}
                </p>
                <button
                  v-if="hasFilter"
                  class="demo-link"
                  @click="resetFilters"
                >
                  {{ tr('common.clearFilter') }}</button
                ><button
                  v-else-if="!readonly"
                  class="demo-link"
                  @click="open(null)"
                >
                  {{
                    snapshot.entries.length
                      ? tr('common.recordANewEntry')
                      : tr('records.recordYourselfFirst')
                  }}
                  →
                </button>
              </div>
              <ul v-else class="entry-list">
                <EntryRow
                  v-for="entry in visible.slice(0, limit)"
                  :key="entry.id"
                  :entry="entry"
                  :category="categoryName(entry.categoryId)"
                  :color="
                    snapshot.categories.find((c) => c.id === entry.categoryId)
                      ?.color ?? '#A0A4B3'
                  "
                  :today="today"
                  :date="selectedDate"
                  :focused="
                    snapshot.focusDays.some(
                      (f) =>
                        f.entryId === entry.id &&
                        f.date === selectedDate &&
                        f.focused,
                    )
                  "
                  :focus-count="
                    snapshot.focusDays.filter(
                      (f) => f.entryId === entry.id && f.focused,
                    ).length
                  "
                  :busy="busy"
                  :readonly="readonly"
                  @edit="open(entry)"
                  @finish="finishEntry(entry)"
                  @remove="confirm = { kind: 'delete', entry: { ...entry } }"
                  @focus="focus(entry)"
                />
              </ul>
              <button
                v-if="visible.length > limit"
                class="demo-link"
                @click="limit += 40"
              >
                {{
                  tr('records.showMoreShown', {
                    value0: Math.min(limit, visible.length),
                    value1: visible.length,
                  })
                }}
              </button>
            </div>
            <button v-if="!readonly" class="add-inline" @click="open(null)">
              <PlannerIcon name="plus" />{{ tr('common.recordSomething') }}
            </button>
          </section>
          <aside class="insights-column">
            <section class="distribution-panel">
              <div class="panel-header">
                <h2>{{ tr('common.categoryDistribution') }}</h2>
                <span class="muted-label">{{
                  tr('common.allRecordsForTheDay')
                }}</span>
              </div>
              <div class="donut-wrap">
                <div
                  class="donut"
                  :style="{ background: donutBackground }"
                  role="img"
                  :aria-label="
                    tr('records.categoryDistributionTotalEntries', {
                      value0: summary.count,
                    })
                  "
                >
                  <div>
                    <span>{{ tr('common.totalNumberOfEntries') }}</span
                    ><strong>{{
                      tr('records.items', { value0: summary.count })
                    }}</strong>
                  </div>
                </div>
              </div>
              <div class="distribution-legend">
                <div
                  v-for="category in distribution"
                  :key="category.id"
                  class="legend-row"
                  :style="{ '--category-color': category.color }"
                >
                  <i class="category-dot"></i
                  ><span class="legend-name">{{ category.name }}</span
                  ><strong>{{
                    tr('records.items', { value0: category.count })
                  }}</strong
                  ><span class="legend-percent"
                    >{{
                      Math.round((category.count / summary.count) * 100)
                    }}%</span
                  >
                </div>
                <div v-if="!summary.count" class="legend-empty">
                  {{ tr('records.afterRecordingLookAtDifferentAspectsOf') }}
                </div>
              </div>
              <p class="distribution-note">
                {{ tr('records.basedOnTheNumberOfEntriesEach') }}
              </p>
            </section>
            <section class="next-panel">
              <span class="next-eyebrow"
                ><span></span>{{ tr('common.recentlyStarted') }}</span
              ><template v-if="recent"
                ><button class="next-title recent-entry" @click="open(recent)">
                  {{ recent.title }}
                </button>
                <div class="next-meta">
                  <PlannerIcon name="calendar" />{{
                    tr('records.started', {
                      value0: dateLabel(recent.startDate),
                      value1: spanLabel(recent, today),
                    })
                  }}
                </div></template
              ><template v-else
                ><p class="next-title">
                  {{ tr('records.whatHaveYouBeenDoingRecently') }}
                </p>
                <div class="next-meta">
                  {{ tr('records.aSmallThingIsWorthRecording') }}
                </div></template
              >
            </section>
            <div class="quote">
              <span>“</span>
              <p>
                {{ tr('common.everyExperience') }}<br />{{
                  tr('records.itAllGivesLifeItsOwnShape')
                }}
              </p>
              <small>LITTLE THINGS, LASTING MEMORIES.</small>
              <div class="quote-art" aria-hidden="true">
                <i></i><i></i><i></i>
              </div>
            </div>
          </aside>
        </div>
      </template>
      <PlannerDialog
        v-if="view === 'editor'"
        :class="{ 'entry-detail-dialog': !editing }"
        :label="editing ? tr('common.entryedit') : tr('common.entryDetails')"
        @close="closeEditor"
      >
        <EntryEditor
          v-if="editor && editing && !readonly"
          :key="editor.key"
          :entry="editor.entry"
          :draft="editor.draft"
          :categories="snapshot.categories"
          :today="today"
          :initial-date="
            contentView === 'day' && isCalendarDate(selectedDate)
              ? selectedDate
              : today
          "
          :initial-category-id="filter.categoryId"
          :local="mode === 'guest'"
          :save="save"
          @saved="closeEditor"
          @close="closeEditor"
        />
        <EntryDetails
          v-else-if="editor?.entry && !editing"
          :entry="
            snapshot.entries.find((e) => e.id === editor?.entry?.id) ??
            editor.entry
          "
          :categories="snapshot.categories"
          :focus-days="snapshot.focusDays"
          :today="today"
          :readonly="readonly"
          @edit="router.replace({ path: route.path, query: { edit: '1' } })"
          @close="closeEditor"
        />
        <p v-else>{{ tr('records.theEntryDoesNotExistOrIs') }}</p>
        <section v-if="editor?.entry && editing" class="record-panel">
          <h2>{{ tr('common.cumulativeFocusDates') }}</h2>
          <p class="date-list">
            {{
              snapshot.focusDays
                .filter((f) => f.entryId === editor?.entry?.id && f.focused)
                .map((f) => f.date)
                .join('、') || tr('common.noFocusDayYet')
            }}
          </p>
        </section></PlannerDialog
      >
      <template v-if="view === 'trash'"
        ><button
          class="button danger"
          v-if="snapshot.trashEntries.length && !readonly"
          :disabled="busy"
          @click="
            confirm = { kind: 'clear', dataVersion: snapshot.dataVersion }
          "
        >
          {{ tr('common.clearTrashPermanently') }}
        </button>
        <p v-if="!snapshot.trashEntries.length" class="empty-state">
          {{ tr('common.trashIsEmpty') }}
        </p>
        <ul class="entry-list">
          <li
            v-for="entry in snapshot.trashEntries"
            :key="entry.id"
            class="entry-row"
          >
            <h2>{{ entry.title }}</h2>
            <p>
              {{ categoryName(entry.categoryId) }} · {{ entry.startDate }} →
              {{
                entry.endDate ??
                (entry.startDate > today
                  ? tr('common.endingPending')
                  : tr('common.present'))
              }}
              · {{ spanLabel(entry, today) }}
            </p>
            <p>
              {{
                tr('records.delete', {
                  value0: formatBeijingTime(entry.deletedAt),
                })
              }}<br />{{
                tr('records.expired', {
                  value0: formatBeijingTime(entry.purgeAfter),
                })
              }}
            </p>
            <p>
              {{
                tr('records.focus', {
                  value0:
                    snapshot.focusDays
                      .filter((f) => f.entryId === entry.id && f.focused)
                      .map((f) => f.date)
                      .join('、') || tr('common.none'),
                })
              }}
            </p>
            <IconButton
              icon="restore"
              :label="tr('common.restoreEntry')"
              v-if="!readonly"
              :disabled="
                busy || (!!entry.purgeAfter && entry.purgeAfter <= serverTime)
              "
              @click="restoreEntry(entry)"
            />
            <IconButton
              icon="trash"
              :label="tr('common.deleteThisItemPermanently')"
              danger
              v-if="!readonly"
              :disabled="busy"
              @click="confirm = { kind: 'purge', entry: { ...entry } }"
            />
          </li></ul
      ></template>
      <PlannerDialog
        v-if="view === 'categories' && !readonly"
        :label="tr('common.categoryManagement')"
        @close="
          router.push({
            path: categoryReturnPath,
            query: categoryReturnPath === '/day' ? { date: selectedDate } : {},
          })
        "
      >
        <button
          class="icon-btn manager-close"
          :aria-label="tr('common.closeCategoryManagement')"
          @click="
            router.push({
              path: categoryReturnPath,
              query:
                categoryReturnPath === '/day' ? { date: selectedDate } : {},
            })
          "
        >
          <PlannerIcon name="close" />
        </button>
        <CategoryManager
          :categories="snapshot.categories"
          :data-version="snapshot.dataVersion"
          :entries="allEntries"
          :busy="busy"
          :mutate="mutate"
      /></PlannerDialog>
      <PlannerDialog
        v-if="confirm"
        :label="tr('common.hazardousOperationConfirmation')"
        @close="confirm = null"
      >
        <section
          v-if="confirm"
          class="confirmation"
          role="region"
          :aria-label="tr('common.hazardousOperationConfirmation')"
          @keydown.esc="confirm = null"
        >
          <div class="modal-header">
            <h2>
              {{
                confirm.kind === 'delete'
                  ? tr('common.deleteThisEntry')
                  : tr('common.permanentlyDeleteRecords')
              }}
            </h2>
            <button
              class="icon-btn"
              :aria-label="tr('common.turnOffDeleteConfirmation')"
              @click="confirm = null"
            >
              <PlannerIcon name="close" />
            </button>
          </div>
          <p>
            {{
              confirm.kind === 'delete'
                ? tr('records.moveAndEmphasisToTrashAndKeep', {
                    value0: confirm.entry.title,
                  })
                : confirm.kind === 'purge'
                  ? tr('records.permanentlyDeleteUnableToRecover', {
                      value0: confirm.entry.title,
                    })
                  : tr('records.permanentlyClearTheCurrentTrashentryUnableTo', {
                      value0: snapshot.trashEntries.length,
                    })
            }}
          </p>
          <button class="button danger" :disabled="busy" @click="confirmed">
            {{
              tr('records.confirm', {
                value0:
                  confirm.kind === 'delete'
                    ? tr('common.moveIntoTrash')
                    : tr('common.deletePermanently'),
              })
            }}</button
          ><button
            class="button subtle"
            :disabled="busy"
            @click="confirm = null"
          >
            {{ tr('common.cancel') }}
          </button>
        </section></PlannerDialog
      >
    </template>
  </section>
</template>
