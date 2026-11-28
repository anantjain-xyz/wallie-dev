"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type Ref,
} from "react";

import { PlusIcon } from "@/components/shared/icons/plus-icon";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  finishInteraction,
  interactionRouteTemplateForPath,
  startInteraction,
} from "@/lib/telemetry/interaction-rum";

type CreateSessionDialogModule = typeof import("@/features/sessions/create-session-dialog");
type CreateSessionDialogComponent = CreateSessionDialogModule["CreateSessionDialog"];
type PreloadedCreateSessionDialogModule = Pick<
  CreateSessionDialogModule,
  "preloadSessionRepositories"
> &
  Partial<Pick<CreateSessionDialogModule, "CreateSessionDialog">>;

const loadCreateSessionDialogModule = () => import("@/features/sessions/create-session-dialog");

let createSessionDialogModule: CreateSessionDialogComponent | null = null;
let createSessionDialogModulePromise: Promise<CreateSessionDialogComponent> | null = null;
const createSessionDialogListeners = new Set<() => void>();

function publishCreateSessionDialog(component: CreateSessionDialogComponent) {
  if (createSessionDialogModule === component) return;
  createSessionDialogModule = component;
  for (const listener of createSessionDialogListeners) listener();
}

function subscribeCreateSessionDialog(listener: () => void) {
  createSessionDialogListeners.add(listener);
  return () => {
    createSessionDialogListeners.delete(listener);
  };
}

function retainCreateSessionDialogModule() {
  if (createSessionDialogModule) return Promise.resolve(createSessionDialogModule);
  if (!createSessionDialogModulePromise) {
    createSessionDialogModulePromise = loadCreateSessionDialogModule()
      .then((module) => {
        publishCreateSessionDialog(module.CreateSessionDialog);
        return module.CreateSessionDialog;
      })
      .catch((error: unknown) => {
        createSessionDialogModulePromise = null;
        throw error;
      });
  }
  return createSessionDialogModulePromise;
}

export function preloadCreateSessionDialogOnce(
  startedKeys: Set<string>,
  input: { userId: string; workspaceId: string; factoryId?: string },
  load: () => Promise<PreloadedCreateSessionDialogModule> = loadCreateSessionDialogModule,
) {
  const key = JSON.stringify([input.userId, input.workspaceId, input.factoryId ?? null]);
  if (startedKeys.has(key)) return;
  startedKeys.add(key);
  load()
    .then((module) => {
      if (module.CreateSessionDialog) publishCreateSessionDialog(module.CreateSessionDialog);
      if (input.factoryId) return module.preloadSessionRepositories(input);
    })
    .catch(() => {
      startedKeys.delete(key);
    });
}

export function CreateSessionDialogLoading({
  onClose,
  onCloseAutoFocus,
  onRetry,
}: { onClose?: () => void; onCloseAutoFocus?: () => void; onRetry?: () => void } = {}) {
  const retryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    finishInteraction("open_create_dialog", "success");
  }, []);

  useEffect(() => {
    if (onRetry) retryRef.current?.focus();
  }, [onRetry]);

  return (
    <Dialog
      defaultOpen
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} title="Start a new session">
        {onRetry ? (
          <div className="space-y-4">
            <p className="text-sm text-foreground" role="alert">
              Couldn’t load the session form. Try again or close to return.
            </p>
            <button className="ui-button-primary" onClick={onRetry} ref={retryRef} type="button">
              Retry
            </button>
          </div>
        ) : (
          <div aria-busy="true" role="status">
            <div aria-hidden="true" className="h-40 animate-pulse rounded bg-control-muted" />
            <p className="mt-4 text-sm text-muted">Loading session form…</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type CreateSessionDialogProps = ComponentProps<CreateSessionDialogComponent>;

export function CreateSessionDialogRequest({
  load = retainCreateSessionDialogModule,
  onClose,
  onCloseAutoFocus,
}: Pick<CreateSessionDialogProps, "onClose" | "onCloseAutoFocus"> & {
  load?: () => Promise<unknown>;
}) {
  const [attempt, setAttempt] = useState(0);
  const [failedAttempt, setFailedAttempt] = useState<number | null>(null);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    let current = true;
    void load().catch(() => {
      if (current) setFailedAttempt(attempt);
    });
    return () => {
      current = false;
    };
  }, [attempt, load]);

  return (
    <CreateSessionDialogLoading
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
      onRetry={failedAttempt === attempt ? retry : undefined}
    />
  );
}

export function LazyCreateSessionDialog(props: CreateSessionDialogProps) {
  const DialogImpl = useSyncExternalStore(
    subscribeCreateSessionDialog,
    () => createSessionDialogModule,
    () => null,
  );

  // next/dynamic wraps this chunk in Suspense. React then keeps that fallback
  // on screen for FALLBACK_THROTTLE_MS (300ms) after the chunk has already
  // loaded. Render the dialog from the resolved module instead.
  if (!DialogImpl) {
    return props.open ? (
      <CreateSessionDialogRequest
        onClose={props.onClose}
        onCloseAutoFocus={props.onCloseAutoFocus}
      />
    ) : null;
  }

  // The value is the cached module export, not a component created in render.
  // eslint-disable-next-line react-hooks/static-components -- module is loaded once and reused
  return <DialogImpl {...props} />;
}

export function NewSessionButton({
  disabledReason,
  factoryId,
  onOpen,
  pathname,
  ref,
  userId,
  workspaceId,
}: {
  disabledReason?: string;
  factoryId?: string;
  onOpen: () => void;
  pathname: string;
  ref?: Ref<HTMLButtonElement>;
  userId: string;
  workspaceId: string;
}) {
  const preloads = useRef<Set<string> | null>(null);
  function preload() {
    if (disabledReason) return;
    preloads.current ??= new Set();
    preloadCreateSessionDialogOnce(preloads.current, { userId, workspaceId, factoryId });
  }

  return (
    <button
      aria-label="New session"
      className="ui-button-primary inline-flex size-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap px-0 lg:size-auto lg:min-h-9 lg:px-3"
      disabled={Boolean(disabledReason)}
      onClick={() => {
        startInteraction("open_create_dialog", interactionRouteTemplateForPath(pathname));
        onOpen();
      }}
      onFocus={preload}
      onPointerEnter={preload}
      ref={ref}
      title={disabledReason ?? "New session"}
      type="button"
    >
      <PlusIcon className="h-3.5 w-3.5" />
      <span className="hidden lg:inline">New session</span>
    </button>
  );
}
