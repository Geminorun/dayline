import { computed, ref } from 'vue';
import { SnapshotCoordinator, ClientError } from '@dayline/api-client';
import { resetRecordView } from './view-state';
import { businessToday } from '@dayline/core';
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
import {
  localEnvironment,
  localRepository,
} from '../adapters/local-repository';
import { useAdmission } from '../admission';
import { api } from '../api';
import { useAccount } from '../account';
import { records, errorMessage } from './record-service';
const mode = ref<'guest' | 'account'>('guest'),
  snapshot = ref<SnapshotDto | null>(null),
  guest = ref<GuestPackage | null>(null),
  loading = ref(false),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  serverTime = ref(''),
  cacheError = ref(''),
  identityState = ref<'unknown' | 'guest' | 'verified' | 'expired'>('unknown');
const { current, refresh } = useAccount();
const retrySeconds = ref(0);
let retryUntil = 0,
  lastReadAt = 0,
  lastProbeAt = 0;
let retryTimer: ReturnType<typeof setInterval> | undefined;
let probeWork: Promise<void> | null = null;
let writeReadTimer: ReturnType<typeof setTimeout> | undefined;
let writeReadPending = false;
function resetReadBudget() {
  clearTimeout(writeReadTimer);
  writeReadTimer = undefined;
  writeReadPending = false;
  clearInterval(retryTimer);
  retryTimer = undefined;
  retryUntil = 0;
  retrySeconds.value = 0;
  lastReadAt = 0;
  lastProbeAt = 0;
  probeWork = null;
}
function refreshError(cause: unknown) {
  if (
    cause instanceof ClientError &&
    cause.status === 429 &&
    cause.retryAfterSeconds !== undefined
  ) {
    retryUntil = Date.now() + Math.max(1, cause.retryAfterSeconds) * 1000;
    clearInterval(retryTimer);
    const tick = () => {
      retrySeconds.value = Math.max(
        0,
        Math.ceil((retryUntil - Date.now()) / 1000),
      );
      if (retrySeconds.value)
        error.value = `操作过于频繁，请等待 ${retrySeconds.value} 秒后再试。`;
      else {
        clearInterval(retryTimer);
        retryTimer = undefined;
        error.value = '';
      }
    };
    tick();
    retryTimer = setInterval(tick, 500);
  } else error.value = errorMessage(cause);
}
let switchIntent = 0;
let bootWork: Promise<void> | null = null;
let initialized = false,
  scopeGeneration = 0,
  loadWork: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined,
  foreground = true;
