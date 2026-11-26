"use client";

import type { ComponentProps } from "react";

export function AnalyticsScorerSelectionForm({
  unchanged,
  ...props
}: ComponentProps<"form"> & {
  unchanged?: { name: string; value?: string };
}) {
  return (
    <form
      {...props}
      onSubmit={(event) => {
        if (
          unchanged?.value &&
          new FormData(event.currentTarget).get(unchanged.name) === unchanged.value
        ) {
          event.preventDefault();
        }
      }}
    />
  );
}
