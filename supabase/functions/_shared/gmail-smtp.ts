// Sends transactional email via Gmail's SMTP relay using an App Password
// (myaccount.google.com/apppasswords — requires 2FA enabled on the account).
// Requires GMAIL_SMTP_USER (the sending Gmail address) and
// GMAIL_SMTP_PASSWORD (the 16-char App Password, not the account password).
// Gmail's relay requires "From" to match the authenticated account, so the
// sender is always GMAIL_SMTP_USER.

const GMAIL_HOST = 'smtp.gmail.com';
const GMAIL_PORT = 465; // implicit TLS (SMTPS) — simpler than STARTTLS upgrade

function b64utf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

// base64 the UTF-8 bytes, wrapped at 76 chars (RFC 2045) — sending raw 8-bit
// Hebrew over SMTP leaves the charset ambiguous and mail parsers fall back to
// Latin-1 (mojibake).
function b64Body(s: string): string {
  return (b64utf8(s).match(/.{1,76}/g) ?? []).join('\r\n');
}

export async function sendViaGmail(to: string, subject: string, html: string): Promise<void> {
  const user = Deno.env.get('GMAIL_SMTP_USER');
  const pass = Deno.env.get('GMAIL_SMTP_PASSWORD');
  if (!user || !pass) throw new Error('GMAIL_SMTP_USER/GMAIL_SMTP_PASSWORD not configured');

  const conn = await Deno.connectTls({ hostname: GMAIL_HOST, port: GMAIL_PORT });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const buf = new Uint8Array(4096);

  const read = async (): Promise<string> => {
    const n = await conn.read(buf);
    return dec.decode(buf.subarray(0, n ?? 0));
  };
  const cmd = async (line: string, expect: RegExp): Promise<void> => {
    await conn.write(enc.encode(line + '\r\n'));
    const reply = await read();
    if (!expect.test(reply)) throw new Error(`SMTP: expected ${expect}, got ${reply.trim()}`);
  };

  try {
    const greeting = await read();
    if (!/^220/.test(greeting)) throw new Error(`SMTP greeting: ${greeting.trim()}`);

    await cmd('EHLO recoveryos', /^250/);
    await cmd('AUTH LOGIN', /^334/);
    await cmd(b64utf8(user), /^334/);
    await cmd(b64utf8(pass), /^235/);
    await cmd(`MAIL FROM:<${user}>`, /^250/);
    await cmd(`RCPT TO:<${to}>`, /^25[05]/);
    await cmd('DATA', /^354/);

    const message =
      `From: ReCOVR <${user}>\r\n` +
      `To: <${to}>\r\n` +
      `Subject: =?UTF-8?B?${b64utf8(subject)}?=\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      `${b64Body(html)}\r\n.`;
    await cmd(message, /^250/);
    await conn.write(enc.encode('QUIT\r\n'));
  } finally {
    conn.close();
  }
}
