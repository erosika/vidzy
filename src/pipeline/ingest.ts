/**
 * Media ingestion for the video pipeline.
 *
 * Discovers media files in a source directory, probes each with ffprobe
 * for extended metadata, detects VFR, deduplicates, classifies content,
 * and sorts by creation time.
 *
 * Edge cases handled:
 * - Mixed formats (MOV/HEVC, MP4/H.264, etc.)
 * - VFR detection (phone recordings) via frame timestamp sampling
 * - Dedup via fast fingerprint (first 8KB hash + file size)
 * - Junk filtering (.DS_Store, clips < 1s, corrupt files)
 * - Rotation metadata from phones
 * - Camera make/model from metadata
 */

import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";
import type { MediaFile, MediaClassification, ProjectManifest } from "./types.ts";

// ----- Constants -----

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v",
  ".mts", ".m2ts", ".ts", ".flv", ".wmv", ".3gp",
]);

const AUDIO_ONLY_EXTENSIONS = new Set([
  ".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".wma",
]);

const JUNK_FILENAMES = new Set([
  ".ds_store", "thumbs.db", "desktop.ini", ".gitkeep",
]);

/** Minimum duration in seconds for a valid clip. */
const MIN_DURATION_S = 1.0;

/** Size of the fingerprint sample in bytes. */
const FINGERPRINT_BYTES = 8192;

/** ffprobe timeout in ms. */
const PROBE_TIMEOUT_MS = 30_000;

// ----- Probe -----

/** Raw ffprobe JSON shape (subset we parse). */
interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    pix_fmt?: string;
    sample_rate?: string;
    channels?: number;
    tags?: Record<string, string>;
    side_data_list?: Array<{
      rotation?: number;
      side_data_type?: string;
    }>;
    display_aspect_ratio?: string;
  }>;
}

/**
 * Run ffprobe on a file and return parsed JSON.
 */
async function runFfprobe(filePath: string): Promise<FfprobeOutput> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      "-show_entries", "stream_side_data",
      filePath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
  let stdout: string;
  try {
    stdout = await new Response(proc.stdout).text();
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  return JSON.parse(stdout) as FfprobeOutput;
}

/**
 * Probe a media file for extended metadata.
 * Returns a fully populated MediaFile (except classification, which is set later).
 */
export async function probeMediaExtended(filePath: string, filename: string): Promise<MediaFile> {
  const data = await runFfprobe(filePath);

  const videoStream = data.streams?.find((s) => s.codec_type === "video");
  const audioStream = data.streams?.find((s) => s.codec_type === "audio");
  const format = data.format ?? {};

  // Parse frame rate
  const fpsStr = videoStream?.r_frame_rate ?? videoStream?.avg_frame_rate ?? "0/1";
  const fpsParts = fpsStr.split("/");
  const fps = parseFloat(fpsParts[0] ?? "0") / parseFloat(fpsParts[1] ?? "1");

  // Parse rotation from side data or tags
  let rotation = 0;
  const sideData = videoStream?.side_data_list?.find(
    (sd) => sd.side_data_type === "Display Matrix" || sd.rotation !== undefined,
  );
  if (sideData?.rotation !== undefined) {
    rotation = Math.abs(sideData.rotation);
  } else {
    const rotateTag = videoStream?.tags?.rotate;
    if (rotateTag) rotation = Math.abs(parseInt(rotateTag, 10)) || 0;
  }

  // Normalize rotation to 0/90/180/270
  rotation = rotation % 360;
  if (![0, 90, 180, 270].includes(rotation)) rotation = 0;

  // Camera make/model from format tags
  const cameraMake = format.tags?.make ?? format.tags?.Make ?? format.tags?.MAKE ?? null;
  const cameraModel = format.tags?.model ?? format.tags?.Model ?? format.tags?.MODEL ?? null;

  // Creation time
  const creationTime =
    format.tags?.creation_time ??
    format.tags?.Creation_time ??
    videoStream?.tags?.creation_time ??
    null;

  // Bitrate
  const bitrateStr = videoStream?.tags?.BPS ?? format.bit_rate;
  const bitrate = bitrateStr ? parseInt(String(bitrateStr), 10) || null : null;

  // Fingerprint
  const fingerprint = await computeFingerprint(filePath);

  return {
    path: filePath,
    filename,
    format: format.format_name ?? "unknown",
    duration: parseFloat(format.duration ?? "0"),
    width: videoStream?.width ?? 0,
    height: videoStream?.height ?? 0,
    fps: Number.isFinite(fps) ? fps : 0,
    codec: videoStream?.codec_name ?? "unknown",
    pixelFormat: videoStream?.pix_fmt ?? "unknown",
    audioCodec: audioStream?.codec_name ?? null,
    audioSampleRate: audioStream?.sample_rate ? parseInt(audioStream.sample_rate, 10) : null,
    audioChannels: audioStream?.channels ?? null,
    fileSizeBytes: parseInt(format.size ?? "0", 10),
    createdAt: creationTime ?? new Date().toISOString(),
    isVfr: false, // Set by VFR detection pass
    rotation,
    cameraMake,
    cameraModel,
    bitrate,
    classification: "primary", // Default, refined by classify()
    fingerprint,
  };
}

