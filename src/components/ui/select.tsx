"use client";

import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

import { CheckIcon } from "@/components/shared/icons/check-icon";
import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { useModalOverlayContainer, useOverlayContainer } from "@/components/ui/portal-root";
import { cn } from "@/lib/utils";

export type SelectOption = {
  icon?: ReactNode;
  label: string;
  value: string;
};

export type SelectFieldProps = {
  className?: string;
  disabled?: boolean;
  emptyOption?: SelectOption;
  fallbackLabel?: string;
  label: ReactNode;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  value: string;
};

type SelectItemDescriptor = {
  disabled: boolean;
  label: string;
  value: string;
};

type SelectContextValue = {
  applyTypeahead: (key: string, mode: "highlight" | "select") => void;
  disabled: boolean;
  highlightedValue: string | null;
  items: readonly SelectItemDescriptor[];
  listboxId: string;
  onValueChange: (value: string) => void;
  open: boolean;
  optionId: (value: string) => string;
  setHighlightedValue: (value: string | null) => void;
  setOpen: (open: boolean) => void;
  setTrigger: (node: HTMLButtonElement | null) => void;
  trigger: HTMLButtonElement | null;
  value: string;
};

const SelectContext = createContext<SelectContextValue | null>(null);
const SELECT_ITEM = Symbol("wallie.select-item");

type SelectItemComponent = ((props: SelectItemProps) => ReactElement) & {
  [SELECT_ITEM]?: true;
};

function useSelectContext() {
  const context = useContext(SelectContext);
  if (!context) {
    throw new Error("Select components must be used within Select.");
  }
  return context;
}

function textFromNode(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children);
  return "";
}

function isSelectItemElement(node: ReactNode): node is ReactElement<SelectItemProps> {
  return isValidElement(node) && Boolean((node.type as SelectItemComponent)[SELECT_ITEM]);
}

function collectItems(node: ReactNode): SelectItemDescriptor[] {
  const items: SelectItemDescriptor[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    if (isSelectItemElement(child)) {
      items.push({
        disabled: Boolean(child.props.disabled),
        label: textFromNode(child.props.children),
        value: child.props.value,
      });
      return;
    }
    if (child.props.children) items.push(...collectItems(child.props.children));
  });
  return items;
}

function firstEnabled(items: readonly SelectItemDescriptor[]) {
  return items.find((item) => !item.disabled) ?? null;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) ref.current = value;
}

const TABBABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function isTabbable(element: HTMLElement) {
  if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") {
    return false;
  }
  if (element.tabIndex < 0) return false;
  return !element.hidden && !element.closest("[hidden]");
}

function focusAdjacentTabbable(from: HTMLElement, shiftKey: boolean, exclude: Element | null) {
  const candidates = [...document.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)].filter(
    (element) => isTabbable(element) && !exclude?.contains(element),
  );
  const index = candidates.indexOf(from);
  candidates[index + (shiftKey ? -1 : 1)]?.focus();
}

function isNonNoneCss(value: string) {
  return Boolean(value) && value !== "none";
}

/** Viewport offset when the portal target is a `position: fixed` containing block. */
function portalFixedContainingBlock(container: HTMLElement) {
  const style = getComputedStyle(container);
  const willChangeTokens = style.willChange.split(",").map((token) => token.trim());
  const createsContainingBlock =
    isNonNoneCss(style.transform) ||
    isNonNoneCss(style.filter) ||
    isNonNoneCss(style.perspective) ||
    style.contain === "paint" ||
    style.contain === "layout" ||
    style.contain === "strict" ||
    style.contain === "content" ||
    willChangeTokens.includes("transform") ||
    willChangeTokens.includes("filter") ||
    willChangeTokens.includes("perspective");

  if (!createsContainingBlock) {
    return { bottom: window.innerHeight, left: 0, top: 0 };
  }

  const rect = container.getBoundingClientRect();
  return { bottom: rect.bottom, left: rect.left, top: rect.top };
}

