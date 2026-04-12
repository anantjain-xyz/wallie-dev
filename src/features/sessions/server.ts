import "server-only";

import { loadIssueWorkspaceContext } from "@/features/issues/server";

// Session routes share the same workspace membership / member indexing
// logic as the current issues routes. This indirection keeps session
// feature code from importing the legacy feature slug directly, so the
// post-PR-4 cleanup only has to move the loader, not rewrite every call site.
export const loadSessionWorkspaceContext = loadIssueWorkspaceContext;
