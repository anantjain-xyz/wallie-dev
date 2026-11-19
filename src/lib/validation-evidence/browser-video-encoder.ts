import "server-only";

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  BROWSER_VIDEO_FRAME_MS,
  MAX_BROWSER_VIDEO_BYTES,
  browserVideoTimelineSchema,
} from "./browser-contract";

const probeSchema = z.object({
  format: z.object({
    format_name: z.literal("matroska,webm"),
    duration: z.string(),
    size: z.string(),
  }),
  streams: z
    .array(
      z.object({
        codec_name: z.literal("vp8"),
        codec_type: z.literal("video"),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
    )
    .length(1),
  frames: z
    .array(
      z.object({
        media_type: z.literal("video"),
        best_effort_timestamp_time: z.string(),
      }),
    )
    .min(1)
    .max(13),
});

function runBinary(
  command: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal; input?: Buffer },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        signal: options.signal,
        killSignal: "SIGKILL",
        env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: "production" },
        encoding: "utf8",
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) => {
        if (error || stderr.trim()) {
          reject(new Error("Video encoding or verification failed."));
        } else {
          resolve(stdout);
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);
  });
}

export async function hasBrowserVideoEncoder(paths: { ffmpeg: string; ffprobe: string }) {
  try {
    await Promise.all([
      access(paths.ffmpeg, constants.X_OK),
      access(paths.ffprobe, constants.X_OK),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Encode complete sanitized crops only. A seekable local output provides a finite duration and index. */
export async function encodeBrowserVideo(input: {
  frames: Buffer[];
  paths: { ffmpeg: string; ffprobe: string };
  signal: AbortSignal;
}) {
  const { frames, paths, signal } = input;
  const first = frames[0];
  if (!first || frames.length > 13 || first.length < 24) throw new Error("Missing video frames.");
  const width = first.readUInt32BE(16);
  const height = first.readUInt32BE(20);
  if (
    frames.some(
      (frame) =>
        frame.length < 24 || frame.readUInt32BE(16) !== width || frame.readUInt32BE(20) !== height,
    )
  ) {
    throw new Error("The planned capture region changed size.");
  }

  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "wallie-browser-video-"));
  const path = join(directory, "capture.webm");
  try {
    await runBinary(
      paths.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        "image2pipe",
        "-framerate",
        String(1000 / BROWSER_VIDEO_FRAME_MS),
        "-c:v",
        "png",
        "-i",
        "pipe:0",
        "-an",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:black",
        "-c:v",
        "libvpx",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-deadline",
        "realtime",
        "-cpu-used",
        "6",
        "-b:v",
        "1000k",
        "-fs",
        String(MAX_BROWSER_VIDEO_BYTES + 1),
        "-f",
        "webm",
        path,
      ],
      { cwd: directory, signal, input: Buffer.concat(frames) },
    );
    const size = (await stat(path)).size;
    if (size < 1 || size > MAX_BROWSER_VIDEO_BYTES)
      throw new Error("Video exceeded its byte limit.");

    const output = await runBinary(
      paths.ffprobe,
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-err_detect",
        "explode",
        "-show_frames",
        "-show_entries",
        "format=format_name,duration,size:stream=codec_name,codec_type,width,height:frame=media_type,best_effort_timestamp_time",
        "-of",
        "json",
        path,
      ],
      { cwd: directory, signal },
    );
    const probe = probeSchema.parse(JSON.parse(output));
    const [stream] = probe.streams;
    if (
      Number(probe.format.size) !== size ||
      stream.width !== Math.ceil(width / 2) * 2 ||
      stream.height !== Math.ceil(height / 2) * 2 ||
      probe.frames.length !== frames.length
    ) {
      throw new Error("Video did not retain the complete capture.");
    }
    const timeline = browserVideoTimelineSchema.parse({
      widthPx: stream.width,
      heightPx: stream.height,
      durationMs: Number(probe.format.duration) * 1000,
      frameOffsetsMs: probe.frames.map((frame) => Number(frame.best_effort_timestamp_time) * 1000),
    });
    const bytes = await readFile(path, { signal });
    if (bytes.length !== size || bytes.readUInt32BE(0) !== 0x1a45dfa3) {
      throw new Error("The finalized video could not be read.");
    }
    return { bytes, timeline };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
