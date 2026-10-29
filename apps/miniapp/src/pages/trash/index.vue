<script setup lang="ts">
import PageShell from '../../components/PageShell.vue';
import SyncStatus from '../../components/SyncStatus.vue';
import { formatBeijingTime, spanLabel, tr } from '../../i18n/index';

import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import type { EntryDto } from '@dayline/contracts';

import { useWorkspace, records, message } from '../../workspace';
const { snapshot, busy, error, readonly, serverTime, ensure, mutate } =
  useWorkspace();
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
  <PageShell
    ><view class="screen-heading"
      ><text class="title">回收站</text><SyncStatus
    /></view>
    <template v-if="snapshot"
      ><button
        v-if="snapshot.trashEntries.length && !readonly"
        :disabled="busy"
        @click="confirm = { kind: 'clear', dataVersion: snapshot.dataVersion }"
      >
        {{ tr('common.clearTrashPermanently') }}</button
      ><text v-if="!snapshot.trashEntries.length" class="text empty">{{
        tr('common.trashIsEmpty')
      }}</text
      ><view v-for="entry in snapshot.trashEntries" :key="entry.id" class="card"
        ><text class="heading">{{ entry.title }}</text
        ><text class="text"
          >{{
            snapshot.categories.find((c) => c.id === entry.categoryId)?.name
          }}
          · {{ entry.startDate }} →
          {{
            entry.endDate ??
            (entry.startDate > snapshot.businessToday
              ? tr('common.endingPending')
              : tr('common.present'))
          }}
          · {{ spanLabel(entry, snapshot.businessToday) }}</text
        ><text class="text">{{
          tr('records.delete', { value0: formatBeijingTime(entry.deletedAt) })
        }}</text
        ><text class="text">{{
          tr('records.expired', { value0: formatBeijingTime(entry.purgeAfter) })
        }}</text
        ><text class="text">{{
          tr('records.focus', {
            value0:
              snapshot.focusDays
                .filter((f) => f.entryId === entry.id && f.focused)
                .map((f) => f.date)
                .join('、') || tr('common.none'),
          })
        }}</text
        ><view v-if="!readonly" class="actions"
          ><button
            :disabled="
              busy || (!!entry.purgeAfter && entry.purgeAfter <= serverTime)
            "
            @click="restore(entry)"
          >
            {{ tr('common.restoreEntry') }}</button
          ><button
            class="secondary"
            :disabled="busy"
            @click="confirm = { kind: 'purge', entry: { ...entry } }"
          >
            {{ tr('common.deleteThisItemPermanently') }}
          </button></view
        ></view
      ></template
    ><view v-if="confirm" class="card confirmation"
      ><text class="text">{{
        tr('mini.cannotRecoverFromTrash', {
          value0:
            confirm.kind === 'clear'
              ? tr('mini.permanentlyClearTheCurrentlySeenEntriesIf', {
                  value0: snapshot?.trashEntries.length,
                })
              : tr('mini.permanentlyDelete', { value0: confirm.entry.title }),
        })
      }}</text
      ><button :disabled="busy" @click="purge">
        {{ tr('common.deletePermanently2') }}</button
      ><button class="secondary" :disabled="busy" @click="confirm = null">
        {{ tr('common.cancel') }}
      </button></view
    ></PageShell
  >
</template>
