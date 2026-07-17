"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { useId, type ComponentProps, type ReactNode } from "react";

import { CheckIcon, ChevronDownIcon } from "@/components/shared/icons";
import { useOverlayContainer } from "@/components/ui/portal-root";
import { cn } from "@/lib/utils";

const RADIX_EMPTY_VALUE = "__wallie_select_empty_value__";

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

export const Select = SelectPrimitive.Root;

export function SelectTrigger({
  accessibleLabel,
  children,
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger> & { accessibleLabel: string }) {
  return (
    <SelectPrimitive.Trigger
      aria-label={accessibleLabel}
      aria-haspopup="listbox"
      className={cn("ui-select-trigger", className)}
      {...props}
    >
      {children ?? <SelectPrimitive.Value />}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="text-muted" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  children,
  className,
  collisionPadding = 8,
  position = "popper",
  sideOffset = 6,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  const container = useOverlayContainer();

  if (!container) return null;

  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Content
        className={cn("ui-select-content", className)}
        collisionPadding={collisionPadding}
        position={position}
        sideOffset={sideOffset}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  children,
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item className={cn("ui-select-item", className)} {...props}>
      <SelectPrimitive.ItemIndicator className="absolute left-2.5">
        <CheckIcon />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

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
  const selectOptions = emptyOption ? [emptyOption, ...options] : [...options];
  const selectedOption = selectOptions.find((option) => option.value === value);
  const hasOptionIcons = selectOptions.some((option) => option.icon);
  const radixValue = value === "" ? RADIX_EMPTY_VALUE : value;
  const selectedLabel =
    selectedOption?.label ?? (value || fallbackLabel || emptyOption?.label || "None");

  return (
    <div className={cn("block space-y-1.5", className)}>
      <span className="text-[13px] font-medium text-foreground" id={labelId}>
        {label}
      </span>
      <SelectPrimitive.Root
        disabled={disabled}
        onValueChange={(nextValue) =>
          onValueChange(nextValue === RADIX_EMPTY_VALUE ? "" : nextValue)
        }
        value={radixValue}
      >
        <SelectPrimitive.Trigger
          aria-haspopup="listbox"
          aria-labelledby={labelId}
          className="ui-select-trigger w-full"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selectedOption?.icon ? (
              <span
                aria-hidden="true"
                className="flex h-5 w-5 shrink-0 items-center justify-center"
              >
                {selectedOption.icon}
              </span>
            ) : null}
            <SelectPrimitive.Value>{selectedLabel}</SelectPrimitive.Value>
          </span>
          <SelectPrimitive.Icon asChild>
            <ChevronDownIcon className="text-muted" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectContent>
          {selectOptions.map((option) => (
            <SelectPrimitive.Item
              className="ui-select-item"
              key={option.value}
              value={option.value === "" ? RADIX_EMPTY_VALUE : option.value}
            >
              <SelectPrimitive.ItemIndicator className="absolute left-2.5">
                <CheckIcon />
              </SelectPrimitive.ItemIndicator>
              {hasOptionIcons ? (
                <span
                  aria-hidden="true"
                  className="flex h-5 w-5 shrink-0 items-center justify-center"
                >
                  {option.icon}
                </span>
              ) : null}
              <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
            </SelectPrimitive.Item>
          ))}
        </SelectContent>
      </SelectPrimitive.Root>
    </div>
  );
}
