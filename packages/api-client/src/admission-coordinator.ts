import { guestPackageSchema, isDefaultGuestEmpty } from '@dayline/contracts';
import type {
  AdmissionOperation,
  GuestPackage,
  ImportJobDto,
  ImportReviewInput,
} from '@dayline/contracts';
import { ClientError } from './index.js';
import type { ApiClient } from './index.js';
import { createImportsClient } from './imports.js';
export interface AdmissionRepository {
  operations(userId: string): Promise<AdmissionOperation[]>;
  putOperation(value: AdmissionOperation): Promise<void>;
}
export interface AdmissionState {
  job: ImportJobDto | null;
  operation: AdmissionOperation | null;
  error: string;
  busy: boolean;
}
/** Explicit import recovery, not a background upload queue. All I/O is injected. */
export class AdmissionCoordinator {
  private state: AdmissionState = {
    job: null,
    operation: null,
    error: '',
    busy: false,
  };
  private readonly imports;
  constructor(
    private readonly api: ApiClient,
    private readonly environment: string,
    private readonly repository: AdmissionRepository,
    private readonly guest: () => Promise<GuestPackage | null>,
    private readonly newId: () => Promise<string>,
    private readonly changed: (state: AdmissionState) => void,
  ) {
    this.imports = createImportsClient(api);
    api.onIdentityChange(() => {
      this.state = { job: null, operation: null, error: '', busy: false };
      this.publish();
    });
  }
  private publish() {
    this.changed({ ...this.state });
  }
  private active(generation: number, userId: string) {
    return (
      generation === this.api.getGeneration() &&
      userId === this.api.getAccount()
    );
  }
  private async receive(
    next: ImportJobDto,
    generation: number,
    userId: string,
  ) {
    const operation = this.state.operation;
    if (!operation || !this.active(generation, userId)) return;
    if (next.clientOperationId !== operation.clientOperationId)
      throw new ClientError('INVALID_RESPONSE', '无法确认接入任务归属。');
    const frozen: AdmissionOperation = {
      ...operation,
      jobId: next.id,
      status: next.status === 'preview' ? 'pending' : next.status,
      result: next.result,
    };
    await this.repository.putOperation(frozen);
    if (!this.active(generation, userId)) return;
    this.state.operation = frozen;
    if (next.result)
      this.api.acknowledgeWrite(
        next.result,
        next.result.dataVersion,
        next.result.committedAt,
      );
    this.state.job = next;
    this.publish();
  }
  private async recover(generation: number, userId: string) {
    const operation = this.state.operation;
    if (!operation) return;
    try {
      const response = operation.jobId
        ? await this.imports.get(operation.jobId)
        : await this.imports.byOperation(operation.clientOperationId);
      if (response.data) await this.receive(response.data, generation, userId);
    } catch (cause) {
      if (
        cause instanceof ClientError &&
        cause.status === 404 &&
        this.active(generation, userId)
      ) {
        if (operation.status === 'pending' && !operation.jobId) {
          const response = await this.imports.prepare({
            clientOperationId: operation.clientOperationId,
            package: operation.package,
          });
          if (response.data)
            await this.receive(response.data, generation, userId);
          return;
        }
        const missing: AdmissionOperation = { ...operation, status: 'missing' };
        await this.repository.putOperation(missing);
        if (this.active(generation, userId)) {
          this.state.operation = missing;
          this.state.job = null;
          this.state.error =
            '服务器未找到原任务。原冻结包与回执保留，请核对云端后明确重新预览。';
          this.publish();
        }
        return;
      }
      throw cause;
    }
  }
  async begin(explicit = false, restart = false) {
    const userId = this.api.getAccount(),
      generation = this.api.getGeneration();
    if (!userId || this.state.busy) return;
    this.state.busy = true;
    this.state.error = '';
    this.publish();
    try {
      const previous = await this.repository.operations(userId);
      if (!this.active(generation, userId)) return;
      if (!restart) {
        const pending = previous.find((o) => o.status === 'pending');
        if (pending) {
          this.state.operation = pending;
          await this.recover(generation, userId);
          return;
        }
      }
      const raw = await this.guest();
      if (!raw || isDefaultGuestEmpty(raw) || !this.active(generation, userId))
        return;
      const source = guestPackageSchema.parse(raw);
      const exact = previous.filter(
        (o) =>
          o.package.guestDatasetId === source.guestDatasetId &&
          o.package.packageRevision === source.packageRevision,
      );
      if (!restart) {
        const completed = exact.find((o) => o.status === 'committed');
        if (completed) {
          this.state.operation = completed;
          if (explicit) await this.recover(generation, userId);
          return;
        }
        const ended = exact.find(
          (o) =>
            o.status === 'expired' ||
            o.status === 'cancelled' ||
            o.status === 'missing',
        );
        if (ended) {
          this.state.operation = ended;
          if (explicit && ended.jobId) await this.recover(generation, userId);
          return;
        }
      }
      const operation: AdmissionOperation = {
        environment: this.environment,
        userId,
        clientOperationId: await this.newId(),
        package: source,
        jobId: null,
        status: 'pending',
        result: null,
      };
      if (!this.active(generation, userId)) return;
      await this.repository.putOperation(operation);
      if (!this.active(generation, userId)) return;
      this.state.operation = operation;
      const response = await this.imports.prepare({
        clientOperationId: operation.clientOperationId,
        package: operation.package,
      });
      if (response.data) await this.receive(response.data, generation, userId);
    } catch (cause) {
      if (this.active(generation, userId)) {
        this.state.error =
          cause instanceof ClientError
            ? cause.message
            : '接入准备或结果确认未完成。原冻结包保留，请查询原任务后重试。';
      }
    } finally {
      if (this.active(generation, userId)) {
        this.state.busy = false;
        this.publish();
      }
    }
  }
  async action(
    kind: 'review' | 'commit' | 'cancel' | 'query',
    input?: ImportReviewInput,
  ) {
    const userId = this.api.getAccount(),
      generation = this.api.getGeneration();
    if (!userId || this.state.busy || !this.state.operation) return;
    const job = this.state.job;
    if (kind !== 'query' && !job) return;
    this.state.busy = true;
    this.state.error = '';
    this.publish();
    try {
      if (kind === 'query') {
        await this.recover(generation, userId);
        return;
      }
      if (!job) return;
      const response =
        kind === 'review' && input
          ? await this.imports.review(job.id, input)
          : kind === 'commit'
            ? await this.imports.commit(job.id, {
                expectedPlanRevision: job.planRevision,
                planDigest: job.planDigest,
              })
            : await this.imports.cancel(job.id);
      if (response.data) await this.receive(response.data, generation, userId);
    } catch (cause) {
      if (this.active(generation, userId)) {
        this.state.error =
          cause instanceof ClientError
            ? cause.message
            : '操作结果待确认，请查询原任务。';
        if (kind === 'commit')
          try {
            await this.recover(generation, userId);
          } catch {
            /* source is durable; no automatic commit retry */
          }
      }
    } finally {
      if (this.active(generation, userId)) {
        this.state.busy = false;
        this.publish();
      }
    }
  }
}
