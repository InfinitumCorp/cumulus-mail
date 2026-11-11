import { createFileRoute } from "@tanstack/react-router";
import { MailApp } from "@/components/mail/mail-app";
import { SignInGate, SignInScreen } from "@/lib/auth/gates";

export const Route = createFileRoute("/")({ component: Home });

/** Signed out: Cumulus ID sign-in. With auth off the dev user passes straight through. */
function Home() {
  return (
    <SignInGate fallback={<SignInScreen title="Cumulus://Mail" />}>
      <MailApp />
    </SignInGate>
  );
}
