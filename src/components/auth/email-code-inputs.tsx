"use client";

import { useRef } from "react";

const CODE_LENGTH = 6;
const COMPLETE_CODE_PATTERN = /^[\s-]*\d(?:[\s-]*\d){5}[\s-]*$/;

export type EmailCodeDigitUpdate = {
  clearExistingDigits: boolean;
  digits: string;
  startIndex: number;
};

export function getEmailCodeDigitUpdate(
  startIndex: number,
  value: string,
): EmailCodeDigitUpdate | null {
  const normalizedCompleteCode = normalizeCompleteEmailCode(value);

  if (normalizedCompleteCode) {
    return {
      clearExistingDigits: true,
      digits: normalizedCompleteCode,
      startIndex: 0,
    };
  }

  const digits = value.replace(/\D/g, "").slice(0, CODE_LENGTH - startIndex);

  if (!digits) {
    return null;
  }

  return {
    clearExistingDigits: false,
    digits,
    startIndex,
  };
}

export function normalizeCompleteEmailCode(value: string) {
  const digits = value.replace(/\D/g, "");

  if (digits.length !== CODE_LENGTH || !COMPLETE_CODE_PATTERN.test(value)) {
    return null;
  }

  return digits;
}

export function EmailCodeInputs() {
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const autoSubmittedRef = useRef(false);

  function focusInput(index: number) {
    inputRefs.current[index]?.focus();
    inputRefs.current[index]?.select();
  }

  function maybeSubmitCompletedCode() {
    if (autoSubmittedRef.current) {
      return;
    }

    const token = Array.from(
      { length: CODE_LENGTH },
      (_, index) => inputRefs.current[index]?.value ?? "",
    ).join("");

    if (!/^\d{6}$/.test(token)) {
      return;
    }

    const form = inputRefs.current[0]?.form;

    if (!form) {
      return;
    }

    autoSubmittedRef.current = true;
    form.requestSubmit();
  }

  function setDigits(startIndex: number, value: string) {
    const update = getEmailCodeDigitUpdate(startIndex, value);

    if (!update) {
      return;
    }

    if (update.clearExistingDigits) {
      inputRefs.current.forEach((input) => {
        if (input) {
          input.value = "";
        }
      });
    }

    update.digits.split("").forEach((digit, offset) => {
      const input = inputRefs.current[update.startIndex + offset];

      if (input) {
        input.value = digit;
      }
    });

    focusInput(Math.min(update.startIndex + update.digits.length, CODE_LENGTH - 1));
    maybeSubmitCompletedCode();
  }

  return (
    <div className="grid grid-cols-6 gap-2" aria-label="Six-digit code">
      {Array.from({ length: CODE_LENGTH }, (_, index) => (
        <input
          key={index}
          ref={(element) => {
            inputRefs.current[index] = element;
          }}
          type="text"
          name="tokenDigit"
          required
          autoComplete={index === 0 ? "one-time-code" : "off"}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          aria-label={`Digit ${index + 1} of ${CODE_LENGTH}`}
          className="ui-input aspect-square min-h-0 min-w-0 px-0 text-center font-mono text-[22px] leading-none"
          onChange={(event) => {
            const value = event.currentTarget.value;

            if (value.length > 1) {
              setDigits(index, value);
              return;
            }

            event.currentTarget.value = value.replace(/\D/g, "");

            if (event.currentTarget.value && index < CODE_LENGTH - 1) {
              focusInput(index + 1);
            }

            maybeSubmitCompletedCode();
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && !event.currentTarget.value && index > 0) {
              focusInput(index - 1);
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            setDigits(index, event.clipboardData.getData("text"));
          }}
        />
      ))}
    </div>
  );
}