/**
 * Non-modal listbox so a portaled dropdown does not hideOthers/inert the app tree.
 * Implemented here rather than via `@radix-ui/react-select`, which has no modal API.
 */
export function Select({
  children,
  defaultValue,
  disabled = false,
  onValueChange,
  value: valueProp,
}: {
  children: ReactNode;
  defaultValue?: string;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
  value?: string;
}) {
  const listboxId = useId();
  const typeaheadRef = useRef({ buffer: "", timeout: 0 });
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  const value = valueProp ?? uncontrolledValue;
  const items = useMemo(() => collectItems(children), [children]);
  const enabledItems = useMemo(() => items.filter((item) => !item.disabled), [items]);

  const commitValue = useCallback(
    (nextValue: string) => {
      if (valueProp === undefined) setUncontrolledValue(nextValue);
      onValueChange?.(nextValue);
    },
    [onValueChange, valueProp],
  );

  const optionId = useCallback(
    (itemValue: string) => `${listboxId}-${itemValue === "" ? "empty" : itemValue}`,
    [listboxId],
  );

  const close = useCallback(
    (options?: { restoreFocus?: boolean }) => {
      setOpen(false);
      setHighlightedValue(null);
      if (options?.restoreFocus !== false) trigger?.focus();
    },
    [trigger],
  );

  const applyTypeahead = useCallback(
    (key: string, mode: "highlight" | "select") => {
      window.clearTimeout(typeaheadRef.current.timeout);
      const nextBuffer = `${typeaheadRef.current.buffer}${key}`.toLowerCase();
      typeaheadRef.current.buffer = nextBuffer;
      typeaheadRef.current.timeout = window.setTimeout(() => {
        typeaheadRef.current.buffer = "";
      }, 500);

      const currentValue = mode === "highlight" ? highlightedValue : value;
      const currentIndex = Math.max(
        0,
        enabledItems.findIndex((item) => item.value === currentValue),
      );
      const skipCurrent = nextBuffer.length === 1;
      const rotated = [
        ...enabledItems.slice(currentIndex + (skipCurrent ? 1 : 0)),
        ...enabledItems.slice(0, currentIndex + (skipCurrent ? 1 : 0)),
      ];
      const match = rotated.find((item) => item.label.toLowerCase().startsWith(nextBuffer));
      if (!match) return;
      if (mode === "highlight") setHighlightedValue(match.value);
      else commitValue(match.value);
    },
    [commitValue, enabledItems, highlightedValue, value],
  );

  const openList = useCallback(() => {
    if (disabled) return;
    const selected = items.find((item) => item.value === value && !item.disabled);
    setHighlightedValue((selected ?? firstEnabled(items))?.value ?? null);
    setOpen(true);
  }, [disabled, items, value]);

  const moveHighlight = useCallback(
    (step: 1 | -1) => {
      if (enabledItems.length === 0) return;
      const currentIndex = enabledItems.findIndex((item) => item.value === highlightedValue);
      const nextIndex =
        currentIndex === -1
          ? step === 1
            ? 0
            : enabledItems.length - 1
          : (currentIndex + step + enabledItems.length) % enabledItems.length;
      setHighlightedValue(enabledItems[nextIndex]?.value ?? null);
    },
    [enabledItems, highlightedValue],
  );

  const selectHighlighted = useCallback(() => {
    if (highlightedValue == null) return;
    const item = items.find((entry) => entry.value === highlightedValue);
    if (!item || item.disabled) return;
    commitValue(item.value);
    close();
  }, [close, commitValue, highlightedValue, items]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (trigger?.contains(target)) return;
      if (document.getElementById(listboxId)?.contains(target)) return;
      close();
    }

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const listbox = document.getElementById(listboxId);
        close({ restoreFocus: false });
        if (trigger) focusAdjacentTabbable(trigger, event.shiftKey, listbox);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveHighlight(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveHighlight(-1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setHighlightedValue(enabledItems[0]?.value ?? null);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setHighlightedValue(enabledItems[enabledItems.length - 1]?.value ?? null);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectHighlighted();
        return;
      }
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;

      event.preventDefault();
      applyTypeahead(event.key, "highlight");
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [
    applyTypeahead,
    close,
    enabledItems,
    listboxId,
    moveHighlight,
    open,
    selectHighlighted,
    trigger,
  ]);

  useEffect(() => {
    const typeahead = typeaheadRef.current;
    return () => window.clearTimeout(typeahead.timeout);
  }, []);

  const context = useMemo<SelectContextValue>(
    () => ({
      applyTypeahead,
      disabled,
      highlightedValue,
      items,
      listboxId,
      onValueChange: (nextValue) => {
        commitValue(nextValue);
        close();
      },
      open,
      optionId,
      setHighlightedValue,
      setOpen: (nextOpen) => {
        if (nextOpen) openList();
        else close();
      },
      setTrigger,
      trigger,
      value,
    }),
    [
      applyTypeahead,
      close,
      commitValue,
      disabled,
      highlightedValue,
      items,
      listboxId,
      open,
      openList,
      optionId,
      trigger,
      value,
    ],
  );

  return <SelectContext value={context}>{children}</SelectContext>;
}

