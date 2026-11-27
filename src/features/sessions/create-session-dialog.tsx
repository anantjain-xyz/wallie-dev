"use client";

import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { z } from "zod/v4";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { AGENT_PROVIDER_LABELS } from "@/components/shared/agent-provider-options";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { MultiSelectField } from "@/components/ui/multi-select-field";
import {
  ROUTE_NAVIGATION_STARTED_EVENT,
  useOptionalRouteProgress,
} from "@/components/ui/route-progress";
import { SelectField } from "@/components/ui/select";
import { useOptionalToast } from "@/components/ui/toast";
import {
  createSessionFromClient,
  deletePendingSessionAttachmentFromClient,
  uploadSessionAttachmentFromClient,
  type CreateSessionInput,
} from "@/features/sessions/client";
import {
  useSessionCreationDestination,
  type SessionCreationScope,
} from "@/features/sessions/creation-destination";
import { deriveSessionTitleFromPrompt } from "@/features/sessions/types";
import {
  PendingSessionCreation,
  type PendingSessionSnapshot,
  type SessionCreationPreview,
} from "@/features/sessions/pending-session-creation";
import { extractLinearIssueId } from "@/features/sessions/linear-issue-url";
import {
  SessionImageAttachments,
  type SessionImageDraft,
} from "@/features/sessions/session-image-attachments";
import {
  isSessionSubmitShortcut,
  SESSION_SUBMIT_KEY_SHORTCUTS,
} from "@/features/sessions/session-submit-shortcut";
import {
  invalidateSessionRepositoryCache,
  preloadSessionRepositories as preloadSessionRepositoryCache,
  retrySessionRepositories,
  useSessionRepositories,
  type SessionRepositoryCacheKey,
  type SessionRepositorySnapshot,
} from "@/features/sessions/session-repository-cache";
import {
  routingOverrideSchema,
  type RoutingOverrideOptions,
} from "@/lib/model-routing/operation-contracts";
import {
  allowedSessionAttachmentMimeTypes,
  maxSessionAttachmentBytes,
  maxSessionAttachments,
  sessionAttachmentExpiryMs,
} from "@/lib/storage/contracts";
import { finishInteraction } from "@/lib/telemetry/interaction-rum";
import { workflowIntakeSelectionSchema } from "@/lib/factory-workflows/intake-selection";
import { workflowAuthoringApiPath } from "@/lib/routes";

export type { SessionCreationScope } from "@/features/sessions/creation-destination";

const intakeOptionsSchema = z
  .object({
    definitionDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    options: workflowIntakeSelectionSchema.extend({ label: z.string() }).array(),
  })
  .refine(({ definitionDigest, options }) => definitionDigest !== null || options.length === 0);
const defaultWorkflowOption = { label: "Default pipeline", value: "" };

type CreateSessionDialogProps = {
  creationFactoryId?: string;
  creationFactoryName?: string;
  creationScope?: SessionCreationScope;
  launchKey?: string;
  onClose: (reason?: "preview") => void;
  onCloseAutoFocus?: () => void;
  onDraftReset?: () => void;
  onPreviewChange?: (preview: SessionCreationPreview | null) => void;
  onReopen?: (submittedFactoryId?: string) => void;
  open: boolean;
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
  workflowLaunchActivationId?: string | null;
};

type OverrideTarget = RoutingOverrideOptions["targets"][number];

type SessionCreationAttempt = {
  input: CreateSessionInput;
  recoverDraft: () => void;
  scopeKey: string;
  snapshot: PendingSessionSnapshot;
  workflowLabel: string;
};

function routingTargetKey({ ruleId, target }: OverrideTarget) {
  return `${ruleId}:${target}`;
}

function routingTargetLabel({ target, modelKey, harness, workerRuntime }: OverrideTarget) {
  const role = target === "primary" ? "Primary" : "Fallback";
  const runtime = workerRuntime === "node" ? "Node.js" : "Cloudflare Workers";
  return `${role} · ${modelKey} · ${AGENT_PROVIDER_LABELS[harness]} · ${runtime}`;
}

export function getLinearUrlError(value: string) {
  const trimmed = value.trim();
  if (!trimmed || extractLinearIssueId(trimmed)) {
    return null;
  }

  return "Must be a Linear issue URL.";
}

function isSessionOptionsChangedError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "session_options_changed";
}

export function preloadSessionRepositories(input: SessionRepositoryCacheKey) {
  return preloadSessionRepositoryCache(input);
}

export function isCreateSessionSubmitDisabled(input: {
  hasRepositoryResult: boolean;
  isRepositoryStale: boolean;
  isSubmitting: boolean;
  linearUrl: string;
  prompt: string;
  selectedStageCount: number;
  stageCount: number;
  hasBlockingAttachments?: boolean;
}) {
  const hasInvalidLinearUrl = Boolean(getLinearUrlError(input.linearUrl));

  return (
    input.isSubmitting ||
    Boolean(input.hasBlockingAttachments) ||
    hasInvalidLinearUrl ||
    (!input.linearUrl.trim() && !input.prompt.trim()) ||
    !input.hasRepositoryResult ||
    input.isRepositoryStale ||
    input.stageCount === 0 ||
    input.selectedStageCount === 0
  );
}

// Keep a draft in the workspace shell's memory until it is submitted or discarded.
// The key also prevents a draft from crossing account or workspace boundaries.
export function CreateSessionDialog({ onDraftReset, ...props }: CreateSessionDialogProps) {
  const [revision, setRevision] = useState(0);
  const reset = useCallback(() => {
    onDraftReset?.();
    setRevision((current) => current + 1);
  }, [onDraftReset]);
  return (
    <CreateSessionDialogBody
      {...props}
      key={`${props.userId}:${props.workspaceId}:${revision}`}
      onReset={reset}
    />
  );
}

