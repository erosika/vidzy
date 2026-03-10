/**
 * ffmpeg/ffprobe subprocess wrappers.
 *
 * All video processing goes through these two functions.
 * Uses Bun.spawn with timeout + concurrent pipe reads.
 */

import { extname } from "node:path";

// ----- Constants -----

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"];
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"];

// ----- Types -----

/** Result of probing a media file. */
export interface MediaProbe {
  path: string;
  format: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audioCodec: string | null;
  fileSizeBytes: number;
}

// ----- Probe -----

/**
 * Probe a media file for technical metadata.
 */
export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const timer = setTimeout(() => proc.kill(), 30_000);
  let stdout: string;
  try {
    stdout = await new Response(proc.stdout).text();
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  const data = JSON.parse(stdout);
  const videoStream = data.streams?.find(
    (s: Record<string, unknown>) => s.codec_type === "video",
  );
  const audioStream = data.streams?.find(
    (s: Record<string, unknown>) => s.codec_type === "audio",
  );
  const format = data.format ?? {};

  return {
    path: filePath,
    format: format.format_name ?? "unknown",
    duration: parseFloat(format.duration ?? "0"),
    width: videoStream?.width ?? 0,
    height: videoStream?.height ?? 0,
    fps: parseFloat(videoStream?.r_frame_rate?.split("/")[0] ?? "0") /
      parseFloat(videoStream?.r_frame_rate?.split("/")[1] ?? "1"),
    codec: videoStream?.codec_name ?? "unknown",
    audioCodec: audioStream?.codec_name ?? null,
    fileSizeBytes: parseInt(format.size ?? "0", 10),
  };
}

// ----- Run -----

/**
 * Run an ffmpeg command with timeout.
 */
export async function runFfmpeg(
  args: string[],
  timeoutMs = 300_000,
): Promise<{ success: boolean; stdout: string; stderr: string; durationMs: number }> {
  const startMs = Date.now();
  const proc = Bun.spawn(["ffmpeg", "-y", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  let stdout: string;
  let stderr: string;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }

  return {
    success: exitCode === 0,
    stdout,
    stderr: stderr.slice(-2000),
    durationMs: Date.now() - startMs,
  };
}

// ----- Helpers -----

/** Check if a file is a recognized video format. */
export function isVideoFile(path: string): boolean {
  return VIDEO_EXTENSIONS.includes(extname(path).toLowerCase());
}

/** Check if a file is a recognized audio format. */
export function isAudioFile(path: string): boolean {
  return AUDIO_EXTENSIONS.includes(extname(path).toLowerCase());
}
