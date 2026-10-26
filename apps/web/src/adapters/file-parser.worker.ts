import { FileError, parseImportFile } from '@dayline/contracts/files';
self.onmessage = (
  event: MessageEvent<{ text: string; format: 'csv' | 'json'; now: string }>,
) => {
  try {
    self.postMessage({
      ok: true,
      source: parseImportFile(
        event.data.text,
        event.data.format,
        event.data.now,
      ),
    });
  } catch (error) {
    self.postMessage({
      ok: false,
      code: error instanceof FileError ? error.code : 'IMPORT_INVALID',
      message: error instanceof FileError ? error.message : '无法解析文件。',
      issues: error instanceof FileError ? error.issues : [],
    });
  }
};
