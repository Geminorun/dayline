import {
  sharedMessages,
  diagnosticMessage,
  fallbackText,
  msg,
} from '@dayline/locales';

import type { Message, UiText } from '@dayline/locales';
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
  readonly localized?: Message;
  constructor(
    readonly code: string,
    message: UiText,
    readonly status = 0,
    readonly details?: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    const localized = diagnosticMessage(message);
    super(fallbackText(localized));
    if (typeof localized !== 'string') this.localized = localized;
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
      throw new ClientError(
        'ACTOR_CONTEXT_REQUIRED',
        msg('errors.pleaseConfirmTheCurrentAccountFirst'),
      );
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
        throw new ClientError(
          'STALE_RESPONSE',
          msg('errors.theAccountHasChangedPleaseReadIt'),
        );
      if (error instanceof ClientError) throw error;
      throw new ClientError(
        'NETWORK_ERROR',
        msg('errors.networkRequestFailedPleaseCheckTheConnection'),
      );
    }
    if (generation !== this.generation)
      throw new ClientError(
        'STALE_RESPONSE',
        msg('errors.theAccountHasChangedPleaseReadIt'),
      );
    if (response.status === 304 && options.requireDataVersion)
      throw new ClientError(
        'INVALID_RESPONSE',
        msg('errors.theServerDidNotReturnAComplete'),
        response.status,
      );
    if (response.status === 304)
      return { status: 304, data: undefined, headers: response.headers };
    if (response.status < 200 || response.status >= 300) {
      const body = record(response.body);
      const error = record(body.error ?? body);
      const code =
        response.status === 429
          ? 'RATE_LIMITED'
          : typeof error.code === 'string'
            ? error.code
            : 'REQUEST_FAILED';
      const retryHeader = Object.entries(response.headers).find(
        ([key]) => key.toLowerCase() === 'retry-after',
      )?.[1];
      const retryAfterSeconds =
        response.status === 429 &&
        retryHeader &&
        /^\d{1,5}$/.test(retryHeader) &&
        Number(retryHeader) <= 86400
          ? Number(retryHeader)
          : undefined;
      if (
        (response.status === 401 && options.account) ||
        code === 'ACTOR_CONTEXT_MISMATCH'
      )
        this.invalidate();
      // Never echo an upstream body, credential or internal SDK message into a UI.
      const messages: Record<string, UiText> = {
        ACTOR_CONTEXT_MISMATCH: msg(
          'errors.theCurrentAccountHasChangedPleaseLog',
        ),
        REAUTH_REQUIRED: msg(
          'errors.thisAuthenticationFailedOrHasExpiredPlease',
        ),
        IDENTITY_COMBINATION_UNSUPPORTED: msg(
          'errors.theFirstVersionSupportsOneEmailAnd',
        ),
        IDENTITY_ALREADY_LINKED: msg(
          'errors.theLoginMethodAssociationHasChangedPlease',
        ),
        BINDING_LINK_INVALID: msg(
          'errors.theEmailVerificationLinkHasExpiredPlease',
        ),
        BINDING_ENDED: msg('errors.thisBindingOperationHasEndedPleaseRead'),
        EMAIL_NOT_VERIFIED: msg('errors.pleaseVerifyYourEmailAddressFirstYou'),
        INVALID_EMAIL_OR_PASSWORD: msg('errors.emailOrPasswordIsIncorrect'),
        MAIL_UNAVAILABLE: msg('errors.theEmailCannotBeSentTemporarilyPlease'),
        AUTH_UNAVAILABLE: msg(
          'errors.theAuthenticationServiceIsTemporarilyUnavailablePlease',
        ),
        USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: msg(
          'errors.thisEmailAddressHasBeenRegisteredPlease',
        ),
        INVALID_EMAIL: msg('errors.theEmailFormatIsIncorrectPleaseCheck'),
        PASSWORD_TOO_SHORT: msg('errors.passwordRequiresAtLeast8Characters'),
        PASSWORD_TOO_LONG: msg('errors.passwordCannotExceed128Characters'),
        INVALID_TOKEN: msg('errors.theLinkHasExpiredOrIsInvalid'),
        QR_EXPIRED: msg('errors.theQrCodeHasExpiredPleaseRegenerate'),
        QR_STATE_CONFLICT: msg('errors.theScanCodeRequestHasExpiredPlease'),
        QR_SCANNER_CONFLICT: msg('errors.theQrCodeHasBeenScannedBy'),
        WECHAT_NOT_CONFIGURED: msg('errors.wechatLoginHasNotBeenConfiguredYet'),
        VERSION_CONFLICT: msg('errors.theRecordHasBeenUpdatedPleaseKeep'),
        FOCUS_VERSION_CONFLICT: msg('errors.theKeyPointsOfTheDayHave'),
        FOCUS_REMOVAL_CONFIRMATION_REQUIRED: msg(
          'errors.dateRangeChangesWillRemoveEmphasisPlease',
        ),
        DATA_VERSION_CONFLICT: msg('errors.theDataHasChangedPleaseRefreshAnd'),
        ENTRY_DELETED: msg('errors.entryIsInTrash'),
        TRASH_EXPIRED: msg('errors.theEntryHasExceededTheRecoveryPeriod'),
        RATE_LIMITED: msg('errors.theOperationIsTooFrequentPleaseTry'),
        ACCOUNT_PENDING_DELETION: msg(
          'errors.theAccountIsBeingCanceledPleaseCheck',
        ),
        DELETION_EXPIRED: msg('errors.theCancellationPeriodHasExpiredAndThe'),
        REQUEST_TIMEOUT: msg('errors.theRequestWasNotCompletedWithinThe'),
        MAINTENANCE_PENDING: msg(
          'errors.theServiceIsCompletingStartupMaintenancePlease',
        ),
        PREVIEW_STALE: msg('errors.theRecordOrPlanHasChangedPlease'),
        IMPORT_REVIEW_REQUIRED: msg(
          'errors.pleaseHandleAllItemByItemConflicts',
        ),
        IDEMPOTENCY_KEY_REUSED: msg('errors.theFileOfTheOriginalTaskCannot'),
        IMPORT_INVALID: msg('errors.theFileFormatLineContentOrReference'),
        UPDATE_VERSION_REQUIRED: msg(
          'errors.missingUpdateBaselinePleaseUseAVersioned',
        ),
        FORMAT_VERSION_UNSUPPORTED: msg(
          'errors.fileVersionIsIncompatiblePleaseUseDayline',
        ),
        FILE_TOO_LARGE: msg('errors.theFileExceeds10MibOrThe'),
      };
      // Only known public error keys and numeric interpolation arguments cross the wire.
      // Free-form upstream messages never become user-facing notices.
      const key =
        typeof error.messageKey === 'string' &&
        error.messageKey.startsWith('errors.') &&
        Object.hasOwn(sharedMessages['zh-CN'], error.messageKey)
          ? error.messageKey
          : null;
      const localized = key
        ? msg(
            key,
            Object.fromEntries(
              Object.entries(record(error.params)).filter(
                (pair): pair is [string, number] =>
                  typeof pair[1] === 'number' && Number.isFinite(pair[1]),
              ),
            ),
          )
        : undefined;
      throw new ClientError(
        code,
        (code === 'RATE_LIMITED' && retryAfterSeconds !== undefined
          ? msg('errors.theOperationIsTooFrequentPleaseWait', {
              value0: retryAfterSeconds,
            })
          : (localized ?? messages[code])) ??
          (response.status === 401
            ? msg('errors.loginStatusIsInvalidPleaseLogIn')
            : msg('errors.theOperationIsNotCompletedPleaseCheck')),
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
        retryAfterSeconds,
      );
    }
    if (response.status === 204) {
      if (options.requireDataVersion)
        throw new ClientError(
          'INVALID_RESPONSE',
          msg('errors.theServerDidNotReturnAComplete'),
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
          msg('errors.theServerResponseDoesNotMeetThe'),
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
        msg('errors.theServerResponseIsIncompletePleaseTry'),
        response.status,
      );
    const meta = parsedMeta?.data;
    if (options.requireDataVersion && !meta?.dataVersion)
      throw new ClientError(
        'INVALID_RESPONSE',
        msg('errors.theServerDidNotReturnAComplete'),
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

export * from './identity.js';
