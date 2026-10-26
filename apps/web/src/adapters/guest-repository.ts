import Dexie, { type Table } from 'dexie';
import {
  GuestError,
  readGuestPackage,
  fileOperationSchema,
  fileReceiptsSchema,
  importReceiptIndex,
} from '@dayline/contracts';
import { guestFileCommit, applyFilePlan } from '@dayline/contracts/files';
import type {
  GuestPackage,
  GuestRepository,
  FileOperation,
  ImportJobDto,
} from '@dayline/contracts';
interface Stored {
  key: string;
  value: unknown;
}
export class WebGuestRepository implements GuestRepository {
  readonly database: Dexie;
  private readonly packages: Table<Stored, string>;
  constructor(
    namespace = `dayline:${import.meta.env.MODE}:v1:guest`,
    private readonly fileEnvironment = `${import.meta.env.MODE}:${window.location.origin}`,
  ) {
    this.database = new Dexie(namespace);
    this.database.version(1).stores({ packages: 'key' });
    this.packages = this.database.table<Stored, string>('packages');
  }
  async read() {
    try {
      const saved = await this.packages.get('current');
      return saved ? readGuestPackage(saved.value) : null;
    } catch (cause) {
      if (cause instanceof GuestError) throw cause;
      throw new GuestError(
        'LOCAL_UNAVAILABLE',
        '无法读取本机记录。原始数据保持不变，请检查浏览器存储权限。',
      );
    }
  }
  async fileOperation(ownerId: string) {
    const raw = await this.packages.get('file:' + ownerId);
    if (!raw) return null;
    const op = fileOperationSchema.parse(raw.value);
    if (
      op.scope !== 'guest' ||
      op.ownerId !== ownerId ||
      op.environment !== this.fileEnvironment ||
      (op.localPlan !== null &&
        (op.jobId !== op.localPlan.id ||
          op.clientOperationId !== op.localPlan.clientOperationId))
    )
      throw new GuestError(
        'LOCAL_RECOVERY_REQUIRED',
        '本机文件任务归属无效，原文已保留。',
      );
    return op;
  }
  async putFileOperation(op: FileOperation) {
    fileOperationSchema.parse(op);
    if (
      op.scope !== 'guest' ||
      op.environment !== this.fileEnvironment ||
      (op.localPlan !== null &&
        (op.jobId !== op.localPlan.id ||
          op.clientOperationId !== op.localPlan.clientOperationId))
    )
      throw new GuestError('LOCAL_RECOVERY_REQUIRED', '文件任务归属无效。');
    await this.database.transaction('rw', this.packages, async () => {
      const current = await this.read();
      if (!current || current.guestDatasetId !== op.ownerId)
        throw new GuestError('LOCAL_RECOVERY_REQUIRED', '文件任务数据集不符。');
      const old = await this.fileOperation(op.ownerId);
      if (
        old &&
        old.clientOperationId === op.clientOperationId &&
        (old.text !== op.text || old.format !== op.format)
      )
        throw new GuestError('IDEMPOTENCY_KEY_REUSED', '原任务文件不能更换。');
      await this.packages.put({
        key: 'file:' + op.ownerId,
        value: fileOperationSchema.parse(op),
      });
    });
  }
  private receipts(raw: unknown, ownerId: string) {
    if (raw === undefined) return [];
    const v = fileReceiptsSchema.parse(raw);
    if (v.environment !== this.fileEnvironment || v.ownerId !== ownerId)
      throw new GuestError(
        'LOCAL_RECOVERY_REQUIRED',
        '文件回执归属无效，原数据已保留。',
      );
    return v.receipts;
  }
  async fileMappings(ownerId: string) {
    const raw = await this.packages.get('file-receipts:' + ownerId);
    const receipts = this.receipts(raw?.value, ownerId);
    return importReceiptIndex(receipts);
  }

  async commitFile(op: FileOperation, plan: ImportJobDto, now: string) {
    return this.database.transaction('rw', this.packages, async () => {
      const saved = await this.fileOperation(op.ownerId);
      if (
        !saved ||
        saved.clientOperationId !== op.clientOperationId ||
        saved.environment !== op.environment ||
        saved.scope !== op.scope ||
        saved.text !== op.text ||
        saved.format !== op.format ||
        saved.jobId !== op.jobId ||
        saved.localPlan?.planDigest !== plan.planDigest
      )
        throw new GuestError('PREVIEW_STALE', '文件计划已变化，请重新读取。');
      if (saved.status === 'committed') return saved.localPlan;
      const current = await this.read();
      if (!current || current.guestDatasetId !== op.ownerId)
        throw new GuestError('PREVIEW_STALE', '本机空间已变化。');
      const frozen = saved.localPlan;
      if (
        !frozen ||
        frozen.id !== plan.id ||
        frozen.planRevision !== plan.planRevision
      )
        throw new GuestError('PREVIEW_STALE', '文件计划已有变化。');
      const completed = await this.fileMappings(op.ownerId);
      if (
        frozen.rows.some(
          (row) =>
            row.action === 'create_copy' &&
            completed.has(row.sourceKey + '@' + row.sourceDigest),
        ) ||
        frozen.categoryMappings.some(
          (c) =>
            !c.targetId &&
            c.action !== 'skip' &&
            c.sourceKey &&
            c.sourceDigest &&
            completed.has(c.sourceKey + '@' + c.sourceDigest),
        )
      )
        throw new GuestError(
          'PREVIEW_STALE',
          '此来源已由另一任务完成，请重新预览。',
        );
      const next = guestFileCommit(current, frozen, now),
        applied = applyFilePlan(current, frozen, now);
      const result = {
        dataVersion: String(next.packageRevision),
        created: applied.created,
        updated: applied.updated,
        unchanged: applied.unchanged,
        skipped: applied.skipped,
        mappings: applied.mappings,
        categoryMappings: applied.categoryMappings,
        committedAt: now,
      };
      const done: ImportJobDto = {
        ...frozen,
        status: 'committed',
        disposition: 'committed',
        canCommit: false,
        result,
      };
      await this.commit(next, current.packageRevision);
      const raw = await this.packages.get('file-receipts:' + op.ownerId);
      const receipts = this.receipts(raw?.value, op.ownerId);
      await this.packages.put({
        key: 'file-receipts:' + op.ownerId,
        value: {
          environment: this.fileEnvironment,
          ownerId: op.ownerId,
          receipts: [...receipts, result],
        },
      });
      await this.packages.put({
        key: 'file:' + op.ownerId,
        value: { ...saved, status: 'committed', localPlan: done },
      });
      return done;
    });
  }
  async commit(next: GuestPackage, expectedRevision: number | null) {
    const checked = readGuestPackage(next);
    try {
      await this.database.transaction('rw', this.packages, async () => {
        const raw = await this.packages.get('current');
        const current = raw ? readGuestPackage(raw.value) : null;
        if (
          (current?.packageRevision ?? null) !== expectedRevision ||
          (current && current.guestDatasetId !== checked.guestDatasetId)
        )
          throw new GuestError(
            'LOCAL_CONFLICT',
            '另一标签页已修改本机记录。请重新读取后核对输入。',
          );
        await this.packages.put({ key: 'current', value: checked });
      });
    } catch (cause) {
      if (cause instanceof GuestError) throw cause;
      throw new GuestError(
        'LOCAL_WRITE_FAILED',
        '本机保存失败，原始记录和当前输入已保留。请检查剩余空间后重试。',
      );
    }
  }
}
export const guestRepository = new WebGuestRepository();
