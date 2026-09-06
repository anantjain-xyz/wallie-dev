// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verificationCheck, verificationData } from "@/features/onboarding/fixtures";
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

  it("lets completed onboarding open the task composer without completing again", () => {
    const data = verificationData();
    data.onboarding.status = "completed";
    data.setupHealth.latestSandboxCapabilityCheck = verificationCheck();
    render(<OnboardingPageClient initialData={data} />);
    fireEvent.click(footerButton("Create your first task"));
    expect(router.push).toHaveBeenCalledWith("/w/northwind?create=1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
