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
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";

import { CheckIcon } from "@/components/shared/icons/check-icon";
import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { scrollSelectOptionIntoView, SelectPopup } from "@/components/ui/select-popup";
import { cn } from "@/lib/utils";

export type SelectOption = {
  disabled?: boolean;
  icon?: ReactNode;
  label: string;
  value: string;
};

export type SelectOptionGroup = {
  label: string;
  options: readonly SelectOption[];
};

export type SelectFieldProps = {
  align?: "start" | "end";
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  className?: string;
  contentClassName?: string;
  defaultValue?: string;
  disabled?: boolean;
  emptyOption?: SelectOption;
  fallbackLabel?: string;
  form?: string;
  groups?: readonly SelectOptionGroup[];
  id?: string;
  label: ReactNode;
  labelClassName?: string;
  name?: string;
  onValueChange?: (value: string) => void;
  options?: readonly SelectOption[];
  required?: boolean;
  triggerClassName?: string;
  value?: string;
  wrap?: boolean;
};

type SelectItemDescriptor = {
  disabled: boolean;
  label: string;
  value: string;
};

type SelectContextValue = {
  applyTypeahead: (key: string, mode: "highlight" | "select") => void;
  disabled: boolean;
  errorId: string;
  form?: string;
  highlightedValue: string | null;
  invalidMessage: string | null;
  items: readonly SelectItemDescriptor[];
  listboxId: string;
  onValueChange: (value: string) => void;
  open: boolean;
  optionId: (value: string) => string;
  required: boolean;
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

function firstInvalidFormControl(form: HTMLFormElement): Element | null {
  for (const element of Array.from(form.elements)) {
    if (
      (element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLButtonElement) &&
      element.willValidate &&
      !element.validity.valid
    ) {
      return element;
    }
  }
  return null;
}

/**
 * Non-modal listbox so a portaled dropdown does not hideOthers/inert the app tree.
 * Implemented here rather than via `@radix-ui/react-select`, which has no modal API.
 */
export function Select({
  children,
  defaultValue,
  disabled = false,
  form,
  name,
  onValueChange,
  required = false,
  value: valueProp,
}: {
  children: ReactNode;
  defaultValue?: string;
  disabled?: boolean;
  form?: string;
  name?: string;
  onValueChange?: (value: string) => void;
  required?: boolean;
  value?: string;
}) {
  const listboxId = useId();
  const errorId = useId();
  const typeaheadRef = useRef({ buffer: "", timeout: 0 });
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [inputElement, setInputElement] = useState<HTMLInputElement | null>(null);
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? "");
  const [invalidMessage, setInvalidMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  const value = valueProp ?? uncontrolledValue;
  const isOpen = !disabled && open;
  const activeInvalidMessage = required && value === "" ? invalidMessage : null;
  const items = useMemo(() => collectItems(children), [children]);
  const enabledItems = useMemo(() => items.filter((item) => !item.disabled), [items]);

  const isControlDisabled = useCallback(
    () => disabled || Boolean(trigger?.matches(":disabled")),
    [disabled, trigger],
  );

  const commitValue = useCallback(
    (nextValue: string) => {
      if (isControlDisabled()) return;
      if (nextValue !== "") setInvalidMessage(null);
      if (valueProp === undefined) setUncontrolledValue(nextValue);
      onValueChange?.(nextValue);
    },
    [isControlDisabled, onValueChange, valueProp],
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
    if (isControlDisabled()) return;
    const selected = items.find((item) => item.value === value && !item.disabled);
    setHighlightedValue((selected ?? firstEnabled(items))?.value ?? null);
    setOpen(true);
  }, [isControlDisabled, items, value]);

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
    if (!isOpen) return;

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
    isOpen,
    listboxId,
    moveHighlight,
    selectHighlighted,
    trigger,
  ]);

  useEffect(() => {
    const typeahead = typeaheadRef.current;
    return () => window.clearTimeout(typeahead.timeout);
  }, []);

  useEffect(() => {
    const formById = form ? document.getElementById(form) : null;
    const ownerForm =
      inputElement?.form ??
      trigger?.form ??
      (formById instanceof HTMLFormElement ? formById : null);
    if (!ownerForm) return;
    function onReset() {
      setInvalidMessage(null);
      if (valueProp === undefined) setUncontrolledValue(defaultValue ?? "");
    }
    ownerForm.addEventListener("reset", onReset);
    return () => ownerForm.removeEventListener("reset", onReset);
  }, [defaultValue, form, inputElement, trigger, valueProp]);

  const context = useMemo<SelectContextValue>(
    () => ({
      applyTypeahead,
      disabled,
      errorId,
      form,
      highlightedValue,
      invalidMessage: activeInvalidMessage,
      items,
      listboxId,
      onValueChange: (nextValue) => {
        commitValue(nextValue);
        close();
      },
      open: isOpen,
      optionId,
      required,
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
      activeInvalidMessage,
      applyTypeahead,
      close,
      commitValue,
      disabled,
      errorId,
      form,
      highlightedValue,
      isOpen,
      items,
      listboxId,
      openList,
      optionId,
      required,
      trigger,
      value,
    ],
  );

  return (
    <SelectContext value={context}>
      {required ? (
        <input
          aria-hidden="true"
          className="pointer-events-none absolute h-px w-px opacity-0"
          disabled={disabled}
          form={form}
          name={name}
          onChange={() => undefined}
          onFocus={() => trigger?.focus()}
          onInvalid={(event) => {
            const input = event.currentTarget;
            const message = input.validity.valueMissing
              ? "Please select an option."
              : input.validationMessage || "Please select an option.";
            setInvalidMessage(message);
            event.preventDefault();
            const ownerForm = input.form;
            if (!ownerForm || firstInvalidFormControl(ownerForm) === input) {
              trigger?.focus();
            }
          }}
          ref={setInputElement}
          required
          tabIndex={-1}
          value={value}
        />
      ) : name ? (
        <input
          disabled={disabled}
          form={form}
          name={name}
          ref={setInputElement}
          type="hidden"
          value={value}
        />
      ) : null}
      {children}
      {activeInvalidMessage ? (
        <p className="text-xs font-medium text-danger" id={errorId} role="alert">
          {activeInvalidMessage}
        </p>
      ) : null}
    </SelectContext>
  );
}