type SelectTriggerProps = Omit<React.ComponentProps<"button">, "type"> & {
  accessibleLabel?: string;
  ref?: Ref<HTMLButtonElement>;
};

export function SelectTrigger({
  accessibleLabel,
  children,
  className,
  ref,
  ...props
}: SelectTriggerProps) {
  const context = useSelectContext();
  const selectedLabel =
    context.items.find((item) => item.value === context.value)?.label ?? context.value;

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    props.onKeyDown?.(event);
    if (event.defaultPrevented || context.disabled || context.open) return;
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      context.setOpen(true);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    context.applyTypeahead(event.key, "select");
  }

  return (
    <button
      {...props}
      aria-controls={context.listboxId}
      aria-expanded={context.open}
      aria-haspopup="listbox"
      aria-label={accessibleLabel}
      className={cn("ui-select-trigger", className)}
      disabled={context.disabled}
      onClick={(event) => {
        props.onClick?.(event);
        if (event.defaultPrevented) return;
        context.setOpen(!context.open);
      }}
      onKeyDown={onKeyDown}
      ref={(node) => {
        context.setTrigger(node);
        assignRef(ref, node);
      }}
      role="combobox"
      type="button"
    >
      {children ?? <span className="min-w-0 truncate">{selectedLabel}</span>}
      <ChevronDownIcon className="text-muted" />
    </button>
  );
}

export function SelectContent({
  children,
  className,
  container: containerOverride,
}: {
  children: ReactNode;
  className?: string;
  container?: HTMLElement | null;
}) {
  const { highlightedValue, listboxId, open, optionId, trigger } = useSelectContext();
  const overlayContainer = useOverlayContainer();
  const modalContainer = useModalOverlayContainer();
  const container = containerOverride ?? modalContainer ?? overlayContainer;
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open) return;
    const listbox = listboxRef.current;
    if (!trigger || !listbox || !container) return;

    function place() {
      if (!trigger || !listbox || !container) return;
      const rect = trigger.getBoundingClientRect();
      const origin = portalFixedContainingBlock(container);
      const gutter = 8;
      const sideOffset = 6;
      const spaceBelow = window.innerHeight - rect.bottom - sideOffset - gutter;
      const spaceAbove = rect.top - sideOffset - gutter;
      const placeAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
      const availableHeight = Math.max(placeAbove ? spaceAbove : spaceBelow, 96);
      const availableWidth = Math.max(window.innerWidth - rect.left - gutter, rect.width);

      listbox.style.setProperty("--radix-select-trigger-width", `${rect.width}px`);
      listbox.style.setProperty("--radix-select-content-available-width", `${availableWidth}px`);
      listbox.style.setProperty("--radix-select-content-available-height", `${availableHeight}px`);
      listbox.style.setProperty(
        "--radix-select-content-transform-origin",
        placeAbove ? "bottom left" : "top left",
      );
      setPosition({
        bottom: placeAbove ? origin.bottom - rect.top + sideOffset : undefined,
        left: rect.left - origin.left,
        position: "fixed",
        top: placeAbove ? undefined : rect.bottom + sideOffset - origin.top,
      });
    }

    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [container, open, trigger]);

  useLayoutEffect(() => {
    if (!open || highlightedValue == null) return;
    document.getElementById(optionId(highlightedValue))?.focus();
  }, [highlightedValue, open, optionId]);

  if (!open || !container) return null;

  return createPortal(
    <div
      aria-label={trigger?.getAttribute("aria-label") ?? undefined}
      aria-labelledby={trigger?.getAttribute("aria-labelledby") ?? undefined}
      className={cn("ui-select-content p-1", className)}
      id={listboxId}
      ref={listboxRef}
      role="listbox"
      style={position}
      tabIndex={-1}
    >
      {children}
    </div>,
    container,
  );
}

