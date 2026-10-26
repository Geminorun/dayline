<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { coversDate, durationDays } from '@dayline/core';
import type {
  CreateEntryInput,
  EntryDto,
  PatchEntryInput,
  SnapshotDto,
} from '@dayline/contracts';
import { useAccount } from '../account';
import { api } from '../api';
import { records, errorMessage } from './record-service';
import EntryEditor from './EntryEditor.vue';
import EntryRow from './EntryRow.vue';
import CategoryManager from './CategoryManager.vue';
const newKey = () => crypto.randomUUID();
const { current, refresh } = useAccount();
const snapshot = ref<SnapshotDto | null>(null);
const serverTime = ref('');
const loading = ref(true),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  selectedDate = ref('');
const tab = ref<'review' | 'all' | 'trash' | 'categories'>('review');
const editor = ref<{ entry: EntryDto | null; key: string } | null>(null);
const confirm = ref<
  | { kind: 'delete' | 'purge'; entry: EntryDto }
  | { kind: 'clear'; dataVersion: string }
  | null
>(null);
const readonly = computed(() => current.value?.status !== 'active');
const visible = computed(
  () =>
    snapshot.value?.entries.filter(
      (entry) =>
        tab.value === 'all' ||
        coversDate(
          entry,
          selectedDate.value,
          snapshot.value?.businessToday ?? selectedDate.value,
        ),
    ) ?? [],
);
const allEntries = computed(() => [
  ...(snapshot.value?.entries ?? []),
  ...(snapshot.value?.trashEntries ?? []),
]);
async function reload() {
  error.value = '';
  const next = await records.snapshot();
  snapshot.value = next.snapshot;
  serverTime.value = next.serverTime ?? '';
  if (!selectedDate.value) selectedDate.value = next.snapshot.businessToday;
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    await refresh();
    snapshot.value = null;
    await reload();
  } catch (cause) {
    error.value = errorMessage(cause);
    if (!api.getAccount()) snapshot.value = null;
  } finally {
    loading.value = false;
  }
}
async function run(action: () => Promise<unknown>) {
  if (busy.value || loading.value)
    throw new Error('Another operation is in progress');
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await action();
    notice.value = '服务器已确认保存。';
    try {
      await reload();
    } catch (cause) {
      error.value = `保存已完成，完整数据刷新失败：${errorMessage(cause)}`;
    }
  } finally {
    busy.value = false;
  }
}
async function action(work: () => Promise<unknown>) {
  try {
    await run(work);
  } catch (cause) {
    error.value = errorMessage(cause);
    if (!api.getAccount()) snapshot.value = null;
  }
}
async function save(
  id: string,
  input: CreateEntryInput | PatchEntryInput,
  creating: boolean,
) {
  // The discriminated input is validated by each shared schema before transport.
  if (creating && 'id' in input) await run(() => records.create(input));
  else if ('expectedVersion' in input)
    await run(() => records.update(id, input));
}
async function focus(entry: EntryDto) {
  const date = selectedDate.value;
  const existing = snapshot.value?.focusDays.find(
    (focus) => focus.entryId === entry.id && focus.date === date,
  );
  await action(() =>
    records.focus(entry.id, date, {
      focused: !existing?.focused,
      expectedEntryVersion: entry.version,
      expectedFocusVersion: existing?.version ?? 0,
    }),
  );
}
async function finishEntry(entry: EntryDto) {
  await action(() => records.finish(entry.id, entry.version));
}
async function restoreEntry(entry: EntryDto) {
  await action(() => records.restore(entry.id, entry.version));
}
async function confirmed() {
  const confirmation = confirm.value;
  if (!confirmation) return;
  try {
    await run(() =>
      confirmation.kind === 'clear'
        ? records.purge({ expectedDataVersion: confirmation.dataVersion })
        : confirmation.kind === 'purge'
          ? records.purge({
              entries: [
                {
                  id: confirmation.entry.id,
                  expectedVersion: confirmation.entry.version,
                },
              ],
            })
          : records.remove(confirmation.entry.id, confirmation.entry.version),
    );
    confirm.value = null;
  } catch (cause) {
    error.value = errorMessage(cause);
    confirm.value = null;
  }
}
function categoryName(id: string) {
  return (
    snapshot.value?.categories.find((category) => category.id === id)?.name ??
    '分类已变化，请刷新'
  );
}
onMounted(load);
</script>
<template>
  <section class="records-page">
    <p class="eyebrow">DAYLINE · 记录与回看</p>
    <h1>记录持续的经历</h1>
    <p v-if="loading" role="status">正在确认账号并完整读取服务器记录…</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <button class="secondary" :disabled="loading || busy" @click="load">
      重新完整读取
    </button>
    <RouterLink v-if="!current && !loading" to="/login">前往登录</RouterLink>
    <template v-if="snapshot && current && snapshot.userId === current.id">
      <p>
        {{ current.displayName }} · 北京时间今天 {{ snapshot.businessToday }} ·
        全部 {{ snapshot.entries.length }} 条活动事项
      </p>
      <p v-if="readonly" class="notice">
        账号正在注销中，此处仅可查看，业务保存已停用。
      </p>
      <nav aria-label="记录视图">
        <button
          v-for="item in [
            ['review', '每日回看'],
            ['all', '全部事项'],
            ['trash', '回收站'],
            ['categories', '分类'],
          ] as const"
          :key="item[0]"
          class="secondary"
          :aria-pressed="tab === item[0]"
          :disabled="busy"
          @click="tab = item[0]"
        >
          {{ item[1] }}
        </button>
      </nav>
      <button
        v-if="!readonly"
        :disabled="busy || !!editor"
        @click="editor = { entry: null, key: newKey() }"
      >
        新建事项
      </button>
      <EntryEditor
        v-if="editor && !readonly"
        :key="editor.key"
        :entry="editor.entry"
        :categories="snapshot.categories"
        :today="snapshot.businessToday"
        :save="save"
        @close="editor = null"
        @saved="editor = null"
      />
      <div v-if="confirm" class="record-panel">
        <p v-if="confirm.kind === 'delete'">
          将“{{ confirm.entry.title }}”及其重点移入回收站，保留 30 天。
        </p>
        <p v-else-if="confirm.kind === 'purge'">
          永久删除“{{ confirm.entry.title }}”？此操作无法从回收站恢复。
        </p>
        <p v-else>
          永久清空当前看到的
          {{ snapshot.trashEntries.length }}
          条回收站事项？此操作无法恢复。若数据有变化会要求重新确认。
        </p>
        <button :disabled="busy" @click="confirmed">
          确认{{
            confirm.kind === 'delete' ? '移入回收站' : '永久删除'
          }}</button
        ><button class="secondary" :disabled="busy" @click="confirm = null">
          取消
        </button>
      </div>
      <template v-if="tab === 'review' || tab === 'all'">
        <label
          >{{ tab === 'review' ? '回看日期' : '重点操作日期'
          }}<input
            v-model="selectedDate"
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            required /></label
        ><button
          class="secondary"
          @click="selectedDate = snapshot.businessToday"
        >
          回到今天
        </button>
        <p v-if="selectedDate > snapshot.businessToday">
          未来日期不能标记重点；未结束事项只回顾到今天。
        </p>
        <p v-if="!visible.length" class="empty-state">
          {{
            tab === 'review'
              ? '这一天没有事项。可以切换日期，或新建一段经历。'
              : '尚无事项，点击新建开始记录。'
          }}
        </p>
        <ul class="entry-list">
          <EntryRow
            v-for="entry in visible"
            :key="entry.id"
            :entry="entry"
            :category="categoryName(entry.categoryId)"
            :today="snapshot.businessToday"
            :date="selectedDate"
            :focused="
              snapshot.focusDays.some(
                (focus) =>
                  focus.entryId === entry.id &&
                  focus.date === selectedDate &&
                  focus.focused,
              )
            "
            :busy="busy"
            :readonly="readonly"
            @edit="editor = { entry: { ...entry }, key: newKey() }"
            @finish="finishEntry(entry)"
            @remove="confirm = { kind: 'delete', entry: { ...entry } }"
            @focus="focus(entry)"
          />
        </ul>
      </template>
      <template v-else-if="tab === 'trash'"
        ><h2>回收站 · {{ snapshot.trashEntries.length }} 条</h2>
        <button
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
            <h3>{{ entry.title }}</h3>
            <p>
              {{ categoryName(entry.categoryId) }} · {{ entry.startDate }} →
              {{ entry.endDate ?? '至今' }} ·
              {{ durationDays(entry, snapshot.businessToday) }} 天
            </p>
            <p>删除于 {{ entry.deletedAt }} · 到期 {{ entry.purgeAfter }}</p>
            <p>
              重点日期：{{
                snapshot.focusDays
                  .filter(
                    (focus) => focus.entryId === entry.id && focus.focused,
                  )
                  .map((focus) => focus.date)
                  .join('、') || '无'
              }}
            </p>
            <template v-if="!readonly"
              ><button
                :disabled="
                  busy ||
                  (!!entry.purgeAfter &&
                    !!serverTime &&
                    entry.purgeAfter <= serverTime)
                "
                @click="restoreEntry(entry)"
              >
                恢复事项</button
              ><button
                class="secondary"
                :disabled="busy"
                @click="confirm = { kind: 'purge', entry: { ...entry } }"
              >
                永久删除此项
              </button></template
            >
          </li>
        </ul></template
      >
      <CategoryManager
        v-else-if="tab === 'categories' && !readonly"
        :categories="snapshot.categories"
        :entries="allEntries"
        :run="run"
        :busy="busy"
      />
    </template>
  </section>
</template>