type SelectTriggerProps = Omit<React.ComponentProps<"button">, "type"> & {
  accessibleLabel?: string;
  fallbackLabel?: string;
  ref?: Ref<HTMLButtonElement>;
};

export function SelectTrigger({
  accessibleLabel,
  children,
  className,
  fallbackLabel,
  ref,
  ...props
}: SelectTriggerProps) {
  const context = useSelectContext();
  const selectedLabel =
    context.items.find((item) => item.value === context.value)?.label ??
    (context.value || fallbackLabel || "");

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

  const describedBy =
    [props["aria-describedby"], context.invalidMessage ? context.errorId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <button
      data-value={context.value}
      {...props}
      aria-controls={context.listboxId}
      aria-describedby={describedBy}
      aria-expanded={context.open}
      aria-haspopup="listbox"
      aria-invalid={context.invalidMessage ? true : props["aria-invalid"]}
      aria-label={accessibleLabel ?? props["aria-label"]}
      aria-required={context.required || undefined}
      className={cn("ui-select-trigger", context.invalidMessage && "border-danger", className)}
      disabled={context.disabled}
      form={context.form ?? props.form}
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
  align,
  children,
  className,
  container,
}: {
  align?: "start" | "end";
  children: ReactNode;
  className?: string;
  container?: HTMLElement | null;
}) {
  const { highlightedValue, listboxId, open, optionId, trigger } = useSelectContext();
  const listboxRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open || highlightedValue == null) return;
    const option = document.getElementById(optionId(highlightedValue));
    const listbox = listboxRef.current;
    // The portal is initially unpositioned until the placement update commits.
    // Native focus scrolling here can jump the whole page to the portal root.
    option?.focus({ preventScroll: true });
    if (listbox && option) scrollSelectOptionIntoView(listbox, option);
  }, [highlightedValue, open, optionId]);

  const triggerAriaLabel = trigger?.getAttribute("aria-label") ?? undefined;
  const triggerAriaLabelledBy = trigger?.getAttribute("aria-labelledby") ?? undefined;
  const fallbackLabelEl = !triggerAriaLabel && !triggerAriaLabelledBy ? trigger?.labels?.[0] : null;
  const listboxAriaLabelledBy = triggerAriaLabelledBy ?? (fallbackLabelEl?.id || undefined);
  const listboxAriaLabel =
    triggerAriaLabel ??
    (!listboxAriaLabelledBy ? fallbackLabelEl?.textContent?.trim() || undefined : undefined);

  return (
    <SelectPopup
      align={align}
      anchor={trigger}
      aria-label={listboxAriaLabel}
      aria-labelledby={listboxAriaLabelledBy}
      className={className}
      container={container}
      id={listboxId}
      open={open}
      ref={listboxRef}
      role="listbox"
      tabIndex={-1}
    >
      {children}
    </SelectPopup>
  );
}

