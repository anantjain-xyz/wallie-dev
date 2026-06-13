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

    function redirectLegacyHash() {
      const redirectId = resolveLegacySettingsAnchorHash(window.location.hash, legacyRedirects);
      if (!redirectId) return;

      const target = document.getElementById(redirectId);
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#${redirectId}`,
      );
      if (target) {
        window.requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
      }
    }

    redirectLegacyHash();
    window.addEventListener("hashchange", redirectLegacyHash);

    return () => window.removeEventListener("hashchange", redirectLegacyHash);
  }, [legacyRedirects]);

  useEffect(() => {
    const sections = groups
      .flatMap((group) => group.anchors)
      .map((anchor) => document.getElementById(anchor.id))
      .filter((node): node is HTMLElement => node !== null);

    if (sections.length === 0) {
      return;
    }

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

    for (const section of sections) {
      observer.observe(section);
    }

    return () => observer.disconnect();
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
    <div className="hidden lg:block">
      <nav aria-label="Settings sections" className="sticky top-6 flex flex-col gap-5">
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
