import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ReauthForm from '../src/ReauthForm.vue';
import { api } from '../src/api';
import { useAccount } from '../src/account';
import { recoverMergeDraft } from '../src/merge-drafts';
import type { EntryDraft, MergeMappings } from '@dayline/contracts';
const user = {
  id: randomUUID(),
  displayName: '当前账号',
  profileVersion: 1,
  email: 'current@example.com',
  emailVerified: true,
  passwordEnabled: true,
  wechatBound: true,
  status: 'active',
  deletionDueAt: null,
  timeZone: 'Asia/Shanghai',
};
const meta = {
  requestId: 'identity-ui',
  serverTime: '2026-10-26T20:00:00.000Z',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAccount().clear();
});
describe('reauth and authorized merge drafts', () => {
  it('wrong reauth password stays in the valid account and Web WeChat proof requires a separate confirmed purpose QR', async () => {
    const id = randomUUID(),
      operationId = randomUUID();
    let confirmed = false;
    const fetch = vi.fn(
      async (path: RequestInfo | URL, options?: RequestInit) => {
        if (path === '/api/v1/me') return Response.json({ data: user, meta });
        if (path === '/api/v1/auth/reauth')
          return Response.json(
            { error: { code: 'REAUTH_REQUIRED' }, meta },
            { status: 403 },
          );
        if (path === '/api/v1/auth/qr-requests') {
          expect(JSON.parse(String(options?.body))).toMatchObject({
            purpose: 'reauth',
            action: {
              purpose: 'bind_email',
              operationId,
              target: 'new@example.com',
            },
          });
          return Response.json({
            data: {
              id,
              purpose: 'reauth',
              status: 'pending',
              expiresAt: '2026-10-26T20:02:00.000Z',
              miniappCode: 'data:image/png;base64,aW1hZ2U=',
            },
            meta,
          });
        }
        if (String(path).endsWith('/consume')) {
          expect(confirmed).toBe(true);
          return Response.json({
            data: {
              proof: 'controlled-purpose-proof-123456',
              expiresAt: '2026-10-26T20:05:00.000Z',
            },
            meta,
          });
        }
        if (options?.method === 'DELETE')
          return Response.json({
            data: {
              id,
              purpose: 'reauth',
              status: 'cancelled',
              expiresAt: '2026-10-26T20:02:00.000Z',
            },
            meta,
          });
        confirmed = true;
        return Response.json({
          data: {
            id,
            purpose: 'reauth',
            status: 'confirmed',
            expiresAt: '2026-10-26T20:02:00.000Z',
          },
          meta,
        });
      },
    );
    vi.stubGlobal('fetch', fetch);
    await useAccount().refresh(true);
    const generation = api.getGeneration();
    const wrapper = mount(ReauthForm, {
      props: {
        action: {
          purpose: 'bind_email',
          operationId,
          target: 'new@example.com',
        },
      },
    });
    try {
      await wrapper.get('input[type=password]').setValue('wrong');
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      expect(wrapper.text()).toContain('当前会话仍保留');
      expect(api.getGeneration()).toBe(generation);
      expect(useAccount().current.value?.id).toBe(user.id);
      expect(wrapper.emitted('verified')).toBeUndefined();
      await wrapper
        .findAll('button')
        .find((b) => b.text().includes('扫码重新验证'))
        ?.trigger('click');
      await flushPromises();
      expect(wrapper.find('img').exists()).toBe(true);
      expect(wrapper.emitted('verified')).toBeUndefined();
      await wrapper
        .findAll('button')
        .find((b) => b.text().includes('领取本次验证证明'))
        ?.trigger('click');
      await flushPromises();
      expect(wrapper.emitted('verified')?.[0]).toEqual([
        'controlled-purpose-proof-123456',
      ]);
    } finally {
      wrapper.unmount();
    }
  });
  it('copies only server-authorized source drafts, preserves reliable original versions and requires explicit category choice when provenance is missing', () => {
    const sourceId = randomUUID(),
      targetId = randomUUID(),
      entryId = randomUUID(),
      categoryId = randomUUID(),
      newCategory = randomUUID();
    const draft: EntryDraft = {
      format: 'dayline-draft',
      localSchemaVersion: 1,
      environment: 'env',
      userId: sourceId,
      draftId: randomUUID(),
      entryId,
      baseEntryVersion: 3,
      baseEntry: {
        id: entryId,
        title: '原基准',
        categoryId,
        startDate: '2026-10-01',
        endDate: null,
        version: 3,
        focusVersion: 1,
        deletedAt: null,
        purgeAfter: null,
        createdAt: meta.serverTime,
        updatedAt: meta.serverTime,
      },
      inputRevision: 7,
      persistedRevision: 7,
      savedLocallyAt: meta.serverTime,
      fields: {
        title: '来源未提交修改',
        startDate: '2026-10-01',
        endDate: null,
        categoryId,
      },
    };
    const mapping: MergeMappings = {
      mergeId: randomUUID(),
      sourceUserId: sourceId,
      targetUserId: targetId,
      entries: [{ oldId: entryId, newId: entryId }],
      categories: [{ oldId: categoryId, newId: newCategory }],
    };
    const recovered = recoverMergeDraft(
      draft,
      mapping,
      randomUUID(),
      randomUUID(),
      meta.serverTime,
    );
    expect(recovered.userId).toBe(targetId);
    expect(recovered.baseEntryVersion).toBe(3);
    expect(recovered.baseEntry?.title).toBe('原基准');
    expect(recovered.fields.title).toBe('来源未提交修改');
    expect(recovered.fields.categoryId).toBe(newCategory);
    expect(draft.userId).toBe(sourceId);
    expect(() =>
      recoverMergeDraft(
        draft,
        { ...mapping, sourceUserId: randomUUID() },
        randomUUID(),
        randomUUID(),
        meta.serverTime,
      ),
    ).toThrow();
    expect(() =>
      recoverMergeDraft(
        draft,
        { ...mapping, categories: [] },
        randomUUID(),
        randomUUID(),
        meta.serverTime,
      ),
    ).toThrow();
    const manual = recoverMergeDraft(
      draft,
      { ...mapping, categories: [] },
      randomUUID(),
      randomUUID(),
      meta.serverTime,
      newCategory,
    );
    expect(manual.baseEntryVersion).toBeNull();
    expect(manual.entryId).not.toBe(entryId);
  });
});
