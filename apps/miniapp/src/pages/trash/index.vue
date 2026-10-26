<script setup lang="ts">
import { formatBeijingTime } from '@dayline/core';
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import type { EntryDto } from '@dayline/contracts';
import { spanLabel } from '@dayline/core';
import { useWorkspace, records, message } from '../../workspace';
const {
  snapshot,
  loading,
  busy,
  error,
  notice,
  readonly,
  serverTime,
  ensure,
  load,
  mutate,
} = useWorkspace();
const confirm = ref<
  | { kind: 'purge'; entry: EntryDto }
  | { kind: 'clear'; dataVersion: string }
  | null
>(null);
onShow(ensure);
async function restore(e: EntryDto) {
  error.value = '';
  try {
    await mutate(
      { kind: 'restore', id: e.id, expectedVersion: e.version },
      () => records.restore(e.id, e.version),
    );
  } catch (cause) {
    error.value = message(cause);
  }
}
async function purge() {
  const c = confirm.value;
  if (!c) return;
  const input =
    c.kind === 'clear'
      ? { expectedDataVersion: c.dataVersion }
      : { entries: [{ id: c.entry.id, expectedVersion: c.entry.version }] };
  try {
    await mutate({ kind: 'purge', input }, () => records.purge(input));
    confirm.value = null;
  } catch (cause) {
    error.value = message(cause);
  }
}
</script>
<template>
  <view class="page"
    ><text class="title">回收站 · 30 天</text
    ><text v-if="loading" class="text">正在完整读取…</text
    ><text v-if="error" class="text error">{{ error }}</text
    ><text v-if="notice" class="text notice">{{ notice }}</text
    ><button class="secondary" :disabled="busy || loading" @click="load">
      重新完整读取</button
    ><template v-if="snapshot"
      ><button
        v-if="snapshot.trashEntries.length && !readonly"
        :disabled="busy"
        @click="confirm = { kind: 'clear', dataVersion: snapshot.dataVersion }"
      >
        永久清空回收站</button
      ><text v-if="!snapshot.trashEntries.length" class="text empty"
        >回收站为空。</text
      ><view v-for="entry in snapshot.trashEntries" :key="entry.id" class="card"
        ><text class="heading">{{ entry.title }}</text
        ><text class="text"
          >{{
            snapshot.categories.find((c) => c.id === entry.categoryId)?.name
          }}
          · {{ entry.startDate }} →
          {{
            entry.endDate ??
            (entry.startDate > snapshot.businessToday ? '结束未定' : '至今')
          }}
          · {{ spanLabel(entry, snapshot.businessToday) }}</text
        ><text class="text">删除：{{ formatBeijingTime(entry.deletedAt) }}</text
        ><text class="text"
          >到期：{{ formatBeijingTime(entry.purgeAfter) }}</text
        ><text class="text"
          >重点：{{
            snapshot.focusDays
              .filter((f) => f.entryId === entry.id && f.focused)
              .map((f) => f.date)
              .join('、') || '无'
          }}</text
        ><view v-if="!readonly" class="actions"
          ><button
            :disabled="
              busy || (!!entry.purgeAfter && entry.purgeAfter <= serverTime)
            "
            @click="restore(entry)"
          >
            恢复事项</button
          ><button
            class="secondary"
            :disabled="busy"
            @click="confirm = { kind: 'purge', entry: { ...entry } }"
          >
            永久删除此项
          </button></view
        ></view
      ></template
    ><view v-if="confirm" class="card confirmation"
      ><text class="text"
        >{{
          confirm.kind === 'clear'
            ? `永久清空当前看到的 ${snapshot?.trashEntries.length} 条事项？期间有修改会要求重新确认。`
            : `永久删除“${confirm.entry.title}”？`
        }}
        无法从回收站恢复。</text
      ><button :disabled="busy" @click="purge">确认永久删除</button
      ><button class="secondary" :disabled="busy" @click="confirm = null">
        取消
      </button></view
    ></view
  >
</template>
