import { userDtoSchema } from '@dayline/contracts';
import { readonly, ref } from 'vue';
import type { UserDto } from '@dayline/contracts';
import { ClientError } from '@dayline/api-client';
import { api } from './api';
const current = ref<UserDto | null>(null);
const loading = ref(false);
export function useAccount() {
  async function refresh() {
    loading.value = true;
    try {
      const { data } = await api.request('/api/v1/me', {
        decode: userDtoSchema.parse,
      });
      if (!data) throw new ClientError('EMPTY_RESPONSE', '无法读取账号。');
      current.value = data;
      api.setAccount(data.id);
    } catch (error) {
      if (error instanceof ClientError && error.status === 401) {
        current.value = null;
        api.invalidate();
      }
      throw error;
    } finally {
      loading.value = false;
    }
  }
  function clear() {
    current.value = null;
    api.invalidate();
  }
  return {
    current: readonly(current),
    loading: readonly(loading),
    refresh,
    clear,
  };
}
