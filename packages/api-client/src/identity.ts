import {
  actionProofDtoSchema,
  bindingResultSchema,
  mergePlanSchema,
  mergeMappingsSchema,
  mergeListSchema,
  successDtoSchema,
} from '@dayline/contracts';
import type { ActionRequest } from '@dayline/contracts';

import type {
  MergeReviewInput,
  MergeCommitInput,
  EmailBindingCompleteInput,
} from '@dayline/contracts';
import type { ApiClient } from './index.js';
export function createIdentityClient(api: ApiClient) {
  return {
    reauth: (body: ActionRequest & { password?: string; code?: string }) =>
      api.request('/api/v1/auth/reauth', {
        method: 'POST',
        account: true,
        body,
        decode: actionProofDtoSchema.parse,
      }),
    email: (body: { email: string; operationId: string; proof: string }) =>
      api.request('/api/v1/me/email-binding-requests', {
        method: 'POST',
        account: true,
        body,
        decode: bindingResultSchema.parse,
      }),
    completeEmail: (id: string, body: EmailBindingCompleteInput) =>
      api.request(`/api/v1/me/email-binding-requests/${id}/complete`, {
        method: 'POST',
        account: true,
        body,
        decode: bindingResultSchema.parse,
      }),
    cancelEmail: (id: string) =>
      api.request(`/api/v1/me/email-binding-requests/${id}`, {
        method: 'DELETE',
        account: true,
        decode: successDtoSchema.parse,
      }),
    preview: (contextId: string, operationId: string) =>
      api.request('/api/v1/account-merges/preview', {
        method: 'POST',
        account: true,
        body: { contextId, operationId },
        decode: mergePlanSchema.parse,
      }),
    list: () =>
      api.request('/api/v1/account-merges', {
        account: true,
        decode: mergeListSchema.parse,
      }),
    get: (id: string) =>
      api.request(`/api/v1/account-merges/${id}`, {
        account: true,
        decode: mergePlanSchema.parse,
      }),
    review: (id: string, body: MergeReviewInput) =>
      api.request(`/api/v1/account-merges/${id}/review`, {
        method: 'POST',
        account: true,
        body,
        decode: mergePlanSchema.parse,
      }),
    commit: (id: string, body: MergeCommitInput) =>
      api.request(`/api/v1/account-merges/${id}/commit`, {
        method: 'POST',
        requireDataVersion: true,
        account: true,
        body,
        decode: mergePlanSchema.parse,
      }),
    cancel: (id: string) =>
      api.request(`/api/v1/account-merges/${id}`, {
        method: 'DELETE',
        account: true,
        decode: successDtoSchema.parse,
      }),
    mappings: (id: string, proof: string, operationId: string) =>
      api.request(`/api/v1/account-merges/${id}/mappings`, {
        method: 'POST',
        account: true,
        body: { proof, operationId },
        decode: mergeMappingsSchema.parse,
      }),
  };
}
