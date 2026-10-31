import "server-only";
import WelcomeEmail from "@/emails/welcome";
import PasswordResetEmail from "@/emails/password-reset";
import { sendEmail } from "./send";

export { sendEmail } from "./send";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://editums.com";

/** Send once per user — the idempotency key makes repeat calls a no-op. */
export function sendWelcomeEmail(user: { id: string; email: string; name: string }) {
  return sendEmail({
    to: user.email,
    subject: "Welcome to Editums",
    react: <WelcomeEmail name={user.name} dashboardUrl={`${APP_URL}/dashboard`} />,
    idempotencyKey: `welcome/${user.id}`,
    tags: [{ name: "category", value: "welcome" }],
  });
}

/** `requestId` should be unique per reset request (e.g. the reset token's DB id). */
export function sendPasswordResetEmail(
  user: { email: string; name: string },
  reset: { requestId: string; token: string; expiresInMinutes?: number },
) {
  const expiresInMinutes = reset.expiresInMinutes ?? 30;
  return sendEmail({
    to: user.email,
    subject: "Reset your Editums password",
    react: (
      <PasswordResetEmail
        name={user.name}
        resetUrl={`${APP_URL}/reset-password?token=${encodeURIComponent(reset.token)}`}
        expiresInMinutes={expiresInMinutes}
      />
    ),
    idempotencyKey: `password-reset/${reset.requestId}`,
    tags: [{ name: "category", value: "password_reset" }],
  });
}
