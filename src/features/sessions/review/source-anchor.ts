/**
 * Offsets count Unicode code points in the exact persisted Markdown source.
 * The selected range is zero-based and end-exclusive. Do not normalize line
 * endings, Unicode, whitespace, or rendered Markdown before using this contract.
 * Code points deliberately differ from UTF-16 offsets and grapheme clusters.
 */
export type ArtifactSourceAnchor = Readonly<{
  coordinateSystem: "unicode_code_points";
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
}>;

const CONTEXT_LENGTH = 32;
const MAX_CONTEXT_LENGTH = 128;
const MAX_QUOTE_LENGTH = 10_000;

function hasLoneSurrogate(points: string[]): boolean {
  return points.some((point) => {
    const unit = point.charCodeAt(0);
    return point.length === 1 && unit >= 0xd800 && unit <= 0xdfff;
  });
}

function validRange(start: number, end: number, length: number): boolean {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end > start &&
    end - start <= MAX_QUOTE_LENGTH &&
    end <= length
  );
}

export function createArtifactSourceAnchor(
  source: string,
  start: number,
  end: number,
): ArtifactSourceAnchor {
  const points = Array.from(source);
  if (hasLoneSurrogate(points)) {
    throw new RangeError("Artifact source must contain valid Unicode scalar values.");
  }
  if (!validRange(start, end, points.length)) {
    throw new RangeError("Artifact source anchor must select between 1 and 10000 code points.");
  }

  return {
    coordinateSystem: "unicode_code_points",
    start,
    end,
    quote: points.slice(start, end).join(""),
    prefix: points.slice(Math.max(0, start - CONTEXT_LENGTH), start).join(""),
    suffix: points.slice(end, end + CONTEXT_LENGTH).join(""),
  };
}

/** Validate an external anchor against its immutable artifact source. */
export function validateArtifactSourceAnchor(
  source: string,
  anchor: unknown,
): anchor is ArtifactSourceAnchor {
  if (typeof anchor !== "object" || anchor === null) return false;

  const candidate = anchor as Record<string, unknown>;
  if (
    candidate.coordinateSystem !== "unicode_code_points" ||
    typeof candidate.start !== "number" ||
    typeof candidate.end !== "number" ||
    typeof candidate.quote !== "string" ||
    typeof candidate.prefix !== "string" ||
    typeof candidate.suffix !== "string"
  ) {
    return false;
  }

  const points = Array.from(source);
  if (hasLoneSurrogate(points) || !validRange(candidate.start, candidate.end, points.length)) {
    return false;
  }

  const prefixLength = Array.from(candidate.prefix).length;
  const suffixLength = Array.from(candidate.suffix).length;
  if (
    prefixLength < Math.min(CONTEXT_LENGTH, candidate.start) ||
    prefixLength > MAX_CONTEXT_LENGTH ||
    suffixLength < Math.min(CONTEXT_LENGTH, points.length - candidate.end) ||
    suffixLength > MAX_CONTEXT_LENGTH
  ) {
    return false;
  }

  return (
    points.slice(candidate.start, candidate.end).join("") === candidate.quote &&
    points.slice(Math.max(0, candidate.start - prefixLength), candidate.start).join("") ===
      candidate.prefix &&
    points.slice(candidate.end, candidate.end + suffixLength).join("") === candidate.suffix
  );
}
