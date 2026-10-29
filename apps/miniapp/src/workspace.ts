import { tr, messageRef } from './i18n/index';
import { msg } from '@dayline/locales';
import { monotonicNow } from './adapters/clock';
import { computed, ref, watch } from 'vue';
import {
  createRecordsClient,
  ClientError,
  SnapshotCoordinator,
} from '@dayline/api-client';
import {
  commitGuestMutation,
  GuestError,
  guestSnapshot,
  loadGuest,
  successDtoSchema,
  userDtoSchema,
  wechatLoginDtoSchema,
} from '@dayline/contracts';
import type {
  GuestMutation,
  GuestPackage,
  SnapshotDto,
  UserDto,
} from '@dayline/contracts';
import { businessToday } from '@dayline/core';
import { useAdmission } from './admission';
import {
  localRepository as accountRepository,
  localEnvironment,
} from './adapters/local-repository';
import {
  api,
  clearCredential,
  hasCredential,
  wechatCode,
  credentialWarning,
} from './api';
import {
  MiniGuestRepository,
  platformStorage,
} from './adapters/guest-repository';
import { uuidBatch, newId } from './adapters/uuid';

export const records = createRecordsClient(api);
export const requestedDay = ref('');
export function message(cause: unknown) {
  if (
    cause instanceof ClientError &&
    cause.status === 429 &&
    cause.retryAfterSeconds !== undefined
  )
    startRetry(cause.retryAfterSeconds);
  return cause instanceof ClientError || cause instanceof GuestError
    ? (cause.localized ?? cause.message)
    : msg('record-service.theOperationIsNotCompletedPleaseTry');
}
const mode = ref<'guest' | 'account'>('guest'),
  snapshot = ref<SnapshotDto | null>(null),
  guest = ref<GuestPackage | null>(null),
  current = ref<UserDto | null>(null),
  busy = ref(false),
  loading = ref(false),
  error = messageRef(),
  notice = messageRef(),
  serverTime = ref(''),
  identityState = ref<'unknown' | 'guest' | 'verified' | 'expired'>('unknown'),
  spaceRevision = ref(0);
const retrySeconds = ref(0);
let retryUntil = 0,
  retryTimer: ReturnType<typeof setInterval> | undefined,
  noticeTimer: ReturnType<typeof setTimeout> | undefined;
function retryTick() {
  retrySeconds.value = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
  if (!retrySeconds.value) {
    clearInterval(retryTimer);
    retryTimer = undefined;
  }
}
function startRetry(seconds: number) {
  retryUntil = Math.max(
    retryUntil,
    Date.now() + Math.min(3600, Math.max(0, seconds)) * 1000,
  );
  retryTick();
  if (!retryTimer && retrySeconds.value)
    retryTimer = setInterval(retryTick, 1000);
}
watch(notice, () => {
  clearTimeout(noticeTimer);
  if (notice.value)
    noticeTimer = setTimeout(() => {
      notice.value = '';
    }, 3500);
});
const namespace = `dayline:${import.meta.env.MODE}:${encodeURIComponent(import.meta.env.VITE_API_BASE_URL ?? 'unconfigured')}:v1:guest`;
async function localRepository() {
  const generation = await newId();
  return new MiniGuestRepository(platformStorage, () => generation, namespace);
}
const modeKey = `dayline:${localEnvironment}:v1:storage-mode`;
let initialized = false;
let bootWork: Promise<void> | null = null;
let scopeGeneration = 0;
let switchIntent = 0;
let loadWork: Promise<void> | null = null;
let foreground = true,
  timer: ReturnType<typeof setTimeout> | undefined;