function CreateSessionDialogBody({
  creationFactoryId,
  creationFactoryName,
  creationScope,
  launchKey,
  onClose,
  onCloseAutoFocus,
  onPreviewChange,
  onReopen,
  onReset,
  open,
  userId,
  workspaceId,
  workflowLaunchActivationId,
}: CreateSessionDialogProps & { onReset: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { dismissToast, pushToast } = useOptionalToast();
  const recoveryToastRef = useRef<number | null>(null);
  const clearRecoveryToast = useCallback(() => {
    if (recoveryToastRef.current !== null) {
      dismissToast(recoveryToastRef.current);
      recoveryToastRef.current = null;
    }
  }, [dismissToast]);
  const { startNavigation } = useOptionalRouteProgress();
  const errorRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const submitInFlightRef = useRef(false);
  const sessionCommittedRef = useRef(false);
  const disposedRef = useRef(false);
  const imageDraftsRef = useRef<SessionImageDraft[]>([]);
  const attemptRef = useRef<SessionCreationAttempt | null>(null);
  const previewVisibleRef = useRef(false);
  const [unconfirmedAttempt, setUnconfirmedAttempt] = useState<SessionCreationAttempt | null>(null);
  const unconfirmed = unconfirmedAttempt !== null;
  const destination = useSessionCreationDestination(creationScope, open, workspaceId);
  const targetFactoryId = destination.factory?.id.toLowerCase();
  const targetFactoryName = creationScope
    ? destination.catalogIsCurrent
      ? destination.factory?.name
      : undefined
    : creationFactoryName;
  const workflowFactoryId = creationScope ? targetFactoryId : creationFactoryId;
  const scopeKey = JSON.stringify([
    creationScope?.kind ?? "legacy",
    targetFactoryId,
    launchKey ?? { workflowLaunchActivationId },
  ]);
  const dialogContextRef = useRef({ open, scopeKey });
  useLayoutEffect(() => {
    dialogContextRef.current = { open, scopeKey };
  }, [open, scopeKey]);
  const workflowLaunchRequested = workflowLaunchActivationId !== undefined;
  const workflowLaunchConflictsWithRetry =
    workflowLaunchRequested &&
    unconfirmed &&
    (!workflowLaunchActivationId ||
      workflowLaunchActivationId !== unconfirmedAttempt.input.workflowSelection?.activationId);
  const factoryConflictsWithRetry =
    unconfirmed && unconfirmedAttempt.input.factoryId !== targetFactoryId;

  const refreshImagesOnOpen = useEffectEvent(() => {
    clearRecoveryToast();
    if (sessionCommittedRef.current) {
      onPreviewChange?.(null);
      onReset();
    } else if (attemptRef.current?.scopeKey === scopeKey && isSubmitting && onPreviewChange) {
      showPendingPreview(attemptRef.current.snapshot);
    } else if (!attemptRef.current && scopeOptionsReady) {
      refreshExpiredImages();
    }
  });

  useLayoutEffect(() => {
    if (sessionCommittedRef.current) onReset();
    if (previewVisibleRef.current) {
      previewVisibleRef.current = false;
      onPreviewChange?.(null);
    }
  }, [pathname, scopeKey, onPreviewChange, onReset]);

  useEffect(() => {
    const dismissForNavigation = () => {
      if (previewVisibleRef.current && !sessionCommittedRef.current) {
        previewVisibleRef.current = false;
        onPreviewChange?.(null);
      }
    };
    window.addEventListener(ROUTE_NAVIGATION_STARTED_EVENT, dismissForNavigation);
    window.addEventListener("popstate", dismissForNavigation);
    return () => {
      window.removeEventListener(ROUTE_NAVIGATION_STARTED_EVENT, dismissForNavigation);
      window.removeEventListener("popstate", dismissForNavigation);
    };
  }, [onPreviewChange]);

  useEffect(() => {
    if (open) {
      refreshImagesOnOpen();
      finishInteraction("open_create_dialog", "success");
    }
  }, [open]);

  const scoped = Boolean(creationScope);
  useEffect(() => {
    if (open && destination.catalogIsCurrent && (!scoped || targetFactoryId)) {
      void preloadSessionRepositories({ userId, workspaceId, factoryId: targetFactoryId }).catch(
        () => undefined,
      );
    }
  }, [open, destination.catalogIsCurrent, scoped, targetFactoryId, userId, workspaceId]);

  const [prompt, setPrompt] = useState("");
  const [manualDraftSpecification, setDraftSpecification] = useState(false);
  const draftSpecification = !workflowLaunchRequested && manualDraftSpecification;
  const [manualWorkflowActivationId, setWorkflowActivationId] = useState("");
  const workflowActivationId = unconfirmedAttempt
    ? (unconfirmedAttempt.input.workflowSelection?.activationId ?? "")
    : workflowLaunchRequested
      ? (workflowLaunchActivationId ?? "")
      : manualWorkflowActivationId;
  const [workflowCatalog, setWorkflowCatalog] = useState<{
    factoryId: string;
    definitionDigest: string;
    options: z.output<typeof intakeOptionsSchema>["options"] | null;
  } | null>(null);
  const [workflowOptionsRevision, setWorkflowOptionsRevision] = useState(0);
  const [workflowCatalogOpen, setWorkflowCatalogOpen] = useState(open);
  if (workflowCatalogOpen !== open) {
    setWorkflowCatalogOpen(open);
    setWorkflowCatalog(null);
  }
  const [imageDrafts, setImageDrafts] = useState<SessionImageDraft[]>([]);
  const [attachmentMessage, setAttachmentMessage] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [linearDraftUrl, setLinearUrl] = useState("");
  const [githubRepositoryId, setGithubRepositoryId] = useState("");
  const [excludedStageIds, setExcludedStageIds] = useState<string[]>([]);
  const [manualOverrideChoice, setOverrideChoice] = useState<{
    scope: string;
    target: string;
  } | null>(null);
  const overrideChoice = workflowLaunchRequested ? null : manualOverrideChoice;
  const [overrideReason, setOverrideReason] = useState("");
  const [linearError, setLinearError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [setupHref, setSetupHref] = useState<string>();
  const [submittingScopeKey, setSubmittingScopeKey] = useState<string | null>(null);
  const isSubmitting = submittingScopeKey !== null;
  const isSubmittingHere = submittingScopeKey === scopeKey;
  const [fieldsFactoryId, setFieldsFactoryId] = useState(targetFactoryId);
  if (fieldsFactoryId !== targetFactoryId) {
    setFieldsFactoryId(targetFactoryId);
    setGithubRepositoryId("");
    setExcludedStageIds([]);
    setWorkflowActivationId("");
    setWorkflowCatalog(null);
    setDraftSpecification(false);
    setOverrideChoice(null);
    setOverrideReason("");
    setLinearError(null);
    setErrorMessage(null);
    setSetupHref(undefined);
  }
  const repositoryCacheKey =
    scoped && (!targetFactoryId || !destination.catalogIsCurrent)
      ? null
      : { userId, workspaceId, factoryId: targetFactoryId };
  const repositorySnapshot = useSessionRepositories(repositoryCacheKey);
  const scopeOptionsReady =
    !scoped ||
    Boolean(
      targetFactoryId &&
      repositorySnapshot.data?.factoryId === targetFactoryId &&
      !repositorySnapshot.isStale,
    );
  const linearIssueLinking =
    !scoped || (scopeOptionsReady && repositorySnapshot.data?.linearIssueLinking === true);
  const linearUrl = linearIssueLinking ? linearDraftUrl : "";
  const factoryDefinitionDigest = repositorySnapshot.data?.factoryDefinitionDigest;
  const canDraftSpecification = repositorySnapshot.data?.canDraftSpecification === true;
  const currentWorkflowCatalog =
    workflowCatalog?.factoryId === workflowFactoryId &&
    workflowCatalog?.definitionDigest === factoryDefinitionDigest &&
    !repositorySnapshot.isStale
      ? workflowCatalog
      : null;
  const workflowOptions = currentWorkflowCatalog?.options ?? [];
  const workflowOptionsError = currentWorkflowCatalog?.options === null;

  useEffect(() => {
    if (!open || !workflowFactoryId || !factoryDefinitionDigest) return;
    const controller = new AbortController();
    void fetch(`${workflowAuthoringApiPath(workspaceId, workflowFactoryId)}/intake-options`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Workflow options are unavailable.");
        const result = intakeOptionsSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        if (result.definitionDigest && result.definitionDigest !== factoryDefinitionDigest) {
          setWorkflowCatalog({
            factoryId: workflowFactoryId,
            definitionDigest: factoryDefinitionDigest,
            options: null,
          });
          invalidateSessionRepositoryCache(workspaceId, targetFactoryId);
          return;
        }
        setWorkflowCatalog({
          factoryId: workflowFactoryId,
          definitionDigest: result.definitionDigest ?? factoryDefinitionDigest,
          options: result.options,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setWorkflowCatalog({
            factoryId: workflowFactoryId,
            definitionDigest: factoryDefinitionDigest,
            options: null,
          });
        }
      });
    return () => controller.abort();
  }, [
    open,
    workflowFactoryId,
    factoryDefinitionDigest,
    targetFactoryId,
    workflowOptionsRevision,
    workspaceId,
  ]);
  const specificationUnavailable = draftSpecification && !canDraftSpecification;
  const specificationReadiness =
    "This factory needs an available named agent to draft a specification. Uncheck to start without one.";
  const repositoryOptions = repositorySnapshot.data?.repositoryOptions ?? [];
  const stageOptions = repositorySnapshot.data?.stageOptions ?? [];
  const excludedStageIdSet = new Set(excludedStageIds);
  const selectedStageIds = stageOptions
    .filter((stage) => factoryDefinitionDigest || !excludedStageIdSet.has(stage.id))
    .map((stage) => stage.id);
  const hasBlockingAttachments = imageDrafts.some(
    (image) => image.status !== "ready" && image.status !== "local",
  );
  const hasActiveAttachmentOperation = imageDrafts.some(
    (image) => image.status === "uploading" || image.status === "removing",
  );

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      clearRecoveryToast();
      for (const image of imageDraftsRef.current) {
        URL.revokeObjectURL(image.previewUrl);
        if (!sessionCommittedRef.current && !attemptRef.current && image.attachmentId) {
          void deletePendingSessionAttachmentFromClient({
            attachmentId: image.attachmentId,
            workspaceId,
          }).catch(() => undefined);
        }
      }
    };
  }, [workspaceId, clearRecoveryToast]);

  function updateImageDrafts(
    update: SessionImageDraft[] | ((current: SessionImageDraft[]) => SessionImageDraft[]),
  ) {
    const next = typeof update === "function" ? update(imageDraftsRef.current) : update;
    imageDraftsRef.current = next;
    setImageDrafts(next);
  }

  function handleImageFiles(files: File[]) {
    if (!scopeOptionsReady || submitInFlightRef.current || attemptRef.current) return;
    const availableSlots = maxSessionAttachments - imageDraftsRef.current.length;
    if (availableSlots <= 0) {
      setAttachmentMessage("A session may include at most five images.");
      return;
    }

    const selectedFiles = files.slice(0, availableSlots);
    const rejectedFiles = selectedFiles.filter(
      (file) =>
        !allowedSessionAttachmentMimeTypes.includes(
          file.type as (typeof allowedSessionAttachmentMimeTypes)[number],
        ) ||
        file.size < 1 ||
        file.size > maxSessionAttachmentBytes,
    );
    const validFiles = selectedFiles.filter((file) => !rejectedFiles.includes(file));

    if (files.length > availableSlots) {
      setAttachmentMessage("Only the first available images were added; the limit is five.");
    } else if (rejectedFiles.length > 0) {
      setAttachmentMessage("Use PNG, JPEG, or WebP images under 4 MB each.");
    } else {
      setAttachmentMessage(null);
    }

    const drafts = validFiles.map((file) => ({
      clientId: crypto.randomUUID(),
      file,
      fileName: file.name || "Pasted image",
      previewUrl: URL.createObjectURL(file),
      sizeBytes: file.size,
      status: "uploading" as const,
    }));
    if (drafts.length === 0) return;

    updateImageDrafts((current) => [...current, ...drafts]);
    for (const draft of drafts) {
      void uploadImageDraft(draft.clientId, draft.file);
    }
  }

  async function uploadImageDraft(clientId: string, file: File) {
    // Start the lifetime before the request and renew a minute early, leaving
    // room for request latency before the server validates pending attachments.
    const refreshAfter = Date.now() + sessionAttachmentExpiryMs - 60_000;
    try {
      const uploaded = await uploadSessionAttachmentFromClient({ file, workspaceId });
      if (disposedRef.current) {
        void deletePendingSessionAttachmentFromClient({
          attachmentId: uploaded.id,
          workspaceId,
        }).catch(() => undefined);
        return;
      }
      updateImageDrafts((current) =>
        current.map((image) =>
          image.clientId === clientId
            ? {
                ...image,
                attachmentId: uploaded.id,
                refreshAfter,
                error: undefined,
                fileName: uploaded.fileName,
                sizeBytes: uploaded.sizeBytes,
                status: "ready",
              }
            : image,
        ),
      );
    } catch (error) {
      updateImageDrafts((current) =>
        current.map((image) =>
          image.clientId === clientId
            ? {
                ...image,
                error: error instanceof Error ? error.message : "Image upload failed.",
                status: "error",
              }
            : image,
        ),
      );
    }
  }

  function refreshExpiredImages(force = false) {
    const expired = imageDraftsRef.current.filter(
      (image) =>
        image.status === "local" ||
        (image.status === "ready" &&
          (force || (image.refreshAfter !== undefined && image.refreshAfter <= Date.now()))),
    );
    if (expired.length === 0) return false;
    const expiredIds = new Set(expired.map((image) => image.clientId));
    updateImageDrafts((current) =>
      current.map((image) =>
        expiredIds.has(image.clientId)
          ? { ...image, attachmentId: undefined, error: undefined, status: "uploading" }
          : image,
      ),
    );
    for (const image of expired) {
      if (image.attachmentId) {
        void deletePendingSessionAttachmentFromClient({
          attachmentId: image.attachmentId,
          workspaceId,
        }).catch(() => undefined);
      }
      void uploadImageDraft(image.clientId, image.file);
    }
    return true;
  }

  async function handleRemoveImage(clientId: string) {
    const image = imageDraftsRef.current.find((candidate) => candidate.clientId === clientId);
    if (!image) return;

    if (!image.attachmentId) {
      URL.revokeObjectURL(image.previewUrl);
      updateImageDrafts((current) =>
        current.filter((candidate) => candidate.clientId !== clientId),
      );
      return;
    }

    updateImageDrafts((current) =>
      current.map((candidate) =>
        candidate.clientId === clientId
          ? { ...candidate, error: undefined, status: "removing" }
          : candidate,
      ),
    );

    try {
      await deletePendingSessionAttachmentFromClient({
        attachmentId: image.attachmentId,
        workspaceId,
      });
      URL.revokeObjectURL(image.previewUrl);
      updateImageDrafts((current) =>
        current.filter((candidate) => candidate.clientId !== clientId),
      );
    } catch (error) {
      updateImageDrafts((current) =>
        current.map((candidate) =>
          candidate.clientId === clientId
            ? {
                ...candidate,
                error: error instanceof Error ? error.message : "Image removal failed.",
                status: "error",
              }
            : candidate,
        ),
      );
    }
  }

  function handleRetryImage(clientId: string) {
    const image = imageDraftsRef.current.find((candidate) => candidate.clientId === clientId);
    if (!image) return;
    if (image.attachmentId) {
      void handleRemoveImage(clientId);
      return;
    }

    updateImageDrafts((current) =>
      current.map((candidate) =>
        candidate.clientId === clientId
          ? { ...candidate, error: undefined, status: "uploading" }
          : candidate,
      ),
    );
    void uploadImageDraft(clientId, image.file);
  }

  function handleLinearBlur() {
    setLinearError(getLinearUrlError(linearUrl));
  }

  function handleLinearChange(value: string) {
    if (!linearIssueLinking) return;
    setLinearUrl(value);
    if (linearError) {
      setLinearError(getLinearUrlError(value));
    }
  }

  const hasLinearIssue = Boolean(extractLinearIssueId(linearUrl.trim()));
  const repositorySelectOptions = repositoryOptions.map((repository) => ({
    label: repository.fullName,
    value: repository.id,
  }));
  const defaultGithubRepositoryId = repositorySnapshot.data?.defaultGithubRepositoryId ?? null;
  const defaultRepositoryAvailable = repositoryOptions.some(
    (repository) => repository.id === defaultGithubRepositoryId,
  );
  const explicitRepositoryAvailable = repositoryOptions.some(
    (repository) => repository.id === githubRepositoryId,
  );
  let selectedGithubRepositoryId = "";
  if (explicitRepositoryAvailable) {
    selectedGithubRepositoryId = githubRepositoryId;
  } else if (!factoryDefinitionDigest || !githubRepositoryId) {
    selectedGithubRepositoryId = defaultRepositoryAvailable
      ? (defaultGithubRepositoryId ?? "")
      : factoryDefinitionDigest
        ? ""
        : (repositoryOptions[0]?.id ?? "");
  }
  const factoryRepositorySelectionRequired = Boolean(
    factoryDefinitionDigest && !selectedGithubRepositoryId,
  );
  const workflowRepositoryAvailable = Boolean(
    defaultGithubRepositoryId && selectedGithubRepositoryId === defaultGithubRepositoryId,
  );
  const eligibleWorkflowOptions = workflowRepositoryAvailable ? workflowOptions : [];
  const workflow = eligibleWorkflowOptions.find(
    (option) => option.activationId === workflowActivationId,
  );
  const workflowSelectionUnavailable =
    (workflowLaunchRequested || !!workflowActivationId) && !workflow;
  const overrideOptions = repositorySnapshot.data?.routingOverrideOptions;
  const overrideScope = JSON.stringify([
    targetFactoryId,
    overrideOptions?.activationNumber,
    factoryDefinitionDigest,
    selectedStageIds[0],
    selectedGithubRepositoryId,
  ]);
  const overrideTargets =
    !draftSpecification &&
    !workflowActivationId &&
    factoryDefinitionDigest &&
    selectedGithubRepositoryId === defaultGithubRepositoryId &&
    overrideOptions
      ? overrideOptions.targets.filter(({ stageId }) => stageId === selectedStageIds[0])
      : [];
  const overrideTarget =
    overrideChoice?.scope === overrideScope
      ? overrideTargets.find((target) => routingTargetKey(target) === overrideChoice.target)
      : undefined;
  const overrideRequest = overrideTarget
    ? routingOverrideSchema.safeParse({
        expectedActivationNumber: overrideOptions?.activationNumber,
        ruleId: overrideTarget.ruleId,
        target: overrideTarget.target,
        reason: overrideReason,
      })
    : null;
  const overrideNeedsSelection = overrideChoice !== null && !overrideTarget;
  const overrideBlocksSubmission = overrideChoice !== null && !overrideRequest?.success;

  function invalidateOverrideChoice() {
    setOverrideChoice((current) => (current ? { ...current, scope: "" } : null));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (
      submitInFlightRef.current ||
      !destination.catalogIsCurrent ||
      workflowLaunchConflictsWithRetry ||
      factoryConflictsWithRetry
    ) {
      return;
    }

    // A lost response may have committed and bound the images. Replay the exact
    // request before refreshing options or uploads that were valid at submission.
    if (unconfirmed && attemptRef.current) {
      await submitAttempt({ ...attemptRef.current, scopeKey });
      return;
    }

    if (scoped && !targetFactoryId) {
      setErrorMessage("Choose a factory before starting a session.");
      return;
    }

    if (!repositorySnapshot.data) {
      setErrorMessage("Wait for session options to load.");
      return;
    }

    if (!scopeOptionsReady || repositorySnapshot.isStale) {
      setErrorMessage("Refresh session options first.");
      return;
    }

    if (factoryRepositorySelectionRequired) {
      setErrorMessage(
        repositoryOptions.length
          ? "Choose a writable factory repository."
          : "Reconnect a writable factory repository before starting a session.",
      );
      return;
    }

    if (specificationUnavailable) return;
    if (workflowSelectionUnavailable) {
      setErrorMessage(
        workflowLaunchRequested
          ? "The requested publication is unavailable. Close and return to Workflows."
          : "Choose a current published workflow or the default pipeline.",
      );
      return;
    }
    if (overrideBlocksSubmission) {
      setErrorMessage(
        overrideNeedsSelection
          ? "Choose a routing override again or use the routing policy."
          : "Enter a reason for the routing override.",
      );
      return;
    }

    if (!prompt.trim() && !linearUrl.trim()) {
      setErrorMessage(
        linearIssueLinking ? "Enter a Linear issue URL or a prompt." : "Enter a prompt.",
      );
      return;
    }

    if (selectedStageIds.length === 0) {
      setErrorMessage("Select at least one stage.");
      return;
    }

    if (refreshExpiredImages()) {
      setErrorMessage("Uploading draft images. Start the session once they are ready.");
      return;
    }

    if (hasBlockingAttachments) {
      setErrorMessage("Wait for uploads or remove failed images.");
      return;
    }

    const nextLinearError = getLinearUrlError(linearUrl);
    if (nextLinearError) {
      setLinearError(nextLinearError);
      setErrorMessage("Fix the Linear URL before submitting.");
      return;
    }

    const attempt: SessionCreationAttempt = {
      recoverDraft: () => onReopen?.(targetFactoryId),
      scopeKey,
      workflowLabel: workflow?.label ?? defaultWorkflowOption.label,
      input: {
        attachmentIds: imageDrafts.map((image) => image.attachmentId!),
        ...(draftSpecification ? { draftSpecification: true } : {}),
        ...(factoryDefinitionDigest ? { factoryDefinitionDigest } : {}),
        ...(targetFactoryId ? { factoryId: targetFactoryId } : {}),
        githubRepositoryId: selectedGithubRepositoryId || null,
        linearIssueUrl: linearUrl.trim() || null,
        promptMd: prompt.trim(),
        requestId: crypto.randomUUID(),
        ...(overrideRequest?.success ? { routingOverride: overrideRequest.data } : {}),
        ...(workflow
          ? {
              workflowSelection: {
                workflowId: workflow.workflowId,
                activationId: workflow.activationId,
              },
            }
          : {}),
        selectedStageIds,
        title: title.trim() || null,
        workspaceId,
      },
      snapshot: {
        ...(targetFactoryName ? { factoryName: targetFactoryName } : {}),
        images: imageDrafts.map(({ clientId, fileName, previewUrl }) => ({
          clientId,
          fileName,
          previewUrl,
        })),
        linearIssueUrl: linearUrl.trim() || null,
        prompt: prompt.trim(),
        repositoryName:
          repositoryOptions.find((repository) => repository.id === selectedGithubRepositoryId)
            ?.fullName ?? null,
        stages: stageOptions
          .filter((stage) => selectedStageIds.includes(stage.id))
          .map(({ id, name }) => ({ id, name })),
        ...(overrideTarget && overrideRequest?.success
          ? {
              routingOverride: {
                label: routingTargetLabel(overrideTarget),
                reason: overrideRequest.data.reason,
              },
            }
          : {}),
        title:
          title.trim() ||
          (linearUrl.trim() ? extractLinearIssueId(linearUrl) : null) ||
          deriveSessionTitleFromPrompt(prompt),
      },
    };
    await submitAttempt(attempt);
  }

  function showPendingPreview(snapshot: PendingSessionSnapshot) {
    if (!onPreviewChange) return;
    previewVisibleRef.current = true;
    const dismiss = () => {
      previewVisibleRef.current = false;
      onPreviewChange(null);
      if (sessionCommittedRef.current) {
        // Returning to the workspace also cancels a canonical route handoff
        // whose response has not arrived yet, preserving the current filters.
        router.replace(`${window.location.pathname}${window.location.search}`);
        onReset();
      }
    };
    onPreviewChange({
      content: <PendingSessionCreation snapshot={snapshot} onDismiss={dismiss} />,
      dismiss,
    });
    onClose("preview");
  }

  function keepDraftWithoutAttempt(attempt: SessionCreationAttempt) {
    const submittedIds = new Set(attempt.input.attachmentIds);
    if (submittedIds.size) {
      updateImageDrafts((current) =>
        current.map((image) =>
          image.attachmentId && submittedIds.has(image.attachmentId)
            ? { ...image, attachmentId: undefined, refreshAfter: undefined, status: "local" }
            : image,
        ),
      );
    }
    attemptRef.current = null;
    clearRecoveryToast();
    setUnconfirmedAttempt(null);
    setErrorMessage(null);
    setSetupHref(undefined);
  }

  async function submitAttempt(attempt: SessionCreationAttempt) {
    clearRecoveryToast();
    attemptRef.current = attempt;
    setErrorMessage(null);
    setSetupHref(undefined);
    submitInFlightRef.current = true;
    setSubmittingScopeKey(attempt.scopeKey);
    showPendingPreview(attempt.snapshot);
    try {
      const result = await createSessionFromClient(attempt.input);
      if (disposedRef.current) return;
      clearRecoveryToast();
      const scopeCurrent = dialogContextRef.current.scopeKey === attempt.scopeKey;
      sessionCommittedRef.current = scopeCurrent;
      const navigateToSession = scopeCurrent && (!onPreviewChange || previewVisibleRef.current);
      previewVisibleRef.current = false;
      // Keep the preview visible until the canonical route commits. Otherwise
      // the previous page flashes while Next loads the newly created session.
      if (!navigateToSession) onPreviewChange?.(null);
      if (scopeCurrent) {
        if (!onPreviewChange) onClose();
        if (!onPreviewChange || !navigateToSession) onReset();
      } else {
        keepDraftWithoutAttempt(attempt);
        submitInFlightRef.current = false;
        setSubmittingScopeKey(null);
      }
      if (navigateToSession) {
        startNavigation(result.canonicalUrl);
        router.push(result.canonicalUrl);
      } else {
        pushToast({
          title: `Session #${result.number} created.`,
          ...(attempt.snapshot.factoryName
            ? { description: `Factory: ${attempt.snapshot.factoryName}` }
            : {}),
          tone: "success",
          action: {
            label: "Open session",
            altText: "Open the newly created session",
            onClick: () => {
              startNavigation(result.canonicalUrl);
              router.push(result.canonicalUrl);
            },
          },
        });
      }
    } catch (error) {
      if (disposedRef.current) return;
      const scopeCurrent = dialogContextRef.current.scopeKey === attempt.scopeKey;
      submitInFlightRef.current = false;
      const rejected =
        error instanceof Error &&
        (("creationRejected" in error && error.creationRejected === true) ||
          ("code" in error &&
            (error.code === "session_options_changed" ||
              error.code === "session_attachments_changed")));
      setUnconfirmedAttempt(rejected ? null : attempt);
      if (rejected) attemptRef.current = null;
      if (isSessionOptionsChangedError(error)) {
        invalidateSessionRepositoryCache(workspaceId, attempt.input.factoryId);
        if (scopeCurrent && attempt.input.routingOverride) invalidateOverrideChoice();
        if (scopeCurrent && attempt.input.workflowSelection) {
          setWorkflowCatalog(null);
          setWorkflowOptionsRevision((revision) => revision + 1);
        }
      }
      if (
        attempt.input.routingOverride &&
        error instanceof Error &&
        "status" in error &&
        error.status === 403
      ) {
        invalidateSessionRepositoryCache(workspaceId, attempt.input.factoryId);
        if (scopeCurrent) invalidateOverrideChoice();
      }
      if (
        scopeCurrent &&
        error instanceof Error &&
        "code" in error &&
        error.code === "session_attachments_changed" &&
        refreshExpiredImages(true)
      ) {
        setErrorMessage("Images expired or changed. Refreshing; start once ready.");
      } else if (scopeCurrent) {
        setErrorMessage(
          rejected
            ? error instanceof Error
              ? error.message
              : "Failed to create session."
            : "Creation unconfirmed. Draft saved. Retry to check the original request.",
        );
        if (error instanceof Error && "setupHref" in error && typeof error.setupHref === "string") {
          setSetupHref(error.setupHref);
        }
      }
      setSubmittingScopeKey(null);
      const reopen = scopeCurrent && previewVisibleRef.current;
      const shouldOfferRecovery =
        rejected || !dialogContextRef.current.open || (onPreviewChange && !scopeCurrent);
      previewVisibleRef.current = false;
      onPreviewChange?.(null);
      if (reopen) onReopen?.();
      else if ((onPreviewChange || !scopeCurrent) && shouldOfferRecovery) {
        clearRecoveryToast();
        recoveryToastRef.current = pushToast({
          title: "Session creation needs attention.",
          description: "Your draft is saved.",
          tone: "danger",
          duration: Infinity,
          action: {
            label: "Open draft",
            altText: "Recover the session creation draft",
            onClick: attempt.recoverDraft,
          },
        });
      }
    }
  }

  function handleFormKeyDown(event: React.KeyboardEvent<HTMLFormElement>) {
    if (!isSessionSubmitShortcut(event)) {
      return;
    }

    event.preventDefault();

    if (!isSubmitting) {
      event.currentTarget.requestSubmit();
    }
  }

  const draftHasEdits = Boolean(
    prompt ||
    title ||
    linearDraftUrl ||
    imageDrafts.length ||
    githubRepositoryId ||
    excludedStageIds.length ||
    manualDraftSpecification ||
    manualWorkflowActivationId ||
    manualOverrideChoice,
  );
  const dialogDisabled = isSubmitting || unconfirmed;
  const repositoryField = repositoryCacheKey ? (
    <RepositoryField
      disabled={dialogDisabled}
      cacheKey={repositoryCacheKey}
      onValueChange={(repositoryId) => {
        if (repositoryId !== selectedGithubRepositoryId) invalidateOverrideChoice();
        setGithubRepositoryId(repositoryId);
      }}
      options={repositorySelectOptions}
      selectedGithubRepositoryId={selectedGithubRepositoryId}
      showFixedValue={scoped}
      snapshot={repositorySnapshot}
    />
  ) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isSubmittingHere && !hasActiveAttachmentOperation) onClose();
      }}
    >
      <DialogContent
        bodyClassName="flex min-h-0 flex-col"
        className="flex max-w-xl flex-col overflow-hidden"
        dismissible={!isSubmittingHere && !hasActiveAttachmentOperation}
        title="Start a new session"
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={(event) => {
          if (errorMessage) {
            event.preventDefault();
            errorRef.current?.focus();
          }
        }}
      >
        <form
          className="flex min-h-0 flex-col"
          onKeyDown={handleFormKeyDown}
          onSubmit={handleSubmit}
        >
          <div
            className="space-y-5 overflow-y-auto overscroll-contain px-1 pb-5"
            data-select-scroll-boundary
            onFocusCapture={(event) => {
              const body = event.currentTarget;
              if (!body.contains(event.target)) return;
              const bodyRect = body.getBoundingClientRect();
              const focusedRect = event.target.getBoundingClientRect();
              const topDelta = focusedRect.top - bodyRect.top;
              if (topDelta < 0 || focusedRect.height > bodyRect.height) {
                body.scrollTop += topDelta;
              } else if (focusedRect.bottom > bodyRect.bottom) {
                body.scrollTop += Math.min(focusedRect.bottom - bodyRect.bottom, topDelta);
              }
            }}
          >
            {errorMessage ? (
              <div
                aria-live="polite"
                id="create-session-error"
                role="status"
                ref={errorRef}
                tabIndex={-1}
                className="rounded-[6px] border border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger"
              >
                <p>{errorMessage}</p>
                {setupHref ? (
                  <Link className="mt-1 inline-block underline" href={setupHref}>
                    Open setup
                  </Link>
                ) : null}
              </div>
            ) : null}
            {creationScope?.kind === "all" &&
            destination.catalog?.factories?.length &&
            (destination.catalog.factories.length > 1 || !destination.factory) ? (
              <SelectField
                aria-required="true"
                disabled={isSubmitting || hasActiveAttachmentOperation}
                fallbackLabel="Choose a factory"
                label="Factory"
                onValueChange={destination.choose}
                options={destination.catalog.factories.map(({ id, name }) => ({
                  label: name,
                  value: id,
                }))}
                value={destination.factory?.id ?? ""}
                wrap
              />
            ) : targetFactoryName ? (
              <dl className="space-y-1">
                <dt className="text-sm font-medium">Factory</dt>
                <dd className="text-sm text-muted wrap-anywhere">{targetFactoryName}</dd>
              </dl>
            ) : null}
            {creationScope?.kind === "all" && (!destination.catalog || !destination.factory) ? (
              !destination.catalog ? (
                <p aria-busy="true" className="text-sm text-muted" role="status">
                  Loading factories…
                </p>
              ) : destination.catalog.error ? (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  role="alert"
                >
                  <p>{destination.catalog.error}</p>
                  <button className="ui-button" onClick={destination.reload} type="button">
                    Retry factories
                  </button>
                </div>
              ) : destination.catalog.factories?.length === 0 ? (
                <p className="text-sm text-muted" role="status">
                  You can’t start a session in any active factory. Ask a workspace admin for access.
                </p>
              ) : null
            ) : null}
            {factoryConflictsWithRetry ? (
              <div className="space-y-2 rounded-[6px] border border-warning/20 bg-warning-soft px-3 py-2">
                <p className="text-sm text-warning" role="status">
                  Creation is unconfirmed in{" "}
                  {unconfirmedAttempt.snapshot.factoryName ?? "the default factory"}. A session may
                  already exist. Return there to retry.
                </p>
                {scopeOptionsReady && targetFactoryId ? (
                  <button
                    className="ui-button min-h-9"
                    disabled={isSubmitting}
                    onClick={() => {
                      keepDraftWithoutAttempt(unconfirmedAttempt);
                      requestAnimationFrame(() => promptRef.current?.focus());
                    }}
                    type="button"
                  >
                    Use draft for a new session
                  </button>
                ) : null}
              </div>
            ) : null}
            {!scopeOptionsReady ? repositoryField : null}
            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground" htmlFor="session-prompt">
                Prompt
              </label>
              <textarea
                id="session-prompt"
                disabled={dialogDisabled}
                aria-describedby={errorMessage ? "create-session-error" : undefined}
                autoComplete="off"
                autoFocus={!errorMessage && creationScope?.kind !== "all"}
                name="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.items)
                    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                    .map((item) => item.getAsFile())
                    .filter((file): file is File => file !== null);
                  if (files.length > 0) handleImageFiles(files);
                }}
                className="ui-textarea min-h-32 leading-6"
                placeholder="Describe the work…"
                ref={promptRef}
              />
              {scopeOptionsReady ? (
                <SessionImageAttachments
                  disabled={dialogDisabled}
                  images={imageDrafts}
                  maxImages={maxSessionAttachments}
                  onFiles={handleImageFiles}
                  onRemove={(clientId) => void handleRemoveImage(clientId)}
                  onRetry={handleRetryImage}
                />
              ) : null}
              {scopeOptionsReady && attachmentMessage ? (
                <p className="text-xs text-warning" role="status">
                  {attachmentMessage}
                </p>
              ) : null}
            </div>
            {linearIssueLinking ? (
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground" htmlFor="session-linear">
                  Linear issue URL
                </label>
                <input
                  id="session-linear"
                  disabled={dialogDisabled}
                  aria-describedby={
                    [
                      linearError ? "session-linear-error" : null,
                      errorMessage ? "create-session-error" : null,
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  autoComplete="off"
                  name="linearUrl"
                  spellCheck={false}
                  value={linearUrl}
                  onChange={(event) => handleLinearChange(event.target.value)}
                  onBlur={handleLinearBlur}
                  className="ui-input"
                  placeholder="https://linear.app/…"
                  type="url"
                />
                {hasLinearIssue && !prompt.trim() ? (
                  <p className="type-annotation text-muted">
                    Uses the linked issue’s description when the prompt is empty.
                  </p>
                ) : null}
                {linearError ? (
                  <p className="text-xs text-danger" id="session-linear-error" role="alert">
                    {linearError}
                  </p>
                ) : null}
              </div>
            ) : scopeOptionsReady && linearDraftUrl.trim() ? (
              <p className="type-annotation text-muted" role="status">
                The draft’s Linear link is saved, but won’t be sent to this factory.
              </p>
            ) : null}

            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground" htmlFor="session-title">
                Title <span className="type-annotation font-normal text-muted">(optional)</span>
              </label>
              <input
                id="session-title"
                autoComplete="off"
                name="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="ui-input"
                disabled={hasLinearIssue || isSubmitting || unconfirmed}
                placeholder={
                  hasLinearIssue ? "From the linked Linear issue" : "Generated from the prompt"
                }
              />
            </div>

            {scopeOptionsReady ? repositoryField : null}

            {scopeOptionsReady && repositorySnapshot.data && factoryDefinitionDigest ? (
              <dl className="space-y-1">
                <dt className="text-sm font-medium">Stages</dt>
                <dd className="text-sm text-muted wrap-anywhere">
                  {stageOptions.map((stage) => stage.name).join(" → ")}
                </dd>
              </dl>
            ) : scopeOptionsReady && repositorySnapshot.data ? (
              <MultiSelectField
                description="Uncheck stages to skip them."
                disabled={dialogDisabled || repositorySnapshot.isStale}
                emptyMessage="No pipeline stages are configured."
                error={
                  stageOptions.length === 0
                    ? "Workspace pipeline has no stages."
                    : selectedStageIds.length === 0
                      ? "Select at least one stage."
                      : undefined
                }
                id="session-stages"
                label="Stages"
                onValuesChange={(values) => {
                  const selected = new Set(values);
                  setExcludedStageIds(
                    stageOptions
                      .filter((stage) => !selected.has(stage.id))
                      .map((stage) => stage.id),
                  );
                }}
                options={stageOptions.map((stage) => ({
                  description: stage.description || undefined,
                  label: stage.name,
                  value: stage.id,
                }))}
                summary={
                  selectedStageIds.length === stageOptions.length
                    ? `All ${stageOptions.length} stages.`
                    : `${selectedStageIds.length} of ${stageOptions.length} stages.`
                }
                values={selectedStageIds}
              />
            ) : null}

            {unconfirmed ||
            workflowOptions.length ||
            workflowActivationId ||
            workflowOptionsError ||
            workflowLaunchRequested ? (
              <div className="min-w-0 space-y-2">
                {unconfirmedAttempt || workflowLaunchRequested ? (
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Workflow</p>
                    <p className="type-secondary wrap-anywhere">
                      {unconfirmedAttempt?.workflowLabel ??
                        workflowOptions.find(
                          ({ activationId }) => activationId === workflowActivationId,
                        )?.label ??
                        "Requested publication"}
                    </p>
                  </div>
                ) : (
                  <SelectField
                    disabled={
                      isSubmitting ||
                      draftSpecification ||
                      overrideChoice !== null ||
                      ((!factoryDefinitionDigest ||
                        repositorySnapshot.isStale ||
                        !workflowRepositoryAvailable) &&
                        !workflowActivationId)
                    }
                    emptyOption={defaultWorkflowOption}
                    label="Workflow"
                    labelClassName="text-sm font-medium"
                    onValueChange={setWorkflowActivationId}
                    options={[
                      ...(workflowSelectionUnavailable
                        ? [
                            {
                              disabled: true,
                              label: "Choose a current workflow",
                              value: workflowActivationId,
                            },
                          ]
                        : []),
                      ...eligibleWorkflowOptions.map(({ activationId, label }) => ({
                        label,
                        value: activationId,
                      })),
                    ]}
                    value={workflowActivationId}
                    wrap
                  />
                )}
                {workflowLaunchConflictsWithRetry ? (
                  <p className="type-secondary text-warning" role="status">
                    Another request is unconfirmed. Close this link and reopen New session to retry
                    that request first.
                  </p>
                ) : unconfirmed ? null : workflowLaunchActivationId === null ? (
                  <p className="type-secondary text-warning" role="status">
                    This workflow link is invalid. Close and start from Workflows again.
                  </p>
                ) : workflowLaunchRequested &&
                  repositorySnapshot.data &&
                  !defaultRepositoryAvailable ? (
                  <p className="type-secondary text-warning" role="status">
                    This workflow needs the factory’s default repository, which is unavailable.
                  </p>
                ) : factoryDefinitionDigest &&
                  selectedGithubRepositoryId &&
                  !workflowRepositoryAvailable ? (
                  <p className="type-secondary text-warning" role="status">
                    Choose the factory’s default repository to use a published workflow.
                  </p>
                ) : workflowOptionsError ? (
                  <p className="type-secondary text-warning" role="status">
                    Published workflows are unavailable.{" "}
                    <button
                      type="button"
                      className="underline underline-offset-4"
                      onClick={() => setWorkflowOptionsRevision((revision) => revision + 1)}
                    >
                      Reload workflows
                    </button>
                  </p>
                ) : workflowSelectionUnavailable ? (
                  <p className="type-secondary text-warning" role="status">
                    {workflowLaunchRequested &&
                    (!repositorySnapshot.data || repositorySnapshot.isStale)
                      ? "Checking the factory’s current session options…"
                      : factoryDefinitionDigest && workflowFactoryId && !currentWorkflowCatalog
                        ? "Loading current workflows…"
                        : workflowLaunchRequested
                          ? "This publication is no longer available. Close and return to Workflows."
                          : "The selected workflow changed. Choose a current workflow or the default pipeline."}
                  </p>
                ) : null}
              </div>
            ) : null}
            {!workflowLaunchRequested && (canDraftSpecification || draftSpecification) ? (
              <label className="flex min-h-11 cursor-pointer items-start gap-3 py-1 text-sm text-foreground">
                <input
                  aria-describedby="session-specification-description"
                  aria-labelledby="session-specification-label"
                  checked={draftSpecification}
                  className="mt-1 size-4 shrink-0 accent-accent"
                  disabled={
                    isSubmitting ||
                    unconfirmed ||
                    overrideChoice !== null ||
                    !!workflowActivationId ||
                    (repositorySnapshot.isStale && !draftSpecification)
                  }
                  onChange={(event) => setDraftSpecification(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  <span id="session-specification-label">Draft a specification first</span>
                  <span
                    id="session-specification-description"
                    className={
                      specificationUnavailable
                        ? "mt-1 block text-xs text-danger"
                        : "mt-1 block text-xs text-muted"
                    }
                    role={specificationUnavailable ? "alert" : undefined}
                  >
                    {specificationUnavailable
                      ? specificationReadiness
                      : overrideChoice
                        ? "Use the routing policy to draft a specification."
                        : "Review the first stage’s specification before implementation starts."}
                  </span>
                </span>
              </label>
            ) : null}
            {overrideTargets.length || overrideChoice ? (
              <fieldset className="min-w-0 space-y-3 rounded-md border border-border p-3">
                <legend className="px-1 text-sm font-medium">Routing override</legend>
                <SelectField
                  disabled={isSubmitting || unconfirmed || repositorySnapshot.isStale}
                  emptyOption={{ label: "Use routing policy", value: "" }}
                  label="Configuration for this session"
                  labelClassName="text-sm font-medium"
                  onValueChange={(target) => {
                    if (target) setOverrideChoice({ scope: overrideScope, target });
                    else {
                      setOverrideChoice(null);
                      setOverrideReason("");
                    }
                  }}
                  options={[
                    ...(overrideNeedsSelection
                      ? [{ disabled: true, label: "Choose again", value: "review" }]
                      : []),
                    ...overrideTargets.map((target) => ({
                      label: routingTargetLabel(target),
                      value: routingTargetKey(target),
                    })),
                  ]}
                  value={
                    overrideTarget
                      ? routingTargetKey(overrideTarget)
                      : overrideNeedsSelection
                        ? "review"
                        : ""
                  }
                  wrap
                />
                {overrideNeedsSelection && !unconfirmed ? (
                  <p className="type-secondary text-warning" role="status">
                    Choose a routing override again or use the routing policy.
                  </p>
                ) : null}
                {overrideTarget ? (
                  <label className="block space-y-1.5">
                    <span className="block text-sm font-medium">Reason for override</span>
                    <textarea
                      className="ui-textarea w-full"
                      disabled={isSubmitting || unconfirmed || repositorySnapshot.isStale}
                      maxLength={500}
                      onChange={(event) => setOverrideReason(event.target.value)}
                      required
                      rows={2}
                      value={overrideReason}
                    />
                  </label>
                ) : null}
              </fieldset>
            ) : null}
            {draftHasEdits ? (
              <button
                type="button"
                disabled={dialogDisabled || hasActiveAttachmentOperation}
                onClick={() => {
                  onClose();
                  onReset();
                }}
                className="min-h-9 rounded px-0.5 text-xs text-muted underline underline-offset-2 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 disabled:no-underline"
              >
                Discard draft
              </button>
            ) : null}
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
            <button
              type="button"
              disabled={isSubmittingHere || hasActiveAttachmentOperation}
              onClick={() => onClose()}
              className="ui-button"
            >
              Close
            </button>
            <button
              type="submit"
              aria-keyshortcuts={SESSION_SUBMIT_KEY_SHORTCUTS}
              disabled={
                unconfirmed
                  ? isSubmitting ||
                    !destination.catalogIsCurrent ||
                    workflowLaunchConflictsWithRetry ||
                    factoryConflictsWithRetry
                  : specificationUnavailable ||
                    workflowSelectionUnavailable ||
                    overrideBlocksSubmission ||
                    isCreateSessionSubmitDisabled({
                      hasRepositoryResult:
                        scopeOptionsReady &&
                        repositorySnapshot.data !== null &&
                        !factoryRepositorySelectionRequired,
                      hasBlockingAttachments,
                      isRepositoryStale: repositorySnapshot.isStale,
                      isSubmitting,
                      linearUrl,
                      prompt,
                      selectedStageCount: selectedStageIds.length,
                      stageCount: stageOptions.length,
                    })
              }
              className="ui-button-primary"
            >
              <ActionButtonLabel
                idle={unconfirmed ? "Retry creation" : "Start session"}
                pending={isSubmittingHere}
                pendingLabel="Starting…"
              />
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type RepositoryFieldProps = {
  disabled?: boolean;
  cacheKey: SessionRepositoryCacheKey;
  onValueChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  selectedGithubRepositoryId: string;
  showFixedValue?: boolean;
  snapshot: SessionRepositorySnapshot;
};

export function RepositoryField({
  disabled = false,
  cacheKey,
  onValueChange,
  options,
  selectedGithubRepositoryId,
  showFixedValue = false,
  snapshot,
}: RepositoryFieldProps) {
  function retry() {
    void retrySessionRepositories(cacheKey).catch(() => undefined);
  }

  if (!snapshot.data && snapshot.isLoading) {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className="rounded-[6px] border border-border bg-control-muted px-3 py-2 text-xs text-muted"
        role="status"
      >
        Loading repositories…
      </div>
    );
  }

  if (!snapshot.data && snapshot.error) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-warning/20 bg-warning-soft px-3 py-2 text-xs text-warning"
        role="alert"
      >
        <span>
          {snapshot.error}
          {snapshot.setupHref ? (
            <>
              {" "}
              <Link className="underline" href={snapshot.setupHref}>
                Open setup
              </Link>
            </>
          ) : null}
        </span>
        <button className="ui-button min-h-8" disabled={disabled} onClick={retry} type="button">
          Retry session options
        </button>
      </div>
    );
  }

  if (!snapshot.data) {
    return (
      <div aria-live="polite" className="text-xs text-muted" role="status">
        Preparing repository options…
      </div>
    );
  }

  const fixedRepository =
    options.length === 1 && options[0].value === selectedGithubRepositoryId
      ? options[0]
      : undefined;
  return (
    <div className="space-y-2">
      {showFixedValue && fixedRepository ? (
        <dl className="space-y-1">
          <dt className="text-sm font-medium">Repository</dt>
          <dd className="text-sm text-muted wrap-anywhere">{fixedRepository.label}</dd>
        </dl>
      ) : options.length > 0 ? (
        <SelectField
          disabled={
            disabled ||
            Boolean(
              snapshot.data.factoryDefinitionDigest &&
              options.length === 1 &&
              selectedGithubRepositoryId,
            )
          }
          fallbackLabel="Choose a repository"
          label="Repository"
          options={options}
          onValueChange={onValueChange}
          value={selectedGithubRepositoryId}
        />
      ) : (
        <div
          aria-live="polite"
          className="rounded-[6px] border border-border bg-control-muted px-3 py-2 text-xs text-muted"
          role="status"
        >
          {snapshot.data.factoryDefinitionDigest
            ? "Reconnect a writable factory repository before starting a session."
            : "No repositories available. Starting without one."}
        </div>
      )}

      {snapshot.isStale ? (
        <div
          aria-live="polite"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-warning/20 bg-warning-soft px-3 py-2 text-xs text-warning"
          role={snapshot.error ? "alert" : "status"}
        >
          <span>
            {snapshot.isRefreshing
              ? "Refreshing repository options…"
              : snapshot.error
                ? `Session options may be out of date. ${snapshot.error}`
                : "Session options may be out of date."}
            {snapshot.setupHref ? (
              <>
                {" "}
                <Link className="underline" href={snapshot.setupHref}>
                  Open setup
                </Link>
              </>
            ) : null}
          </span>
          {!snapshot.isRefreshing ? (
            <button className="ui-button min-h-8" disabled={disabled} onClick={retry} type="button">
              Refresh session options
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
