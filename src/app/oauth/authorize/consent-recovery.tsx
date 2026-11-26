import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { loginPath } from "@/lib/routes";

export function ConsentRecovery({
  resumePath,
  signedOut = false,
}: {
  resumePath?: string;
  signedOut?: boolean;
}) {
  return (
    <PageContainer className="max-w-xl">
      <PageHeader title="Authorize client" />
      <div className="ui-sheet space-y-4 p-4 sm:p-5">
        <p className="type-body text-foreground">
          {signedOut ? "Your Wallie sign-in ended." : "This authorization request is unavailable."}
        </p>
        <p className="type-secondary text-muted">
          {resumePath
            ? "Check that you’re using the right Wallie account. To start over, return to the app that requested access and connect again."
            : "Return to the app that requested access and connect again."}
        </p>
        {resumePath ? (
          <form action="/auth/signout" method="post">
            <input type="hidden" name="next" value={resumePath} />
            <input type="hidden" name="switchAccount" value="1" />
            <button className="ui-button min-h-11" type="submit">
              Use a different account
            </button>
          </form>
        ) : signedOut ? (
          <Link className="ui-button min-h-11" href={loginPath()}>
            Sign in to Wallie
          </Link>
        ) : null}
      </div>
    </PageContainer>
  );
}
