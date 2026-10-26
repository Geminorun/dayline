import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { WechatAdapter } from './wechat-adapter.js';
import { UsersModule } from '../users/users.module.js';
import { WechatController } from './wechat.controller.js';
import { ProductionWechatAdapter, WECHAT_ADAPTER } from './wechat-adapter.js';
import { WechatService } from './wechat.service.js';
import { QrService } from './qr.service.js';
@Module({})
export class WechatModule {
  static register(adapter?: WechatAdapter): DynamicModule {
    return {
      module: WechatModule,
      imports: [UsersModule],
      controllers: [WechatController],
      providers: [
        {
          provide: WECHAT_ADAPTER,
          ...(adapter
            ? { useValue: adapter }
            : { useClass: ProductionWechatAdapter }),
        },
        WechatService,
        QrService,
      ],
    };
  }
}
