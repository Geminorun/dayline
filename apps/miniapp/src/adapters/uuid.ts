import { msg } from '@dayline/locales';
import { GuestError } from '@dayline/contracts';
declare const wx: {
  getRandomValues(options: {
    length: number;
    success: (result: { randomValues: ArrayBuffer }) => void;
    fail: () => void;
  }): void;
};
export async function uuidBatch(count: number): Promise<string[]> {
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    if (typeof wx === 'undefined' || typeof wx.getRandomValues !== 'function') {
      reject(
        new GuestError(
          'RANDOM_UNAVAILABLE',
          msg('uuid.theCurrentWechatVersionDoesNotSupport'),
        ),
      );
      return;
    }
    wx.getRandomValues({
      length: count * 16,
      success: (result) => resolve(result.randomValues),
      fail: () =>
        reject(
          new GuestError(
            'RANDOM_UNAVAILABLE',
            msg('uuid.unableToGenerateRecordIdPleaseTry'),
          ),
        ),
    });
  });
  const data = new Uint8Array(bytes),
    ids: string[] = [];
  if (data.length !== count * 16)
    throw new GuestError(
      'RANDOM_UNAVAILABLE',
      msg('uuid.unableToGenerateRecordIdPleaseTry'),
    );
  for (let i = 0; i < count; i++) {
    const part = data.slice(i * 16, (i + 1) * 16);
    part[6] = ((part[6] ?? 0) & 15) | 64;
    part[8] = ((part[8] ?? 0) & 63) | 128;
    const hex = Array.from(part, (n) => n.toString(16).padStart(2, '0')).join(
      '',
    );
    ids.push(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    );
  }
  return ids;
}
export async function newId() {
  const id = (await uuidBatch(1))[0];
  if (!id) throw new Error('Missing UUID');
  return id;
}
