/**
 * Minimal SMTP client (damage-claims return path, phase 1) — SERVER-ONLY.
 *
 * Gmail SMTP with an app password (smtp.gmail.com:465, implicit TLS) is the
 * default transport for returning signed claim forms to companies. Built on
 * node:net/node:tls with ZERO dependencies (the stack stays lightweight; the
 * app has no nodemailer). The protocol implementation is a compact line-based
 * state machine:
 *
 *   connect → 220 greeting → EHLO → AUTH LOGIN (base64 user/pass) → 235
 *   → MAIL FROM → 250 → RCPT TO (per recipient) → 250 → DATA → 354
 *   → headers + MIME multipart body + attachments (base64) → "." → 250
 *   → QUIT
 *
 * HERMETIC BY DESIGN: the socket factory (`connectImpl`) is injectable, so
 * tests replay canned SMTP dialogue over a fake duplex and never touch the
 * network. The damage-claims send path injects a transport mock at a higher
 * layer too (claims-core sendClaimCore — see its `sendImpl` option); nothing
 * in the suite ever sends real mail.
 *
 * Security: never logs credentials or message content. The caller supplies
 * the SMTP account (the owner's Gmail address + app password, loaded via the
 * same loadGmailConfig used by IMAP — app passwords work for both).
 *
 * Imported ONLY by claims-core / hermetic tests — never by client-reachable
 * modules (client-graph rule: node:net/node:tls must not enter the bundle).
 */
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { connect as netConnect, type Socket } from "node:net";
import type { Socket as NetSocket } from "node:net";

export type SmtpMessage = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  /** Base64-encoded attachments (e.g. the signed form image). */
  attachments?: Array<{ filename: string; contentType: string; base64: string; inline?: boolean }>;
};

export type SmtpConfig = { host: string; port: number; secure: boolean; user: string; pass: string };

/** Minimal duplex surface the client needs — injectable in tests. */
export type SmtpSocketLike = {
  write: (data: string | Uint8Array) => void;
  end: () => void;
  on: (event: "data" | "error" | "close", cb: (arg?: unknown) => void) => void;
  once: (event: "data" | "error" | "close", cb: (arg?: unknown) => void) => void;
  removeAllListeners?: (event?: string) => void;
};

export type SmtpSendResult = { ok: true; response: string } | { ok: false; error: string };

/** Default Gmail SMTP settings (app password). */
export const GMAIL_SMTP: SmtpConfig = { host: "smtp.gmail.com", port: 465, secure: true, user: "", pass: "" };

/** Line reader: accumulates chunks, emits complete CRLF/LF-terminated lines. */
class LineReader {
  private buf = "";
  private pending: Array<(line: string) => void> = [];
  push(chunk: string | Uint8Array): void {
    this.buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      const cb = this.pending.shift();
      if (cb) cb(line);
    }
  }
  /** Resolve on the NEXT complete line (with an overall timeout). */
  nextLine(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SMTP: timed out waiting for a server response.")), timeoutMs);
      this.pending.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }
}

/** Expect a numeric code (optionally with an allowed set); returns the line. */
function expectCode(line: string, okCodes: number[]): { ok: boolean; code: number; line: string } {
  const m = /^(\d{3})/.exec(line);
  const code = m ? Number(m[1]) : -1;
  return { ok: okCodes.includes(code), code, line };
}