const coordinator = new SnapshotCoordinator(
  localEnvironment,
  localRepository,
  (etag) => records.conditionalSnapshot(etag),
  (next, time) => {
    if (mode.value === 'account') {
      snapshot.value = next;
      if (time) serverTime.value = time;
    }
  },
  () => {
    cacheError.value =
      '本机账号缓存不可用，云端保存状态不受影响；草稿仍独立保留。';
  },
  () => performance.now(),
);
let identityWritePending = false;
async function identityWrite<T>(work: () => Promise<T>): Promise<T> {
  if (identityWritePending)
    throw new ClientError('OPERATION_BUSY', '身份操作正在处理中。');
  identityWritePending = true;
  stop();
  const generation = api.getGeneration();
  const resumeProbes = await useAccount().pauseProbes();
  try {
    await loadWork?.catch(() => {});
    if (generation !== api.getGeneration())
      throw new ClientError('STALE_RESPONSE', '账号已变化，请重新验证。');
    return await work();
  } finally {
    resumeProbes();
    identityWritePending = false;
    schedule();
  }
}
function stop() {
  if (timer) clearTimeout(timer);
  timer = undefined;
}
function schedule() {
  stop();
  if (
    !identityWritePending &&
    foreground &&
    mode.value === 'account' &&
    current.value?.status === 'active'
  )
    timer = setTimeout(
      () => {
        coordinator.tick();
        void useWorkspace().load('background').finally(schedule);
      },
      Math.max(30_000, retryUntil - Date.now()),
    );
}
api.onIdentityChange(() => {
  resetReadBudget();
  scopeGeneration++;
  stop();
  initialized = false;
  loadWork = null;
  busy.value = false;
  loading.value = false;
  identityState.value = api.getAccount() ? 'unknown' : 'expired';
  snapshot.value = null;
  notice.value = '';
  error.value = api.getAccount()
    ? ''
    : '会话已变化，私人内容已隐藏，原账号草稿保留。请重新验证或明确继续游客。';
  cacheError.value = '';
  mode.value = 'guest';
  resetRecordView();
  coordinator.reset(null);
});
api.onWrite((data, version, time) => {
  if (mode.value === 'account') coordinator.written(data, version, time);
});
export function useWorkspace() {
  async function reload() {
    if (identityWritePending) return;
    if (Date.now() < retryUntil)
      throw new ClientError(
        'RATE_LIMITED',
        error.value,
        429,
        undefined,
        retrySeconds.value,
      );
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
    } else if (current.value?.status === 'active') {
      await coordinator.refresh();
      if (generation === scopeGeneration) {
        lastReadAt = Date.now();
        writeReadPending = false;
      }
    } else snapshot.value = null;
  }
  function load(reason: 'manual' | 'background' = 'manual'): Promise<void> {
    if (
      Date.now() < retryUntil ||
      (reason === 'background' &&
        !writeReadPending &&
        Date.now() - lastReadAt < 5000)
    )
      return Promise.resolve();
    if (identityWritePending) return Promise.resolve();
    if (loadWork) return loadWork;
    const generation = scopeGeneration;
    loading.value = true;
    error.value = '';
    const work = (async () => {
      try {
        await reload();
        if (generation === scopeGeneration) initialized = true;
      } catch (cause) {
        if (generation === scopeGeneration) refreshError(cause);
      } finally {
        if (generation === scopeGeneration) loading.value = false;
      }
    })();
    loadWork = work.finally(() => {
      if (loadWork === result) loadWork = null;
    });
    const result = loadWork;
    return result;
  }
  async function switchMode(next: 'guest' | 'account', admit = true) {
    const intent = ++switchIntent;
    resetReadBudget();
    try {
      if (admit) sessionStorage.setItem('dayline:storage-mode', next);
    } catch {
      /* preference only */
    }
    scopeGeneration++;
    stop();
    snapshot.value = null;
    busy.value = false;
    loading.value = false;
    initialized = false;
    notice.value = '';
    error.value = '';
    cacheError.value = '';
    resetRecordView();
    mode.value = 'guest';
    coordinator.reset(null);
    loadWork = null;
    try {
      if (next === 'account') {
        await refresh();
        if (intent !== switchIntent) return;
        if (!current.value)
          throw new ClientError('UNAUTHENTICATED', '请先登录。');
        mode.value = 'account';
        identityState.value = 'verified';
        coordinator.reset(current.value.id);
        if (useAccount().serverTime.value)
          coordinator.setServerTime(useAccount().serverTime.value);
        if (current.value.status === 'active') await coordinator.cache();
        if (intent !== switchIntent) return;
      }
      if (intent !== switchIntent) return;
      if (next === 'guest') identityState.value = 'guest';
      if (admit && next === 'account' && current.value?.status === 'active')
        await useAdmission().begin();
      if (intent !== switchIntent) return;
      await load();
      if (intent === switchIntent) schedule();
    } catch (cause) {
      if (intent !== switchIntent) return;
      if (!admit && cause instanceof ClientError && cause.status === 401) {
        identityState.value = 'guest';
        error.value = '';
        await load();
      } else {
        identityState.value = current.value ? 'expired' : 'unknown';
        error.value = errorMessage(cause);
      }
    }
  }
  async function mutate(
    mutation: GuestMutation,
    cloud: () => Promise<unknown>,
  ) {
    if (busy.value) throw new Error('操作正在进行');
    const generation = scopeGeneration,
      space = mode.value;
    busy.value = true;
    error.value = '';
    notice.value = '';
    try {
      if (space === 'guest') {
        if (!guest.value) throw new Error('本机记录尚未加载');
        const data = await commitGuestMutation(
          guestRepository,
          guest.value,
          mutation,
          new Date().toISOString(),
        );
        if (generation !== scopeGeneration) return;
        guest.value = data;
        snapshot.value = guestSnapshot(data, businessToday());
        serverTime.value = new Date().toISOString();
        notice.value = '已保存到本机。';
      } else {
        if (!navigator.onLine)
          throw new ClientError('OFFLINE', '当前离线，联网后请手动保存。');
        const result = await cloud();
        if (generation !== scopeGeneration)
          throw new ClientError('STALE_RESPONSE', '账号已变化，原输入仍保留。');
        notice.value = '已保存到云端。';
        try {
          if (coordinator.requiresFullRefresh()) await reload();
          else {
            // Paint confirmed writes immediately, then reconcile one complete snapshot for a burst.
            writeReadPending = true;
            if (!writeReadTimer)
              writeReadTimer = setTimeout(() => {
                writeReadTimer = undefined;
                if (generation === scopeGeneration && foreground)
                  void load('background');
              }, 750);
          }
        } catch (cause) {
          if (generation === scopeGeneration) refreshError(cause);
        }
        return result;
      }
    } finally {
      if (generation === scopeGeneration) busy.value = false;
    }
  }
  function lifecycle(active: boolean) {
    foreground = active;
    stop();
    if (!active) return;
    coordinator.tick();
    if (identityState.value === 'verified' || identityState.value === 'guest')
      void load('background').finally(schedule);
  }
  function reprobe(): Promise<void> {
    if (probeWork) return probeWork;
    if (
      identityWritePending ||
      mode.value !== 'account' ||
      Date.now() - lastProbeAt < 5000
    )
      return Promise.resolve();
    const generation = scopeGeneration;
    lastProbeAt = Date.now();
    const work = (async () => {
      try {
        await refresh();
      } catch {
        return;
      }
      if (generation === scopeGeneration && mode.value === 'account')
        await load('background');
    })();
    const result = work.finally(() => {
      if (probeWork === result) probeWork = null;
    });
    probeWork = result;
    return result;
  }
  return {
    mode,
    identityState,
    snapshot,
    guest,
    loading,
    retrySeconds,
    busy,
    error,
    notice,
    serverTime,
    cacheError,
    readonly: computed(
      () => mode.value === 'account' && current.value?.status !== 'active',
    ),
    load,
    reload,
    switchMode,
    mutate,
    lifecycle,
    reprobe,
    ensure: () => {
      if (initialized) return Promise.resolve();
      if (bootWork) return bootWork;
      const work = (async () => {
        // A valid session always opens its account; anonymous sessions fall back to local records.
        await switchMode('account', false);
      })();
      const result = work.finally(() => {
        if (bootWork === result) bootWork = null;
      });
      bootWork = result;
      return result;
    },
    retryIdentity: () => switchMode('account', false),
    networkRestored: () => {
      if (foreground) {
        coordinator.tick();
        void load('background').finally(schedule);
      }
    },
    identityWrite,
    generation: () => scopeGeneration,
  };
}
