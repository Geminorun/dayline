import Dexie, { type Table } from 'dexie';
import {
  snapshotEnvelopeSchema,
  draftSchema,
  admissionOperationSchema,
} from '@dayline/contracts';
import type {
  SnapshotEnvelope,
  EntryDraft,
  AdmissionOperation,
} from '@dayline/contracts';
export const localEnvironment = `${import.meta.env.MODE}:${window.location.origin}`;
interface Stored {
  key: string;
  value: unknown;
}
export class WebLocalRepository {
  readonly database: Dexie;
  private readonly values: Table<Stored, string>;
  constructor(private readonly environment = localEnvironment) {
    this.database = new Dexie(`dayline:${environment}:v1:account`);
    this.database.version(1).stores({ values: 'key' });
    this.values = this.database.table('values');
  }
  private scope<T extends { environment: string; userId: string }>(
    value: T,
    userId: string,
  ): T {
    if (value.environment !== this.environment || value.userId !== userId)
      throw new Error('Local recovery required: scope mismatch');
    return value;
  }
  private checkDraft(value: unknown, userId: string, id: string) {
    const draft = this.scope(draftSchema.parse(value), userId);
    if (draft.draftId !== id)
      throw new Error('Local recovery required: draft mismatch');
    return draft;
  }
  private checkOperation(value: unknown, userId: string, id: string) {
    const operation = this.scope(admissionOperationSchema.parse(value), userId);
    if (operation.clientOperationId !== id)
      throw new Error('Local recovery required: operation mismatch');
    return operation;
  }
  private async put(
    key: string,
    value: unknown,
    validate: (v: unknown) => unknown,
  ) {
    await this.database.transaction('rw', this.values, async () => {
      const old = await this.values.get(key);
      if (old) validate(old.value);
      const checked = validate(value);
      await this.values.put({ key, value: checked });
    });
  }
  async read(userId: string) {
    const raw = await this.values.get(`${userId}:snapshot`);
    return raw
      ? this.scope(snapshotEnvelopeSchema.parse(raw.value), userId)
      : null;
  }
  write(value: SnapshotEnvelope) {
    return this.put(`${value.userId}:snapshot`, value, (v) =>
      this.scope(snapshotEnvelopeSchema.parse(v), value.userId),
    );
  }
  async drafts(userId: string) {
    return (
      await this.values.where('key').startsWith(`${userId}:draft:`).toArray()
    ).map((row) =>
      this.checkDraft(
        row.value,
        userId,
        row.key.slice(`${userId}:draft:`.length),
      ),
    );
  }
  async draft(userId: string, id: string) {
    const raw = await this.values.get(`${userId}:draft:${id}`);
    return raw ? this.checkDraft(raw.value, userId, id) : null;
  }
  putDraft(value: EntryDraft) {
    return this.put(`${value.userId}:draft:${value.draftId}`, value, (v) =>
      this.checkDraft(v, value.userId, value.draftId),
    );
  }
  async removeDraft(userId: string, id: string, revision?: number) {
    await this.database.transaction('rw', this.values, async () => {
      const old = await this.values.get(`${userId}:draft:${id}`);
      if (old) {
        const draft = this.checkDraft(old.value, userId, id);
        if (revision === undefined || draft.inputRevision === revision)
          await this.values.delete(old.key);
      }
    });
  }
  async operations(userId: string) {
    return (
      await this.values
        .where('key')
        .startsWith(`${userId}:operation:`)
        .toArray()
    ).map((row) =>
      this.checkOperation(
        row.value,
        userId,
        row.key.slice(`${userId}:operation:`.length),
      ),
    );
  }
  putOperation(value: AdmissionOperation) {
    return this.put(
      `${value.userId}:operation:${value.clientOperationId}`,
      value,
      (v) => this.checkOperation(v, value.userId, value.clientOperationId),
    );
  }
}
export const localRepository = new WebLocalRepository();
