import type { Metadata } from "next";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";

export const metadata: Metadata = {
  title: "Get help",
  robots: { index: false, follow: false },
};

export default function RecoveryPage() {
  return (
    <main id="main-content" tabIndex={-1}>
      <PageContainer className="max-w-xl">
        <PageHeader title="Get help with Wallie" />
        <div className="ui-sheet space-y-4 p-4 sm:p-5">
          <p className="type-body text-foreground">
            If you followed a workspace link, check that you’re using the account that was invited.
            Ask the person who shared the link for an invitation or an updated link.
          </p>
          <p className="type-body text-muted">
            If a page still won’t load after retrying, share the link with your workspace
            administrator.
          </p>
          <form action="/auth/signout" method="post">
            <button type="submit" className="ui-button">
              Use a different account
            </button>
          </form>
        </div>
      </PageContainer>
    </main>
  );
}
