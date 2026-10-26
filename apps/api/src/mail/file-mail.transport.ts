import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MailTransport, TransactionalMail } from './mail-transport.js';

export class FileMailTransport implements MailTransport {
  constructor(private readonly directory: string) {}

  async send(mail: TransactionalMail): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(this.directory, `${Date.now()}-${randomUUID()}.json`),
      JSON.stringify(mail, null, 2),
      { mode: 0o600, flag: 'wx' },
    );
  }
}
