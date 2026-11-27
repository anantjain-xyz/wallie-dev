"use client";

import Image from "next/image";
import { useRef } from "react";

import { Spinner } from "@/components/shared/spinner";

export type SessionImageDraft = {
  attachmentId?: string;
  clientId: string;
  error?: string;
  refreshAfter?: number;
  file: File;
  fileName: string;
  previewUrl: string;
  sizeBytes: number;
  status: "error" | "local" | "ready" | "removing" | "uploading";
};

type SessionImageAttachmentsProps = {
  disabled: boolean;
  images: SessionImageDraft[];
  maxImages: number;
  onFiles: (files: File[]) => void;
  onRemove: (clientId: string) => void;
  onRetry: (clientId: string) => void;
};

export function SessionImageAttachments({
  disabled,
  images,
  maxImages,
  onFiles,
  onRemove,
  onRetry,
}: SessionImageAttachmentsProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const atLimit = images.length >= maxImages;

  function acceptFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    onFiles(Array.from(fileList));
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div
      aria-label="Session images"
      className="space-y-2"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (disabled || atLimit) return;
        acceptFiles(event.dataTransfer.files);
      }}
      role="group"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label
          className="ui-button min-h-9 cursor-pointer text-xs focus-within:ring-2 focus-within:ring-primary"
          aria-disabled={disabled || atLimit}
        >
          Add images
          <input
            ref={inputRef}
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={disabled || atLimit}
            multiple
            onChange={(event) => acceptFiles(event.currentTarget.files)}
            type="file"
          />
        </label>
        {atLimit ? <span className="type-annotation text-muted">Five images added</span> : null}
      </div>

      {images.length > 0 ? (
        <ul className="space-y-2" aria-live="polite">
          {images.map((image) => (
            <li
              className="flex items-center gap-3 rounded-[5px] border border-border bg-control-muted/40 p-2"
              key={image.clientId}
            >
              <Image
                alt={`Preview of ${image.fileName}`}
                className="h-12 w-12 shrink-0 rounded-[4px] border border-border object-cover"
                height={48}
                src={image.previewUrl}
                unoptimized
                width={48}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">{image.fileName}</p>
                <p className="type-annotation text-muted">
                  {formatBytes(image.sizeBytes)} · {statusLabel(image.status)}
                </p>
                {image.error ? <p className="mt-1 text-xs text-danger">{image.error}</p> : null}
              </div>
              {image.status === "uploading" || image.status === "removing" ? (
                <Spinner className="h-4 w-4 shrink-0" label={statusLabel(image.status)} />
              ) : (
                <div className="flex shrink-0 items-center gap-1">
                  {image.status === "error" ? (
                    <button
                      className="ui-button px-2 py-1 text-xs"
                      disabled={disabled}
                      onClick={() => onRetry(image.clientId)}
                      type="button"
                    >
                      Retry
                    </button>
                  ) : null}
                  <button
                    aria-label={`Remove ${image.fileName}`}
                    className="ui-button px-2 py-1 text-xs"
                    disabled={disabled}
                    onClick={() => onRemove(image.clientId)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(status: SessionImageDraft["status"]) {
  switch (status) {
    case "error":
      return "Needs attention";
    case "local":
      return "Will reupload";
    case "ready":
      return "Ready";
    case "removing":
      return "Removing image";
    case "uploading":
      return "Uploading image";
  }
}
