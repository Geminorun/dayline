import { monotonicNow } from './adapters/clock';
import { computed, ref } from 'vue';
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
  return cause instanceof ClientError || cause instanceof GuestError
    ? cause.message
    : '操作未完成，请重试。';
}
const mode = ref<'guest' | 'account'>('guest'),
  snapshot = ref<SnapshotDto | null>(null),
  guest = ref<GuestPackage | null>(null),
  current = ref<UserDto | null>(null),
  busy = ref(false),
  loading = ref(false),
  error = ref(''),
  notice = ref(''),
  serverTime = ref(''),
  identityState = ref<'unknown' | 'guest' | 'verified' | 'expired'>('unknown'),
  spaceRevision = ref(0);
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
    error.value = '本机账号缓存不可用，云端数据仍保留。';
  },
  monotonicNow,
);
function stop() {
  if (timer) clearTimeout(timer);
  timer = undefined;
}
function schedule() {
  stop();
  if (foreground && mode.value === 'account' && current.value)
    timer = setTimeout(() => {
      coordinator.tick();
      void useWorkspace().load().finally(schedule);
    }, 30000);
}
api.onIdentityChange(() => {
  scopeGeneration++;
  spaceRevision.value = scopeGeneration;
  stop();
  mode.value = 'guest';
  identityState.value = api.getAccount() ? 'unknown' : 'expired';
  initialized = false;
  busy.value = false;
  loading.value = false;
  error.value = '会话已变化，私人内容已隐藏；请重新验证或明确继续游客。';
  snapshot.value = null;
  current.value = null;
  requestedDay.value = '';
  coordinator.reset(null);
  loadWork = null;
});
api.onWrite((data, version, time) => {
  if (mode.value === 'account') coordinator.written(data, version, time);
});
export function useWorkspace() {
  async function reload() {
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
    } else {
      await coordinator.refresh();
    }
  }

  function load(): Promise<void> {
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
      await coordinator.cache();
    }
    if (intent !== switchIntent) return;
    if (next === 'guest') identityState.value = 'guest';
    await load();
    if (intent === switchIntent) schedule();
  }
  async function mutate(
    mutation: GuestMutation,
    cloud: () => Promise<unknown>,
  ) {
    if (busy.value || loading.value) throw new Error('操作正在进行');
    const generation = scopeGeneration;
    busy.value = true;
    error.value = '';
    notice.value = '';
    try {
      if (mode.value === 'guest') {
        if (!guest.value) throw new Error('未完整读取本机数据');
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
        notice.value = '已保存到本机。';
      } else {
        const result = await cloud();
        if (generation !== scopeGeneration)
          throw new ClientError('STALE_RESPONSE', '账号已变化。');
        notice.value = '已保存到云端。';
        try {
          await reload();
        } catch (cause) {
          if (generation === scopeGeneration)
            error.value = `已保存到云端，刷新失败：${message(cause)}`;
        }
        return result;
      }
    } finally {
      if (generation === scopeGeneration) busy.value = false;
    }
  }
  async function login() {
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
    const intent = ++switchIntent;
    error.value = '';
    try {
      const response = await api.request('/api/v1/me', {
        decode: userDtoSchema.parse,
      });
      if (intent !== switchIntent) return;
      if (!response.data) throw new Error('Missing profile');
      api.confirmAccount(response.data.id);
      current.value = response.data;
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
    if (initialized) return Promise.resolve();
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
        notice.value = '已退出，登录凭据本机清理失败，请检查存储。';
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
