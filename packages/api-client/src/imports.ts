import { importJobSchema } from '@dayline/contracts';
import type {
  GuestAdmissionInput,
  ImportReviewInput,
  ImportCommitInput,
} from '@dayline/contracts';
import type { ApiClient } from './index.js';
export function createImportsClient(api: ApiClient) {
  const read = (path: string) =>
    api.request(path, { account: true, decode: importJobSchema.parse });
  return {
    prepare: (body: GuestAdmissionInput) =>
      api.request('/api/v1/guest-admissions/prepare', {
        method: 'POST',
        account: true,
        body,
        decode: importJobSchema.parse,
      }),
    get: (id: string) => read(`/api/v1/imports/${id}`),
    byOperation: (id: string) => read(`/api/v1/imports/by-operation/${id}`),
    review: (id: string, body: ImportReviewInput) =>
      api.request(`/api/v1/imports/${id}/review`, {
        method: 'POST',
        account: true,
        body,
        decode: importJobSchema.parse,
      }),
    commit: (id: string, body: ImportCommitInput) =>
      api.request(`/api/v1/imports/${id}/commit`, {
        method: 'POST',
        account: true,
        body,
        decode: importJobSchema.parse,
      }),
    cancel: (id: string) =>
      api.request(`/api/v1/imports/${id}`, {
        method: 'DELETE',
        account: true,
        decode: importJobSchema.parse,
      }),
  };
}
