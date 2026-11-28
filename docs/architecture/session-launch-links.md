# Workspace session launcher links

Link to `/w/<workspace-slug>/sessions?factory=<factory-id>&create=1` to open the shared
New session composer. The shell only opens it for the workspace's visible, active default
factory, and existing onboarding rules still apply. The factory ID is a URL value, not a
name to display; name the target factory on a link that takes people out of their current scope.

Call `sessionLaunchHref(workspaceSlug, factoryId, returnTo)` from
`src/components/app-shell/shell-navigation.ts` to add an optional cancel destination. Pass the
origin's workspace-relative pathname, query, and anchor, for example
`/w/acme/runs?status=error&factory=all#main-content`. Cancel accepts only an app-relative URL within
the same workspace, strips nested launch parameters, and otherwise falls back to Sessions.
The return target does not grant access to the page or factory it names.

Existing `?create=1` deep links still open on the same page when in the creation scope.
Canceling a direct Sessions link keeps its non-launch filters. The shared shell launcher
restores focus and uses browser history to return to its own recorded origin when possible.
Starting a session still follows the creation flow, not the cancel destination.

For a workflow-specific handoff, pass the eligible publication's activation ID as the fourth
argument to `sessionLaunchHref`. The `workflowActivation` URL value is an untrusted hint.
The composer checks that exact activation against current intake options in the named default
factory and requires its default repository. A missing, malformed, or superseded requested
activation blocks submission rather than falling back to the default pipeline. Links without
the parameter retain the normal composer and workflow picker.
