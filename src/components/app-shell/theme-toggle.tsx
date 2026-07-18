"use client";

import { useSyncExternalStore } from "react";

import { MoonIcon, SunIcon } from "@/components/shared/icons";
import { Tooltip } from "@/components/ui/tooltip";

export const THEME_STORAGE_KEY = "wallie-theme";

export type Theme = "light" | "dark";

export function normalizeTheme(value: string | null | undefined): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

export function resolveInitialTheme(
  storedTheme: string | null | undefined,
  prefersDark: boolean,
): Theme {
  return normalizeTheme(storedTheme) ?? (prefersDark ? "dark" : "light");
}

const themeListeners = new Set<() => void>();

function getSystemTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredTheme(): Theme | null {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function readCurrentTheme(): Theme {
  const documentTheme = normalizeTheme(document.documentElement.dataset.theme);

  return documentTheme ?? readStoredTheme() ?? getSystemTheme();
}

function getThemeSnapshot(): Theme {
  if (typeof document === "undefined") {
    return "light";
  }

  return readCurrentTheme();
}

function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);

  return () => {
    themeListeners.delete(listener);
  };
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The visible theme should still update when storage is blocked.
  }

  for (const listener of themeListeners) {
    listener();
  }
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, () => "light");

  function handleToggle() {
    const nextTheme = readCurrentTheme() === "dark" ? "light" : "dark";

    applyTheme(nextTheme);
  }

  const isDark = theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  const Icon = isDark ? SunIcon : MoonIcon;

  return (
    <Tooltip content={label}>
      <button
        type="button"
        className="ui-icon-button"
        aria-label={label}
        aria-pressed={isDark}
        onClick={handleToggle}
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}