export function SelectGroup({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  const groupLabelId = useId();
  return (
    <div aria-labelledby={groupLabelId} className={cn("mt-1 first:mt-0", className)} role="group">
      <div
        className="px-3 py-1.5 type-annotation font-semibold uppercase tracking-wide text-muted"
        id={groupLabelId}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

type SelectItemProps = {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  leading?: ReactNode;
  value: string;
  wrap?: boolean;
};

export function SelectItem({
  children,
  className,
  disabled = false,
  leading,
  value,
  wrap = false,
}: SelectItemProps) {
  const context = useSelectContext();
  const highlighted = context.highlightedValue === value;
  const selected = context.value === value;

  return (
    <div
      aria-disabled={disabled || undefined}
      aria-selected={selected}
      className={cn("ui-select-item", wrap && "items-start", className)}
      data-disabled={disabled ? "" : undefined}
      data-highlighted={highlighted ? "" : undefined}
      data-value={value}
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
        <span aria-hidden="true" className={cn("absolute left-2.5", wrap && "top-2.5")}>
          <CheckIcon />
        </span>
      ) : null}
      {leading}
      <span className={wrap ? "min-w-0 whitespace-normal break-words" : "min-w-0 truncate"}>
        {children}
      </span>
    </div>
  );
}

(SelectItem as SelectItemComponent)[SELECT_ITEM] = true;

function SelectFieldTriggerLabel({
  fallbackLabel,
  options,
}: {
  fallbackLabel: string;
  options: readonly SelectOption[];
}) {
  const { value } = useSelectContext();
  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? (value || fallbackLabel);
  return (
    <span className="flex min-w-0 items-center gap-2">
      {selectedOption?.icon ? (
        <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center">
          {selectedOption.icon}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{selectedLabel}</span>
    </span>
  );
}

export function SelectField({
  align = "start",
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  className,
  contentClassName,
  defaultValue,
  disabled = false,
  emptyOption,
  fallbackLabel,
  form,
  groups,
  id,
  label,
  labelClassName,
  name,
  onValueChange,
  options = [],
  required = false,
  triggerClassName,
  value,
  wrap = false,
}: SelectFieldProps) {
  const generatedId = useId();
  const labelId = useId();
  const triggerId = id ?? generatedId;
  const [triggerElement, setTriggerElement] = useState<HTMLButtonElement | null>(null);
  const flatOptions = useMemo(() => {
    const grouped = groups ? groups.flatMap((group) => group.options) : [];
    return [...(emptyOption ? [emptyOption] : []), ...options, ...grouped];
  }, [emptyOption, groups, options]);
  const hasOptionIcons = flatOptions.some((option) => option.icon);
  const resolvedFallbackLabel = fallbackLabel || emptyOption?.label || "None";

  function renderItem(option: SelectOption, keyPrefix = "") {
    return (
      <SelectItem
        disabled={option.disabled}
        key={`${keyPrefix}${option.value || "__empty__"}`}
        leading={
          hasOptionIcons ? (
            <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center">
              {option.icon}
            </span>
          ) : undefined
        }
        value={option.value}
        wrap={wrap}
      >
        {option.label}
      </SelectItem>
    );
  }

  return (
    <div className={cn("relative block min-w-0 space-y-1.5", className)}>
      <label
        className={cn("block text-[13px] font-medium text-foreground", labelClassName)}
        htmlFor={triggerId}
        id={labelId}
      >
        {label}
      </label>
      <Select
        defaultValue={defaultValue}
        disabled={disabled}
        form={form}
        name={name}
        onValueChange={onValueChange}
        required={required}
        value={value}
      >
        <SelectTrigger
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          aria-labelledby={labelId}
          className={cn("w-full", triggerClassName)}
          fallbackLabel={resolvedFallbackLabel}
          id={triggerId}
          ref={setTriggerElement}
        >
          <SelectFieldTriggerLabel fallbackLabel={resolvedFallbackLabel} options={flatOptions} />
        </SelectTrigger>
        <SelectContent
          align={align}
          className={contentClassName}
          container={triggerElement?.closest<HTMLElement>('[aria-modal="true"]') ?? undefined}
        >
          {emptyOption ? renderItem(emptyOption, "empty-") : null}
          {options.map((option) => renderItem(option))}
          {groups?.map((group) => (
            <SelectGroup key={group.label} label={group.label}>
              {group.options.map((option) => renderItem(option, `${group.label}-`))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
