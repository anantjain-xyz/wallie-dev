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
      <PageHeader className="mb-4 sm:mb-5" title="Start authorization again" />
      <div className="ui-sheet space-y-4 p-4 sm:p-5">
        <p className="type-body text-foreground">
          {signedOut && !resumePath
            ? "After signing in, return to the app that requested access and connect again."
            : "Return to the app that requested access and connect again."}
        </p>
        {resumePath ? (
          <form action="/auth/signout" method="post" className="space-y-2">
            <input type="hidden" name="next" value={resumePath} />
            <input type="hidden" name="switchAccount" value="1" />
            <p className="type-secondary text-muted">
              If you’re using the wrong Wallie account, switch accounts to retry this request.
            </p>
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
