"use client";

import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLiveRegion } from "@/components/ui/live-region";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";

const themes = ["light", "dark"] as const;

export function UiPrimitivesShowcase() {
  const { announce } = useLiveRegion();
  const { pushToast } = useToast();
  const [theme, setTheme] = useState<(typeof themes)[number]>("light");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [selection, setSelection] = useState("build");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (reducedMotion) {
      document.documentElement.dataset.reducedMotion = "reduce";
    } else {
      delete document.documentElement.dataset.reducedMotion;
    }

    return () => {
      delete document.documentElement.dataset.reducedMotion;
    };
  }, [reducedMotion]);

  function chooseTheme(nextTheme: (typeof themes)[number]) {
    setTheme(nextTheme);
  }

  function toggleReducedMotion() {
    setReducedMotion((current) => !current);
  }

  function showSuccess() {
    pushToast({
      description: "The shared notification viewport announced this update politely.",
      priority: "polite",
      title: "Pipeline saved",
      tone: "success",
    });
  }

  function showFailure() {
    pushToast({
      description: "The failure needs immediate attention and uses assertive priority.",
      priority: "assertive",
      title: "Connection failed",
      tone: "danger",
    });
  }

  return (
    <main id="main-content" className="min-h-screen bg-canvas px-5 py-10 text-foreground sm:px-8">
      <div className="mx-auto max-w-5xl space-y-8">
        <header className="space-y-3">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-accent">
            Design system lab
          </p>
          <h1 className="text-balance text-3xl font-semibold tracking-tight">
            Accessible overlay primitives
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-muted">
            Development-only coverage for focus, keyboard navigation, collision handling, live
            announcements, themes, and reduced motion.
          </p>
        </header>

        <section aria-labelledby="display-heading" className="ui-sheet p-5">
          <h2 className="text-base font-semibold" id="display-heading">
            Display conditions
          </h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {themes.map((value) => (
              <button
                aria-pressed={theme === value}
                className={theme === value ? "ui-button-primary" : "ui-button"}
                key={value}
                onClick={() => chooseTheme(value)}
                type="button"
              >
                {value === "light" ? "Light" : "Dark"}
              </button>
            ))}
            <button
              aria-pressed={reducedMotion}
              className={reducedMotion ? "ui-button-primary" : "ui-button"}
              onClick={toggleReducedMotion}
              type="button"
            >
              Reduced motion
            </button>
          </div>
        </section>

        <div className="grid gap-5 md:grid-cols-2">
          <ShowcaseCard
            description="Non-destructive tasks with trapped, restored focus."
            title="Dialog"
          >
            <Dialog>
              <DialogTrigger asChild>
                <button className="ui-button-primary" type="button">
                  Edit workspace
                </button>
              </DialogTrigger>
              <DialogContent
                description="Changes are local to this accessibility lab."
                title="Edit workspace"
              >
                <label className="block space-y-1.5 text-sm font-medium">
                  Workspace name
                  <input
                    autoComplete="off"
                    className="ui-input"
                    defaultValue="Wallie"
                    name="workspace-name"
                  />
                </label>
                <DialogFooter>
                  <DialogClose asChild>
                    <button className="ui-button" type="button">
                      Cancel
                    </button>
                  </DialogClose>
                  <DialogClose asChild>
                    <button className="ui-button-primary" type="button">
                      Save
                    </button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </ShowcaseCard>

          <ShowcaseCard
            description="Destructive decisions cannot dismiss on outside press."
            title="Alert dialog"
          >
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button className="ui-button-danger" type="button">
                  Delete sandbox
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent
                description="This permanently removes the sandbox and its uncommitted files."
                title="Delete sandbox?"
              >
                <AlertDialogFooter>
                  <AlertDialogCancel className="ui-button">Keep sandbox</AlertDialogCancel>
                  <AlertDialogAction className="ui-button-danger">Delete sandbox</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </ShowcaseCard>

          <ShowcaseCard
            description="Actions support arrows, Home/End, typeahead, and Escape."
            title="Menu"
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="ui-button" type="button">
                  Session actions
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" label="Session actions">
                <DropdownMenuLabel>Session</DropdownMenuLabel>
                <DropdownMenuItem>Open details</DropdownMenuItem>
                <DropdownMenuItem>Duplicate session</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-danger">Archive session</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ShowcaseCard>

          <ShowcaseCard
            description="Selection includes typeahead and collision-aware placement."
            title="Select"
          >
            <Select onValueChange={setSelection} value={selection}>
              <SelectTrigger accessibleLabel="Pipeline stage" className="w-full" />
              <SelectContent>
                <SelectItem value="plan">Plan</SelectItem>
                <SelectItem value="build">Build</SelectItem>
                <SelectItem value="land">Land</SelectItem>
              </SelectContent>
            </Select>
          </ShowcaseCard>

          <ShowcaseCard
            description="Supplementary help appears on hover and keyboard focus."
            title="Tooltip"
          >
            <Tooltip
              content="Artifacts preserve the reviewed output from each stage."
              delayDuration={0}
            >
              <button aria-label="What is an artifact?" className="ui-icon-button" type="button">
                ?
              </button>
            </Tooltip>
          </ShowcaseCard>

          <ShowcaseCard
            description="Polite progress and assertive failures share one viewport."
            title="Async status"
          >
            <div className="flex flex-wrap gap-2">
              <button className="ui-button" onClick={showSuccess} type="button">
                Show success
              </button>
              <button className="ui-button-danger" onClick={showFailure} type="button">
                Show failure
              </button>
              <button
                className="ui-button"
                onClick={() => announce("Background sync completed.", "polite")}
                type="button"
              >
                Announce only
              </button>
            </div>
          </ShowcaseCard>
        </div>
      </div>
    </main>
  );
}

function ShowcaseCard({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="ui-sheet min-h-48 p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 min-h-10 text-sm leading-5 text-muted">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}