const coordinator = new SnapshotCoordinator(
  localEnvironment,
  accountRepository,
  (etag) => records.conditionalSnapshot(etag),
  (next, time) => {
    if (mode.value === 'account') {
      snapshot.value = next;
      if (time) serverTime.value = time;
    }
  },
  () => {
    error.value = msg('workspace.theLocalAccountCacheIsUnavailableAnd2');
  },
  monotonicNow,
);
const profileProbes = new Set<Promise<unknown>>();
function readProfile() {
  if (identityWritePending)
    return Promise.reject(
      new ClientError(
        'OPERATION_BUSY',
        msg('workspace.identityOperationInProgress'),
      ),
    );
  const work = api.request('/api/v1/me', { decode: userDtoSchema.parse });
  profileProbes.add(work);
  void work.finally(() => profileProbes.delete(work)).catch(() => {});
  return work;
}
let identityWritePending = false;
let pendingNavigation = false;
async function identityWrite<T>(work: () => Promise<T>): Promise<T> {
  if (identityWritePending)
    throw new ClientError(
      'OPERATION_BUSY',
      msg('workspace.identityOperationInProgress'),
    );
  identityWritePending = true;
  stop();
  const generation = api.getGeneration();
  try {
    await Promise.allSettled([...profileProbes]);
    await loadWork?.catch(() => {});
    if (generation !== api.getGeneration())
      throw new ClientError(
        'STALE_RESPONSE',
        msg('workspace.theAccountHasChangedPleaseVerifyAgain'),
      );
    return await work();
  } finally {
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
        void useWorkspace().load().finally(schedule);
      },
      Math.max(30000, retrySeconds.value * 1000),
    );
}
api.onIdentityChange(() => {
  clearInterval(retryTimer);
  retryTimer = undefined;
  retryUntil = 0;
  retrySeconds.value = 0;
  notice.value = '';
  pendingNavigation = false;
  scopeGeneration++;
  spaceRevision.value = scopeGeneration;
  stop();
  mode.value = 'guest';
  identityState.value = api.getAccount() ? 'unknown' : 'expired';
  initialized = false;
  busy.value = false;
  loading.value = false;
  error.value = msg('workspace.theSessionHasChangedAndPrivateContent');
  snapshot.value = null;
  current.value = null;
  requestedDay.value = '';
  coordinator.reset(null);
  loadWork = null;
});
api.onWrite((data, version, time) => {
  if (mode.value === 'account') coordinator.written(data, version, time);
});
function navigatePending() {
  if (pendingNavigation || typeof uni.navigateTo !== 'function') return;
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  if (
    ['pages/account/deletion', 'pages/scan/confirm'].includes(
      pages.at(-1)?.route ?? '',
    )
  )
    return;
  pendingNavigation = true;
  uni.navigateTo({
    url: '/pages/account/deletion',
    complete: () => {
      pendingNavigation = false;
    },
  });
}
export function useWorkspace() {
  async function reload() {
    if (identityWritePending) return;
    const generation = scopeGeneration;
    if (mode.value === 'guest') {
      const ids = await uuidBatch(7),
        repository = await localRepository();
      let index = 0;
      const data = await loadGuest(
        repository,
        () => {
          const id = ids[index++];
          if (!id) throw new Error('Missing UUID');
          return id;
        },
        new Date().toISOString(),
      );
      if (generation !== scopeGeneration || mode.value !== 'guest') return;
      guest.value = data;
      snapshot.value = guestSnapshot(data, businessToday());
      serverTime.value = new Date().toISOString();
    } else if (current.value?.status === 'active') {
      await coordinator.refresh();
    } else snapshot.value = null;
  }

  function load(): Promise<void> {
    retryTick();
    if (retrySeconds.value > 0) return Promise.resolve();
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
        if (generation === scopeGeneration) error.value = message(cause);
      } finally {
        if (generation === scopeGeneration) loading.value = false;
      }
    })();
    const result = work.finally(() => {
      if (loadWork === result) loadWork = null;
    });
    loadWork = result;
    return result;
  }
  async function switchMode(
    next: 'guest' | 'account',
    time?: string,
    remember = true,
  ) {
    const intent = ++switchIntent;
    const user = current.value;
    if (remember)
      try {
        platformStorage.set(modeKey, next);
      } catch {
        /* preference only */
      }
    scopeGeneration++;
    spaceRevision.value = scopeGeneration;
    stop();
    snapshot.value = null;
    mode.value = 'guest';
    requestedDay.value = '';
    busy.value = false;
    loading.value = false;
    coordinator.reset(null);
    loadWork = null;
    if (next === 'account') {
      if (!user) return;
      mode.value = 'account';
      identityState.value = 'verified';
      coordinator.reset(user.id);
      if (time) coordinator.setServerTime(time);
      if (user.status === 'active') await coordinator.cache();
    }
    if (intent !== switchIntent) return;
    if (next === 'guest') identityState.value = 'guest';
    await load();
    if (intent === switchIntent) {
      schedule();
      if (next === 'account' && current.value?.status === 'pending_deletion')
        navigatePending();
    }
  }
  async function mutate(
    mutation: GuestMutation,
    cloud: () => Promise<unknown>,
  ) {
    retryTick();
    if (retrySeconds.value > 0)
      throw new ClientError(
        'RATE_LIMITED',
        msg('errors.theOperationIsTooFrequentPleaseWait', {
          value0: retrySeconds.value,
        }),
        0,
        undefined,
        retrySeconds.value,
      );
    if (busy.value || loading.value)
      throw new Error(tr('common.operationInProgress'));
    const generation = scopeGeneration;
    busy.value = true;
    error.value = '';
    notice.value = '';
    try {
      if (mode.value === 'guest') {
        if (!guest.value)
          throw new Error(tr('workspace.incompleteReadingOfLocalData'));
        const repository = await localRepository(),
          data = await commitGuestMutation(
            repository,
            guest.value,
            mutation,
            new Date().toISOString(),
          );
        if (generation !== scopeGeneration) return;
        guest.value = data;
        snapshot.value = guestSnapshot(data, businessToday());
        serverTime.value = new Date().toISOString();
        notice.value = msg('common.savedToThisMachine');
      } else {
        const result = await cloud();
        if (generation !== scopeGeneration)
          throw new ClientError(
            'STALE_RESPONSE',
            msg('common.theAccountHasChanged'),
          );
        notice.value = msg('common.savedToTheCloud');
        try {
          await reload();
        } catch (cause) {
          if (generation === scopeGeneration)
            error.value = msg('workspace.savedToCloudRefreshFailed', {
              value0: message(cause),
            });
        }
        return result;
      }
    } finally {
      if (generation === scopeGeneration) busy.value = false;
    }
  }
  async function login() {
    retryTick();
    if (retrySeconds.value > 0) return;
    const intent = ++switchIntent;
    busy.value = true;
    error.value = '';
    try {
      const code = await wechatCode();
      if (intent !== switchIntent) return;
      const response = await api.request('/api/v1/auth/wechat/login', {
        method: 'POST',
        body: { code },
        decode: wechatLoginDtoSchema.parse,
      });
      if (intent !== switchIntent) return;
      if (!response.data) throw new Error('Missing login');
      api.setAccount(response.data.user.id);
      const result = await api.request('/api/v1/me', {
        decode: userDtoSchema.parse,
      });
      if (intent !== switchIntent || !result.data) return;
      current.value = result.data;
      await switchMode('account', result.serverTime);
      const mounted = switchIntent;
      if (mode.value === 'account' && current.value?.status === 'active')
        await useAdmission().begin();
      if (mounted === switchIntent) await load();
    } catch (cause) {
      if (intent === switchIntent) error.value = message(cause);
    } finally {
      if (intent === switchIntent) busy.value = false;
    }
  }
  async function restoreSession() {
    retryTick();
    if (retrySeconds.value > 0) return;
    if (identityWritePending) return;
    const intent = ++switchIntent;
    error.value = '';
    try {
      const response = await readProfile();
      if (intent !== switchIntent) return;
      if (!response.data) throw new Error('Missing profile');
      const same =
        current.value?.id === response.data.id &&
        mode.value === 'account' &&
        api.getAccount() === response.data.id;
      api.confirmAccount(response.data.id);
      current.value = response.data;
      if (same) {
        if (response.serverTime) coordinator.setServerTime(response.serverTime);
        await load();
        return;
      }
      await switchMode('account', response.serverTime, false);
    } catch (cause) {
      if (intent !== switchIntent) return;
      if (cause instanceof ClientError && cause.status === 401) {
        identityState.value = 'guest';
        current.value = null;
        error.value = '';
        await switchMode('guest', undefined, false);
      } else {
        identityState.value = 'unknown';
        snapshot.value = null;
        error.value = message(cause);
      }
    }
  }
  function ensure(): Promise<void> {
    if (initialized) {
      if (
        mode.value === 'account' &&
        current.value?.status === 'pending_deletion'
      ) {
        const pages =
          typeof getCurrentPages === 'function' ? getCurrentPages() : [];
        if (pages.at(-1)?.route !== 'pages/me/index') navigatePending();
      }
      return Promise.resolve();
    }
    if (bootWork) return bootWork;
    const work = (async () => {
      try {
        if (platformStorage.get(modeKey) === 'guest' || !hasCredential()) {
          identityState.value = 'guest';
          await load();
        } else await restoreSession();
      } catch (cause) {
        identityState.value = 'unknown';
        snapshot.value = null;
        error.value = message(cause);
      }
    })();
    const result = work.finally(() => {
      if (bootWork === result) bootWork = null;
    });
    bootWork = result;
    return result;
  }
  async function logout() {
    busy.value = true;
    error.value = '';
    try {
      await api.request('/api/v1/auth/logout', {
        method: 'POST',
        account: true,
        body: {},
        decode: successDtoSchema.parse,
      });
      api.invalidate();
      try {
        clearCredential();
      } catch {
        notice.value = msg(
          'workspace.exitedLocalCleanupOfLoginCredentialsFailed',
        );
      }
      current.value = null;
      await switchMode('guest');
    } catch (cause) {
      error.value = message(cause);
    } finally {
      busy.value = false;
    }
  }
  return {
    mode,
    retrySeconds,
    dismissNotice: () => {
      notice.value = '';
    },
    credentialWarning,
    spaceRevision,
    identityState,
    snapshot,
    current,
    busy,
    loading,
    error,
    notice,
    serverTime,
    lifecycle: (active: boolean) => {
      foreground = active;
      retryTick();
      if (!active) {
        clearInterval(retryTimer);
        retryTimer = undefined;
      } else if (retrySeconds.value && !retryTimer)
        retryTimer = setInterval(retryTick, 1000);
      stop();
      if (active) {
        coordinator.tick();
        if (
          identityState.value === 'verified' ||
          identityState.value === 'guest'
        )
          void load().finally(schedule);
      }
    },
    identityWrite,
    generation: () => scopeGeneration,
    readonly: computed(
      () => mode.value === 'account' && current.value?.status !== 'active',
    ),
    load,
    reload,
    switchMode,
    mutate,
    login,
    restoreSession,
    logout,
    networkRestored: () => {
      if (
        foreground &&
        (identityState.value === 'verified' || identityState.value === 'guest')
      )
        void load().finally(schedule);
    },
    ensure,
  };
}
