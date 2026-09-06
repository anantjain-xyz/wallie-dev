// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verificationCheck, verificationData } from "@/features/onboarding/fixtures";
import { WORKSPACE_ONBOARDING_STEPS } from "@/lib/onboarding/contracts";
import { OnboardingPageClient } from "@/features/onboarding/onboarding-page-client";
import VerifyStep from "@/features/onboarding/steps/verify-step";
import type { OnboardingStepProps } from "@/features/onboarding/steps/types";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
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

function footerButton(name: string) {
  return within(screen.getByRole("contentinfo")).getByRole("button", { name });
}

describe("onboarding verification", () => {
  it("shows recommended agent defaults when no explicit config values were saved", () => {
    const data = verificationData();
    data.agentConfig = {};
    render(<OnboardingPageClient initialData={data} />);
    const agentSummary = screen.getByRole("button", { name: "Edit Agent" }).closest("li")!;
    expect(agentSummary).toHaveTextContent("codex · gpt-5.6-sol");
    expect(agentSummary).not.toHaveTextContent("undefined");
  });

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
      const linearSummary = screen
        .getByRole("button", { name: "Edit Linear (optional)" })
        .closest("li")!;
      expect(linearSummary).toHaveTextContent(configured ? "Configured" : "Skipped");
      expect(linearSummary).not.toHaveTextContent(configured ? "Skipped" : "Configured");
    },
  );

  it("keeps saved connections distinct from verification and collapses configuration", () => {
    render(<OnboardingPageClient initialData={verificationData()} />);
    expect(screen.getByText("Your connections are saved")).toBeVisible();
    expect(screen.queryByText("Setup status")).not.toBeInTheDocument();
    expect(screen.getByText("View configuration").closest("details")).not.toHaveAttribute("open");
    expect(footerButton("Verify setup")).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Create your first task" }),
    ).not.toBeInTheDocument();
    const linearStep = screen.getByRole("button", { name: /Linear.*optional.*Skipped/ });
    expect(linearStep).not.toHaveTextContent("Completed");
    expect(screen.getByRole("button", { name: "Verify", current: "step" })).not.toHaveTextContent(
      "Completed",
    );
  });

  it.each(["in_progress", "completed"] as const)(
    "keeps the checkmark when selecting a completed step during %s setup",
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

      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: /GitHub\s*Completed/ })),
      );

      const selectedStep = screen.getByRole("button", {
        name: /GitHub\s*Completed/,
        current: "step",
      });
      expect(selectedStep).toHaveClass("bg-accent-soft", "text-accent");
      expect(within(selectedStep).getByText("Completed")).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Setup step" })).toHaveValue("github");
      expect(
        screen.getByRole("option", { name: "GitHub — Completed", selected: true }),
      ).toBeInTheDocument();
    },
  );

  it("keeps skipped status when selecting an optional step from the mobile picker", async () => {
    const data = verificationData();
    data.onboarding.status = "completed";
    render(<OnboardingPageClient initialData={data} />);

    await act(async () =>
      fireEvent.change(screen.getByRole("combobox", { name: "Setup step" }), {
        target: { value: "linear" },
      }),
    );

    const selectedStep = screen.getByRole("button", {
      name: /Linear.*optional.*Skipped/,
      current: "step",
    });
    expect(selectedStep).toHaveClass("bg-accent-soft", "text-accent");
    expect(selectedStep).not.toHaveTextContent("Completed");
    expect(
      screen.getByRole("option", { name: "Linear (optional) — Skipped", selected: true }),
    ).toBeInTheDocument();
  });

  it("submits verification from the footer once, polls, and completes into the task composer", async () => {
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

    fireEvent.click(footerButton("Verify setup"));
    expect(footerButton("Starting…")).toBeDisabled();
    fireEvent.submit(document.getElementById("onboarding-verification")!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/sandbox-capability-check",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ repositoryId: "repo-a" }) }),
    );
    await act(async () => startCheck(Response.json({ check: verificationCheck("running") })));
    expect(footerButton("Checking…")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Checking your setup…");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText("You’re ready for your first task")).toBeVisible();
    expect(footerButton("Create your first task")).toBeEnabled();

    await act(async () => fireEvent.click(footerButton("Create your first task")));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/workspaces/workspace-1/onboarding/complete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedUpdatedAt: data.onboarding.updatedAt }),
      }),
    );
    expect(router.push).toHaveBeenCalledWith("/w/northwind?create=1");
  });

  it("keeps the retry action available after verification cannot start", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "Unable to connect to sandbox." }, { status: 500 }),
    );
    render(<OnboardingPageClient initialData={verificationData()} />);
    await act(async () => fireEvent.click(footerButton("Verify setup")));
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to connect to sandbox.");
    expect(footerButton("Verify setup")).toBeEnabled();
  });

  it("shows a failed check and retries it without losing the saved configuration", async () => {
    const data = verificationData();
    data.setupHealth.latestSandboxCapabilityCheck = verificationCheck("error");
    fetchMock.mockResolvedValueOnce(Response.json({ check: verificationCheck("running") }));
    render(<OnboardingPageClient initialData={data} />);
    expect(screen.getByRole("status")).toHaveTextContent("Agent sign-in expired.");
    await act(async () => fireEvent.click(footerButton("Retry verification")));
    expect(footerButton("Checking…")).toBeDisabled();
    expect(screen.getByText("View configuration")).toBeVisible();
  });

  it("does not reuse a successful check from an older configuration", () => {
    const data = verificationData();
    data.setupHealth.latestSandboxCapabilityCheck = {
      ...verificationCheck(),
      agentModel: "old-model",
    };
    render(<OnboardingPageClient initialData={data} />);
    expect(screen.getByText("Your setup has changed")).toBeVisible();
    expect(screen.getByText("Previous verification details")).toBeVisible();
    expect(screen.queryByText("You’re ready for your first task")).not.toBeInTheDocument();
    expect(footerButton("Verify setup")).toBeEnabled();
  });

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
    expect(footerButton("Verify setup")).toBeDisabled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open Agent" })));
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
    expect(footerButton("Verify setup")).toBeDisabled();
    fireEvent.submit(document.getElementById("onboarding-verification")!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByText("A workspace owner or admin can verify and complete setup."),
    ).toBeVisible();
  });

  it.each(["owner", "admin", "member"] as const)(
    "lets a %s open the task composer after setup is completed",
    (role) => {
      const data = verificationData();
      data.currentMember.role = role;
      data.canManage = role !== "member";
      data.onboarding.status = "completed";
      data.setupHealth.latestSandboxCapabilityCheck = verificationCheck();
      render(<OnboardingPageClient initialData={data} />);
      expect(footerButton("Create your first task")).toBeEnabled();
      fireEvent.click(footerButton("Create your first task"));
      expect(router.push).toHaveBeenCalledWith("/w/northwind?create=1");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        screen.queryByText("A workspace owner or admin can verify and complete setup."),
      ).not.toBeInTheDocument();
    },
  );

  it("does not let a member complete setup after verification passes", () => {
    const data = verificationData();
    data.currentMember.role = "member";
    data.canManage = false;
    data.setupHealth.latestSandboxCapabilityCheck = verificationCheck();
    render(<OnboardingPageClient initialData={data} />);
    expect(footerButton("Create your first task")).toBeDisabled();
    fireEvent.click(footerButton("Create your first task"));
    expect(router.push).not.toHaveBeenCalled();
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
    expect(footerButton("Verify setup")).toBeDisabled();
    fireEvent.submit(document.getElementById("onboarding-verification")!);
    expect(router.push).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByText("A workspace owner or admin can verify and complete setup."),
    ).toBeVisible();
  });
});
