import { computed, ref } from 'vue';
import { recordView } from './view-state';
import { businessToday, emptyFilter } from '@dayline/core';
import {
  commitGuestMutation,
  guestSnapshot,
  loadGuest,
} from '@dayline/contracts';
import type {
  GuestMutation,
  GuestPackage,
  SnapshotDto,
} from '@dayline/contracts';
import { guestRepository } from '../adapters/guest-repository';
import { useAccount } from '../account';
import { records, errorMessage } from './record-service';
const mode = ref<'guest' | 'account'>('guest'),
  snapshot = ref<SnapshotDto | null>(null),
  guest = ref<GuestPackage | null>(null),
  loading = ref(false),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  serverTime = ref('');
const { current, refresh } = useAccount();
let initialized = false;
let scopeGeneration = 0;
let loadWork: Promise<void> | null = null;
export function useWorkspace() {
  async function reload() {
    const generation = scopeGeneration;
    if (mode.value === 'guest') {
      const data = await loadGuest(
        guestRepository,
        () => crypto.randomUUID(),
        new Date().toISOString(),
      );
      if (generation !== scopeGeneration || mode.value !== 'guest') return;
      guest.value = data;
      snapshot.value = guestSnapshot(data, businessToday());
      serverTime.value = new Date().toISOString();
    } else {
      const next = await records.snapshot();
      if (
        generation !== scopeGeneration ||
        mode.value !== 'account' ||
        next.snapshot.userId !== current.value?.id
      )
        return;
      snapshot.value = next.snapshot;
      serverTime.value = next.serverTime ?? new Date().toISOString();
    }
  }
  function load(): Promise<void> {
    if (loadWork) return loadWork;
    loading.value = true;
    error.value = '';
    loadWork = (async () => {
      try {
        await reload();
        initialized = true;
      } catch (cause) {
        error.value = errorMessage(cause);
      } finally {
        loading.value = false;
      }
    })().finally(() => {
      loadWork = null;
    });
    return loadWork;
  }
  async function switchMode(next: 'guest' | 'account') {
    if (busy.value) return;
    scopeGeneration++;
    recordView.filter = emptyFilter();
    if (loadWork) await loadWork;
    loading.value = true;
    error.value = '';
    snapshot.value = null;
    notice.value = '';
    try {
      if (next === 'account') await refresh();
      mode.value = next;
      await reload();
      initialized = true;
    } catch (cause) {
      error.value = errorMessage(cause);
    } finally {
      loading.value = false;
    }
  }
  async function mutate(
    mutation: GuestMutation,
    cloud: () => Promise<unknown>,
  ) {
    if (busy.value || loading.value) throw new Error('操作正在进行');
    busy.value = true;
    error.value = '';
    notice.value = '';
    try {
      if (mode.value === 'guest') {
        if (!guest.value) throw new Error('本机记录尚未加载');
        const data = await commitGuestMutation(
          guestRepository,
          guest.value,
          mutation,
          new Date().toISOString(),
        );
        guest.value = data;
        snapshot.value = guestSnapshot(data, businessToday());
        serverTime.value = new Date().toISOString();
        notice.value = '已保存到本机。';
      } else {
        await cloud();
        notice.value = '已保存到云端。';
        try {
          await reload();
        } catch (cause) {
          error.value = `已保存到云端，刷新失败：${errorMessage(cause)}`;
        }
      }
    } finally {
      busy.value = false;
    }
  }
  return {
    mode,
    snapshot,
    guest,
    loading,
    busy,
    error,
    notice,
    serverTime,
    readonly: computed(
      () => mode.value === 'account' && current.value?.status !== 'active',
    ),
    load,
    reload,
    switchMode,
    mutate,
    ensure: () => (initialized ? Promise.resolve() : load()),
  };
}
