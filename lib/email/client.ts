import "server-only";
import { Resend } from "resend";

let client: Resend | null = null;

/** Lazily create the Resend client so builds don't fail when the key is absent. */
export function getResend(): Resend {
  if (client) return client;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not set. Add it to .env.local or your hosting provider's secrets.");
  }
  client = new Resend(apiKey);
  return client;
}

/** Default sender for app (transactional) email. */
export const EMAIL_FROM = process.env.EMAIL_FROM ?? "Editums <noreply@mail.editums.com>";

/** Where replies to app email should go — the Resend inbox on the same domain. */
export const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO ?? "hello@mail.editums.com";
