import { businessToday } from '@dayline/core';
import {
  compareDataVersions,
  snapshotDtoSchema,
  snapshotEnvelopeSchema,
  entryResultSchema,
  categoryResultSchema,
  focusResultSchema,
} from '@dayline/contracts';
import type { SnapshotDto, SnapshotEnvelope } from '@dayline/contracts';
import { ClientError } from './index.js';
export interface SnapshotRepository {
  read(userId: string): Promise<SnapshotEnvelope | null>;
  write(value: SnapshotEnvelope): Promise<void>;
}
interface Response {
  status: number;
  data: SnapshotDto | undefined;
  headers: Record<string, string>;
  serverTime?: string;
}
/** One active space, one in-flight GET; a fresh authenticated baseline may supersede old local versions. */
export class SnapshotCoordinator {
  private generation = 0;
  private userId: string | null = null;
  private value: SnapshotDto | null = null;
  private etag: string | null = null;
  private lowerBound: string | null = null;
  private onlineBaseline = false;
  private work: Promise<void> | null = null;
  private workGeneration = -1;
  private rerun = false;
  private sequence = 0;
  private pendingFullRead = false;
  private persistedWork: Promise<void> = Promise.resolve();
  private calibratedAt = 0;
  private serverAt = 0;
  constructor(
    private readonly environment: string,
    private readonly repository: SnapshotRepository,
    private readonly fetch: (etag?: string) => Promise<Response>,
    private readonly changed: (
      snapshot: SnapshotDto | null,
      serverTime?: string,
    ) => void,
    private readonly storageFailed: (error: unknown) => void,
    private readonly monotonic: () => number,
  ) {}
  reset(userId: string | null) {
    this.generation++;
    this.userId = userId;
    this.value = null;
    this.etag = null;
    this.lowerBound = null;
    this.onlineBaseline = false;
    this.rerun = false;
    this.serverAt = 0;
    this.calibratedAt = 0;
    this.sequence++;
    this.pendingFullRead = false;
    this.changed(null);
  }
  private active(g: number, id: string) {
    return g === this.generation && id === this.userId;
  }
  async cache() {
    const id = this.userId,
      g = this.generation,
      sequence = this.sequence;
    if (!id) return;
    try {
      const raw = await this.repository.read(id);
      if (!this.active(g, id) || sequence !== this.sequence || !raw) return;
      const cache = snapshotEnvelopeSchema.parse(raw);
      if (cache.environment !== this.environment || cache.userId !== id)
        throw new Error('Invalid cache scope');
      this.value = cache.payload;
      this.etag = cache.etag;
      this.changed(this.value);
      this.tick();
    } catch (error) {
      if (this.active(g, id)) this.storageFailed(error);
    }
  }
  setServerTime(time: string) {
    this.calibrate(time);
    this.tick();
  }
  private calibrate(time: string) {
    this.serverAt = Date.parse(time);
    this.calibratedAt = this.monotonic();
  }
  tick() {
    if (!this.value || !this.serverAt) return false;
    const today = businessToday(
      new Date(
        this.serverAt + Math.max(0, this.monotonic() - this.calibratedAt),
      ),
    );
    if (today === this.value.businessToday) return false;
    this.value = { ...this.value, businessToday: today };
    this.etag = null;
    this.changed(this.value);
    return true;
  }
  private async persist(g: number, id: string, time: string) {
    if (!this.value || !this.active(g, id)) return;
    const envelope: SnapshotEnvelope = {
      localSchemaVersion: 1,
      environment: this.environment,
      scope: 'account',
      userId: id,
      complete: true,
      savedAt: time,
      etag: this.etag,
      serverTime: time,
      payload: this.value,
    };
    const persist = this.persistedWork
      .catch(() => {})
      .then(async () => {
        if (this.active(g, id)) await this.repository.write(envelope);
      });
    this.persistedWork = persist;
    try {
      await persist;
    } catch (error) {
      if (this.active(g, id)) this.storageFailed(error);
    }
  }
  refresh(): Promise<void> {
    const g = this.generation,
      id = this.userId;
    if (!id) return Promise.resolve();
    if (this.work && this.workGeneration === g) {
      this.rerun = true;
      return this.work;
    }
    this.workGeneration = g;
    const run = (async () => {
      do {
        this.rerun = false;
        const validator = this.value && this.etag ? this.etag : undefined;
        let response = await this.fetch(validator);
        if (!this.active(g, id)) return;
        if (response.status === 304 && (!this.value || !validator)) {
          response = await this.fetch();
          if (!this.active(g, id)) return;
        }
        if (response.status === 304) {
          if (!this.value || !validator)
            throw new ClientError(
              'INVALID_RESPONSE',
              '缺少完整数据，请重新读取。',
            );
          const date = response.headers.date;
          if (date && Number.isFinite(Date.parse(date)))
            this.setServerTime(new Date(date).toISOString());
          continue;
        }
        const next = snapshotDtoSchema.parse(response.data);
        if (next.userId !== id)
          throw new ClientError('INVALID_RESPONSE', '无法确认数据归属。');
        if (
          (this.lowerBound &&
            compareDataVersions(next.dataVersion, this.lowerBound) < 0) ||
          (this.onlineBaseline &&
            this.value &&
            compareDataVersions(next.dataVersion, this.value.dataVersion) < 0)
        ) {
          // A stale GET cannot replace an acknowledged write. The next lifecycle GET will retry.
          continue;
        }
        const time = response.serverTime;
        if (!time)
          throw new ClientError('INVALID_RESPONSE', '缺少服务器时间。');
        this.sequence++;
        this.value = next;
        this.onlineBaseline = true;
        this.pendingFullRead = false;
        this.etag = response.headers.etag ?? null;
        this.calibrate(time);
        this.changed(next, time);
        await this.persist(g, id, time);
      } while (this.rerun && this.active(g, id));
    })();
    this.work = run.finally(() => {
      if (this.workGeneration === g) this.work = null;
    });
    return this.work;
  }
  requiresFullRefresh() {
    return this.pendingFullRead;
  }
  written(data: unknown, version: string, time?: string) {
    if (!this.userId) return;
    if (
      (this.lowerBound && compareDataVersions(version, this.lowerBound) < 0) ||
      (this.onlineBaseline &&
        this.value &&
        compareDataVersions(version, this.value.dataVersion) < 0)
    )
      return;
    this.sequence++;
    if (!this.lowerBound || compareDataVersions(version, this.lowerBound) > 0)
      this.lowerBound = version;
    this.etag = null;
    if (time) this.calibrate(time);
    if (!this.value) {
      this.pendingFullRead = true;
      return;
    }
    const next = { ...this.value };
    const entry = entryResultSchema.safeParse(data),
      category = categoryResultSchema.safeParse(data),
      focus = focusResultSchema.safeParse(data);
    if (entry.success) {
      const e = entry.data.entry;
      next.entries = next.entries.filter((v) => v.id !== e.id);
      next.trashEntries = next.trashEntries.filter((v) => v.id !== e.id);
      (e.deletedAt ? next.trashEntries : next.entries).push(e);
      next.focusDays = [
        ...next.focusDays.filter((f) => f.entryId !== e.id),
        ...entry.data.focusDays,
      ];
    } else if (category.success) {
      const changed = category.data.category;
      next.categories = next.categories.some((c) => c.id === changed.id)
        ? next.categories.map((c) => (c.id === changed.id ? changed : c))
        : [...next.categories, changed];
    } else if (focus.success) {
      const f = focus.data.focusDay;
      next.focusDays = [
        ...next.focusDays.filter(
          (v) => v.entryId !== f.entryId || v.date !== f.date,
        ),
        f,
      ];
      next.entries = next.entries.map((e) =>
        e.id === f.entryId
          ? { ...e, focusVersion: focus.data.focusVersion }
          : e,
      );
    } else {
      this.pendingFullRead = true;
      return;
    } // Bulk writes still require a full GET; the lower bound is already installed.
    this.value = next;
    this.changed(next, time); // Visible confirmed overlay; only a full GET may persist a complete newer snapshot.
  }
}
