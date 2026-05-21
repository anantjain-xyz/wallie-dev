"use client";

import { useRef } from "react";

const CODE_LENGTH = 6;

export function EmailCodeInputs() {
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  function focusInput(index: number) {
    inputRefs.current[index]?.focus();
    inputRefs.current[index]?.select();
  }

  function setDigits(startIndex: number, value: string) {
    const digits = value.replace(/\D/g, "").slice(0, CODE_LENGTH - startIndex);

    if (!digits) {
      return;
    }

    digits.split("").forEach((digit, offset) => {
      const input = inputRefs.current[startIndex + offset];

      if (input) {
        input.value = digit;
      }
    });

    focusInput(Math.min(startIndex + digits.length, CODE_LENGTH - 1));
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
