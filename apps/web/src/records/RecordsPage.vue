<script setup lang="ts">
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
const view = computed(() =>
  route.path.startsWith('/timeline')
    ? 'timeline'
    : route.path === '/trash'
      ? 'trash'
      : route.path === '/categories'
        ? 'categories'
        : route.path === '/entries'
          ? 'all'
          : route.path.startsWith('/entries/')
            ? 'editor'
            : 'day',
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
  if (view.value === 'day')
    return filtered.value.filter(
      (e) =>
        isCalendarDate(selectedDate.value) &&
        coversDate(e, selectedDate.value, today.value),
    );
  if (view.value === 'timeline')
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
const summary = computed(() => summarizeEntries(visible.value, today.value));
const dailyFocusCount = computed(() => {
  const ids = new Set(visible.value.map((e) => e.id));
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
      ? '/entries'
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
  () => void syncEditor(),
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
</script>
<template>
  <section class="records-page">
    <p class="eyebrow">
      DAYLINE · {{ mode === 'guest' ? '游客本机记录' : '云端记录' }}
    </p>
    <h1>
      {{
        view === 'day'
          ? '每日回看'
          : view === 'timeline'
            ? '时间轴'
            : view === 'trash'
              ? '回收站'
              : view === 'categories'
                ? '分类管理'
                : view === 'editor'
                  ? '记录一段经历'
                  : '全部记录'
      }}
    </h1>
    <p v-if="loading" role="status">正在完整读取记录…</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <button class="secondary" :disabled="loading || busy" @click="load">
      重新完整读取
    </button>
    <template v-if="snapshot"
      ><p class="muted">
        {{
          mode === 'guest'
            ? '游客 · 仅保存在此设备，登录后可同步。'
            : '输入自动尝试暂存本机草稿；点击保存才提交云端。'
        }}
        北京时间 {{ today }}
      </p>
      <p v-if="readonly" class="notice">账号受限，当前仅可查看。</p>
      <button
        v-if="!readonly && view !== 'editor'"
        :disabled="busy"
        @click="open(null)"
      >
        ＋ 新建事项
      </button>
      <template v-if="view === 'day' || view === 'all' || view === 'timeline'">
        <div v-if="view !== 'timeline'" class="record-panel">
          <div class="toolbar">
            <button
              class="secondary"
              :disabled="
                !isCalendarDate(selectedDate) || selectedDate === '0001-01-01'
              "
              @click="changeDate(shiftDate(selectedDate, -1))"
            >
              前一天</button
            ><label
              >{{ view === 'day' ? '回看日期' : '重点操作日期'
              }}<input
                :value="selectedDate"
                type="date"
                min="0001-01-01"
                max="9999-12-31"
                @change="
                  changeDate(($event.target as HTMLInputElement).value)
                " /></label
            ><button
              class="secondary"
              :disabled="
                !isCalendarDate(selectedDate) || selectedDate === '9999-12-31'
              "
              @click="changeDate(shiftDate(selectedDate, 1))"
            >
              后一天</button
            ><button class="secondary" @click="changeDate(today)">今天</button>
          </div>
          <div v-if="view === 'day'" class="week-strip">
            <button
              v-for="date in week"
              :key="date"
              class="secondary"
              :aria-pressed="date === selectedDate"
              @click="changeDate(date)"
            >
              {{ weekdays[(dateOrdinal(date) - 1) % 7] }}<br />{{
                date.slice(5)
              }}
            </button>
          </div>
          <p v-if="selectedDate > today">
            未来日期可回看已知计划范围，重点只可标记今天及过去。
          </p>
        </div>
        <div class="filters">
          <label
            >搜索标题<input
              v-model="filter.search"
              type="search"
              placeholder="搜索当前完整数据" /></label
          ><label
            >分类<select v-model="filter.categoryId">
              <option value="">全部分类</option>
              <option
                v-for="c in snapshot.categories"
                :key="c.id"
                :value="c.id"
              >
                {{ c.name }}
              </option>
            </select></label
          ><label
            >当前状态<select v-model="filter.status">
              <option value="all">全部状态</option>
              <option value="not_started">未开始</option>
              <option value="ongoing">进行中</option>
              <option value="ended">已结束</option>
            </select></label
          ><label
            >开始日期排序<select v-model="filter.sort">
              <option value="desc">从新到旧</option>
              <option value="asc">从旧到新</option>
            </select></label
          ><button class="secondary" @click="filter = emptyFilter()">
            清除筛选
          </button>
        </div>
        <div v-if="view === 'timeline'" class="toolbar">
          <label
            >时间尺度<select v-model="scale">
              <option value="month">月</option>
              <option value="quarter">季度</option>
              <option value="year">年</option>
              <option value="all">全部时间</option>
            </select></label
          ><button
            class="secondary"
            :disabled="scale === 'all' || anchor === '0001-01-01'"
            @click="move(-1)"
          >
            上一段</button
          ><label
            >浏览锚点<input
              v-model="anchor"
              type="date"
              min="0001-01-01"
              max="9999-12-31" /></label
          ><button
            class="secondary"
            :disabled="scale === 'all' || anchor.slice(0, 4) === '9999'"
            @click="move(1)"
          >
            下一段</button
          ><button class="secondary" @click="locate">定位今天</button>
        </div>
        <section class="stats" aria-label="当前范围统计">
          <span
            >{{
              view === 'day'
                ? '选定日事项'
                : view === 'timeline'
                  ? '所选整段范围事项'
                  : '筛选后全部事项'
            }}
            <strong>{{ summary.count }}</strong></span
          ><span
            >今天仍在进行 <strong>{{ summary.ongoing }}</strong></span
          ><span
            >涉及分类 <strong>{{ summary.categoryCount }}</strong></span
          >
          <span v-if="view === 'day'"
            >选定日重点 <strong>{{ dailyFocusCount }}</strong></span
          >
          <p>
            分类分布 · 按事项数量：<span
              v-for="(count, id) in summary.categories"
              :key="id"
              >{{ categoryName(String(id)) }} {{ count }}（{{
                Math.round((count / summary.count) * 100)
              }}%） </span
            ><span v-if="!summary.count">暂无分布</span>
          </p>
        </section>
        <p v-if="!visible.length" class="empty-state">
          {{
            hasFilter
              ? '筛选后无结果，请调整或清除筛选。'
              : !snapshot.entries.length
                ? '当前空间还没有事项，开始记录自己的经历。'
                : view === 'day'
                  ? '这一天没有覆盖的事项，可切换日期或新建。'
                  : '当前时间范围没有事项。'
          }}
        </p>
        <TimelineView
          v-if="view === 'timeline' && isCalendarDate(anchor)"
          ref="timeline"
          :entries="visible"
          :focus-days="snapshot.focusDays"
          :categories="snapshot.categories"
          :today="today"
          :scale="scale"
          :anchor="anchor"
          @edit="open"
          @day="(date) => router.push({ path: '/day', query: { date } })"
        />
        <template v-else
          ><ul class="entry-list">
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
            class="secondary"
            @click="limit += 40"
          >
            显示更多（已显示 {{ Math.min(limit, visible.length) }} /
            {{ visible.length }}）
          </button></template
        >
      </template>
      <template v-if="view === 'editor'"
        ><EntryEditor
          v-if="editor && !readonly"
          :key="editor.key"
          :entry="editor.entry"
          :draft="editor.draft"
          :categories="snapshot.categories"
          :today="today"
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
        </section></template
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
            <p>删除：{{ entry.deletedAt }}<br />到期：{{ entry.purgeAfter }}</p>
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
      <CategoryManager
        v-if="view === 'categories' && !readonly"
        :categories="snapshot.categories"
        :entries="allEntries"
        :busy="busy"
        :mutate="mutate"
      />
      <section
        v-if="confirm"
        class="confirmation"
        role="region"
        aria-label="危险操作确认"
        @keydown.esc="confirm = null"
      >
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
      </section>
    </template>
  </section>
</template>
