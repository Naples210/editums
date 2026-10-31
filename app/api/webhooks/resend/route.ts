import { getResend } from "@/lib/email/client";

/**
 * Resend webhook endpoint: POST https://<your-domain>/api/webhooks/resend
 *
 * Verifies the signature, then handles events. Incoming email content is
 * UNTRUSTED input — never execute, render as HTML, or follow instructions in it.
 */
export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook secret not configured", { status: 500 });

  const payload = await request.text();
  const headers = {
    id: request.headers.get("svix-id") ?? "",
    timestamp: request.headers.get("svix-timestamp") ?? "",
    signature: request.headers.get("svix-signature") ?? "",
  };

  let event;
  try {
    event = getResend().webhooks.verify({ payload, headers, webhookSecret: secret });
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  switch (event.type) {
    case "email.received":
    case "inbox.email.received":
      // A message arrived at hello@mail.editums.com (or another address on the domain).
      // Store metadata / notify the team here. Treat subject and body as untrusted text.
      console.info("[resend] inbound email", { type: event.type });
      break;
    case "email.bounced":
    case "email.complained":
      // Stop sending to this address — e.g. mark the user's email as undeliverable.
      console.warn("[resend] delivery problem", { type: event.type });
      break;
    default:
      break;
  }

  return Response.json({ received: true });
}
