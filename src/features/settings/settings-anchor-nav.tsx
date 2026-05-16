"use client";

import { useEffect, useState } from "react";

export type SettingsAnchor = {
  id: string;
  label: string;
};

export function SettingsAnchorNav({ anchors }: { anchors: SettingsAnchor[] }) {
  const [activeId, setActiveId] = useState<string | null>(anchors[0]?.id ?? null);

  useEffect(() => {
    const sections = anchors
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
  }, [anchors]);

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
      <nav aria-label="Settings sections" className="sticky top-6">
        <ul className="flex flex-col gap-0.5">
          {anchors.map((anchor) => {
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
      </nav>
    </div>
  );
}

export function SettingsAnchorNavMobile({ anchors }: { anchors: SettingsAnchor[] }) {
  return (
    <nav aria-label="Settings sections" className="lg:hidden -mx-4 px-4 pb-4">
      <ul className="flex gap-2 overflow-x-auto">
        {anchors.map((anchor) => (
          <li key={anchor.id} className="shrink-0">
            <a className="ui-tab" href={`#${anchor.id}`}>
              {anchor.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