// ----- VFR Detection -----

/**
 * Detect variable frame rate by sampling frame timestamps.
 *
 * Samples N frames from the beginning of the file and checks if the
 * inter-frame intervals are consistent. If the standard deviation of
 * intervals exceeds 10% of the mean, it's VFR.
 */
export async function detectVfr(filePath: string, sampleFrames = 60): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      [
        "ffprobe",
        "-v", "quiet",
        "-select_streams", "v:0",
        "-show_entries", "frame=pts_time",
        "-of", "csv=p=0",
        "-read_intervals", "%+#" + sampleFrames,
        filePath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
    let stdout: string;
    try {
      stdout = await new Response(proc.stdout).text();
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    const timestamps = stdout
      .trim()
      .split("\n")
      .map((line) => parseFloat(line.trim()))
      .filter((t) => Number.isFinite(t));

    if (timestamps.length < 3) return false;

    // Calculate inter-frame intervals
    const intervals: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i]! - timestamps[i - 1]!);
    }

    const mean = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
    if (mean <= 0) return false;

    const variance = intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intervals.length;
    const stddev = Math.sqrt(variance);

    // If stddev > 10% of mean, it's VFR
    return stddev / mean > 0.1;
  } catch {
    return false; // Assume CFR on probe failure
  }
}

// ----- Fingerprinting -----

/**
 * Compute a fast dedup fingerprint: SHA-256 of first 8KB + file size.
 */
async function computeFingerprint(filePath: string): Promise<string> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    const slice = file.slice(0, FINGERPRINT_BYTES);
    const buffer = await slice.arrayBuffer();
    const hash = createHash("sha256");
    hash.update(new Uint8Array(buffer));
    hash.update(`:${size}`);
    return hash.digest("hex");
  } catch {
    return `error:${filePath}`;
  }
}

// ----- Classification -----

/**
 * Classify a media file based on its probe data.
 *
 * Rules:
 * - No video stream -> voicememo
 * - Duration < 1s -> junk
 * - No audio -> broll
 * - Otherwise -> primary (refined later by transcription analysis)
 */
export function classifyMedia(file: MediaFile): MediaClassification {
  // Audio-only (no video dimensions)
  if (file.width === 0 && file.height === 0) {
    return "voicememo";
  }

  // Too short
  if (file.duration < MIN_DURATION_S) {
    return "junk";
  }

  // Corrupt (no codec detected)
  if (file.codec === "unknown" && file.format === "unknown") {
    return "junk";
  }

  // No audio track -> likely b-roll
  if (!file.audioCodec) {
    return "broll";
  }

  // Default: primary footage (may be reclassified after transcription)
  return "primary";
}

// ----- Deduplication -----

