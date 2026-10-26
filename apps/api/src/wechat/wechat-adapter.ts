import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from '../config/environment.js';
import type { AppConfig } from '../config/environment.js';
import { AppError } from '../common/app-error.js';

export const WECHAT_ADAPTER = Symbol('WECHAT_ADAPTER');
export interface WechatIdentityProof {
  appId: string;
  openid: string;
  unionid?: string;
}
export interface WechatAdapter {
  exchangeCode(code: string): Promise<WechatIdentityProof>;
  createMiniappCode(scene: string): Promise<string>;
}

@Injectable()
export class ProductionWechatAdapter implements WechatAdapter {
  private accessToken: { value: string; expiresAt: number } | undefined;
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private credentials() {
    const { wechatAppId: appId, wechatAppSecret: secret } = this.config;
    if (!appId?.trim() || !secret?.trim())
      throw new AppError(503, 'WECHAT_NOT_CONFIGURED', '微信登录暂未配置。');
    return { appId, secret };
  }

  private async fetch(url: URL, options?: RequestInit) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('upstream');
      return response;
    } catch {
      throw new AppError(
        503,
        'WECHAT_UNAVAILABLE',
        '微信服务暂不可用，请重新获取登录凭据后重试。',
      );
    }
  }

  async exchangeCode(code: string): Promise<WechatIdentityProof> {
    const { appId, secret } = this.credentials();
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({
      appid: appId,
      secret,
      js_code: code,
      grant_type: 'authorization_code',
    }).toString();
    try {
      const body: unknown = await (await this.fetch(url)).json();
      const upstreamError = z.object({ errcode: z.number() }).safeParse(body);
      if (upstreamError.success && upstreamError.data.errcode !== 0) {
        if ([40029, 40163, 40226].includes(upstreamError.data.errcode))
          throw new AppError(
            401,
            'WECHAT_CODE_INVALID',
            '微信凭据失效，请重新登录。',
          );
        throw new AppError(
          503,
          'WECHAT_UNAVAILABLE',
          '微信服务暂不可用，请稍后重试。',
        );
      }
      const result = z
        .object({
          openid: z.string().min(1),
          unionid: z.string().optional(),
          errcode: z.number().optional(),
        })
        .safeParse(body);
      if (!result.success)
        throw new AppError(502, 'WECHAT_UNAVAILABLE', '微信返回了无效响应。');
      return {
        appId,
        openid: result.data.openid,
        ...(result.data.unionid ? { unionid: result.data.unionid } : {}),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'WECHAT_UNAVAILABLE', '微信返回了无效响应。');
    }
  }

  private async token() {
    const { appId, secret } = this.credentials();
    if (this.accessToken && this.accessToken.expiresAt > Date.now())
      return this.accessToken.value;
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.search = new URLSearchParams({
      grant_type: 'client_credential',
      appid: appId,
      secret,
    }).toString();
    try {
      const body: unknown = await (await this.fetch(url)).json();
      const result = z
        .object({
          access_token: z.string().min(1),
          expires_in: z.number().positive(),
        })
        .safeParse(body);
      if (!result.success) throw new Error('invalid');
      this.accessToken = {
        value: result.data.access_token,
        expiresAt:
          Date.now() + Math.max(0, result.data.expires_in - 120) * 1000,
      };
      return this.accessToken.value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'WECHAT_UNAVAILABLE', '无法取得小程序码。');
    }
  }

  async createMiniappCode(scene: string): Promise<string> {
    const url = new URL('https://api.weixin.qq.com/wxa/getwxacodeunlimit');
    url.searchParams.set('access_token', await this.token());
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scene,
        page: this.config.wechatScanPage,
        env_version: this.config.wechatEnvironment,
        check_path: true,
        width: 360,
      }),
    });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new AppError(
        503,
        'WECHAT_UNAVAILABLE',
        '小程序码下载失败，请稍后重试。',
      );
    }
    const png =
      bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (bytes.length > 1024 * 1024 || (!png && !jpeg)) {
      this.accessToken = undefined;
      throw new AppError(
        502,
        'WECHAT_CODE_UNAVAILABLE',
        '小程序码生成失败，请稍后重试。',
      );
    }
    return `data:image/${png ? 'png' : 'jpeg'};base64,${Buffer.from(bytes).toString('base64')}`;
  }
}
