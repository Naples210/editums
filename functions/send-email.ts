// Espobase Edge Function: send-email
// Deploy: Edge Functions → New function → name "send-email" → Who can call it: project API key (default).
// Secret required: RESEND_API_KEY (sending-only key for mail.editums.com).
//
// Callers:
//  • A signed-in user (espobase.functions.invoke("send-email", { body: { template: "welcome", name } }))
//    can only send the welcome email, only to their own verified address, at most once.
//  • A trusted server using the secret key (x-espobase-auth: service) can send any template
//    to any address, and must pass its own idempotencyKey.

// Espobase only grants access to secrets that exist; reading any other name throws.
const env = (name: string): string | undefined => {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
};

const FROM = env("EMAIL_FROM") ?? "Editums <noreply@mail.editums.com>";
const REPLY_TO = env("EMAIL_REPLY_TO") ?? "hello@mail.editums.com";
const APP_URL = env("APP_URL") ?? "https://editums.espohost.com";

type Rendered = { subject: string; html: string; text: string; tag: string };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(preview: string, body: string): string {
  return `<!doctype html><html lang="en"><body style="margin:0;padding:32px 0;background:#f6f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden">${esc(preview)}</span>
<table role="presentation" width="100%"><tr><td align="center">
<table role="presentation" style="max-width:520px;width:100%;background:#fff;border-radius:12px;padding:32px 36px">
<tr><td><p style="font-size:20px;font-weight:700;margin:0 0 24px;color:#111">Editums</p>${body}
<hr style="border:none;border-top:1px solid #eee;margin:32px 0 16px">
<p style="font-size:12px;color:#888;margin:0">You&#39;re receiving this because you have an Editums account. Questions? Just reply to this email.</p>
</td></tr></table></td></tr></table></body></html>`;
}

const p = (t: string) => `<p style="font-size:15px;line-height:24px;color:#333;margin:0 0 16px">${t}</p>`;
const button = (href: string, label: string) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#111;color:#fff;border-radius:8px;padding:12px 20px;font-size:15px;font-weight:600;text-decoration:none">${esc(label)}</a>`;

function render(template: string, data: Record<string, unknown>): Rendered | null {
  const name = String(data.name ?? "there").slice(0, 80);
  switch (template) {
    case "welcome": {
      const url = `${APP_URL}/dashboard`;
      return {
        subject: "Welcome to Editums",
        tag: "welcome",
        html: layout(`Welcome to Editums, ${name}`, p(`Hi ${esc(name)},`) + p("Welcome to Editums — your account is ready.") + button(url, "Open Editums")),
        text: `Hi ${name},\n\nWelcome to Editums — your account is ready.\n\nOpen Editums: ${url}\n`,
      };
    }
    case "password-reset": {
      const resetUrl = String(data.resetUrl ?? "");
      const minutes = Number(data.expiresInMinutes ?? 30);
      if (!resetUrl.startsWith("https://")) return null;
      return {
        subject: "Reset your Editums password",
        tag: "password_reset",
        html: layout(
          "Reset your Editums password",
          p(`Hi ${esc(name)},`) +
            p(`We got a request to reset your Editums password. This link expires in ${minutes} minutes.`) +
            button(resetUrl, "Reset password") +
            `<p style="font-size:13px;line-height:20px;color:#666;margin:24px 0 0">If you didn&#39;t ask for this, you can ignore this email — your password won&#39;t change.</p>`,
        ),
        text: `Hi ${name},\n\nWe got a request to reset your Editums password. This link expires in ${minutes} minutes.\n\nReset password: ${resetUrl}\n\nIf you didn't ask for this, you can ignore this email.\n`,
      };
    }
    default:
      return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST to Resend with an idempotency key; retry network errors, 429 and 5xx (fits the 10 s limit). */
async function sendViaResend(payload: Record<string, unknown>, idempotencyKey: string) {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY secret is not set");

  let last = "unknown error";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true as const, id: body.id as string };
      last = `${res.status} ${body.message ?? ""}`.trim();
      if (res.status !== 429 && res.status < 500) return { ok: false as const, status: res.status, error: last };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (attempt < 3) await sleep(400 * 2 ** (attempt - 1) + Math.random() * 200);
  }
  return { ok: false as const, status: 502, error: last };
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const auth = req.headers.get("x-espobase-auth");
  const body = await req.json().catch(() => null);
  if (!body || typeof body.template !== "string") return Response.json({ error: "template is required" }, { status: 400 });

  let to: string;
  let idempotencyKey: string;

  if (auth === "service") {
    if (typeof body.to !== "string" || typeof body.idempotencyKey !== "string") {
      return Response.json({ error: "to and idempotencyKey are required" }, { status: 400 });
    }
    to = body.to;
    idempotencyKey = body.idempotencyKey;
  } else if (auth === "authenticated") {
    // Users may only trigger their own welcome email.
    if (body.template !== "welcome") return Response.json({ error: "not allowed" }, { status: 403 });
    const email = req.headers.get("x-espobase-user-email");
    const userId = req.headers.get("x-espobase-user-id");
    if (!email || !userId) return Response.json({ error: "no user email" }, { status: 400 });
    to = email;
    idempotencyKey = `welcome/${userId}`;
  } else {
    return new Response("Sign in first", { status: 401 });
  }

  const rendered = render(body.template, body.data ?? {});
  if (!rendered) return Response.json({ error: "unknown template or bad data" }, { status: 400 });

  const result = await sendViaResend(
    {
      from: FROM,
      to: [to],
      reply_to: REPLY_TO,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: [{ name: "category", value: rendered.tag }],
    },
    idempotencyKey,
  );

  if (!result.ok) {
    console.error("send failed", { template: body.template, status: result.status, error: result.error });
    return Response.json({ error: "send failed" }, { status: result.status });
  }
  console.log("sent", { template: body.template, id: result.id });
  return Response.json({ id: result.id });
};
