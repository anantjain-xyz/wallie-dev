// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verificationCheck, verificationData } from "@/features/onboarding/fixtures";
import { WORKSPACE_ONBOARDING_STEPS } from "@/lib/onboarding/contracts";
import { OnboardingPageClient } from "@/features/onboarding/onboarding-page-client";
import VerifyStep from "@/features/onboarding/steps/verify-step";
import type { OnboardingStepProps } from "@/features/onboarding/steps/types";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/features/onboarding/steps/active-step", () => ({
  ActiveOnboardingStep: (props: OnboardingStepProps & { step: string }) =>
    props.step === "verify" ? <VerifyStep {...props} /> : <p>Editing {props.step}</p>,
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function verifyPanel() {
  return within(screen.getByRole("region", { name: "Verify setup" }));
}

function verificationButton(name: string) {
  return verifyPanel().getByRole("button", { name });
}

function desktopSteps() {
  return within(screen.getByRole("complementary"));
}

function allChecks() {
  return screen.getByText("All checks", { exact: true }).closest("details")!;
}

function diagnosticRow(label: string) {
  return within(allChecks()).getByText(label, { exact: true }).closest("div")!;
}

describe("onboarding verification", () => {
  it("shows recommended agent defaults when provider and model were not explicitly saved", () => {
    const data = verificationData();
    data.agentConfig = { agent_effort: "high" };
    render(<OnboardingPageClient initialData={data} />);
    const agentSummary = diagnosticRow("Runtime completed");
    expect(agentSummary).toHaveTextContent("codex · gpt-5.6-sol");
    expect(agentSummary).not.toHaveTextContent("undefined");
  });

  it.each([false, true])(
    "uses saved Agent configuration after completed setup clears skip history (configured: %s)",
    (configured) => {
      const data = verificationData();
      data.onboarding.status = "completed";
      data.onboarding.completedSteps = [...WORKSPACE_ONBOARDING_STEPS];
      data.onboarding.skippedSteps = [];
      if (!configured) data.agentConfig = {};
      data.setupHealth.agentConfig = {
        configured,
        configuredKeys: configured ? ["agent_provider", "agent_model"] : [],
        status: configured ? "present" : "missing",
        values: data.agentConfig,
      };
      render(<OnboardingPageClient initialData={data} />);
      const agentSummary = diagnosticRow("Runtime completed");
      expect(agentSummary).toHaveTextContent(configured ? "Done" : "Defaults");
      expect(agentSummary).not.toHaveTextContent(configured ? "Defaults" : "Done");
      expect(agentSummary).toHaveTextContent("codex · gpt-5.6-sol");
    },
  );

  it.each([false, true])(
    "uses Linear configuration health after completed setup clears skip history (configured: %s)",
    (configured) => {
      const data = verificationData();
      data.onboarding.status = "completed";
      data.onboarding.completedSteps = [...WORKSPACE_ONBOARDING_STEPS];
      data.onboarding.skippedSteps = [];
      data.setupHealth.linearKey.configured = configured;
      data.setupHealth.linearRouting.configured = configured;
      render(<OnboardingPageClient initialData={data} />);
      const linearSummary = diagnosticRow("Linear (optional)");
      expect(linearSummary).toHaveTextContent(configured ? "Done" : "Not connected");
      expect(linearSummary).not.toHaveTextContent(configured ? "Not connected" : "Done");
    },
  );

  it("keeps saved connections distinct from verification and collapses configuration", () => {
    render(<OnboardingPageClient initialData={verificationData()} />);
    expect(screen.getByText("Verification required")).toBeVisible();
    expect(screen.queryByText("Setup status")).not.toBeInTheDocument();
    expect(allChecks()).not.toHaveAttribute("open");
    expect(verificationButton("Verify setup")).toBeEnabled();
    expect(
      verifyPanel().queryByRole("button", { name: "Create your first task" }),
    ).not.toBeInTheDocument();
    const linearStep = desktopSteps().getByRole("button", { name: /Linear.*optional.*Skipped/ });
    expect(linearStep).not.toHaveTextContent("Completed");
    expect(
      desktopSteps().getByRole("button", { name: "Verify", current: "step" }),
    ).not.toHaveTextContent("Completed");
  });

  it.each(["in_progress", "completed"] as const)(
    "keeps progress history distinct from the selected step during %s setup",
    async (status) => {
      const data = verificationData();
      data.onboarding.status = status;
      if (status === "in_progress") {
        fetchMock.mockResolvedValueOnce(
          Response.json({
            kind: "onboarding-mutation",
            onboarding: { ...data.onboarding, currentStep: "github" },
          }),
        );
      }
      render(<OnboardingPageClient initialData={data} />);
      const name = status === "in_progress" ? /GitHub\s*Completed/ : "GitHub";
      await act(async () => fireEvent.click(desktopSteps().getByRole("button", { name })));

      const selectedStep = desktopSteps().getByRole("button", { name, current: "step" });
      expect(selectedStep).toHaveClass("bg-accent-soft", "text-accent");
      if (status === "in_progress") {
        expect(within(selectedStep).getByText("Completed")).toBeInTheDocument();
      } else {
        expect(selectedStep).not.toHaveTextContent("Completed");
      }
      expect(screen.getByText("Repository · Step 1 of 7")).toBeVisible();
    },
  );

  it("keeps skipped status when selecting an optional step from the mobile disclosure", async () => {
    const data = verificationData();
    data.onboarding.status = "completed";
    render(<OnboardingPageClient initialData={data} />);

    const mobile = screen.getByText("All setup steps", { exact: true }).closest("details")!;
    expect(mobile).not.toHaveAttribute("open");
    mobile.open = true;
    await act(async () => {
      fireEvent.click(within(mobile).getByRole("button", { name: /Linear.*optional.*Skipped/ }));
    });

    const selectedStep = desktopSteps().getByRole("button", {
      name: /Linear.*optional.*Skipped/,
      current: "step",
    });
    expect(selectedStep).toHaveClass("bg-accent-soft", "text-accent");
    expect(selectedStep).not.toHaveTextContent("Completed");
    expect(mobile).not.toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "Connect Linear (optional)" })).toHaveFocus();
  });

  it("submits verification once, polls, and completes into the task composer on first setup", async () => {
    vi.useFakeTimers();
    const data = verificationData();
    let startCheck!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            startCheck = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({ check: verificationCheck() }))
      .mockResolvedValueOnce(
        Response.json({
          kind: "onboarding-mutation",
          onboarding: { ...data.onboarding, status: "completed" },
        }),
      );
    render(<OnboardingPageClient initialData={data} />);

    fireEvent.click(verificationButton("Verify setup"));
    expect(verificationButton("Starting…")).toBeDisabled();
    fireEvent.submit(document.getElementById("onboarding-verification")!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/sandbox-capability-check",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ repositoryId: "repo-a" }) }),
    );
    await act(async () => startCheck(Response.json({ check: verificationCheck("running") })));
    expect(verificationButton("Checking…")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Checking your setup…");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText("Setup is ready")).toBeVisible();
    expect(verificationButton("Create your first task")).toBeEnabled();

    await act(async () => fireEvent.click(verificationButton("Create your first task")));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/workspaces/workspace-1/onboarding/complete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedUpdatedAt: data.onboarding.updatedAt }),
      }),
    );
    expect(router.replace).toHaveBeenCalledWith("/w/northwind?create=1");
  });

  it("keeps the retry action available after verification cannot start", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "Unable to connect to sandbox." }, { status: 500 }),
    );
    render(<OnboardingPageClient initialData={verificationData()} />);
    await act(async () => fireEvent.click(verificationButton("Verify setup")));
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to connect to sandbox.");
    expect(verificationButton("Verify setup")).toBeEnabled();
  });

  it("shows a failed check and retries it without losing the saved configuration", async () => {
    const data = verificationData();
    data.setupHealth.latestSandboxCapabilityCheck = verificationCheck("error");
    fetchMock.mockResolvedValueOnce(Response.json({ check: verificationCheck("running") }));
    render(<OnboardingPageClient initialData={data} />);
    expect(screen.getByRole("status")).toHaveTextContent("Agent sign-in expired.");
    await act(async () => fireEvent.click(verificationButton("Retry verification")));
    expect(verificationButton("Checking…")).toBeDisabled();
    expect(allChecks()).not.toHaveAttribute("open");
  });

  it.each(["agent", "repository", "sandbox"] as const)(
    "does not reuse a successful check from a different %s",
    (scope) => {
      const data = verificationData();
      data.setupHealth.latestSandboxCapabilityCheck = {
        ...verificationCheck(),
        ...(scope === "agent"
          ? { agentModel: "old-model" }
          : scope === "repository"
            ? { githubRepositoryId: "old-repo" }
            : { sandboxVercelProjectId: "old-project" }),
      };
      render(<OnboardingPageClient initialData={data} />);
      expect(screen.getByText("Setup has changed")).toBeVisible();
      expect(allChecks()).not.toHaveAttribute("open");
      expect(within(allChecks()).getByText("Previous verification result")).toBeInTheDocument();
      expect(screen.queryByText("Setup is ready")).not.toBeInTheDocument();
      expect(verificationButton("Verify again")).toBeEnabled();
    },
  );

  it("links missing access to its setup step and prevents verification", async () => {
    const data = verificationData();
    data.setupHealth.codexConnection.connected = false;
    fetchMock.mockResolvedValueOnce(
      Response.json({
        kind: "onboarding-mutation",
        onboarding: { ...data.onboarding, currentStep: "runtime" },
      }),
    );
    render(<OnboardingPageClient initialData={data} />);
    expect(verifyPanel().queryByRole("button", { name: "Verify setup" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connect the current user's Codex credential.",
    );
    await act(async () => fireEvent.click(verificationButton("Fix agent access")));
    expect(screen.getByText("Editing runtime")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/onboarding",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("does not let a read-only member verify or complete setup", () => {
    const data = verificationData();
    data.canManage = false;
    render(<OnboardingPageClient initialData={data} />);
    expect(verifyPanel().queryByRole("button", { name: "Verify setup" })).not.toBeInTheDocument();
    fireEvent.submit(document.getElementById("onboarding-verification")!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByText("Read only. Ask a workspace owner or admin to verify the current setup."),
    ).toBeVisible();
  });

  it.each(["owner", "admin", "member"] as const)(
    "offers a returning %s Sessions rather than opening the task composer",
    (role) => {
      const data = verificationData();
      data.currentMember.role = role;
      data.canManage = role !== "member";
      data.onboarding.status = "completed";
      data.setupHealth.latestSandboxCapabilityCheck = verificationCheck();
      render(<OnboardingPageClient initialData={data} />);
      expect(verifyPanel().getByRole("link", { name: "Back to sessions" })).toHaveAttribute(
        "href",
        "/w/northwind/sessions",
      );
      expect(
        verifyPanel().queryByRole("button", { name: "Create your first task" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Setup is ready")).toBeVisible();
      expect(screen.getByText("Setup was completed previously.")).toBeVisible();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("returns to Sessions after a previously completed workspace finishes setup again", async () => {
    const data = verificationData();
    data.onboarding.completedAt = "2026-09-06T19:15:00.000Z";
    data.setupHealth.latestSandboxCapabilityCheck = verificationCheck();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        kind: "onboarding-mutation",
        onboarding: { ...data.onboarding, status: "completed" },
      }),
    );
    render(<OnboardingPageClient initialData={data} />);
    await act(async () => fireEvent.click(verificationButton("Finish setup")));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith("/w/northwind/sessions");
  });

  it("does not let a member complete setup after verification passes", () => {
    const data = verificationData();
    data.currentMember.role = "member";
    data.canManage = false;
    data.setupHealth.latestSandboxCapabilityCheck = verificationCheck();
    render(<OnboardingPageClient initialData={data} />);
    expect(
      verifyPanel().queryByRole("button", { name: "Create your first task" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Read only. Ask a workspace owner or admin to finish setup."),
    ).toBeVisible();
    fireEvent.submit(document.getElementById("onboarding-verification")!);
    expect(router.replace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps reverification restricted when a member revisits completed setup with stale results", () => {
    const data = verificationData();
    data.currentMember.role = "member";
    data.canManage = false;
    data.onboarding.status = "completed";
    data.setupHealth.latestSandboxCapabilityCheck = {
      ...verificationCheck(),
      agentModel: "old-model",
    };
    render(<OnboardingPageClient initialData={data} />);
    expect(verifyPanel().queryByRole("button", { name: "Verify again" })).not.toBeInTheDocument();
    fireEvent.submit(document.getElementById("onboarding-verification")!);
    expect(router.replace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByText("Read only. Ask a workspace owner or admin to verify the current setup."),
    ).toBeVisible();
  });

  describe.each(["owner", "member"] as const)("completed setup for a %s", (role) => {
    it.each(["stale", "error", "missing", "running", "blocked"] as const)(
      "cannot bypass %s verification by selecting another step",
      async (state) => {
        const data = verificationData();
        data.currentMember.role = role;
        data.canManage = role === "owner";
        data.onboarding.status = "completed";
        data.setupHealth.latestSandboxCapabilityCheck =
          state === "missing"
            ? null
            : verificationCheck(state === "error" || state === "running" ? state : "success");
        if (state === "stale")
          data.setupHealth.latestSandboxCapabilityCheck!.agentModel = "old-model";
        if (state === "blocked") data.setupHealth.codexConnection.connected = false;
        render(<OnboardingPageClient initialData={data} />);

        await act(async () =>
          fireEvent.click(desktopSteps().getByRole("button", { name: "Agent" })),
        );
        expect(screen.getByText("Editing runtime")).toBeVisible();
        expect(
          screen.queryByRole("button", { name: "Create your first task" }),
        ).not.toBeInTheDocument();
        const review = screen.getByRole("button", { name: "Review readiness" });
        expect(review).toBeEnabled();
        expect(review).not.toHaveAttribute("form");
        await act(async () => fireEvent.click(review));

        expect(screen.getByRole("heading", { name: "Verify setup" })).toBeVisible();
        const label =
          state === "running"
            ? "Checking…"
            : state === "error"
              ? "Retry verification"
              : state === "stale"
                ? "Verify again"
                : state === "blocked"
                  ? "Fix agent access"
                  : "Verify setup";
        if (role === "member") {
          expect(verifyPanel().queryByRole("button", { name: label })).not.toBeInTheDocument();
        } else if (state === "running") {
          expect(verificationButton(label)).toBeDisabled();
        } else if (state === "blocked") {
          expect(verificationButton(label)).toHaveAttribute("data-step-link", "runtime");
          expect(verificationButton(label)).not.toHaveAttribute("form");
        } else {
          expect(verificationButton(label)).toBeEnabled();
          expect(verificationButton(label)).toHaveAttribute("form", "onboarding-verification");
        }
        expect(screen.queryByText("Setup is ready")).not.toBeInTheDocument();
        expect(router.replace).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it("can return to Sessions from another step when the current setup is verified", async () => {
      const data = verificationData();
      data.currentMember.role = role;
      data.canManage = role === "owner";
      data.onboarding.status = "completed";
      data.setupHealth.latestSandboxCapabilityCheck = verificationCheck();
      render(<OnboardingPageClient initialData={data} />);

      await act(async () => fireEvent.click(desktopSteps().getByRole("button", { name: "Agent" })));
      expect(screen.getByRole("link", { name: "Back to sessions" })).toHaveAttribute(
        "href",
        "/w/northwind/sessions",
      );
      expect(
        screen.queryByRole("button", { name: "Create your first task" }),
      ).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
