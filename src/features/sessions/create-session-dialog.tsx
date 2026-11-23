"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
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

const intakeOptionsSchema = z.object({
  options: workflowIntakeSelectionSchema.extend({ label: z.string() }).array(),
});
const defaultWorkflowOption = { label: "Default pipeline", value: "" };

type CreateSessionDialogProps = {
  creationFactoryId?: string;
  creationFactoryName?: string;
  onClose: () => void;
  onPreviewChange?: (preview: SessionCreationPreview | null) => void;
  onReopen?: () => void;
  open: boolean;
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
};

type OverrideTarget = RoutingOverrideOptions["targets"][number];

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
export function CreateSessionDialog(props: CreateSessionDialogProps) {
  const [revision, setRevision] = useState(0);
  const reset = useCallback(() => setRevision((current) => current + 1), []);
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
  onClose,
  onPreviewChange,
  onReopen,
  onReset,
  open,
  userId,
  workspaceId,
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
  const submitInFlightRef = useRef(false);
  const sessionCommittedRef = useRef(false);
  const disposedRef = useRef(false);
  const imageDraftsRef = useRef<SessionImageDraft[]>([]);
  const attemptRef = useRef<{ input: CreateSessionInput; snapshot: PendingSessionSnapshot } | null>(
    null,
  );
  const previewVisibleRef = useRef(false);
  const [unconfirmed, setUnconfirmed] = useState(false);

  const refreshImagesOnOpen = useEffectEvent(() => {
    clearRecoveryToast();
    if (sessionCommittedRef.current) {
      onPreviewChange?.(null);
      onReset();
    } else if (attemptRef.current && isSubmitting && onPreviewChange) {
      showPendingPreview(attemptRef.current.snapshot);
      onClose();
    } else if (!attemptRef.current) {
      refreshExpiredImages();
    }
  });

  useEffect(() => {
    if (sessionCommittedRef.current) onReset();
    if (previewVisibleRef.current) {
      previewVisibleRef.current = false;
      onPreviewChange?.(null);
    }
  }, [pathname, onPreviewChange, onReset]);

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
      void preloadSessionRepositories({ userId, workspaceId }).catch(() => undefined);
    }
  }, [open, userId, workspaceId]);

  const [prompt, setPrompt] = useState("");
  const [draftSpecification, setDraftSpecification] = useState(false);
  const [workflowActivationId, setWorkflowActivationId] = useState("");
  const [workflowCatalog, setWorkflowCatalog] = useState<{
    factoryId: string;
    definitionDigest: string;
    options: z.output<typeof intakeOptionsSchema>["options"] | null;
  } | null>(null);
  const [workflowOptionsRevision, setWorkflowOptionsRevision] = useState(0);
  const [imageDrafts, setImageDrafts] = useState<SessionImageDraft[]>([]);
  const [attachmentMessage, setAttachmentMessage] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [linearUrl, setLinearUrl] = useState("");
  const [githubRepositoryId, setGithubRepositoryId] = useState("");
  const [excludedStageIds, setExcludedStageIds] = useState<string[]>([]);
  const [overrideChoice, setOverrideChoice] = useState<{ scope: string; target: string } | null>(
    null,
  );
  const [overrideReason, setOverrideReason] = useState("");
  const [linearError, setLinearError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const repositoryCacheKey = { userId, workspaceId };
  const repositorySnapshot = useSessionRepositories(repositoryCacheKey);
  const factoryDefinitionDigest = repositorySnapshot.data?.factoryDefinitionDigest;
  const canDraftSpecification = repositorySnapshot.data?.canDraftSpecification === true;
  const currentWorkflowCatalog =
    workflowCatalog?.factoryId === creationFactoryId &&
    workflowCatalog?.definitionDigest === factoryDefinitionDigest &&
    !repositorySnapshot.isStale
      ? workflowCatalog
      : null;
  const workflowOptions = currentWorkflowCatalog?.options ?? [];
  const workflowOptionsError = currentWorkflowCatalog?.options === null;
  const workflow = workflowOptions.find((option) => option.activationId === workflowActivationId);
  const workflowSelectionUnavailable = Boolean(workflowActivationId && !workflow);

  useEffect(() => {
    if (!open || !creationFactoryId || !factoryDefinitionDigest) return;
    const controller = new AbortController();
    void fetch(`${workflowAuthoringApiPath(workspaceId, creationFactoryId)}/intake-options`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Workflow options are unavailable.");
        const result = intakeOptionsSchema.parse(await response.json());
        if (!controller.signal.aborted) {
          setWorkflowCatalog({
            factoryId: creationFactoryId,
            definitionDigest: factoryDefinitionDigest,
            options: result.options,
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setWorkflowCatalog({
            factoryId: creationFactoryId,
            definitionDigest: factoryDefinitionDigest,
            options: null,
          });
        }
      });
    return () => controller.abort();
  }, [open, creationFactoryId, factoryDefinitionDigest, workflowOptionsRevision, workspaceId]);
  const specificationUnavailable = draftSpecification && !canDraftSpecification;
  const specificationReadiness =
    "This factory needs an available named agent to draft a specification. Uncheck to start without one.";
  const repositoryOptions = repositorySnapshot.data?.repositoryOptions ?? [];
  const stageOptions = repositorySnapshot.data?.stageOptions ?? [];
  const excludedStageIdSet = new Set(excludedStageIds);
  const selectedStageIds = stageOptions
    .filter((stage) => factoryDefinitionDigest || !excludedStageIdSet.has(stage.id))
    .map((stage) => stage.id);
  const hasBlockingAttachments = imageDrafts.some((image) => image.status !== "ready");
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
    if (submitInFlightRef.current || attemptRef.current) return;
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
        image.status === "ready" &&
        (force || (image.refreshAfter !== undefined && image.refreshAfter <= Date.now())),
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
  const overrideOptions = repositorySnapshot.data?.routingOverrideOptions;
  const overrideScope = JSON.stringify([
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

    if (submitInFlightRef.current) {
      return;
    }

    // A lost response may have committed and bound the images. Replay the exact
    // request before refreshing options or uploads that were valid at submission.
    if (unconfirmed && attemptRef.current) {
      await submitAttempt(attemptRef.current);
      return;
    }

    if (!repositorySnapshot.data) {
      setErrorMessage("Wait for repositories to load.");
      return;
    }

    if (repositorySnapshot.isStale) {
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
      setErrorMessage("Choose a current published workflow or the default pipeline.");
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
      setErrorMessage("Enter a Linear issue URL or a prompt.");
      return;
    }

    if (selectedStageIds.length === 0) {
      setErrorMessage("Select at least one stage.");
      return;
    }

    if (refreshExpiredImages()) {
      setErrorMessage("Refreshing expired images. Start the session once they are ready.");
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

    const attempt = {
      input: {
        attachmentIds: imageDrafts.map((image) => image.attachmentId!),
        ...(draftSpecification ? { draftSpecification: true } : {}),
        ...(factoryDefinitionDigest ? { factoryDefinitionDigest } : {}),
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
  }

  async function submitAttempt(attempt: NonNullable<typeof attemptRef.current>) {
    clearRecoveryToast();
    attemptRef.current = attempt;
    setErrorMessage(null);
    submitInFlightRef.current = true;
    setIsSubmitting(true);
    if (onPreviewChange) {
      showPendingPreview(attempt.snapshot);
      onClose();
    }
    try {
      const result = await createSessionFromClient(attempt.input);
      // The dialog now lives in the workspace shell (stays mounted across
      // route changes), so we must explicitly close it on success — the
      // previous page-scoped mounting closed it implicitly on navigation.
      sessionCommittedRef.current = true;
      if (disposedRef.current) return;
      clearRecoveryToast();
      const navigateToSession = !onPreviewChange || previewVisibleRef.current;
      previewVisibleRef.current = false;
      // Keep the preview visible until the canonical route commits. Otherwise
      // the previous page flashes while Next loads the newly created session.
      if (!navigateToSession) onPreviewChange?.(null);
      if (!onPreviewChange) onClose();
      // Retain the draft's image URLs until the shell removes the preview.
      if (!onPreviewChange || !navigateToSession) onReset();
      if (navigateToSession) {
        startNavigation(result.canonicalUrl);
        router.push(result.canonicalUrl);
      } else {
        pushToast({
          title: `Session #${result.number} created.`,
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
      submitInFlightRef.current = false;
      const rejected =
        error instanceof Error &&
        (("creationRejected" in error && error.creationRejected === true) ||
          ("code" in error &&
            (error.code === "session_options_changed" ||
              error.code === "session_attachments_changed")));
      setUnconfirmed(!rejected);
      if (rejected) attemptRef.current = null;
      if (isSessionOptionsChangedError(error)) {
        invalidateSessionRepositoryCache(workspaceId);
        if (attempt.input.routingOverride) invalidateOverrideChoice();
        if (attempt.input.workflowSelection) {
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
        invalidateSessionRepositoryCache(workspaceId);
        invalidateOverrideChoice();
      }
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "session_attachments_changed" &&
        refreshExpiredImages(true)
      ) {
        setErrorMessage("Images expired or changed. Refreshing; start once ready.");
      } else {
        setErrorMessage(
          rejected
            ? error instanceof Error
              ? error.message
              : "Failed to create session."
            : "Creation unconfirmed. Draft saved. Retry to check the original request.",
        );
      }
      setIsSubmitting(false);
      const reopen = previewVisibleRef.current;
      previewVisibleRef.current = false;
      onPreviewChange?.(null);
      if (reopen) onReopen?.();
      else if (onPreviewChange) {
        clearRecoveryToast();
        recoveryToastRef.current = pushToast({
          title: "Session creation needs attention.",
          description: "Your draft is saved.",
          tone: "danger",
          duration: Infinity,
          action: {
            label: "Open draft",
            altText: "Recover the session creation draft",
            onClick: () => onReopen?.(),
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

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isSubmitting && !hasActiveAttachmentOperation) onClose();
      }}
    >
      <DialogContent
        bodyClassName="flex min-h-0 flex-col"
        className="flex max-w-xl flex-col overflow-hidden"
        description={
          creationFactoryName
            ? `This session will run in ${creationFactoryName}, the workspace’s default factory. Describe the work or link a Linear issue.`
            : "Describe the work or link a Linear issue, then choose where Wallie should run."
        }
        dismissible={!isSubmitting && !hasActiveAttachmentOperation}
        title="Start a new session"
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
                {errorMessage}
              </div>
            ) : null}
            <div className="space-y-4 rounded-[8px] border border-border bg-control-muted/40 p-4">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground" htmlFor="session-prompt">
                  Prompt
                </label>
                <textarea
                  id="session-prompt"
                  disabled={isSubmitting || unconfirmed}
                  aria-describedby={
                    ["session-prompt-description", errorMessage ? "create-session-error" : null]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  autoComplete="off"
                  autoFocus={!errorMessage}
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
                  placeholder="What should Wallie build?"
                />
                <p className="type-annotation text-muted" id="session-prompt-description">
                  Required only when no Linear issue is linked.
                </p>
                <SessionImageAttachments
                  disabled={isSubmitting || unconfirmed}
                  images={imageDrafts}
                  maxImages={maxSessionAttachments}
                  onFiles={handleImageFiles}
                  onRemove={(clientId) => void handleRemoveImage(clientId)}
                  onRetry={handleRetryImage}
                />
                {attachmentMessage ? (
                  <p className="text-xs text-warning" role="status">
                    {attachmentMessage}
                  </p>
                ) : null}
              </div>

              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-border" />
                <span className="type-annotation text-muted">or</span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground" htmlFor="session-linear">
                  Linear issue URL
                </label>
                <input
                  id="session-linear"
                  disabled={isSubmitting || unconfirmed}
                  aria-describedby={
                    [
                      "session-linear-description",
                      linearError ? "session-linear-error" : null,
                      errorMessage ? "create-session-error" : null,
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  autoComplete="off"
                  name="linearUrl"
                  value={linearUrl}
                  onChange={(event) => handleLinearChange(event.target.value)}
                  onBlur={handleLinearBlur}
                  className="ui-input"
                  placeholder="https://linear.app/acme/issue/TEAM-123"
                  type="url"
                />
                <p className="type-annotation text-muted" id="session-linear-description">
                  Wallie uses the issue title and, when the prompt is empty, its description.
                </p>
                {linearError ? (
                  <p className="text-xs text-danger" id="session-linear-error" role="alert">
                    {linearError}
                  </p>
                ) : null}
              </div>
            </div>

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
              {hasLinearIssue ? (
                <p className="type-annotation text-muted">Linear issue titles take precedence.</p>
              ) : null}
            </div>

            <RepositoryField
              disabled={isSubmitting || unconfirmed}
              cacheKey={repositoryCacheKey}
              onValueChange={(repositoryId) => {
                if (repositoryId !== selectedGithubRepositoryId) invalidateOverrideChoice();
                setGithubRepositoryId(repositoryId);
              }}
              options={repositorySelectOptions}
              selectedGithubRepositoryId={selectedGithubRepositoryId}
              snapshot={repositorySnapshot}
            />

            {repositorySnapshot.data ? (
              <MultiSelectField
                description={
                  factoryDefinitionDigest
                    ? "The active factory sets the stage order."
                    : "Choose the pipeline stages this session should run."
                }
                disabled={
                  isSubmitting ||
                  unconfirmed ||
                  repositorySnapshot.isStale ||
                  Boolean(factoryDefinitionDigest)
                }
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
                  factoryDefinitionDigest
                    ? stageOptions.map((stage) => stage.name).join(" → ")
                    : selectedStageIds.length === stageOptions.length
                      ? `All ${stageOptions.length} stages.`
                      : `${selectedStageIds.length} of ${stageOptions.length} stages.`
                }
                values={selectedStageIds}
              />
            ) : repositorySnapshot.isLoading ? (
              <div
                aria-busy="true"
                aria-live="polite"
                className="rounded-[6px] border border-border bg-control-muted px-3 py-2 text-xs text-muted"
                role="status"
              >
                Loading stages…
              </div>
            ) : null}

            {workflowOptions.length || workflowActivationId || workflowOptionsError ? (
              <div className="min-w-0 space-y-2">
                <SelectField
                  disabled={
                    isSubmitting ||
                    unconfirmed ||
                    draftSpecification ||
                    overrideChoice !== null ||
                    ((!factoryDefinitionDigest || repositorySnapshot.isStale) &&
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
                    ...workflowOptions.map(({ activationId, label }) => ({
                      label,
                      value: activationId,
                    })),
                  ]}
                  value={workflowActivationId}
                  wrap
                />
                {workflowOptionsError ? (
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
                    The selected workflow changed. Choose a current workflow or the default
                    pipeline.
                  </p>
                ) : null}
              </div>
            ) : null}
            {canDraftSpecification || draftSpecification ? (
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
            <p className="text-xs text-muted">
              Closing keeps your draft while you stay in this workspace. Reloading clears it.
            </p>
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
            <button
              type="button"
              disabled={isSubmitting || unconfirmed || hasActiveAttachmentOperation}
              onClick={() => {
                onClose();
                onReset();
              }}
              className="ui-button mr-auto"
            >
              Discard draft
            </button>
            <button
              type="button"
              disabled={isSubmitting || hasActiveAttachmentOperation}
              onClick={onClose}
              className="ui-button"
            >
              Close
            </button>
            <button
              type="submit"
              aria-keyshortcuts={SESSION_SUBMIT_KEY_SHORTCUTS}
              disabled={
                unconfirmed
                  ? isSubmitting
                  : specificationUnavailable ||
                    workflowSelectionUnavailable ||
                    overrideBlocksSubmission ||
                    isCreateSessionSubmitDisabled({
                      hasRepositoryResult:
                        repositorySnapshot.data !== null && !factoryRepositorySelectionRequired,
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
                pending={isSubmitting}
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
  snapshot: SessionRepositorySnapshot;
};

export function RepositoryField({
  disabled = false,
  cacheKey,
  onValueChange,
  options,
  selectedGithubRepositoryId,
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
        <span>{snapshot.error}</span>
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

  return (
    <div className="space-y-2">
      {options.length > 0 ? (
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
