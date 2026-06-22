import "server-only";

import { headers } from "next/headers";

type TimingMetadataValue = boolean | number | string | null | undefined;
type TimingMetadata = Record<string, TimingMetadataValue>;

type TimingSegment = {
  durationMs: number;
  metadata: TimingMetadata;
  name: string;
  ok: boolean;
};

type TimingSegmentMetadata<T> = TimingMetadata | ((result: T) => TimingMetadata);

export type ServerTimingCollector = {
  segment<T>(
    name: string,
    operation: () => PromiseLike<T> | T,
    metadata?: TimingSegmentMetadata<T>,
  ): Promise<T>;
};

const noopCollector: ServerTimingCollector = {
  async segment(_name, operation) {
    return operation();
  },
};

function timingLogsEnabled() {
  return process.env.WALLIE_TIMING_LOGS === "1";
}

function roundDuration(durationMs: number) {
  return Math.round(durationMs * 10) / 10;
}

async function getRequestMetadata() {
  try {
    const headerStore = await headers();

    return {
      deploymentRegion: process.env.VERCEL_REGION ?? null,
      requestId: headerStore.get("x-vercel-id") ?? headerStore.get("x-request-id") ?? null,
    };
  } catch {
    return {
      deploymentRegion: process.env.VERCEL_REGION ?? null,
      requestId: null,
    };
  }
}

function resolveSegmentMetadata<T>(
  metadata: TimingSegmentMetadata<T> | undefined,
  result: T,
): TimingMetadata {
  if (!metadata) return {};
  return typeof metadata === "function" ? metadata(result) : metadata;
}

export function approximatePayloadSizeBytes(value: unknown) {
  try {
    const json = JSON.stringify(value);
    return json ? Buffer.byteLength(json, "utf8") : 0;
  } catch {
    return null;
  }
}

export async function withServerTiming<T>(
  name: string,
  metadata: TimingMetadata,
  operation: (timing: ServerTimingCollector) => Promise<T>,
): Promise<T> {
  if (!timingLogsEnabled()) {
    return operation(noopCollector);
  }

  const requestMetadata = await getRequestMetadata();
  const startedAt = performance.now();
  const segments: TimingSegment[] = [];

  const timing: ServerTimingCollector = {
    async segment(segmentName, segmentOperation, segmentMetadata) {
      const segmentStartedAt = performance.now();

      try {
        const result = await segmentOperation();
        segments.push({
          durationMs: roundDuration(performance.now() - segmentStartedAt),
          metadata: resolveSegmentMetadata(segmentMetadata, result),
          name: segmentName,
          ok: true,
        });
        return result;
      } catch (error) {
        segments.push({
          durationMs: roundDuration(performance.now() - segmentStartedAt),
          metadata: {
            error: error instanceof Error ? error.message : String(error),
          },
          name: segmentName,
          ok: false,
        });
        throw error;
      }
    },
  };

  try {
    const result = await operation(timing);
    console.info("[server-timing]", {
      durationMs: roundDuration(performance.now() - startedAt),
      ...requestMetadata,
      ...metadata,
      name,
      ok: true,
      segments,
    });
    return result;
  } catch (error) {
    console.error("[server-timing]", {
      durationMs: roundDuration(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
      ...requestMetadata,
      ...metadata,
      name,
      ok: false,
      segments,
    });
    throw error;
  }
}
