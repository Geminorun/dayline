<script setup lang="ts">
import { formatBeijingTime } from '@dayline/core';
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
  shiftMonth,
  spanLabel,
  summarizeEntries,
  timelineWindow,
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
import EntryRow from './EntryRow.vue';
import CategoryManager from './CategoryManager.vue';
import TimelineView from './TimelineView.vue';
import PlannerIcon from '../components/PlannerIcon.vue';
import PlannerDialog from '../components/PlannerDialog.vue';
import {
  localEnvironment,
  localRepository,
} from '../adapters/local-repository';
import { useAccount } from '../account';
import { recordView } from './view-state';
const route = useRoute(),
  router = useRouter();
const {
  mode,
  snapshot,
  loading,
  busy,
  error,
  notice,
  serverTime,
  readonly,
  ensure,
  load,
  mutate,
} = useWorkspace();
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
  timelineWindow(
    filtered.value,
    today.value,
    scale.value,
    anchor.value || today.value,
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
          coversDate(entry, selectedDate.value, today.value),
      )
      .sort((a, b) => Number(focused.has(b.id)) - Number(focused.has(a.id)));
  }
  if (contentView.value === 'timeline')
    return selectEntries(
      filtered.value,
      today.value,
      emptyFilter(),
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
const allEntries = computed(() => [
  ...(snapshot.value?.entries ?? []),
  ...(snapshot.value?.trashEntries ?? []),
]);
const hasFilter = computed(
  () =>
    !!filter.value.search.trim() ||
    !!filter.value.categoryId ||
    filter.value.status !== 'all',
);
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
function open(entry: EntryDto | null) {
  recordView.returnPath = route.fullPath;
  recordView.scrollTop = window.scrollY;
  void router.push(entry ? `/entries/${entry.id}` : '/entries/new');
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
      error.value = '无法读取原草稿，已保留原始内容。';
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
  () => route.path,
  (path) => {
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
      notice.value = '分类已变化，已清除失效筛选。';
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
    snapshot.value?.categories.find((c) => c.id === id)?.name ?? '分类已变化'
  );
}
function changeDate(date: string) {
  if (isCalendarDate(date)) {
    selectedDate.value = date;
    void router.replace({ query: { date } });
  }
}
function move(amount: number) {
  anchor.value = shiftMonth(
    anchor.value,
    (scale.value === 'year' ? 12 : scale.value === 'quarter' ? 3 : 1) * amount,
  );
}
async function locate() {
  anchor.value = today.value;
  if (scale.value === 'all' && range.value.todayX === null)
    scale.value = 'month';
  await nextTick();
  timeline.value?.locateToday();
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
const listMode = ref(false),
  searchOpen = ref(false);
const statuses = [
  { value: 'all', label: '全部状态' },
  { value: 'not_started', label: '未开始' },
  { value: 'ongoing', label: '进行中' },
  { value: 'ended', label: '已结束' },
] as const;
function dateLabel(date: string) {
  return isCalendarDate(date)
    ? `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`
    : '选择日期';
}
const selectedWeekday = computed(() =>
  isCalendarDate(selectedDate.value)
    ? ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'][
        (dateOrdinal(selectedDate.value) - 1) % 7
      ]
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
  if (!summary.value.count) return '#f0eef7';
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
              ? '时间轴'
              : view === 'trash'
                ? '回收站'
                : '我的记录'
          }}<span class="heading-dot">.</span>
        </h1>
        <p>记录这段日子，正在做的事。</p>
      </div>
      <button
        v-if="!readonly && view !== 'editor'"
        class="button primary"
        :disabled="busy"
        @click="open(null)"
      >
        <PlannerIcon name="plus" />新建事项
      </button>
    </div>
    <section
      v-if="mode === 'guest'"
      class="account-panel"
      aria-label="记录保存方式"
    >
      <div>
        <strong>游客模式</strong>
        <p>
          事项、分类和每日重点仅保存在当前浏览器。换设备不会同步，清除网站数据会丢失。
        </p>
      </div>
    </section>
    <p v-if="loading" class="notice" role="status">正在完整读取记录…</p>
    <p v-if="error" class="error" role="alert">
      {{ error }}
      <button class="button subtle" :disabled="loading || busy" @click="load">
        重试读取
      </button>
    </p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <template v-if="snapshot">
      <p v-if="readonly" class="notice">账号受限，当前仅可查看。</p>
      <template v-if="contentView === 'day' || contentView === 'timeline'">
        <section
          v-if="contentView !== 'timeline'"
          class="date-panel"
          aria-label="选择日期"
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
                aria-label="选择日期"
                min="0001-01-01"
                max="9999-12-31"
                @change="changeDate(($event.target as HTMLInputElement).value)"
              />
              <span class="weekday">{{ selectedWeekday }}</span>
            </div>
            <div class="date-controls">
              <button
                class="icon-btn"
                aria-label="前一天"
                :disabled="
                  !isCalendarDate(selectedDate) || selectedDate === '0001-01-01'
                "
                @click="changeDate(shiftDate(selectedDate, -1))"
              >
                <PlannerIcon class="flip" name="chevron" /></button
              ><button class="today-btn" @click="changeDate(today)">今天</button
              ><button
                class="icon-btn"
                aria-label="后一天"
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
              v-for="(date, index) in week"
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
                ><span v-if="date === today" class="today-tag">今</span></span
              ><span class="week-dot"></span>
            </button>
          </div>
        </section>
        <section class="stats-row" aria-label="当前范围统计">
          <div class="stat">
            <span class="stat-icon purple"
              ><PlannerIcon name="calendar"
            /></span>
            <div>
              <span>{{
                contentView === 'timeline' ? '范围事项' : '当天事项'
              }}</span
              ><strong>{{ summary.count }}<small>件</small></strong>
            </div>
          </div>
          <div class="stat">
            <span class="stat-icon peach"><PlannerIcon name="clock" /></span>
            <div>
              <span>仍在进行</span
              ><strong>{{ summary.ongoing }}<small>件</small></strong>
            </div>
          </div>
          <div class="stat">
            <span class="stat-icon mint"><PlannerIcon name="folder" /></span>
            <div>
              <span>涉及分类</span
              ><strong>{{ summary.categoryCount }}<small>类</small></strong>
            </div>
          </div>
        </section>
        <section
          v-if="contentView === 'timeline'"
          class="timeline-panel"
          aria-label="事项时间轴"
        >
          <div class="timeline-toolbar">
            <div class="timeline-heading">
              <h2>每一段经历，都有自己的跨度</h2>
              <p>按开始日期排列 · 点击横条编辑记录</p>
            </div>
            <div class="timeline-controls">
              <select v-model="filter.sort" aria-label="排序方式">
                <option value="asc">开始日期 ↑</option>
                <option value="desc">开始日期 ↓</option>
              </select>
              <select v-model="scale" aria-label="时间轴范围">
                <option value="month">月视图</option>
                <option value="quarter">季度视图</option>
                <option value="year">年视图</option>
                <option value="all">全部时间</option>
              </select>
            </div>
          </div>
          <div class="timeline-filters">
            <div class="filter-tabs">
              <button
                class="filter-tab"
                :class="{ active: !filter.categoryId }"
                :aria-pressed="!filter.categoryId"
                @click="filter.categoryId = ''"
              >
                全部</button
              ><button
                v-for="category in snapshot.categories"
                :key="category.id"
                class="filter-tab"
                :class="{ active: filter.categoryId === category.id }"
                :aria-pressed="filter.categoryId === category.id"
                @click="filter.categoryId = category.id"
              >
                {{ category.name }}</button
              ><RouterLink class="filter-tab manage-tab" to="/categories"
                >管理分类</RouterLink
              >
            </div>
            <label class="timeline-search"
              ><PlannerIcon name="search" /><input
                v-model="filter.search"
                type="search"
                aria-label="搜索时间轴事项"
                placeholder="搜索记录…"
            /></label>
          </div>
          <div class="timeline-range-toolbar">
            <div
              class="timeline-state-tabs"
              role="group"
              aria-label="时间轴状态筛选"
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
                aria-label="上一个时间范围"
                :disabled="scale === 'all' || anchor === '0001-01-01'"
                @click="move(-1)"
              >
                <PlannerIcon class="flip" name="chevron" /></button
              ><strong
                >{{ dateLabel(ordinalDate(range.start)) }} —
                {{ dateLabel(ordinalDate(range.endExclusive - 1)) }}</strong
              ><button
                class="icon-btn"
                aria-label="下一个时间范围"
                :disabled="scale === 'all' || anchor.slice(0, 4) === '9999'"
                @click="move(1)"
              >
                <PlannerIcon name="chevron" /></button
              ><button class="today-btn" @click="locate">今天</button>
            </div>
          </div>
          <TimelineView
            v-if="isCalendarDate(anchor)"
            ref="timeline"
            :entries="visible"
            :focus-days="snapshot.focusDays"
            :categories="snapshot.categories"
            :today="today"
            :scale="scale"
            :anchor="anchor"
            :sort="filter.sort"
            :readonly="readonly"
            :busy="busy"
            @edit="open"
            @finish="finishEntry"
            @day="(date) => router.push({ path: '/day', query: { date } })"
          />
          <div v-if="!visible.length" class="timeline-empty">
            {{
              hasFilter
                ? '这里还没有匹配的记录，试试其他分类或关键词。'
                : '时间轴还空着，记录第一段经历吧。'
            }}
          </div>
          <footer class="timeline-footer">
            <span><i></i>未结束事项自动延伸到今天</span
            ><span class="focus-legend"
              ><b>★</b>重点日期 · 缩小时按周 / 月汇总</span
            ><span>{{ visible.length }} 件事项</span>
          </footer>
        </section>
        <div v-else class="content-grid">
          <section class="schedule-panel">
            <div class="panel-header">
              <div class="section-title">
                <h2>这一天，正在做的事</h2>
                <span>{{ visible.length }}</span>
              </div>
              <div class="view-toggle" role="group" aria-label="显示方式">
                <button
                  :class="{ active: !listMode }"
                  :aria-pressed="!listMode"
                  aria-label="日期卡片"
                  @click="listMode = false"
                >
                  <PlannerIcon name="clock" /></button
                ><button
                  :class="{ active: listMode }"
                  :aria-pressed="listMode"
                  aria-label="列表"
                  @click="listMode = true"
                >
                  <PlannerIcon name="list" />
                </button>
              </div>
            </div>
            <div class="schedule-tools">
              <div class="filter-tabs">
                <button
                  class="filter-tab"
                  :class="{ active: !filter.categoryId }"
                  :aria-pressed="!filter.categoryId"
                  @click="filter.categoryId = ''"
                >
                  全部</button
                ><button
                  v-for="category in snapshot.categories"
                  :key="category.id"
                  class="filter-tab"
                  :class="{ active: filter.categoryId === category.id }"
                  :aria-pressed="filter.categoryId === category.id"
                  @click="filter.categoryId = category.id"
                >
                  {{ category.name }}</button
                ><RouterLink class="filter-tab manage-tab" to="/categories"
                  >管理分类</RouterLink
                >
              </div>
              <button
                class="icon-btn"
                aria-label="搜索事项"
                @click="searchOpen = !searchOpen"
              >
                <PlannerIcon name="search" /></button
              ><RouterLink
                class="icon-btn"
                to="/data"
                aria-label="导入导出记录"
                title="导入 / 导出记录"
                ><PlannerIcon name="download"
              /></RouterLink>
            </div>
            <div class="state-filters" role="group" aria-label="筛选记录状态">
              <button
                v-for="status in statuses"
                :key="status.value"
                class="state-tab"
                :class="{ active: filter.status === status.value }"
                :aria-pressed="filter.status === status.value"
                @click="filter.status = status.value"
              >
                {{ status.label }}</button
              ><button
                v-if="hasFilter"
                class="state-tab"
                @click="filter = emptyFilter()"
              >
                清除筛选
              </button>
            </div>
            <label v-if="searchOpen || filter.search" class="search-field"
              ><PlannerIcon name="search" /><input
                v-model="filter.search"
                type="search"
                placeholder="搜索事项名称…"
                aria-label="搜索事项名称"
            /></label>
            <div class="daily-focus-summary">
              <div>
                <PlannerIcon name="star" /><strong
                  >{{ Number(selectedDate.slice(5, 7)) }}月{{
                    Number(selectedDate.slice(8))
                  }}日的重点</strong
                ><span>{{ dailyFocusCount }}项</span>
              </div>
              <p>
                {{
                  selectedDate > today
                    ? '可以记录今天及过去日期的重点。'
                    : '建议每天选择1–2项 · 星标只属于这一天，可切换日期补记。'
                }}
              </p>
            </div>
            <div class="event-area" :class="{ 'list-mode': listMode }">
              <div v-if="!visible.length" class="empty-state">
                <div class="empty-art" aria-hidden="true">
                  <div class="empty-paper"><i></i><i></i><i></i></div>
                  <div class="empty-sun"><PlannerIcon name="sun" /></div>
                </div>
                <h3>
                  {{
                    hasFilter
                      ? '这里还没有匹配的记录'
                      : '记录一段经历，从今天开始'
                  }}
                </h3>
                <p v-if="hasFilter">试试其他分类或状态，或换个关键词。</p>
                <p v-else>
                  一本读了一个月的书，一款玩了几周的游戏，<br />都可以在这里，慢慢留下痕迹。
                </p>
                <button
                  v-if="hasFilter"
                  class="demo-link"
                  @click="filter = emptyFilter()"
                >
                  清除筛选 →</button
                ><button
                  v-else-if="!readonly"
                  class="demo-link"
                  @click="open(null)"
                >
                  记录自己的第一件事 →
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
                显示更多（已显示 {{ Math.min(limit, visible.length) }} /
                {{ visible.length }}）
              </button>
            </div>
            <button v-if="!readonly" class="add-inline" @click="open(null)">
              <PlannerIcon name="plus" />记录一件事
            </button>
          </section>
          <aside class="insights-column">
            <section class="distribution-panel">
              <div class="panel-header">
                <h2>分类分布</h2>
                <span class="muted-label">当天记录</span>
              </div>
              <div class="donut-wrap">
                <div
                  class="donut"
                  :style="{ background: donutBackground }"
                  role="img"
                  :aria-label="`分类分布，共 ${summary.count} 件事项`"
                >
                  <div>
                    <span>事项总数</span><strong>{{ summary.count }}件</strong>
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
                  ><strong>{{ category.count }}件</strong
                  ><span class="legend-percent"
                    >{{
                      Math.round((category.count / summary.count) * 100)
                    }}%</span
                  >
                </div>
                <div v-if="!summary.count" class="legend-empty">
                  记录之后，看看生活的不同侧面
                </div>
              </div>
              <p class="distribution-note">按事项数量统计，每件事只计一次。</p>
            </section>
            <section class="next-panel">
              <span class="next-eyebrow"><span></span>最近开始</span
              ><template v-if="recent"
                ><button class="next-title recent-entry" @click="open(recent)">
                  {{ recent.title }}
                </button>
                <div class="next-meta">
                  <PlannerIcon name="calendar" />{{
                    dateLabel(recent.startDate)
                  }}开始 · {{ spanLabel(recent, today) }}
                </div></template
              ><template v-else
                ><p class="next-title">最近，在做些什么？</p>
                <div class="next-meta">一件小事，也值得被记录。</div></template
              >
            </section>
            <div class="quote">
              <span>“</span>
              <p>每一段经历，<br />都让日子有了自己的形状。</p>
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
        label="事项编辑"
        @close="closeEditor"
      >
        <EntryEditor
          v-if="editor && !readonly"
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
        <p v-else>事项不存在或当前不可编辑。</p>
        <section v-if="editor?.entry" class="record-panel">
          <h2>累计重点日期</h2>
          <p class="date-list">
            {{
              snapshot.focusDays
                .filter((f) => f.entryId === editor?.entry?.id && f.focused)
                .map((f) => f.date)
                .join('、') || '尚无重点日'
            }}
          </p>
        </section></PlannerDialog
      >
      <template v-if="view === 'trash'"
        ><button
          v-if="snapshot.trashEntries.length && !readonly"
          :disabled="busy"
          @click="
            confirm = { kind: 'clear', dataVersion: snapshot.dataVersion }
          "
        >
          永久清空回收站
        </button>
        <p v-if="!snapshot.trashEntries.length" class="empty-state">
          回收站为空。
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
                entry.endDate ?? (entry.startDate > today ? '结束未定' : '至今')
              }}
              · {{ spanLabel(entry, today) }}
            </p>
            <p>
              删除：{{ formatBeijingTime(entry.deletedAt) }}<br />到期：{{
                formatBeijingTime(entry.purgeAfter)
              }}
            </p>
            <p>
              重点：{{
                snapshot.focusDays
                  .filter((f) => f.entryId === entry.id && f.focused)
                  .map((f) => f.date)
                  .join('、') || '无'
              }}
            </p>
            <button
              v-if="!readonly"
              :disabled="
                busy || (!!entry.purgeAfter && entry.purgeAfter <= serverTime)
              "
              @click="restoreEntry(entry)"
            >
              恢复事项</button
            ><button
              v-if="!readonly"
              class="secondary"
              :disabled="busy"
              @click="confirm = { kind: 'purge', entry: { ...entry } }"
            >
              永久删除此项
            </button>
          </li>
        </ul></template
      >
      <PlannerDialog
        v-if="view === 'categories' && !readonly"
        label="分类管理"
        @close="
          router.push({
            path: categoryReturnPath,
            query: categoryReturnPath === '/day' ? { date: selectedDate } : {},
          })
        "
      >
        <button
          class="icon-btn manager-close"
          aria-label="关闭分类管理"
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
          :entries="allEntries"
          :busy="busy"
          :mutate="mutate"
      /></PlannerDialog>
      <PlannerDialog
        v-if="confirm"
        label="危险操作确认"
        @close="confirm = null"
      >
        <section
          v-if="confirm"
          class="confirmation"
          role="region"
          aria-label="危险操作确认"
          @keydown.esc="confirm = null"
        >
          <div class="modal-header">
            <h2>
              {{
                confirm.kind === 'delete' ? '删除这件事项？' : '永久删除记录？'
              }}
            </h2>
            <button
              class="icon-btn"
              aria-label="关闭删除确认"
              @click="confirm = null"
            >
              <PlannerIcon name="close" />
            </button>
          </div>
          <p>
            {{
              confirm.kind === 'delete'
                ? `将“${confirm.entry.title}”及重点移入回收站，保留 30 天。`
                : confirm.kind === 'purge'
                  ? `永久删除“${confirm.entry.title}”？无法恢复。`
                  : `永久清空当前 ${snapshot.trashEntries.length} 条回收站事项？无法恢复；期间有修改会重新确认。`
            }}
          </p>
          <button :disabled="busy" @click="confirmed">
            确认{{
              confirm.kind === 'delete' ? '移入回收站' : '永久删除'
            }}</button
          ><button class="secondary" :disabled="busy" @click="confirm = null">
            取消
          </button>
        </section></PlannerDialog
      >
    </template>
  </section>
</template>
