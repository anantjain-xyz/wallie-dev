import type { Metadata } from "next";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";

export const metadata: Metadata = {
  title: "Get help",
  robots: { index: false, follow: false },
};

export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ signOut?: string | string[] }>;
}) {
  const failedSignOut = (await searchParams).signOut === "failed";
  return (
    <main id="main-content" tabIndex={-1}>
      <PageContainer className="max-w-xl">
        <PageHeader
          className="mb-4 sm:mb-5"
          title={failedSignOut ? "Wallie couldn’t sign you out" : "Get help with a Wallie link"}
        />
        <div className="ui-sheet space-y-4 p-4 sm:p-5">
          {failedSignOut ? (
            <p className="type-body text-foreground" role="alert">
              You may still be signed in. Sign out before reopening the link or restarting
              authorization in the app that requested access.
            </p>
          ) : (
            <p className="type-body text-foreground">
              If you’re using the wrong account, sign out and sign in with the email address that
              received the invitation.
            </p>
          )}
          <form action="/auth/signout" method="post">
            <input type="hidden" name="switchAccount" value="1" />
            <button type="submit" className="ui-button min-h-11">
              {failedSignOut ? "Try signing out again" : "Use a different account"}
            </button>
          </form>
          {!failedSignOut ? (
            <p className="type-secondary text-muted">
              Ask the person who shared the link for an invitation or a new link. If it still
              doesn’t open, share it with your workspace admin.
            </p>
          ) : null}
        </div>
      </PageContainer>
    </main>
  );
}
