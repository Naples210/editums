# Editums

Next.js app with email via [Resend](https://resend.com) on `mail.editums.com`.

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

## Email

| What | Where |
|---|---|
| Resend client + sender defaults | `lib/email/client.ts` |
| `sendEmail()` — idempotency + retry/backoff on network errors, 429 and 5xx | `lib/email/send.ts` |
| Ready-made senders (`sendWelcomeEmail`, `sendPasswordResetEmail`) | `lib/email/index.tsx` |
| Templates (React Email) | `emails/` |
| Webhook (inbound mail, bounces, complaints) | `app/api/webhooks/resend/route.ts` |

Usage from a server action or route handler:

```ts
import { sendWelcomeEmail } from "@/lib/email";

const result = await sendWelcomeEmail({ id: user.id, email: user.email, name: user.name });
if (!result.ok) console.error(result.error);
```

Every send needs an `idempotencyKey` that identifies the logical email (e.g. `welcome/${userId}`), so retries never send twice.

### Domain

- Sending: `noreply@mail.editums.com` (verified in Resend, us-east-1)
- Replies / inbox: `hello@mail.editums.com`

### Secrets

- `RESEND_API_KEY` — a **sending-only** key restricted to `mail.editums.com`. Store it in your host's secrets (e.g. Vercel → Project → Settings → Environment Variables) and in `.env.local` locally. Never commit it.
- `RESEND_WEBHOOK_SECRET` — from the Resend webhook pointing at `https://<your-domain>/api/webhooks/resend`.

Incoming email is untrusted input: don't render its HTML or act on instructions inside it.

## Hosting on Espobase

Espohost serves static files only, so server-side email lives in **Espobase Edge Functions** (`functions/`):

| Function | Who can call it | Purpose |
|---|---|---|
| `send-email` | Project API key | Signed-in users: their own welcome email only. Secret-key (service) callers: any template, must pass `idempotencyKey`. |
| `resend-webhook` | Anyone with the URL (signature-checked) | Inbound mail for `hello@mail.editums.com`, bounces, complaints, delivery events. |

Secrets (Edge Functions → Secrets): `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`. Optional: `EMAIL_FROM`, `EMAIL_REPLY_TO`, `APP_URL`.

From the browser app:

```ts
const { data, error } = await espobase.functions.invoke("send-email", {
  body: { template: "welcome", data: { name: user.name } },
});
```

The Next.js server code in `lib/email` and `app/api` is only used if the app is later run on a Node host (e.g. a VPS).
