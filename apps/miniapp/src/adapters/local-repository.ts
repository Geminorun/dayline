import {
  localChunksManifestSchema as manifestSchema,
  snapshotEnvelopeSchema,
  admissionOperationSchema,
} from '@dayline/contracts';

import type { SnapshotEnvelope, AdmissionOperation } from '@dayline/contracts';
import { platformStorage, CHUNK_CHARACTERS } from './guest-repository';
import type { KeyStorage } from './guest-repository';
import { newId } from './uuid';
export const localEnvironment = `${import.meta.env.MODE}:${encodeURIComponent(import.meta.env.VITE_API_BASE_URL ?? 'unconfigured')}`;

function checksum(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
export class MiniLocalRepository {
  private readonly prefix: string;
  constructor(
    private readonly storage: KeyStorage = platformStorage,
    private readonly generation: () => Promise<string> = newId,
    private readonly environment = localEnvironment,
  ) {
    this.prefix = `dayline:${environment}:v1:account:`;
  }

  private readValue(key: string): unknown {
    const raw = this.storage.get(this.prefix + key + ':manifest');
    if (raw === '' || raw === undefined || raw === null) {
      if (
        this.storage
          .keys()
          .some((k) => k.startsWith(this.prefix + key + ':chunk:'))
      )
        throw new Error('Incomplete local storage');
      return null;
    }
    const m = manifestSchema.parse(JSON.parse(String(raw)));
    let text = '';
    for (let i = 0; i < m.chunks; i++) {
      const part = this.storage.get(
        `${this.prefix}${key}:chunk:${m.generation}:${i}`,
      );
      if (typeof part !== 'string') throw new Error('Missing chunk');
      text += part;
    }
    if (text.length !== m.length || checksum(text) !== m.checksum)
      throw new Error('Damaged local storage');
    return JSON.parse(text) as unknown;
  }
  private async put(
    key: string,
    value: unknown,
    validate: (v: unknown) => unknown,
  ) {
    const id = await this.generation();
    if (
      this.storage
        .keys()
        .some((k) => k.startsWith(`${this.prefix}${key}:chunk:${id}:`))
    )
      throw new Error('Generation collision');
    const old = this.readValue(key);
    if (old) validate(old);
    validate(value);
    const text = JSON.stringify(value),
      chunks = Math.ceil(text.length / CHUNK_CHARACTERS);
    if (
      chunks > 200 ||
      text.length * 3 + 2048 >
        this.storage.capacityBytes() - this.storage.usedBytes()
    )
      throw new Error('Local capacity');
    for (let i = 0; i < chunks; i++) {
      const part = text.slice(i * CHUNK_CHARACTERS, (i + 1) * CHUNK_CHARACTERS),
        partKey = `${this.prefix}${key}:chunk:${id}:${i}`;
      this.storage.set(partKey, part);
      if (this.storage.get(partKey) !== part)
        throw new Error('Local write failed');
    }
    this.storage.set(
      this.prefix + key + ':manifest',
      JSON.stringify({
        generation: id,
        chunks,
        length: text.length,
        checksum: checksum(text),
      }),
    );
    validate(this.readValue(key));
    for (const saved of this.storage.keys())
      if (
        saved.startsWith(this.prefix + key + ':chunk:') &&
        !saved.startsWith(`${this.prefix}${key}:chunk:${id}:`)
      )
        try {
          this.storage.remove(saved);
        } catch {
          /* new manifest is already committed */
        }
  }
  private scope<T extends { environment: string; userId: string }>(
    value: T,
    userId: string,
  ): T {
    if (value.environment !== this.environment || value.userId !== userId)
      throw new Error('Local recovery required: scope mismatch');
    return value;
  }
  private checkOperation(value: unknown, userId: string, id: string) {
    const operation = this.scope(admissionOperationSchema.parse(value), userId);
    if (operation.clientOperationId !== id)
      throw new Error('Local recovery required: operation mismatch');
    return operation;
  }
  async read(userId: string) {
    const value = this.readValue(userId + ':snapshot');
    return value
      ? this.scope(snapshotEnvelopeSchema.parse(value), userId)
      : null;
  }
  write(value: SnapshotEnvelope) {
    return this.put(value.userId + ':snapshot', value, (v) =>
      this.scope(snapshotEnvelopeSchema.parse(v), value.userId),
    );
  }
  async operations(userId: string) {
    return this.storage
      .keys()
      .filter(
        (k) =>
          k.startsWith(this.prefix + userId + ':operation:') &&
          k.endsWith(':manifest'),
      )
      .map((k) => {
        const id = k.slice(
          (this.prefix + userId + ':operation:').length,
          -':manifest'.length,
        );
        return this.checkOperation(
          this.readValue(k.slice(this.prefix.length, -':manifest'.length)),
          userId,
          id,
        );
      });
  }
  putOperation(value: AdmissionOperation) {
    return this.put(
      value.userId + ':operation:' + value.clientOperationId,
      value,
      (v) => this.checkOperation(v, value.userId, value.clientOperationId),
    );
  }
}
export const localRepository = new MiniLocalRepository();