/** Send one message over an injected (or real) socket. */
export async function smtpSend(
  config: SmtpConfig,
  message: SmtpMessage,
  opts: { connectImpl?: () => Promise<SmtpSocketLike>; timeoutMs?: number } = {},
): Promise<SmtpSendResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  let sock: SmtpSocketLike;
  try {
    sock = opts.connectImpl
      ? await opts.connectImpl()
      : await new Promise<SmtpSocketLike>((resolve, reject) => {
          const s: Socket | TLSSocket = config.secure
            ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
            : netConnect({ host: config.host, port: config.port });
          const onErr = (e: Error) => reject(e);
          s.once("error", onErr);
          s.once("secureConnect", () => { s.removeListener("error", onErr); resolve(s as unknown as SmtpSocketLike); });
          s.once("connect", () => { s.removeListener("error", onErr); resolve(s as unknown as SmtpSocketLike); });
        });
  } catch (err) {
    return { ok: false, error: `SMTP: could not connect — ${err instanceof Error ? err.message : String(err)}` };
  }
  const reader = new LineReader();
  const onData = (chunk: unknown) => reader.push(chunk as string | Uint8Array);
  sock.on("data", onData);
  const fail = (err: string): SmtpSendResult => ({ ok: false, error: err });
  try {
    // greeting
    const greeting = await reader.nextLine(timeoutMs);
    const g = expectCode(greeting, [220]);
    if (!g.ok) return fail(`SMTP: unexpected greeting (${greeting}).`);
    // EHLO
    sock.write(`EHLO lightningdispatch.app\r\n`);
    // EHLO may span multiple 250 lines; consume until a line without "-"
    for (;;) {
      const l = await reader.nextLine(timeoutMs);
      if (!/^250-/.test(l)) {
        const e = expectCode(l, [250]);
        if (!e.ok) return fail(`SMTP: EHLO rejected (${l}).`);
        break;
      }
    }
    // AUTH LOGIN
    sock.write(`AUTH LOGIN\r\n`);
    const auth334 = await reader.nextLine(timeoutMs);
    if (!/^334/.test(auth334)) return fail(`SMTP: AUTH LOGIN not offered (${auth334}).`);
    sock.write(`${Buffer.from(config.user, "utf8").toString("base64")}\r\n`);
    const user334 = await reader.nextLine(timeoutMs);
    if (!/^334/.test(user334)) return fail(`SMTP: username rejected (${user334}).`);
    sock.write(`${Buffer.from(config.pass, "utf8").toString("base64")}\r\n`);
    const auth235 = await reader.nextLine(timeoutMs);
    if (!/^235/.test(auth235)) return fail(`SMTP: authentication failed (${auth235}).`);
    // MAIL FROM
    sock.write(`MAIL FROM:<${message.from}>\r\n`);
    const mailFrom = await reader.nextLine(timeoutMs);
    if (!/^250/.test(mailFrom)) return fail(`SMTP: MAIL FROM rejected (${mailFrom}).`);
    // RCPT TO (dedupe, ignore empty)
    const rcpts = [...new Set([...(message.to ?? []), ...(message.cc ?? []), ...(message.bcc ?? [])].filter((r) => r && /@/.test(r)))];
    if (!rcpts.length) return fail("SMTP: no recipients.");
    for (const r of rcpts) {
      sock.write(`RCPT TO:<${r}>\r\n`);
      const rcpt = await reader.nextLine(timeoutMs);
      if (!/^250/.test(rcpt)) return fail(`SMTP: RCPT TO rejected for ${r} (${rcpt}).`);
    }
    // DATA
    sock.write(`DATA\r\n`);
    const data354 = await reader.nextLine(timeoutMs);
    if (!/^354/.test(data354)) return fail(`SMTP: DATA not accepted (${data354}).`);
    const raw = buildMimeMessage(message);
    sock.write(raw.replace(/\r?\n/g, "\r\n"));
    sock.write("\r\n.\r\n");
    const done = await reader.nextLine(timeoutMs);
    if (!/^250/.test(done)) return fail(`SMTP: message rejected (${done}).`);
    // QUIT
    try { sock.write(`QUIT\r\n`); } catch { /* best-effort */ }
    return { ok: true, response: done };
  } catch (err) {
    return fail(`SMTP: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try { sock.end(); } catch { /* best-effort */ }
    try { sock.removeAllListeners?.(); } catch { /* best-effort */ }
  }
}

/** Build a MIME multipart/alternative + mixed message from a SmtpMessage.
 *  Pure — unit-testable without any socket. */
export function buildMimeMessage(m: SmtpMessage): string {
  const boundary = `----=_ld_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const hasAttachments = (m.attachments ?? []).length > 0;
  const head = [
    `From: ${m.from}`,
    ...(m.to ?? []).filter(Boolean).map((r) => `To: ${r}`),
    ...(m.cc ?? []).filter(Boolean).map((r) => `Cc: ${r}`),
    ...(m.bcc ?? []).filter(Boolean).map((r) => `Bcc: ${r}`),
    `Subject: ${encodeHeader(m.subject)}`,
    `MIME-Version: 1.0`,
    `Date: ${new Date().toUTCString()}`,
    hasAttachments
      ? `Content-Type: multipart/mixed; boundary="${boundary}"`
      : `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join("\r\n");
  const altBoundary = `${boundary}_alt`;
  const html = m.html ? htmlToMime(m.html, altBoundary, m.text) : null;
  let body = "";
  if (hasAttachments) {
    const alt = [
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      html ?? `--${altBoundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.text}`,
      `--${altBoundary}--`,
      "",
    ].join("\r\n");
    body = alt;
    for (const att of m.attachments ?? []) {
      body += [
        `--${boundary}`,
        `Content-Type: ${att.contentType}; name="${sanitizeFilename(att.filename)}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: ${att.inline ? "inline" : "attachment"}; filename="${sanitizeFilename(att.filename)}"`,
        "",
        wrapBase64(att.base64),
        "",
      ].join("\r\n");
    }
    body += `--${boundary}--\r\n`;
  } else {
    body = `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.text}\r\n--${boundary}--\r\n`;
  }
  return `${head}\r\n\r\n${body}`;
}

function htmlToMime(html: string, boundary: string, text: string): string {
  return [
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    text,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintable(html),
    `--${boundary}--`,
  ].join("\r\n");
}

/** RFC 2047 header encoding for non-ASCII subjects (best-effort). */
function encodeHeader(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function sanitizeFilename(name: string): string {
  return String(name).replace(/["\r\n]/g, "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "file";
}

/** Wrap base64 at 76 columns (SMTP line limits). */
function wrapBase64(b64: string): string {
  const clean = b64.replace(/\s+/g, "");
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += 76) out.push(clean.slice(i, i + 76));
  return out.join("\r\n");
}

/** Minimal quoted-printable encoder for HTML bodies. */
function quotedPrintable(s: string): string {
  return s
    .split("\n")
    .map((line) => {
      const encoded = line.replace(/[^\x20-\x7e\t]/g, (ch) => `=${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
      // hard-wrap long lines
      const out: string[] = [];
      for (let i = 0; i < encoded.length; i += 75) out.push(encoded.slice(i, i + 75));
      return out.join("=\r\n");
    })
    .join("\r\n");
}
