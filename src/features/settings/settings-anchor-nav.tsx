"use client";

import { useEffect, useState } from "react";

export type SettingsAnchor = {
  id: string;
  label: string;
};

export type SettingsAnchorGroup = {
  label: string;
  anchors: SettingsAnchor[];
};

type SettingsAnchorNavProps = {
  groups: SettingsAnchorGroup[];
  legacyRedirects?: Record<string, string>;
};

const EMPTY_LEGACY_REDIRECTS: Record<string, string> = {};

export function resolveLegacySettingsAnchorHash(
  hash: string,
  legacyRedirects: Record<string, string>,
) {
  const anchorId = hash.replace(/^#/u, "");
  return legacyRedirects[anchorId] ?? null;
}

export function SettingsAnchorNav({
  groups,
  legacyRedirects = EMPTY_LEGACY_REDIRECTS,
}: SettingsAnchorNavProps) {
  const anchors = groups.flatMap((group) => group.anchors);
  const [activeId, setActiveId] = useState<string | null>(anchors[0]?.id ?? null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let pendingHashId: string | null = null;

    function scrollToPendingHash() {
      if (!pendingHashId) return;

      const target = document.getElementById(pendingHashId);
      if (!target) return;

      pendingHashId = null;
      window.requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
    }

    function syncHashTarget() {
      const anchorId = window.location.hash.replace(/^#/u, "");
      const redirectId = resolveLegacySettingsAnchorHash(window.location.hash, legacyRedirects);
      pendingHashId = (redirectId ?? anchorId) || null;

      if (redirectId) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}#${redirectId}`,
        );
      }

      scrollToPendingHash();
    }

    syncHashTarget();
    window.addEventListener("hashchange", syncHashTarget);

    const mutationObserver = new MutationObserver(scrollToPendingHash);
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    return () => {
      mutationObserver.disconnect();
      window.removeEventListener("hashchange", syncHashTarget);
    };
  }, [legacyRedirects]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setActiveId(visible[0].target.id);
        }
      },
      {
        rootMargin: "-80px 0px -60% 0px",
        threshold: [0, 1],
      },
    );

    const observedSections = new WeakSet<HTMLElement>();

    function observeMountedSections() {
      const sections = groups
        .flatMap((group) => group.anchors)
        .map((anchor) => document.getElementById(anchor.id))
        .filter((node): node is HTMLElement => node !== null);

      for (const section of sections) {
        if (observedSections.has(section)) continue;
        observedSections.add(section);
        observer.observe(section);
      }
    }

    observeMountedSections();
    const mutationObserver = new MutationObserver(observeMountedSections);
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    return () => {
      mutationObserver.disconnect();
      observer.disconnect();
    };
  }, [groups]);

  function handleClick(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    const target = document.getElementById(id);
    if (target) {
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveId(id);
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", `#${id}`);
      }
    }
  }

  return (
    <div className="hidden self-start sticky top-[calc(var(--shell-scroll-padding)+16px)] max-h-[calc(100dvh-var(--shell-scroll-padding)-16px)] overflow-y-auto lg:block">
      <nav aria-label="Settings sections" className="flex flex-col gap-5">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="settings-anchor-group">{group.label}</p>
            <ul className="flex flex-col gap-0.5">
              {group.anchors.map((anchor) => {
                const isActive = anchor.id === activeId;
                return (
                  <li key={anchor.id}>
                    <a
                      aria-current={isActive ? "true" : undefined}
                      className={`settings-anchor ${isActive ? "settings-anchor-active" : ""}`}
                      href={`#${anchor.id}`}
                      onClick={(event) => handleClick(event, anchor.id)}
                    >
                      <span>{anchor.label}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
