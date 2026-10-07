// Transactional e-mail with attachments (booking confirmations carry an
// .ics invite). Same transports as patient-invite / notifications-dispatch:
//   - prod: Gmail's SMTP relay, implicit TLS on 465, AUTH LOGIN with an App
//     Password (GMAIL_SMTP_USER / GMAIL_SMTP_PASSWORD — see gmail-smtp.ts);
//   - local dev: the Inbucket relay over plain TCP (SMTP_HOST / SMTP_PORT,
//     caught mail at http://127.0.0.1:54324).
// Every part is base64 so the body never needs dot-stuffing and Hebrew
// survives any relay (RFC 2045).

export interface EmailAttachment {
  filename: string;
  contentType: string;
  /** UTF-8 text */
  content: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

const GMAIL_USER = Deno.env.get('GMAIL_SMTP_USER') ?? '';
const GMAIL_PASSWORD = Deno.env.get('GMAIL_SMTP_PASSWORD') ?? '';
const SMTP_HOST = Deno.env.get('SMTP_HOST') ?? '';
const SMTP_PORT = Number(Deno.env.get('SMTP_PORT') ?? '2500');
const SMTP_FROM = Deno.env.get('SMTP_FROM') ?? 'ReCOVR <no-reply@recoveryos.local>';

export function emailConfigured(): boolean {
  return !!(GMAIL_USER && GMAIL_PASSWORD) || !!SMTP_HOST;
}

const enc = new TextEncoder();

function b64(s: string): string {
  const bytes = enc.encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64Wrapped(s: string): string {
  return (b64(s).match(/.{1,76}/g) ?? []).join('\r\n');
}

function encodedWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
}

function addrOnly(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from.trim();
}

function boundary(): string {
  return `=_recovr_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** The full RFC 5322 message (headers + MIME body), CRLF line endings. */
export function buildMime(msg: EmailMessage, from: string): string {
  const alt = boundary();
  const alternative =
    `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
    `--${alt}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Wrapped(msg.text)}\r\n` +
    `--${alt}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Wrapped(msg.html)}\r\n` +
    `--${alt}--\r\n`;

  let body: string;
  if (msg.attachments?.length) {
    const mixed = boundary();
    body =
      `Content-Type: multipart/mixed; boundary="${mixed}"\r\n\r\n` +
      `--${mixed}\r\n${alternative}` +
      msg.attachments
        .map(
          (a) =>
            `--${mixed}\r\nContent-Type: ${a.contentType}; charset=UTF-8; name="${a.filename}"\r\n` +
            `Content-Disposition: attachment; filename="${a.filename}"\r\n` +
            `Content-Transfer-Encoding: base64\r\n\r\n${b64Wrapped(a.content)}\r\n`,
        )
        .join('') +
      `--${mixed}--\r\n`;
  } else {
    body = alternative;
  }

  return (
    `From: ${from}\r\n` +
    `To: <${msg.to}>\r\n` +
    `Subject: ${encodedWord(msg.subject)}\r\n` +
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}\r\n` +
    `Message-ID: <${crypto.randomUUID()}@recovr>\r\n` +
    `MIME-Version: 1.0\r\n` +
    body
  );
}

type Conn = Deno.Conn | Deno.TlsConn;

async function smtpDialog(conn: Conn, steps: (cmd: (line: string, expect: RegExp) => Promise<void>) => Promise<void>) {
  const dec = new TextDecoder();
  const buf = new Uint8Array(4096);
  let pending = '';

  // A reply is complete at its last line: "NNN text" or "NNN" — not the
  // "NNN-text" continuation lines of a multi-line reply.
  const readReply = async (): Promise<string> => {
    while (!/(^|\r\n)\d{3}(?: [^\r\n]*)?\r\n$/.test(pending)) {
      const n = await conn.read(buf);
      if (n === null) throw new Error('SMTP: connection closed');
      pending += dec.decode(buf.subarray(0, n));
    }
    const reply = pending;
    pending = '';
    return reply;
  };
  const cmd = async (line: string, expect: RegExp) => {
    await conn.write(enc.encode(line + '\r\n'));
    const reply = await readReply();
    if (!expect.test(reply)) throw new Error(`SMTP: expected ${expect}, got ${reply.trim().slice(0, 200)}`);
  };

  const greeting = await readReply();
  if (!/^220/.test(greeting)) throw new Error(`SMTP greeting: ${greeting.trim()}`);
  await steps(cmd);
  await conn.write(enc.encode('QUIT\r\n'));
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  if (GMAIL_USER && GMAIL_PASSWORD) {
    const conn = await Deno.connectTls({ hostname: 'smtp.gmail.com', port: 465 });
    try {
      await smtpDialog(conn, async (cmd) => {
        await cmd('EHLO recoveryos', /^250/);
        await cmd('AUTH LOGIN', /^334/);
        await cmd(b64(GMAIL_USER), /^334/);
        await cmd(b64(GMAIL_PASSWORD), /^235/);
        await cmd(`MAIL FROM:<${GMAIL_USER}>`, /^250/);
        await cmd(`RCPT TO:<${msg.to}>`, /^25[01]/);
        await cmd('DATA', /^354/);
        await cmd(`${buildMime(msg, `ReCOVR <${GMAIL_USER}>`)}\r\n.`, /^250/);
      });
    } finally {
      conn.close();
    }
    return;
  }

  if (!SMTP_HOST) throw new Error('e-mail is not configured');
  const conn = await Deno.connect({ hostname: SMTP_HOST, port: SMTP_PORT });
  try {
    await smtpDialog(conn, async (cmd) => {
      await cmd('EHLO recoveryos', /^250/);
      await cmd(`MAIL FROM:<${addrOnly(SMTP_FROM)}>`, /^250/);
      await cmd(`RCPT TO:<${msg.to}>`, /^25[01]/);
      await cmd('DATA', /^354/);
      await cmd(`${buildMime(msg, SMTP_FROM)}\r\n.`, /^250/);
    });
  } finally {
    conn.close();
  }
}
