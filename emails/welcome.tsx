import { Button, Text } from "@react-email/components";
import { EmailLayout, buttonStyle, textStyle } from "./components/layout";

export type WelcomeEmailProps = { name: string; dashboardUrl: string };

export default function WelcomeEmail({ name, dashboardUrl }: WelcomeEmailProps) {
  return (
    <EmailLayout preview={`Welcome to Editums, ${name}`}>
      <Text style={textStyle}>Hi {name},</Text>
      <Text style={textStyle}>Welcome to Editums — your account is ready.</Text>
      <Button href={dashboardUrl} style={buttonStyle}>
        Open Editums
      </Button>
    </EmailLayout>
  );
}

WelcomeEmail.PreviewProps = { name: "Ana", dashboardUrl: "https://editums.com/dashboard" } satisfies WelcomeEmailProps;
