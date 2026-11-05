import { createFileRoute } from "@tanstack/react-router";
import { MailApp } from "@/components/mail/mail-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <MailApp />;
}
