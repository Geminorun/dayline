import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FileMailTransport } from '../src/mail/file-mail.transport.js';
import { MailService } from '../src/mail/mail.service.js';
import { ResendMailTransport } from '../src/mail/resend-mail.transport.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('transactional mail', () => {
  it('sends through the Resend SDK with a timeout and the configured sender', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'test-mail-id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const transport = new ResendMailTransport(
      'test-only-key',
      'Dayline <noreply@example.com>',
    );
    const receipt = await transport.send({
      to: 'reader@example.com',
      subject: 'test',
      text: 'hello',
      html: '<p>hello</p>',
    });
    expect(receipt).toEqual({ messageId: 'test-mail-id' });
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('Missing Resend request');
    expect(call[0]).toBe('https://api.resend.com/emails');
    const options = z
      .object({
        method: z.literal('POST'),
        body: z.string(),
        signal: z.instanceof(AbortSignal),
      })
      .parse(call[1]);
    expect(JSON.parse(options.body)).toMatchObject({
      from: 'Dayline <noreply@example.com>',
      to: 'reader@example.com',
      subject: 'test',
    });
  });
  it('previews escaped links in private files, without sending mail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dayline-mail-'));
    try {
      const mail = new MailService(new FileMailTransport(directory));
      await mail.sendVerification(
        'reader@example.com',
        'https://example.com/verify?token=test&next="quoted"',
      );
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      const file = files[0];
      if (!file) throw new Error('Missing preview file');
      const data = z
        .object({ to: z.string(), html: z.string(), text: z.string() })
        .parse(JSON.parse(await readFile(join(directory, file), 'utf8')));
      expect(data.to).toBe('reader@example.com');
      expect(data.html).toContain('token=test&amp;next=&quot;quoted&quot;');
      expect(data.text).toContain('token=test&next="quoted"');
      if (process.platform !== 'win32')
        expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not send verification or reset links to internal identities', async () => {
    const transport = { send: vi.fn().mockResolvedValue(undefined) };
    const mail = new MailService(transport);
    await expect(
      mail.sendVerification(
        'wx-test@identity.dayline.invalid',
        'https://example.com',
      ),
    ).rejects.toThrow('Internal identity');
    await expect(
      mail.sendPasswordReset(
        'wx-test@identity.dayline.invalid',
        'https://example.com',
      ),
    ).rejects.toThrow('Internal identity');
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('sanitizes mail provider errors', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: 'validation_error',
            message: 'private provider detail',
            statusCode: 422,
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const transport = new ResendMailTransport(
      'test-only-key',
      'Dayline <noreply@example.com>',
    );
    await expect(
      transport.send({
        to: 'reader@example.com',
        subject: 'test',
        html: '<p>test</p>',
        text: 'test',
      }),
    ).rejects.toMatchObject({
      message: 'Transactional mail was not accepted by the mail provider.',
      providerCode: 'validation_error',
      providerStatus: 422,
    });
    expect(consoleError).not.toHaveBeenCalled();
  });
});
