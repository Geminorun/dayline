import { isMessage } from '@dayline/locales';
import { tr } from '../i18n/index';
import { FileError, parseImportFile } from '@dayline/contracts/files';
import { normalizedImportSourceSchema } from '@dayline/contracts';
import type { NormalizedImportSource } from '@dayline/contracts';
export function parseWebFile(
  text: string,
  format: 'csv' | 'json',
  now: string,
): Promise<NormalizedImportSource> {
  if (text.length < 256 * 1024 || typeof Worker === 'undefined')
    return Promise.resolve().then(() => parseImportFile(text, format, now));
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./file-parser.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onerror = () => {
      worker.terminate();
      reject(
        new FileError(
          'IMPORT_INVALID',
          tr('file-parser.fileParsingIsNotCompletedPleaseKeep'),
        ),
      );
    };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      worker.terminate();
      const result = event.data;
      if (typeof result !== 'object' || result === null || !('ok' in result)) {
        reject(
          new FileError(
            'IMPORT_INVALID',
            tr('file-parser.invalidFileParsingResponse'),
          ),
        );
        return;
      }
      if (result.ok === true && 'source' in result) {
        const checked = normalizedImportSourceSchema.safeParse(result.source);
        if (checked.success) resolve(checked.data);
        else
          reject(
            new FileError('IMPORT_INVALID', tr('common.invalidFileStructure')),
          );
      } else {
        const error = result as {
          code?: unknown;
          message?: unknown;
          issues?: unknown;
        };
        reject(
          new FileError(
            typeof error.code === 'string' ? error.code : 'IMPORT_INVALID',
            typeof error.message === 'string' || isMessage(error.message)
              ? error.message
              : tr('common.fileParsingNotCompleted'),
            Array.isArray(error.issues)
              ? error.issues.filter(
                  (i): i is { path: string; message: string } =>
                    typeof i === 'object' &&
                    i !== null &&
                    typeof i.path === 'string' &&
                    typeof i.message === 'string',
                )
              : [],
          ),
        );
      }
    };
    worker.postMessage({ text, format, now });
  });
}
