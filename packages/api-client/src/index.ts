import {
  focusRemovalDetailsSchema,
  versionConflictDetailsSchema,
  dataVersionSchema,
  EXPECTED_USER_HEADER,
  apiMetaSchema,
} from '@dayline/contracts';
import type { ApiMeta } from '@dayline/contracts';

export interface TransportRequest {
  path: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body?: unknown;
}
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}
export type Transport = (
  request: TransportRequest,
) => Promise<TransportResponse>;
export interface RequestOptions {
  method?: TransportRequest['method'];
  body?: unknown;
  headers?: Record<string, string>;
  account?: boolean;
  native?: boolean;
  requireDataVersion?: boolean;
}
export class ClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ClientError';
  }
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Pure account-generation barrier. Platforms own credentials, I/O and lifecycle. */
export class ApiClient {
  private accountId: string | null = null;
  private generation = 0;
  constructor(
    private readonly transport: Transport,
    private readonly acceptCredentials?: (
      headers: Record<string, string>,
    ) => void,
  ) {}

  private readonly identityListeners = new Set<() => void>();
  private readonly writeListeners = new Set<
    (data: unknown, version: string, serverTime: string | undefined) => void
  >();
  onIdentityChange(listener: () => void) {
    this.identityListeners.add(listener);
    return () => this.identityListeners.delete(listener);
  }
  onWrite(
    listener: (
      data: unknown,
      version: string,
      serverTime: string | undefined,
    ) => void,
  ) {
    this.writeListeners.add(listener);
    return () => this.writeListeners.delete(listener);
  }
  acknowledgeWrite(data: unknown, version: string, serverTime?: string) {
    dataVersionSchema.parse(version);
    for (const listener of this.writeListeners)
      listener(data, version, serverTime);
  }
  getGeneration() {
    return this.generation;
  }
  confirmAccount(userId: string) {
    if (this.accountId !== userId) this.setAccount(userId);
  }
  setAccount(userId: string | null) {
    this.accountId = userId;
    this.generation++;
    for (const listener of this.identityListeners) listener();
  }
  getAccount() {
    return this.accountId;
  }
  invalidate() {
    this.accountId = null;
    this.generation++;
    for (const listener of this.identityListeners) listener();
  }

