import Dexie, { type Table } from 'dexie';
import { GuestError, readGuestPackage } from '@dayline/contracts';
import type { GuestPackage, GuestRepository } from '@dayline/contracts';
interface Stored {
  key: string;
  value: unknown;
}
export class WebGuestRepository implements GuestRepository {
  readonly database: Dexie;
  private readonly packages: Table<Stored, string>;
  constructor(namespace = `dayline:${import.meta.env.MODE}:v1:guest`) {
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
