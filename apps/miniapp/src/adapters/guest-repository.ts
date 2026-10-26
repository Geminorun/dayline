import { GuestError, readGuestPackage } from '@dayline/contracts';
import type { GuestPackage, GuestRepository } from '@dayline/contracts';
import { guestManifestSchema as manifestSchema } from '@dayline/contracts';
export interface KeyStorage {
  get(key: string): unknown;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
  capacityBytes(): number;
  usedBytes(): number;
}
// UTF-8 upper bound: each UTF-16 code unit needs at most 3 bytes.
export const CHUNK_CHARACTERS = 180_000;
function checksum(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
export class MiniGuestRepository implements GuestRepository {
  private busy = false;
  constructor(
    private readonly storage: KeyStorage,
    private readonly generation: () => string,
    private readonly prefix = 'dayline:development:v1:guest',
  ) {}
  private manifest() {
    const raw = this.storage.get(this.prefix + ':manifest');
    if (raw === '' || raw === undefined || raw === null) return null;
    try {
      return manifestSchema.parse(
        typeof raw === 'string' ? JSON.parse(raw) : raw,
      );
    } catch {
      throw new GuestError(
        'LOCAL_RECOVERY_REQUIRED',
        '本机记录目录损坏或版本不兼容。已保留原始分片，请恢复后重试。',
      );
    }
  }
  async read() {
    try {
      const manifest = this.manifest();
      if (!manifest) {
        if (
          this.storage.keys().some((k) => k.startsWith(this.prefix + ':chunk:'))
        )
          throw new GuestError(
            'LOCAL_RECOVERY_REQUIRED',
            '发现未提交或缺少目录的本机分片。原数据已保留，停止空包初始化。',
          );
        return null;
      }
      let text = '';
      for (let i = 0; i < manifest.chunks; i++) {
        const part = this.storage.get(
          `${this.prefix}:chunk:${manifest.generation}:${i}`,
        );
        if (typeof part !== 'string' || !part.length)
          throw new Error('Missing chunk');
        text += part;
      }
      if (
        text.length !== manifest.length ||
        checksum(text) !== manifest.checksum
      )
        throw new Error('Invalid checksum');
      const data = readGuestPackage(JSON.parse(text));
      if (
        data.guestDatasetId !== manifest.datasetId ||
        data.packageRevision !== manifest.revision
      )
        throw new Error('Invalid pointer');
      return data;
    } catch (cause) {
      if (cause instanceof GuestError) throw cause;
      throw new GuestError(
        'LOCAL_RECOVERY_REQUIRED',
        '本机记录无法完整读取，原始数据已保留，请恢复后重试。',
      );
    }
  }
  async commit(next: GuestPackage, expectedRevision: number | null) {
    if (this.busy)
      throw new GuestError('LOCAL_CONFLICT', '另一次本机保存正在进行。');
    this.busy = true;
    try {
      const checked = readGuestPackage(next),
        old = await this.read();
      if (
        (old?.packageRevision ?? null) !== expectedRevision ||
        (old && old.guestDatasetId !== next.guestDatasetId)
      )
        throw new GuestError(
          'LOCAL_CONFLICT',
          '本机记录已有更新，请重新读取并核对输入。',
        );
      const text = JSON.stringify(checked),
        generation = this.generation(),
        chunks = Math.ceil(text.length / CHUNK_CHARACTERS);
      if (
        chunks > 200 ||
        text.length * 3 + 2048 >
          this.storage.capacityBytes() - this.storage.usedBytes()
      )
        throw new GuestError(
          'LOCAL_CAPACITY',
          '本机空间不足，未保存。原记录仍保留，请释放空间后重试。',
        );
      for (let i = 0; i < chunks; i++) {
        const key = `${this.prefix}:chunk:${generation}:${i}`,
          part = text.slice(i * CHUNK_CHARACTERS, (i + 1) * CHUNK_CHARACTERS);
        this.storage.set(key, part);
        if (this.storage.get(key) !== part) throw new Error('Read-back failed');
      }
      const manifest = {
        schema: 1,
        datasetId: checked.guestDatasetId,
        revision: checked.packageRevision,
        generation,
        length: text.length,
        chunks,
        checksum: checksum(text),
      };
      const latest = this.manifest();
      if (
        (latest?.revision ?? null) !== expectedRevision ||
        (latest && latest.datasetId !== checked.guestDatasetId)
      )
        throw new GuestError(
          'LOCAL_CONFLICT',
          '本机记录已有更新，请重新读取并核对输入。',
        );
      // Single final pointer replacement is the commit point. Never destroy the old generation before it.
      this.storage.set(this.prefix + ':manifest', JSON.stringify(manifest));
      const committed = this.manifest();
      if (committed?.generation !== generation)
        throw new Error('Manifest not committed');
      // Only own obsolete generations; credentials and other environments are never removed.
      for (const key of this.storage.keys())
        if (
          key.startsWith(this.prefix + ':chunk:') &&
          !key.startsWith(`${this.prefix}:chunk:${generation}:`)
        ) {
          try {
            this.storage.remove(key);
          } catch {
            /* committed data is already durable */
          }
        }
    } catch (cause) {
      if (cause instanceof GuestError) throw cause;
      throw new GuestError(
        'LOCAL_WRITE_FAILED',
        '本机保存未完成，上一份完整记录已保留。当前输入仍在，请重试。',
      );
    } finally {
      this.busy = false;
    }
  }
}
export const platformStorage: KeyStorage = {
  get: (key) => uni.getStorageSync(key),
  set: (key, value) => uni.setStorageSync(key, value),
  remove: (key) => uni.removeStorageSync(key),
  keys: () => uni.getStorageInfoSync().keys,
  capacityBytes: () => uni.getStorageInfoSync().limitSize * 1024,
  usedBytes: () => uni.getStorageInfoSync().currentSize * 1024,
};
