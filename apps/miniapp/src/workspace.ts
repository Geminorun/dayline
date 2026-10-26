import { computed, ref } from 'vue';
import { createRecordsClient, ClientError } from '@dayline/api-client';
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
import { api, clearCredential, wechatCode } from './api';
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
  serverTime = ref('');
const namespace = `dayline:${import.meta.env.MODE}:${encodeURIComponent(import.meta.env.VITE_API_BASE_URL ?? 'unconfigured')}:v1:guest`;
async function localRepository() {
  const generation = await newId();
  return new MiniGuestRepository(platformStorage, () => generation, namespace);
}
let scopeGeneration = 0;
let loadWork: Promise<void> | null = null;
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
      const next = await records.snapshot();
      if (
        generation === scopeGeneration &&
        mode.value === 'account' &&
        next.snapshot.userId === current.value?.id
      ) {
        snapshot.value = next.snapshot;
        serverTime.value = next.serverTime ?? new Date().toISOString();
      }
    }
  }
  function load(): Promise<void> {
    if (loadWork) return loadWork;
    loading.value = true;
    error.value = '';
    loadWork = (async () => {
      try {
        await reload();
      } catch (cause) {
        error.value = message(cause);
      } finally {
        loading.value = false;
      }
    })().finally(() => (loadWork = null));
    return loadWork;
  }
  async function switchMode(next: 'guest' | 'account') {
    scopeGeneration++;
    if (loadWork) await loadWork;
    snapshot.value = null;
    mode.value = next;
    await load();
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
        if (!guest.value) throw new Error('未完整读取本机数据');
        const repository = await localRepository(),
          data = await commitGuestMutation(
            repository,
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
          error.value = `已保存到云端，刷新失败：${message(cause)}`;
        }
      }
    } finally {
      busy.value = false;
    }
  }
  async function login() {
    busy.value = true;
    error.value = '';
    try {
      const code = await wechatCode();
      const response = await api.request('/api/v1/auth/wechat/login', {
        method: 'POST',
        body: { code },
        decode: wechatLoginDtoSchema.parse,
      });
      if (!response.data) throw new Error('Missing login');
      api.setAccount(response.data.user.id);
      const result = await api.request('/api/v1/me', {
        decode: userDtoSchema.parse,
      });
      if (!result.data) throw new Error('Missing profile');
      current.value = result.data;
      busy.value = false;
      await switchMode('account');
    } catch (cause) {
      error.value = message(cause);
    } finally {
      busy.value = false;
    }
  }
  async function restoreSession() {
    error.value = '';
    try {
      const response = await api.request('/api/v1/me', {
        decode: userDtoSchema.parse,
      });
      if (!response.data) throw new Error('Missing profile');
      current.value = response.data;
      api.setAccount(response.data.id);
      await switchMode('account');
    } catch (cause) {
      error.value = message(cause);
    }
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
      clearCredential();
      api.invalidate();
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
    snapshot,
    current,
    busy,
    loading,
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
    login,
    restoreSession,
    logout,
    ensure: () => (snapshot.value ? Promise.resolve() : load()),
  };
}
