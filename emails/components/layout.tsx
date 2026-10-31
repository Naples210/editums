import { Body, Container, Head, Hr, Html, Preview, Section, Text } from "@react-email/components";
import type { ReactNode } from "react";

export function EmailLayout({ preview, children }: { preview: string; children: ReactNode }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: "#f6f6f4", fontFamily: "-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif", margin: 0, padding: "32px 0" }}>
        <Container style={{ backgroundColor: "#ffffff", borderRadius: 12, maxWidth: 520, padding: "32px 36px" }}>
          <Text style={{ fontSize: 20, fontWeight: 700, margin: "0 0 24px", color: "#111" }}>Editums</Text>
          <Section>{children}</Section>
          <Hr style={{ borderColor: "#eee", margin: "32px 0 16px" }} />
          <Text style={{ fontSize: 12, color: "#888", margin: 0 }}>
            You&apos;re receiving this because you have an Editums account. Questions? Just reply to this email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export const textStyle = { fontSize: 15, lineHeight: "24px", color: "#333", margin: "0 0 16px" } as const;
export const buttonStyle = {
  backgroundColor: "#111",
  borderRadius: 8,
  color: "#fff",
  fontSize: 15,
  fontWeight: 600,
  padding: "12px 20px",
  textDecoration: "none",
  display: "inline-block",
} as const;
