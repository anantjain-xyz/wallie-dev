"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
} from "react";

import { CheckIcon } from "@/components/shared/icons/check-icon";
import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import {
  scrollSelectOptionIntoView,
  SELECT_FIT_CONTENT_CLASS,
  SelectPopup,
} from "@/components/ui/select-popup";
import { cn } from "@/lib/utils";

export type EditableComboboxOption = {
  description?: string;
  label: string;
  value: string;
};

type EditableComboboxProps = Omit<
  ComponentPropsWithoutRef<"input">,
  "children" | "defaultValue" | "list" | "onChange" | "role" | "type" | "value"
> & {
  defaultActiveValue?: string;
  listboxLabel: string;
  onOpenChange?: (open: boolean) => void;
  onOptionSelect?: (option: EditableComboboxOption) => void;
  onValueChange: (value: string) => void;
  open?: boolean;
  options: readonly EditableComboboxOption[];
  preventUnmatchedEnter?: boolean;
  selectedValue?: string;
  status?: string;
  value: string;
};

export function EditableCombobox({
  className,
  defaultActiveValue,
  disabled,
  listboxLabel,
  onBlur,
  onClick,
  onFocus,
  onKeyDown,
  onOpenChange,
  onOptionSelect,
  onValueChange,
  open: controlledOpen,
  options,
  preventUnmatchedEnter = false,
  selectedValue,
  status,
  value,
  ...props
}: EditableComboboxProps) {
  const listboxId = useId();
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const open = controlledOpen ?? uncontrolledOpen;
  const expanded = open && !disabled && (options.length > 0 || Boolean(status));
  const activeIndex = options.findIndex((option) => option.value === activeValue);
  const highlightedIndex =
    activeIndex < 0
      ? options.findIndex((option) => option.value === defaultActiveValue)
      : activeIndex;
  const activeId =
    expanded && highlightedIndex >= 0 ? `${listboxId}-${highlightedIndex}` : undefined;

  useLayoutEffect(() => {
    if (!activeId || !popupRef.current) return;
    const option = document.getElementById(activeId);
    if (option) scrollSelectOptionIntoView(popupRef.current, option);
  }, [activeId]);

  function setOpen(next: boolean) {
    if (next === open) return;
    if (!next) setActiveValue(null);
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  function selectOption(option: EditableComboboxOption) {
    if (input?.matches(":disabled")) return;
    if (onOptionSelect) onOptionSelect(option);
    else onValueChange(option.value);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;

    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Enter" && open) {
      const option = options[highlightedIndex];
      if (option || preventUnmatchedEnter) event.preventDefault();
      if (option) selectOption(option);
      else if (!preventUnmatchedEnter) setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!options.length && !status) return;
      event.preventDefault();
      setOpen(true);
      if (!open && highlightedIndex >= 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next =
        highlightedIndex < 0
          ? step === 1
            ? 0
            : options.length - 1
          : (highlightedIndex + step + options.length) % options.length;
      const option = options[next];
      if (option) setActiveValue(option.value);
    }
  }

  return (
    <span className="relative block min-w-0">
      <input
        autoComplete="off"
        {...props}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        aria-controls={expanded ? listboxId : undefined}
        aria-expanded={expanded}
        aria-haspopup="listbox"
        className={cn("ui-input block pr-8", className)}
        disabled={disabled}
        onBlur={(event) => {
          onBlur?.(event);
          setOpen(false);
        }}
        onChange={(event) => {
          setActiveValue(null);
          onValueChange(event.currentTarget.value);
          setOpen(true);
        }}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) setOpen(true);
        }}
        onFocus={(event) => {
          onFocus?.(event);
          if (!event.defaultPrevented) setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        ref={setInput}
        role="combobox"
        type="text"
        value={value}
      />
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted" />
      <SelectPopup
        align="end"
        anchor={input}
        className={SELECT_FIT_CONTENT_CLASS}
        onMouseDown={(event) => event.preventDefault()}
        open={expanded}
        ref={popupRef}
      >
        <ul aria-label={listboxLabel} id={listboxId} role="listbox">
          {options.map((option, index) => {
            const selected = option.value === selectedValue;
            return (
              <li
                aria-selected={selected}
                className="ui-select-item items-start"
                data-highlighted={index === highlightedIndex ? "" : undefined}
                id={`${listboxId}-${index}`}
                key={option.value}
                onClick={() => selectOption(option)}
                onPointerMove={(event) => {
                  if (event.pointerType !== "touch") setActiveValue(option.value);
                }}
                role="option"
              >
                {selected ? <CheckIcon className="absolute top-2.5 left-2.5" /> : null}
                <span className="min-w-0 whitespace-normal break-words">
                  {option.label}
                  {option.description ? (
                    <span className="block text-xs text-muted">{option.description}</span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        {status ? (
          <p className="px-3 py-1.5 text-xs text-muted" role="status">
            {status}
          </p>
        ) : null}
      </SelectPopup>
    </span>
  );
}