/**
 * Remove duplicate files based on fingerprint.
 * Keeps the first occurrence (sorted by creation time).
 */
export function deduplicateFiles(files: MediaFile[]): {
  unique: MediaFile[];
  duplicates: MediaFile[];
} {
  const seen = new Map<string, MediaFile>();
  const duplicates: MediaFile[] = [];

  for (const file of files) {
    if (file.fingerprint.startsWith("error:")) {
      // Can't fingerprint, keep it
      seen.set(file.path, file);
      continue;
    }

    if (seen.has(file.fingerprint)) {
      duplicates.push(file);
    } else {
      seen.set(file.fingerprint, file);
    }
  }

  return {
    unique: Array.from(seen.values()),
    duplicates,
  };
}

// ----- Discovery -----

/**
 * Check if a filename is a recognized media file.
 */
export function isMediaFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext) || AUDIO_ONLY_EXTENSIONS.has(ext);
}

/**
 * Check if a filename should be skipped (junk, hidden, etc.).
 */
export function isJunkFile(filename: string): boolean {
  if (filename.startsWith(".")) return true;
  if (JUNK_FILENAMES.has(filename.toLowerCase())) return true;
  return false;
}

/**
 * Discover media files in a directory (non-recursive).
 * Returns filenames sorted alphabetically.
 */
export async function discoverMedia(sourceDir: string): Promise<string[]> {
  const entries = await readdir(sourceDir);
  return entries
    .filter((name) => !isJunkFile(name) && isMediaFile(name))
    .sort();
}

// ----- Full Ingest Pipeline -----

/**
 * Run the full ingest phase:
 * 1. Discover media files
 * 2. Probe each file
 * 3. Detect VFR
 * 4. Classify
 * 5. Deduplicate
 * 6. Sort by creation time
 *
 * Returns the populated files array for the manifest.
 */
export async function ingest(
  sourceDir: string,
  onProgress?: (current: number, total: number, file: string) => void,
): Promise<{ files: MediaFile[]; duplicates: MediaFile[]; junk: string[] }> {
  // 1. Discover
  const filenames = await discoverMedia(sourceDir);
  const junk: string[] = [];

  if (filenames.length === 0) {
    return { files: [], duplicates: [], junk: [] };
  }

  // 2. Probe each file
  const probed: MediaFile[] = [];
  for (let i = 0; i < filenames.length; i++) {
    const name = filenames[i]!;
    const filePath = join(sourceDir, name);

    onProgress?.(i + 1, filenames.length, name);

    try {
      const file = await probeMediaExtended(filePath, name);

      // 3. Detect VFR (only for video files)
      if (file.width > 0 && file.height > 0) {
        file.isVfr = await detectVfr(filePath);
      }

      // 4. Classify
      file.classification = classifyMedia(file);

      if (file.classification === "junk") {
        junk.push(name);
      } else {
        probed.push(file);
      }
    } catch {
      // Probe failure -> junk
      junk.push(name);
    }
  }

  // 5. Deduplicate
  const { unique, duplicates } = deduplicateFiles(probed);

  // 6. Sort by creation time
  unique.sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta - tb;
  });

  return { files: unique, duplicates, junk };
}

/**
 * Find which files need VFR normalization (conversion to CFR).
 * Returns paths of VFR files.
 */
export function findVfrFiles(files: MediaFile[]): MediaFile[] {
  return files.filter((f) => f.isVfr);
}

/**
 * Detect codec mismatches that would require normalization before concat.
 * Returns true if files have inconsistent codecs.
 */
export function hasCodecMismatch(files: MediaFile[]): boolean {
  const videoFiles = files.filter((f) => f.width > 0 && f.height > 0);
  if (videoFiles.length <= 1) return false;

  const codecs = new Set(videoFiles.map((f) => f.codec));
  const pixFmts = new Set(videoFiles.map((f) => f.pixelFormat));

  return codecs.size > 1 || pixFmts.size > 1;
}
