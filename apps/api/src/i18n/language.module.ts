import { Module, Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { I18nLoader, I18nModule } from 'nestjs-i18n';
import type { I18nResolver } from 'nestjs-i18n';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  sharedMessages,
} from '@dayline/locales';
import { serverMessages } from '@dayline/locales/server';
import type { Request } from 'express';

@Injectable()
class RequestLocaleResolver implements I18nResolver {
  resolve(context: ExecutionContext) {
    return (
      context.switchToHttp().getRequest<Request>().daylineLocale ??
      DEFAULT_LOCALE
    );
  }
}
class CatalogLoader extends I18nLoader {
  async languages() {
    return [...SUPPORTED_LOCALES];
  }
  async load() {
    return Object.fromEntries(
      SUPPORTED_LOCALES.map((locale) => {
        interface Tree {
          [key: string]: Tree | string;
        }
        const tree: Tree = {};
        for (const [key, value] of Object.entries({
          ...sharedMessages[locale],
          ...serverMessages[locale],
        })) {
          const parts = key.split('.');
          let target = tree;
          for (const name of parts.slice(0, -1)) {
            const old = target[name];
            if (old && typeof old === 'object') target = old;
            else {
              const next: Tree = {};
              target[name] = next;
              target = next;
            }
          }
          const name = parts.at(-1);
          if (name) target[name] = value;
        }
        return [locale, tree];
      }),
    );
  }
}
@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: DEFAULT_LOCALE,
      loader: CatalogLoader,
      resolvers: [RequestLocaleResolver],
      logging: false,
    }),
  ],
})
export class LanguageModule {}
