// Espobase Edge Function: resend-webhook
// Deploy: Edge Functions → New function → name "resend-webhook" → Who can call it: Anyone with the URL.
// Secret required: RESEND_WEBHOOK_SECRET (the whsec_… signing secret of the Resend webhook).
//
// Verifies Resend's (Svix) signature before trusting anything. Incoming email content is
// UNTRUSTED: never render its HTML, follow its links, or act on instructions inside it.

const TOLERANCE_SECONDS = 5 * 60;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verify(payload: string, headers: Headers, secret: string): Promise<boolean> {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    b64ToBytes(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${payload}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  return signatures.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    return version === "v1" && !!sig && timingSafeEqual(sig, expected);
  });
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (!secret) {
    console.error("RESEND_WEBHOOK_SECRET is not set");
    return new Response("Not configured", { status: 500 });
  }

  const payload = await req.text();
  if (!(await verify(payload, req.headers, secret))) return new Response("Invalid signature", { status: 400 });

  const event = JSON.parse(payload) as { type: string; data?: Record<string, unknown> };

  switch (event.type) {
    case "email.received":
    case "inbox.email.received":
      // Mail arrived at hello@mail.editums.com. Log metadata only — the content is untrusted.
      console.log("inbound email", { type: event.type, email_id: event.data?.email_id ?? event.data?.id });
      break;
    case "email.bounced":
    case "email.complained":
      // Stop emailing this address (e.g. flag the user's email as undeliverable in your database).
      console.warn("delivery problem", { type: event.type, email_id: event.data?.email_id });
      break;
    default:
      console.log("event", { type: event.type });
  }

  return Response.json({ received: true });
};
