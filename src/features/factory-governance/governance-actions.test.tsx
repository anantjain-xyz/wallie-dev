// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { ApproveGrant, CreateServicePrincipal, RevokeGrant } from "./governance-actions";
import { GovernanceEventSubscriptions } from "./governance-event-subscriptions";
import { GrantMachineTokens } from "./governance-machine-tokens";
import { RevokeOAuthAccess } from "./governance-oauth-actions";

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const id = (suffix: number) => `60900000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const scope = { factoryId: id(1), workspaceId: id(2), workspaceSlug: "example" };
const expiry = "2099-07-01T10:00";
const at = "2026-11-26T00:00:00Z";

function mount(children: React.ReactNode) {
  return render(<OverlayProvider>{children}</OverlayProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
  refresh.mockReset();
});

it("searches beyond the principal display page and submits the exact reviewed permissions", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ grant: { id: id(6) } }));
  vi.stubGlobal("fetch", fetch);
  const { container } = mount(
    <ApproveGrant
      isOperator
      members={[{ id: id(3), label: "Jamie Sample · jamie@example.test" }]}
      policies={[
        {
          id: id(4),
          label: "Revision 3 (current workspace policy)",
          requirements: {
            version: 1,
            maxRepairAttempts: 2,
            maxExecutionMs: 90000,
            maxTotalTokens: 1200,
            maxCostUsd: 0.05,
          },
        },
      ]}
      principals={Array.from({ length: 25 }, (_, index) => ({
        id: id(index + 10),
        label: `Runner (runner-${index + 1})`,
      }))}
      repositories={[
        { id: id(7), label: "example/releases" },
        { id: id(8), label: "example/handbook" },
      ]}
      scope={scope}
      tools={[{ id: `${id(9)}/lookup`, label: "Docs · v4 · lookup" }]}
    />,
  );

  async function choose(label: string, name: string | RegExp) {
    fireEvent.click(screen.getByRole("combobox", { name: label }));
    fireEvent.click(await screen.findByRole("option", { name }));
  }
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter service principal options" }), {
    target: { value: "runner-25" },
  });
  await choose("Service principal", "Runner (runner-25)");
  await choose("Writable repository", "example/releases");
  await choose("Execution policy", /Revision 3/);
  await choose("Budget payer", "Jamie Sample · jamie@example.test");
  fireEvent.click(screen.getByText("Read-only repositories · None"));
  expect(screen.getByRole("checkbox", { name: "example/releases" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "example/handbook" }));
  fireEvent.click(screen.getByText("Allowed tool operations · None"));
  fireEvent.click(screen.getByRole("checkbox", { name: "Docs · v4 · lookup" }));
  fireEvent.click(screen.getByText("Machine command scopes · None"));
  fireEvent.click(screen.getByRole("checkbox", { name: "Read sessions" }));
  fireEvent.change(screen.getByLabelText("Expires at"), { target: { value: expiry } });

  const review = within(
    screen.getByRole("heading", { name: "Review grant permissions" }).parentElement!,
  );
  expect(review.getByText("Runner (runner-25)")).toBeVisible();
  expect(review.getByText("example/releases")).toBeVisible();
  expect(review.getByText("example/handbook")).toBeVisible();
  expect(review.getByText("Docs · v4 · lookup")).toBeVisible();
  expect(review.getByText("Read sessions")).toBeVisible();
  expect(review.getByText("Jamie Sample · jamie@example.test")).toBeVisible();
  expect(
    review.getByText("Repairs: 2 · Time: 90 s · Tokens: 1200 · Spend: $0.05 USD"),
  ).toBeVisible();
  expect(review.getByText(/2099/)).toBeVisible();
  expect(screen.getByText("Read-only repositories · 1 selected")).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();

  fireEvent.submit(container.querySelector("form")!);
  await waitFor(() => expect(push).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    action: "approve",
    servicePrincipalId: id(34),
    writableRepositoryId: id(7),
    readContextRepositoryIds: [id(8)],
    toolIds: [`${id(9)}/lookup`],
    commandScopes: ["sessions:read"],
    executionPolicyRevisionId: id(4),
    budgetPayerMemberId: id(3),
    expiresAt: new Date(expiry).toISOString(),
  });
});

it("suggests an editable machine identifier and reports identifier collisions", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({}, { status: 409 })),
  );
  mount(<CreateServicePrincipal factoryName="Release factory" scope={scope} />);
  const trigger = screen.getByRole("button", { name: "New service principal" });
  expect(screen.queryByRole("textbox", { name: "Principal name" })).not.toBeInTheDocument();
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "New service principal" });
  expect(dialog).toHaveAccessibleDescription(
    /Release factory.*does not grant access or issue credentials/,
  );
  const principalName = within(dialog).getByRole("textbox", { name: "Principal name" });
  await waitFor(() => expect(principalName).toHaveFocus());
  fireEvent.change(screen.getByRole("textbox", { name: "Principal name" }), {
    target: { value: "Rélease runner" },
  });
  const identifier = screen.getByRole("textbox", { name: "Identifier" });
  expect(identifier).toHaveValue("release-runner");
  fireEvent.change(identifier, { target: { value: "release-candidate" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Principal name" }), {
    target: { value: "Candidate runner" },
  });
  expect(identifier).toHaveValue("release-candidate");
  await user.click(screen.getByRole("button", { name: "Create service principal" }));
  expect(
    await screen.findByText("This identifier is already in use. Choose a different one."),
  ).toBeVisible();
  expect(principalName).toHaveValue("Candidate runner");
  expect(identifier).toHaveValue("release-candidate");
  expect(push).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("textbox", { name: "Identifier" })).toHaveValue(
    "release-candidate",
  );
});

it.each([true, false])(
  "names a grant, warns only for its exact published pin (%s), and never retries a conflict",
  async (pinned) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { error: "This execution grant changed or was revoked. Reload before trying again." },
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    mount(
      <RevokeGrant
        dependencies={["Machine token: Release job"]}
        dependencyLookup="checked"
        grantId={id(6)}
        pinned={pinned}
        scope={scope}
        target="Release runner · example/releases"
        version={3}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Revoke grant" }));
    const dialog = within(screen.getByRole("alertdialog"));
    expect(dialog.getByText(/revokes v3 for Release runner · example\/releases/)).toBeVisible();
    expect(dialog.getByText(/Machine token: Release job/)).toBeVisible();
    expect(dialog.getByText(/only includes credential bindings loaded on this page/)).toBeVisible();
    expect(Boolean(dialog.queryByText(/published definition uses this version/))).toBe(pinned);
    await userEvent.type(
      dialog.getByRole("textbox", { name: "Reason (optional)" }),
      "Rotate authority",
    );
    const confirm = dialog.getByRole("button", { name: "Revoke grant" });
    await userEvent.click(confirm);
    expect(await dialog.findByRole("button", { name: "Reload and review" })).toBeVisible();
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      action: "revoke",
      grantId: id(6),
      expectedVersion: 3,
      reason: "Rotate authority",
    });
  },
);

it.each(["checked", "failed"] as const)(
  "describes an empty partial dependency preview distinctly for a %s lookup",
  (dependencyLookup) => {
    mount(
      <RevokeGrant
        dependencies={[]}
        dependencyLookup={dependencyLookup}
        grantId={id(6)}
        pinned={false}
        scope={scope}
        target="Release runner"
        version={3}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke grant" }));
    const dialog = within(screen.getByRole("alertdialog"));
    expect(dialog.getByText(/This preview is partial/)).toBeVisible();
    expect(Boolean(dialog.queryByText(/No dependencies found in this preview/))).toBe(
      dependencyLookup === "checked",
    );
    expect(Boolean(dialog.queryByText(/Couldn’t load some machine token or OAuth/))).toBe(
      dependencyLookup === "failed",
    );
  },
);

type SubscriptionSettings = React.ComponentProps<typeof GovernanceEventSubscriptions>["data"];

it("keeps the selected authorization visible and submits its exact ID after filtering", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ signingSecret: "synthetic-signing-fixture" }),
  );
  vi.stubGlobal("fetch", fetch);
  const { container } = mount(
    <GovernanceEventSubscriptions
      data={{
        authorizations: Array.from({ length: 9 }, (_, index) => ({
          credential_id: id(20 + index),
          credential_kind: "machine_token" as const,
          credential_name: `Credential ${index + 1}`,
          service_principal_id: id(6),
          scopeLabel: "Release runner · example/releases · Grant v3",
        })),
        subscriptions: [],
      }}
      endpoint="/mock-subscriptions"
    />,
  );
  const authorization = screen.getByRole("combobox", { name: "Authorization" });
  fireEvent.click(authorization);
  fireEvent.click(await screen.findByRole("option", { name: /^Credential 2 ·/ }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter authorization options" }), {
    target: { value: "Credential 9" },
  });
  expect(authorization).toHaveTextContent("Credential 2 · Machine token");
  fireEvent.click(authorization);
  expect(screen.getByRole("option", { name: /^Credential 2 ·/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("option", { name: /^Credential 9 ·/ })).toBeVisible();
  expect(screen.queryByRole("option", { name: /^Credential 1 ·/ })).not.toBeInTheDocument();
  fireEvent.keyDown(authorization, { key: "Escape" });
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Release receiver" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "HTTPS endpoint" }), {
    target: { value: "https://receiver.example.test" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Review approved" }));
  fireEvent.submit(container.querySelector("form")!);
  await screen.findByRole("region", { name: "Signing secret" });
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    action: "create",
    name: "Release receiver",
    destination: "https://receiver.example.test",
    credentialKind: "machine_token",
    credentialId: id(21),
    eventTypes: ["review.approved"],
  });
  expect(authorization).toHaveTextContent("Choose an authorization");
});

function subscriptions(authorized: boolean): SubscriptionSettings {
  return {
    authorizations: [],
    subscriptions: [
      {
        authorized,
        id: id(10),
        name: "Release receiver",
        endpoint_url: "https://receiver.example.test",
        credential_kind: "machine_token",
        credential_id: id(11),
        credentialLabel: "Release job",
        status: "active",
        event_types: ["review.approved"],
      },
    ],
  };
}

function delivery(status: "unknown" | "failed", hasUnknown: boolean) {
  return {
    nextCursor: null,
    deliveries: [
      {
        id: id(12),
        event_id: id(13),
        event_type: "review.approved",
        status,
        has_unknown_outcome: hasUnknown,
        retryable: true,
        attempt_count: 2,
        created_at: at,
        last_http_status: 503,
        next_attempt_at: null,
      },
    ],
  };
}

it.each([
  ["unknown", false],
  ["failed", true],
] as const)(
  "requires receiver review before queueing a %s attempt with possible delivery",
  async (status, hasUnknown) => {
    const fetch = vi.fn(async (_input: RequestInfo, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ queued: true })
        : Response.json(delivery(status, hasUnknown)),
    );
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    mount(
      <GovernanceEventSubscriptions data={subscriptions(true)} endpoint="/mock-subscriptions" />,
    );
    await user.click(screen.getByRole("button", { name: /Inspect deliveries/ }));
    expect(await screen.findByText(/receiver may already have applied/)).toBeVisible();
    const review = screen.getByRole("button", { name: /Review replay/ });
    await user.click(review);
    const dialog = within(screen.getByRole("alertdialog"));
    expect(dialog.getByText(/Check its logs using the event ID/)).toBeVisible();
    expect(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(dialog.getByRole("button", { name: "Copy event ID" }));
    expect(copy).toHaveBeenCalledWith(id(13));
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(review).toHaveFocus());
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await user.click(review);
    await user.click(screen.getByRole("button", { name: "Replay delivery" }));
    await screen.findByText("Delivery queued.");
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({
      action: "retry",
      deliveryId: id(12),
    });
  },
);

it("keeps a known failed retry direct and hides retries if the backing authority is unavailable", async () => {
  const fetch = vi.fn(async (_input: RequestInfo, init?: RequestInit) =>
    init?.method === "POST"
      ? Response.json({ queued: true })
      : Response.json(delivery("failed", false)),
  );
  vi.stubGlobal("fetch", fetch);
  const { rerender } = mount(
    <GovernanceEventSubscriptions data={subscriptions(true)} endpoint="/mock-subscriptions" />,
  );
  await userEvent.click(screen.getByRole("button", { name: /Inspect deliveries/ }));
  await userEvent.click(await screen.findByRole("button", { name: /Retry delivery/ }));
  await screen.findByText("Delivery queued.");
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  rerender(
    <OverlayProvider>
      <GovernanceEventSubscriptions data={subscriptions(false)} endpoint="/mock-subscriptions" />
    </OverlayProvider>,
  );
  expect(screen.getByText(/Backing authorization: Release job · Machine token/)).toBeVisible();
  expect(
    screen.getByText(/create a replacement subscription, and verify its endpoint/),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Retry delivery|Review replay/ }),
  ).not.toBeInTheDocument();
});

it("describes OAuth registration revocation as workspace-wide and names affected factories", async () => {
  mount(
    <RevokeOAuthAccess
      command={{ action: "revoke-client", clientId: id(5) }}
      factories={["Release", "Operations"]}
      name="Deployment viewer"
      workspaceId={scope.workspaceId}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Revoke client" }));
  const dialog = within(screen.getByRole("alertdialog"));
  expect(dialog.getByText(/workspace registration and all its connections/)).toBeVisible();
  expect(dialog.getByText("Affected factories: Release, Operations.")).toBeVisible();
});

it("moves keyboard focus to a new one-time machine token and restores it after dismissal", async () => {
  const fixture = "synthetic-token-not-a-credential";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ credential: fixture })),
  );
  mount(
    <GrantMachineTokens
      asOf={Date.parse(at)}
      factoryActive
      factoryId={scope.factoryId}
      grant={{
        id: id(6),
        version: 3,
        command_scopes: ["sessions:read"],
        expires_at: "2099-07-01T10:00:00Z",
        revoked_at: null,
      }}
      tokens={[]}
      workspaceId={scope.workspaceId}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Token name" }), {
    target: { value: "Release job" },
  });
  await userEvent.click(screen.getByRole("checkbox", { name: "Read sessions" }));
  await userEvent.click(screen.getByRole("button", { name: "Create machine token" }));
  expect(await screen.findByRole("button", { name: "Copy token" })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByRole("textbox", { name: "Token name" })).toHaveFocus();
  expect(screen.queryByText(fixture)).not.toBeInTheDocument();
});
