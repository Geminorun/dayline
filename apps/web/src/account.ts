import {
  sessionStatusSchema,
  userDtoSchema,
  successDtoSchema,
} from '@dayline/contracts';
import { readonly, ref } from 'vue';
import type { UserDto } from '@dayline/contracts';
import { ClientError } from '@dayline/api-client';
import { api } from './api';
const current = ref<UserDto | null>(null),
  loading = ref(false),
  serverTime = ref('');
let probe: Promise<void> | null = null;
let probeSequence = 0;
let probesPaused = false;
api.onIdentityChange(() => {
  probe = null;
  probeSequence++;
  loading.value = false;
  if (current.value?.id !== api.getAccount()) {
    current.value = null;
    serverTime.value = '';
  }
});
let channel: BroadcastChannel | undefined;
if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel('dayline:identity');
  channel.onmessage = () => {
    api.invalidate();
    void useAccount()
      .refresh()
      .catch(() => {});
  };
}
export function useAccount() {
  async function refresh(relogin = false) {
    if (probesPaused)
      throw new ClientError(
        'OPERATION_BUSY',
        '身份操作正在处理中，请完成后重新读取。',
      );
    if (probe && !relogin) return probe;
    if (relogin) api.setAccount(api.getAccount());
    const generation = api.getGeneration(),
      sequence = ++probeSequence;
    loading.value = true;
    const work = (async () => {
      try {
        if (!relogin && !api.getAccount()) {
          const session = await api.request('/api/v1/auth/session', {
            decode: sessionStatusSchema.parse,
          });
          if (!session.data?.authenticated)
            throw new ClientError('UNAUTHENTICATED', '请先登录。', 401);
        }
        const response = await api.request('/api/v1/me', {
          decode: userDtoSchema.parse,
        });
        const data = response.data;
        if (generation !== api.getGeneration()) return;
        if (!data) throw new ClientError('EMPTY_RESPONSE', '无法读取账号。');
        current.value = data;
        serverTime.value = response.serverTime ?? '';
        api.confirmAccount(data.id);
      } catch (error) {
        if (
          generation === api.getGeneration() &&
          error instanceof ClientError &&
          error.status === 401
        ) {
          current.value = null;
          if (api.getAccount()) api.invalidate();
        }
        throw error;
      } finally {
        if (sequence === probeSequence) loading.value = false;
      }
    })();
    probe = work;
    try {
      await work;
    } finally {
      if (probe === work) probe = null;
    }
  }
  async function pauseProbes() {
    probesPaused = true;
    await probe?.catch(() => {});
    return () => {
      probesPaused = false;
    };
  }
  function clear() {
    current.value = null;
    api.invalidate();
    channel?.postMessage({ type: 'identity-may-have-changed' });
  }
  function announce() {
    channel?.postMessage({ type: 'identity-may-have-changed' });
  }
  async function logout() {
    await api.request('/api/v1/auth/logout', {
      method: 'POST',
      account: true,
      body: {},
      decode: successDtoSchema.parse,
    });
    clear();
  }
  return {
    pauseProbes,
    serverTime: readonly(serverTime),
    current: readonly(current),
    loading: readonly(loading),
    refresh,
    clear,
    announce,
    logout,
  };
}