type SelectItemProps = {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  leading?: ReactNode;
  value: string;
};

export function SelectItem({
  children,
  className,
  disabled = false,
  leading,
  value,
}: SelectItemProps) {
  const context = useSelectContext();
  const highlighted = context.highlightedValue === value;
  const selected = context.value === value;

  return (
    <div
      aria-disabled={disabled || undefined}
      aria-selected={selected}
      className={cn("ui-select-item", className)}
      data-disabled={disabled ? "" : undefined}
      data-highlighted={highlighted ? "" : undefined}
      id={context.optionId(value)}
      onClick={() => {
        if (disabled) return;
        context.onValueChange(value);
      }}
      onPointerMove={() => {
        if (!disabled) context.setHighlightedValue(value);
      }}
      role="option"
      tabIndex={highlighted ? 0 : -1}
    >
      {selected ? (
        <span aria-hidden="true" className="absolute left-2.5">
          <CheckIcon />
        </span>
      ) : null}
      {leading}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

(SelectItem as SelectItemComponent)[SELECT_ITEM] = true;

export function SelectField({
  className,
  disabled = false,
  emptyOption,
  fallbackLabel,
  label,
  onValueChange,
  options,
  value,
}: SelectFieldProps) {
  const labelId = useId();
  const [triggerElement, setTriggerElement] = useState<HTMLButtonElement | null>(null);
  const selectOptions = emptyOption ? [emptyOption, ...options] : [...options];
  const selectedOption = selectOptions.find((option) => option.value === value);
  const hasOptionIcons = selectOptions.some((option) => option.icon);
  const selectedLabel =
    selectedOption?.label ?? (value || fallbackLabel || emptyOption?.label || "None");

  return (
    <div className={cn("block space-y-1.5", className)}>
      <span className="text-[13px] font-medium text-foreground" id={labelId}>
        {label}
      </span>
      <Select disabled={disabled} onValueChange={onValueChange} value={value}>
        <SelectTrigger aria-labelledby={labelId} className="w-full" ref={setTriggerElement}>
          <span className="flex min-w-0 items-center gap-2">
            {selectedOption?.icon ? (
              <span
                aria-hidden="true"
                className="flex h-5 w-5 shrink-0 items-center justify-center"
              >
                {selectedOption.icon}
              </span>
            ) : null}
            <span className="min-w-0 truncate">{selectedLabel}</span>
          </span>
        </SelectTrigger>
        <SelectContent
          container={triggerElement?.closest<HTMLElement>('[aria-modal="true"]') ?? undefined}
        >
          {selectOptions.map((option) => (
            <SelectItem
              key={option.value || "__empty__"}
              leading={
                hasOptionIcons ? (
                  <span
                    aria-hidden="true"
                    className="flex h-5 w-5 shrink-0 items-center justify-center"
                  >
                    {option.icon}
                  </span>
                ) : undefined
              }
              value={option.value}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
