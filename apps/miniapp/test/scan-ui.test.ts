import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientError } from '@dayline/api-client';
const hooks = vi.hoisted(() => ({
  load: undefined as undefined | ((options: { scene: string }) => void),
  unload: undefined as undefined | (() => void),
}));
const request = vi.hoisted(() => vi.fn());
vi.mock('@dcloudio/uni-app', () => ({
  onLoad(callback: typeof hooks.load) {
    hooks.load = callback;
  },
  onUnload(callback: typeof hooks.unload) {
    hooks.unload = callback;
  },
}));
vi.mock('../src/api', () => ({
  api: { request },
  wechatCode: async () => 'fresh-wechat-code',
}));
import ScanPage from '../src/pages/scan/confirm.vue';
afterEach(() => {
  request.mockReset();
  hooks.load = undefined;
  hooks.unload = undefined;
});
describe('miniapp explicit scan intent', () => {
  it('does not confirm on scan, retains proof after confirmation and can cancel before consumption', async () => {
    const proof = 'p'.repeat(43);
    const id = '63a561bd-2302-485d-8d89-cea248ffbdf1';
    request
      .mockResolvedValueOnce({
        data: {
          id,
          purpose: 'login',
          status: 'scanned',
          scannerProof: proof,
          expiresAt: '2026-10-26T23:59:59.000Z',
        },
      })
      .mockResolvedValue({
        data: {
          id,
          purpose: 'login',
          status: 'confirmed',
          expiresAt: '2026-10-26T23:59:59.000Z',
        },
      });
    const wrapper = mount(ScanPage);
    hooks.load?.({ scene: 'a'.repeat(32) });
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('/api/v1/auth/qr-requests/resolve');
    const confirm = wrapper
      .findAll('button')
      .find((button) => button.text() === '确认登录网页');
    await confirm?.trigger('click');
    await flushPromises();
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      body: { scannerProof: proof },
    });
    const cancel = wrapper
      .findAll('button')
      .find((button) => button.text() === '取消已确认的登录');
    expect(cancel).toBeDefined();
    await cancel?.trigger('click');
    await flushPromises();
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      method: 'DELETE',
      headers: { 'X-Dayline-Scanner-Proof': proof },
    });
    expect(wrapper.text()).toContain('本次操作已取消');
    hooks.unload?.();
    wrapper.unmount();
  });
  it('explains that an already consumed request cannot be cancelled', async () => {
    request
      .mockResolvedValueOnce({
        data: {
          id: '63a561bd-2302-485d-8d89-cea248ffbdf1',
          purpose: 'login',
          status: 'scanned',
          scannerProof: 'p'.repeat(43),
          expiresAt: '2026-10-26T23:59:59.000Z',
        },
      })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(
        new ClientError('QR_STATE_CONFLICT', 'conflict', 409),
      );
    const wrapper = mount(ScanPage);
    hooks.load?.({ scene: 'a'.repeat(32) });
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '确认登录网页')
      ?.trigger('click');
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '取消已确认的登录')
      ?.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('已被网页领取或已经结束');
    expect(wrapper.findAll('button')).toHaveLength(0);
    hooks.unload?.();
    wrapper.unmount();
  });
});
