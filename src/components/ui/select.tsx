"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { CheckIcon, ChevronDownIcon } from "@/components/shared/icons";
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
  const buttonId = useId();
  const listboxId = useId();
  const selectedValueId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectOptions = useMemo(
    () => (emptyOption ? [emptyOption, ...options] : [...options]),
    [emptyOption, options],
  );
  const selectedOptionIndex = selectOptions.findIndex((option) => option.value === value);
  const selectedIndex = selectedOptionIndex >= 0 ? selectedOptionIndex : 0;
  const selectedOption =
    selectedOptionIndex >= 0
      ? selectOptions[selectedOptionIndex]
      : {
          label: value || fallbackLabel || emptyOption?.label || "None",
          value,
        };
  const activeOptionId =
    isOpen && selectOptions[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined;
  const hasOptionIcons = selectOptions.some((option) => option.icon);

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  function openMenu(nextActiveIndex = selectedIndex) {
    if (disabled || selectOptions.length === 0) return;
    setActiveIndex(nextActiveIndex);
    setIsOpen(true);
  }

  function selectValue(nextValue: string) {
    onValueChange(nextValue);
    setIsOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || selectOptions.length === 0) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!isOpen) {
          openMenu(selectedIndex);
          return;
        }
        setActiveIndex((current) => (current + 1) % selectOptions.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!isOpen) {
          openMenu(selectedIndex);
          return;
        }
        setActiveIndex((current) => (current - 1 + selectOptions.length) % selectOptions.length);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (!isOpen) {
          openMenu(selectedIndex);
          return;
        }
        selectValue(selectOptions[activeIndex]?.value ?? selectedOption.value);
        break;
      case "Escape":
        if (isOpen) {
          event.preventDefault();
          setIsOpen(false);
        }
        break;
      default:
        break;
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    const nextFocusedElement = event.relatedTarget;

    if (
      !(nextFocusedElement instanceof Node) ||
      !event.currentTarget.contains(nextFocusedElement)
    ) {
      setIsOpen(false);
    }
  }

  return (
    <div
      className={cn("relative block space-y-1.5", className)}
      onBlur={handleBlur}
      ref={containerRef}
    >
      <span className="text-[13px] font-medium text-foreground" id={buttonId}>
        {label}
      </span>
      <button
        aria-activedescendant={activeOptionId}
        aria-controls={isOpen ? listboxId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-labelledby={`${buttonId} ${selectedValueId}`}
        className={cn(
          "flex min-h-10 w-full items-center justify-between gap-3 rounded-[6px] border border-border bg-surface px-3 py-2.5 text-left text-sm text-foreground outline-none transition-[border-color,box-shadow,background-color] duration-150",
          "focus-visible:border-accent/40 focus-visible:ring-4 focus-visible:ring-accent/10",
          disabled
            ? "cursor-not-allowed opacity-60"
            : "cursor-pointer hover:border-border-strong hover:bg-surface-strong",
        )}
        disabled={disabled}
        onClick={() => (isOpen ? setIsOpen(false) : openMenu(selectedIndex))}
        onKeyDown={handleKeyDown}
        role="combobox"
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2" id={selectedValueId}>
          {selectedOption.icon ? (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
              {selectedOption.icon}
            </span>
          ) : null}
          <span className="min-w-0 truncate">{selectedOption.label}</span>
        </span>
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted">
          <ChevronDownIcon
            className={cn("h-4 w-4 transition-transform duration-150", isOpen ? "rotate-180" : "")}
          />
        </span>
      </button>

      {isOpen ? (
        <div
          className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-[8px] border border-border bg-surface py-1 [box-shadow:var(--shadow-elevated)]"
          id={listboxId}
          role="listbox"
        >
          {selectOptions.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            const optionId = `${listboxId}-option-${index}`;

            return (
              <button
                aria-selected={isSelected}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-[color,background-color] duration-100",
                  isActive ? "bg-surface-muted text-foreground" : "text-foreground",
                  isSelected ? "font-semibold" : "font-medium",
                )}
                id={optionId}
                key={option.value}
                onClick={() => selectValue(option.value)}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center text-muted">
                  {isSelected ? <CheckIcon className="h-4 w-4" /> : null}
                </span>
                {hasOptionIcons ? (
                  <span
                    aria-hidden="true"
                    className="flex h-5 w-5 shrink-0 items-center justify-center text-foreground"
                  >
                    {option.icon}
                  </span>
                ) : null}
                <span className="min-w-0 truncate">{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