  request(
    path: string,
    options?: RequestOptions,
  ): Promise<{
    data: unknown;
    status: number;
    headers: Record<string, string>;
    dataVersion?: string;
    serverTime?: string;
    meta?: ApiMeta;
  }>;
  request<T>(
    path: string,
    options: RequestOptions & { decode: (value: unknown) => T },
  ): Promise<{
    data: T | undefined;
    status: number;
    headers: Record<string, string>;
    dataVersion?: string;
    serverTime?: string;
    meta?: ApiMeta;
  }>;
  async request(
    path: string,
    options: RequestOptions & { decode?: (value: unknown) => unknown } = {},
  ): Promise<{
    data: unknown;
    status: number;
    headers: Record<string, string>;
    dataVersion?: string;
    serverTime?: string;
    meta?: ApiMeta;
  }> {
    const generation = this.generation;
    const userId = this.accountId;
    if (options.account && !userId)
      throw new ClientError('ACTOR_CONTEXT_REQUIRED', '请先确认当前账号。');
    const headers = {
      ...options.headers,
      ...(options.account && userId ? { [EXPECTED_USER_HEADER]: userId } : {}),
    };
    let response: TransportResponse;
    try {
      response = await this.transport({
        path,
        method: options.method ?? 'GET',
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    } catch (error) {
      if (generation !== this.generation)
        throw new ClientError('STALE_RESPONSE', '账号已变化，请重新读取。');
      if (error instanceof ClientError) throw error;
      throw new ClientError(
        'NETWORK_ERROR',
        '网络请求失败，请检查连接后重试。',
      );
    }
    if (generation !== this.generation)
      throw new ClientError('STALE_RESPONSE', '账号已变化，请重新读取。');
    if (response.status === 304 && options.requireDataVersion)
      throw new ClientError(
        'INVALID_RESPONSE',
        '服务器未返回完整保存确认，请刷新后核对记录。',
        response.status,
      );
    if (response.status === 304)
      return { status: 304, data: undefined, headers: response.headers };
    if (response.status < 200 || response.status >= 300) {
      const body = record(response.body);
      const error = record(body.error ?? body);
      const code =
        typeof error.code === 'string' ? error.code : 'REQUEST_FAILED';
      if (
        (response.status === 401 && options.account) ||
        code === 'ACTOR_CONTEXT_MISMATCH'
      )
        this.invalidate();
      // Never echo an upstream body, credential or internal SDK message into a UI.
      const messages: Record<string, string> = {
        ACTOR_CONTEXT_MISMATCH: '当前账号已变化，请重新登录。',
        EMAIL_NOT_VERIFIED: '请先验证邮箱，可重新发送验证邮件。',
        INVALID_EMAIL_OR_PASSWORD: '邮箱或密码不正确。',
        QR_EXPIRED: '二维码已过期，请重新生成。',
        QR_STATE_CONFLICT: '扫码请求已失效，请重新生成。',
        QR_SCANNER_CONFLICT: '二维码已被其他微信扫描，请重新生成。',
        WECHAT_NOT_CONFIGURED: '微信登录暂未配置，请使用邮箱登录。',
        VERSION_CONFLICT: '记录已有更新，请保留输入并重新核对。',
        FOCUS_VERSION_CONFLICT: '当天重点已有更新，请重新读取。',
        FOCUS_REMOVAL_CONFIRMATION_REQUIRED:
          '日期范围变化将移除重点，请确认具体日期。',
        DATA_VERSION_CONFLICT: '数据已有变化，请刷新后重新确认。',
        ENTRY_DELETED: '事项已在回收站。',
        TRASH_EXPIRED: '事项已超过恢复期限。',
        RATE_LIMITED: '操作过于频繁，请稍后重试。',
        PREVIEW_STALE:
          '记录或计划已有变化，请保留原文件，重新建立预览并核对当前内容。',
        IMPORT_REVIEW_REQUIRED:
          '请先处理所有逐项冲突与分类映射，再确认整体导入。',
        IDEMPOTENCY_KEY_REUSED:
          '原任务的文件不能更换，请查询原任务，或为另一份文件建立新预览。',
        IMPORT_INVALID: '文件格式、行内容或引用无效，请修正原文件后重新预览。',
        UPDATE_VERSION_REQUIRED:
          '缺少更新基准，请使用带版本的导出，或明确核对当前内容。',
        FORMAT_VERSION_UNSUPPORTED: '文件版本不兼容，请使用 Dayline v1 格式。',
        FILE_TOO_LARGE:
          '文件超过 10 MiB 或单次事项、重点数量限制，请拆分文件后重试。',
      };
      throw new ClientError(
        code,
        messages[code] ??
          (response.status === 401
            ? '登录状态失效，请重新登录。'
            : '操作未完成，请核对输入后重试。'),
        response.status,
        code === 'FOCUS_REMOVAL_CONFIRMATION_REQUIRED'
          ? focusRemovalDetailsSchema.safeParse(error.details).data
          : code === 'VERSION_CONFLICT' || code === 'FOCUS_VERSION_CONFLICT'
            ? versionConflictDetailsSchema.safeParse(error.details).data
            : code === 'DATA_VERSION_CONFLICT' &&
                typeof record(error.details).currentDataVersion === 'string'
              ? {
                  currentDataVersion: dataVersionSchema.safeParse(
                    record(error.details).currentDataVersion,
                  ).data,
                }
              : undefined,
      );
    }
    if (response.status === 204) {
      if (options.requireDataVersion)
        throw new ClientError(
          'INVALID_RESPONSE',
          '服务器未返回完整保存确认，请刷新后核对记录。',
          response.status,
        );
      this.acceptCredentials?.(response.headers);
      return { status: 204, data: undefined, headers: response.headers };
    }
    const raw = options.native ? response.body : record(response.body).data;
    let data: unknown = raw;
    if (options.decode) {
      try {
        data = options.decode(raw);
      } catch {
        throw new ClientError(
          'INVALID_RESPONSE',
          '服务器响应不符合约定，请稍后重试。',
          response.status,
        );
      }
    }
    const rawMeta = record(response.body).meta;
    const parsedMeta = options.native
      ? undefined
      : apiMetaSchema.safeParse(rawMeta);
    if (parsedMeta && !parsedMeta.success)
      throw new ClientError(
        'INVALID_RESPONSE',
        '服务器响应不完整，请稍后重试。',
        response.status,
      );
    const meta = parsedMeta?.data;
    if (options.requireDataVersion && !meta?.dataVersion)
      throw new ClientError(
        'INVALID_RESPONSE',
        '服务器未返回完整保存确认，请刷新后核对记录。',
        response.status,
      );
    this.acceptCredentials?.(response.headers);
    const dataVersion = meta?.dataVersion;
    const serverTime = meta?.serverTime;
    if (options.requireDataVersion && dataVersion)
      for (const listener of this.writeListeners)
        listener(data, dataVersion, serverTime);
    return {
      status: response.status,
      headers: response.headers,
      data,
      ...(dataVersion ? { dataVersion } : {}),
      ...(serverTime ? { serverTime } : {}),
      ...(meta ? { meta } : {}),
    };
  }
}

export { createRecordsClient } from './records.js';

export { SnapshotCoordinator } from './snapshot-coordinator.js';
export { createImportsClient } from './imports.js';
export { AdmissionCoordinator } from './admission-coordinator.js';
export type { AdmissionState } from './admission-coordinator.js';
