import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductionWechatAdapter } from '../src/wechat/wechat-adapter.js';
import { parseEnvironment } from '../src/config/environment.js';

function config(configured = true) {
  return parseEnvironment({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:unused@localhost/dayline_test',
    AUTH_BASE_URL: 'http://localhost:3000',
    WEB_BASE_URL: 'http://localhost:5173',
    AUTH_TRUSTED_ORIGINS: 'http://localhost:5173',
    BETTER_AUTH_SECRET: 'unit-test-placeholder-with-at-least-32-characters',
    MAIL_TRANSPORT: 'file',
    MAIL_FROM: 'Dayline <noreply@example.com>',
    ...(configured
      ? {
          WECHAT_APP_ID: 'test-app',
          WECHAT_APP_SECRET: 'unit-test-only-secret',
        }
      : {}),
  });
}
afterEach(() => vi.unstubAllGlobals());
describe('production WeChat adapter boundary', () => {
  it('fails explicitly without credentials and never calls the network', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const adapter = new ProductionWechatAdapter(config(false));
    await expect(adapter.exchangeCode('code')).rejects.toMatchObject({
      code: 'WECHAT_NOT_CONFIGURED',
    });
    await expect(adapter.createMiniappCode('scene')).rejects.toMatchObject({
      code: 'WECHAT_NOT_CONFIGURED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses timeout and returns only the verified identity, never session_key', async () => {
    const fetch = vi.fn(async (_url: URL, options: RequestInit) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return Response.json({
        openid: 'verified-openid',
        session_key: 'do-not-return',
        unionid: 'optional-unionid',
      });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await new ProductionWechatAdapter(config()).exchangeCode(
      'temporary',
    );
    expect(result).toEqual({
      appId: 'test-app',
      openid: 'verified-openid',
      unionid: 'optional-unionid',
    });
    expect(JSON.stringify(result)).not.toContain('do-not-return');
  });
  it.each([
    [40029, 'WECHAT_CODE_INVALID'],
    [40163, 'WECHAT_CODE_INVALID'],
    [40013, 'WECHAT_UNAVAILABLE'],
    [45011, 'WECHAT_UNAVAILABLE'],
    [-1, 'WECHAT_UNAVAILABLE'],
  ])(
    'classifies provider errcode %s without exposing provider data',
    async (errcode, code) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({ errcode, errmsg: 'secret-bearing-provider-error' }),
        ),
      );
      await expect(
        new ProductionWechatAdapter(config()).exchangeCode('temporary'),
      ).rejects.toMatchObject({ code });
      try {
        await new ProductionWechatAdapter(config()).exchangeCode('temporary');
      } catch (error) {
        expect(String(error)).not.toContain('secret-bearing');
      }
    },
  );
  it('normalizes network and malformed response failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('upstream-secret');
      }),
    );
    await expect(
      new ProductionWechatAdapter(config()).exchangeCode('temporary'),
    ).rejects.toMatchObject({ code: 'WECHAT_UNAVAILABLE' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json')),
    );
    await expect(
      new ProductionWechatAdapter(config()).exchangeCode('temporary'),
    ).rejects.toMatchObject({ code: 'WECHAT_UNAVAILABLE' });
  });
  it.each([
    ['png', [137, 80, 78, 71, 13, 10, 26, 10]],
    ['jpeg', [255, 216, 255, 224]],
  ])(
    'requests a real miniapp code and accepts %s image responses',
    async (format, bytes) => {
      let calls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: URL, options: RequestInit) => {
          calls++;
          if (url.pathname.endsWith('/token'))
            return Response.json({
              access_token: 'private-access-token',
              expires_in: 7200,
            });
          expect(url.hostname).toBe('api.weixin.qq.com');
          expect(JSON.parse(String(options.body))).toMatchObject({
            scene: 'a'.repeat(32),
            page: 'pages/scan/confirm',
            check_path: true,
            env_version: 'release',
          });
          return new Response(Uint8Array.from(bytes));
        }),
      );
      const adapter = new ProductionWechatAdapter(config());
      expect(await adapter.createMiniappCode('a'.repeat(32))).toMatch(
        new RegExp(`^data:image/${format};base64,`),
      );
      await adapter.createMiniappCode('a'.repeat(32));
      expect(calls).toBe(3);
    },
  );
  it('rejects provider JSON in place of an image and never returns a pretend QR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) =>
        url.pathname.endsWith('/token')
          ? Response.json({ access_token: 'private-token', expires_in: 7200 })
          : Response.json({ errcode: 40001, errmsg: 'private-token' }),
      ),
    );
    await expect(
      new ProductionWechatAdapter(config()).createMiniappCode('a'.repeat(32)),
    ).rejects.toMatchObject({ code: 'WECHAT_CODE_UNAVAILABLE' });
  });
});
