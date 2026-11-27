"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { PlusIcon } from "@/components/shared/icons/plus-icon";
import { Spinner } from "@/components/shared/spinner";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { workspaceFactoriesPath } from "@/lib/routes";

type FactoryDialogContent =
  (typeof import("./create-factory-dialog-content"))["CreateFactoryDialogContent"];

export function CreateFactoryDialog({
  workspaceId,
  workspaceName,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
}) {
  const router = useRouter();
  const inFlight = useRef(false);
  const closingForNavigation = useRef(false);
  const [Content, setContent] = useState<FactoryDialogContent>();
  const [open, setOpen] = useState(false);
  const [instance, setInstance] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [navigating, startNavigation] = useTransition();

  async function changeOpen(next: boolean) {
    if (inFlight.current || navigating || loading) return;
    if (!next) {
      setOpen(false);
      return;
    }
    if (!Content) {
      setLoading(true);
      setLoadFailed(false);
      try {
        const { CreateFactoryDialogContent } = await import("./create-factory-dialog-content");
        setContent(() => CreateFactoryDialogContent);
      } catch {
        setLoadFailed(true);
        return;
      } finally {
        setLoading(false);
      }
    }
    closingForNavigation.current = false;
    setInstance((value) => value + 1);
    setOpen(true);
  }

  return (
    <Dialog onOpenChange={(next) => void changeOpen(next)} open={open}>
      <DialogTrigger asChild>
        <button
          aria-busy={loading || undefined}
          aria-disabled={loading || undefined}
          className="ui-button-primary min-h-11 gap-1.5 sm:min-h-9"
          disabled={navigating}
          type="button"
        >
          {loading ? <Spinner /> : <PlusIcon />}
          New factory
        </button>
      </DialogTrigger>
      <span className="sr-only" role="status">
        {loading ? "Opening factory form." : ""}
      </span>
      {loadFailed ? (
        <p className="type-secondary text-danger" role="alert">
          Couldn’t open the factory form. Reload Settings and try again.
        </p>
      ) : null}
      {Content ? (
        <Content
          closingForNavigation={closingForNavigation}
          inFlight={inFlight}
          key={instance}
          onCancel={() => void changeOpen(false)}
          onCheck={() => {
            setOpen(false);
            router.refresh();
          }}
          onCreated={(factoryId) => {
            closingForNavigation.current = true;
            setOpen(false);
            startNavigation(() => {
              router.push(workspaceFactoriesPath(workspaceSlug, factoryId), { scroll: false });
            });
          }}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
        />
      ) : null}
    </Dialog>
  );
}
