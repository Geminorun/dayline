import { createRecordsClient, ClientError } from '@dayline/api-client';
import { GuestError } from '@dayline/contracts';
import { api } from '../api';
export const records = createRecordsClient(api);
export function errorMessage(error: unknown) {
  return error instanceof ClientError || error instanceof GuestError
    ? error.message
    : '操作未完成，请重试。';
}
