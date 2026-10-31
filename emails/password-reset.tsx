import { Button, Text } from "@react-email/components";
import { EmailLayout, buttonStyle, textStyle } from "./components/layout";

export type PasswordResetEmailProps = { name: string; resetUrl: string; expiresInMinutes: number };

export default function PasswordResetEmail({ name, resetUrl, expiresInMinutes }: PasswordResetEmailProps) {
  return (
    <EmailLayout preview="Reset your Editums password">
      <Text style={textStyle}>Hi {name},</Text>
      <Text style={textStyle}>
        We got a request to reset your Editums password. This link expires in {expiresInMinutes} minutes.
      </Text>
      <Button href={resetUrl} style={buttonStyle}>
        Reset password
      </Button>
      <Text style={{ ...textStyle, marginTop: 24, fontSize: 13, color: "#666" }}>
        If you didn&apos;t ask for this, you can ignore this email — your password won&apos;t change.
      </Text>
    </EmailLayout>
  );
}

PasswordResetEmail.PreviewProps = {
  name: "Ana",
  resetUrl: "https://editums.com/reset?token=example",
  expiresInMinutes: 30,
} satisfies PasswordResetEmailProps;
