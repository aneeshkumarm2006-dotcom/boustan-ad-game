/**
 * The one place that talks to the email provider (Resend, DECISIONS D3), so switching to
 * Postmark is a one-file change.
 *
 * EMAIL_SANDBOX=1 (dev and preview) never reaches a real inbox: with an API key, mail goes to
 * Resend's delivered@resend.dev test address; without one, it's written to ./.emails/ for a
 * look in the browser (dev only) and logged.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Resend } from "resend";
import { env } from "../env";
import { log } from "../log";
import { scrub } from "../scrub";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  /** Resend drops a repeat with the same key for 24 h, so a retry never sends twice. */
  idempotencyKey: string;
  tags: { name: string; value: string }[];
}

export class SendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SendError";
  }
}

export type Sender = (email: OutgoingEmail) => Promise<{ id: string }>;

let resend: Resend | null = null;

/** Statuses Resend uses for problems a retry can't fix. */
const PERMANENT = new Set([
  "validation_error",
  "invalid_from_address",
  "invalid_parameter",
  "missing_required_field",
  "restricted_api_key",
  "invalid_api_key",
]);

async function sendWithResend(email: OutgoingEmail, to: string): Promise<{ id: string }> {
  const e = env();
  resend ??= new Resend(e.EMAIL_API_KEY);
  const { data, error } = await resend.emails.send(
    {
      from: e.EMAIL_FROM,
      to,
      replyTo: e.EMAIL_REPLY_TO,
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: email.headers,
      tags: email.tags,
    },
    { idempotencyKey: email.idempotencyKey },
  );
  if (error || !data) {
    const name = error?.name ?? "unknown";
    throw new SendError(scrub(`${name}: ${error?.message ?? "no response"}`), !PERMANENT.has(name));
  }
  return { id: data.id };
}

async function writeToDisk(email: OutgoingEmail): Promise<{ id: string }> {
  const id = `sandbox-${randomUUID()}`;
  if (!process.env.VERCEL) {
    const dir = path.resolve(".emails");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${id}.html`), email.html);
    await writeFile(path.join(dir, `${id}.txt`), `Subject: ${email.subject}\n\n${email.text}`);
  }
  log.info("email_sandboxed", { id });
  return { id };
}

export const defaultSender: Sender = async (email) => {
  const e = env();
  if (e.EMAIL_SANDBOX) {
    return e.EMAIL_API_KEY ? sendWithResend(email, "delivered@resend.dev") : writeToDisk(email);
  }
  if (!e.EMAIL_API_KEY) throw new SendError("EMAIL_API_KEY is blank", true);
  return sendWithResend(email, email.to);
};
