import {
  categoryResultSchema,
  entryResultSchema,
  focusResultSchema,
  snapshotDtoSchema,
  purgeResultSchema,
  deleteCategoryResultSchema,
} from '@dayline/contracts';
import type {
  CreateCategoryInput,
  PatchCategoryInput,
  DeleteCategoryInput,
  CreateEntryInput,
  PatchEntryInput,
  SetFocusInput,
  PurgeTrashInput,
} from '@dayline/contracts';
import { ClientError } from '@dayline/api-client';
import type { ApiClient } from './index.js';
export function createRecordsClient(api: ApiClient) {
  return {
    async snapshot() {
      const response = await api.request('/api/v1/snapshot', {
        account: true,
        decode: snapshotDtoSchema.parse,
      });
      if (!response.data || response.data.userId !== api.getAccount())
        throw new ClientError(
          'INVALID_RESPONSE',
          '无法确认数据归属，请重新读取。',
        );
      return { snapshot: response.data, serverTime: response.serverTime };
    },
    create(input: CreateEntryInput) {
      return api.request('/api/v1/entries', {
        requireDataVersion: true,
        method: 'POST',
        account: true,
        body: input,
        decode: entryResultSchema.parse,
      });
    },
    update(id: string, input: PatchEntryInput) {
      return api.request(`/api/v1/entries/${id}`, {
        requireDataVersion: true,
        method: 'PATCH',
        account: true,
        body: input,
        decode: entryResultSchema.parse,
      });
    },
    finish(id: string, expectedVersion: number) {
      return api.request(`/api/v1/entries/${id}/finish`, {
        requireDataVersion: true,
        method: 'POST',
        account: true,
        body: { expectedVersion },
        decode: entryResultSchema.parse,
      });
    },
    remove(id: string, expectedVersion: number) {
      return api.request(`/api/v1/entries/${id}`, {
        requireDataVersion: true,
        method: 'DELETE',
        account: true,
        body: { expectedVersion },
        decode: entryResultSchema.parse,
      });
    },
    focus(id: string, date: string, input: SetFocusInput) {
      return api.request(`/api/v1/entries/${id}/focus-days/${date}`, {
        requireDataVersion: true,
        method: 'PUT',
        account: true,
        body: input,
        decode: focusResultSchema.parse,
      });
    },
    restore(id: string, expectedVersion: number) {
      return api.request(`/api/v1/trash/${id}/restore`, {
        requireDataVersion: true,
        method: 'POST',
        account: true,
        body: { expectedVersion },
        decode: entryResultSchema.parse,
      });
    },
    purge(input: PurgeTrashInput) {
      return api.request('/api/v1/trash/purge', {
        requireDataVersion: true,
        method: 'POST',
        account: true,
        body: input,
        decode: purgeResultSchema.parse,
      });
    },
    createCategory(input: CreateCategoryInput) {
      return api.request('/api/v1/categories', {
        requireDataVersion: true,
        method: 'POST',
        account: true,
        body: input,
        decode: categoryResultSchema.parse,
      });
    },
    updateCategory(id: string, input: PatchCategoryInput) {
      return api.request(`/api/v1/categories/${id}`, {
        requireDataVersion: true,
        method: 'PATCH',
        account: true,
        body: input,
        decode: categoryResultSchema.parse,
      });
    },
    deleteCategory(id: string, input: DeleteCategoryInput) {
      return api.request(`/api/v1/categories/${id}`, {
        requireDataVersion: true,
        method: 'DELETE',
        account: true,
        body: input,
        decode: deleteCategoryResultSchema.parse,
      });
    },
  };
}
