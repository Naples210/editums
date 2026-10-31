import "server-only";
import type { ReactElement } from "react";
import { EMAIL_FROM, EMAIL_REPLY_TO, getResend } from "./client";

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  /** A React Email component, e.g. <WelcomeEmail name="Ana" /> */
  react: ReactElement;
  /**
   * Required. A stable key for this logical email (e.g. `welcome/${userId}`).
   * Resend drops repeats with the same key for 24h, so retries and double
   * clicks never send twice.
   */
  idempotencyKey: string;
  from?: string;
  replyTo?: string;
  tags?: { name: string; value: string }[];
};

export type SendEmailResult = { ok: true; id: string } | { ok: false; error: string; statusCode: number | null };

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;

function isRetryable(statusCode: number | null): boolean {
  // null = network/unknown failure; 429 = rate limited; 5xx = Resend-side error.
  return statusCode === null || statusCode === 429 || statusCode >= 500;
}

function backoff(attempt: number): Promise<void> {
  const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Send one transactional email with idempotency and retry-with-backoff on
 * network errors, 429s and 5xx responses. Never throws for delivery errors —
 * check `result.ok`.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const resend = getResend();
  let last: { error: string; statusCode: number | null } = { error: "unknown", statusCode: null };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { data, error } = await resend.emails.send(
        {
          from: input.from ?? EMAIL_FROM,
          to: input.to,
          subject: input.subject,
          react: input.react,
          replyTo: input.replyTo ?? EMAIL_REPLY_TO,
          tags: input.tags,
        },
        { idempotencyKey: input.idempotencyKey },
      );

      if (data) return { ok: true, id: data.id };

      last = { error: error?.message ?? "unknown", statusCode: error?.statusCode ?? null };
      if (!isRetryable(last.statusCode)) break;
    } catch (err) {
      last = { error: err instanceof Error ? err.message : String(err), statusCode: null };
    }

    if (attempt < MAX_ATTEMPTS) await backoff(attempt);
  }

  console.error("[email] send failed", { subject: input.subject, ...last });
  return { ok: false, ...last };
}
