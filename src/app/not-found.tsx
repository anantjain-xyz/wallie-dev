import type { Metadata } from "next";
import { headers } from "next/headers";

import { PageFailure } from "@/components/ui/page-failure";
import { WORKSPACE_RETURN_HEADER, workspaceReturnPath } from "@/lib/workspace-return-path";

export const metadata: Metadata = {
  title: { absolute: "Page unavailable | Wallie" },
};

export default async function NotFoundPage() {
  const next = workspaceReturnPath((await headers()).get(WORKSPACE_RETURN_HEADER));
  return (
    <main id="main-content" tabIndex={-1}>
      {next ? (
        <PageFailure
          notFound
          description="Check which account you’re signed in with, or ask the person who shared the link for an invitation or an updated link."
          returnHref="/recovery"
          returnLabel="Get help"
          actions={
            <form action="/auth/signout" method="post">
              <input type="hidden" name="next" value={next} />
              <input type="hidden" name="switchAccount" value="1" />
              <button type="submit" className="ui-button">
                Use a different account
              </button>
            </form>
          }
        />
      ) : (
        <PageFailure notFound />
      )}
    </main>
  );
}
