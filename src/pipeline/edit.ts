/**
 * Video editing module for the pipeline.
 *
 * Generates and executes ffmpeg commands from the edit decision list.
 * Handles:
 * - Segment cutting (stream copy when possible)
 * - Audio normalization (2-pass loudnorm per clip before concat)
 * - Concatenation via ffmpeg concat demuxer
 * - SRT generation for captions
 * - Keyframe-accurate cuts
 */

import { join, basename, dirname, extname } from "node:path";
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import type {
  EditDecisionList,
  EditPoint,
  TranscriptSegment,
  MediaFile,
} from "./types.ts";

// ----- Constants -----

/** ffmpeg timeout for individual operations (5 minutes). */
const FFMPEG_TIMEOUT_MS = 300_000;

/** Normalization target loudness in LUFS. */
const TARGET_LUFS = -14;

// ----- ffmpeg Command Builders -----

/**
 * Build ffmpeg args for cutting a segment from a media file.
 *
 * Uses stream copy (-c copy) when the in-point is near a keyframe.
 * Falls back to re-encoding when precise cuts are needed.
 */
export function buildCutArgs(
  point: EditPoint,
  outputPath: string,
  reencode = false,
): string[] {
  const args: string[] = [];

  if (!reencode && !point.needsReencode) {
    // Stream copy -- fast but cut may not be frame-accurate
    // Place -ss before -i for keyframe-seeking (faster)
    args.push(
      "-ss", String(point.inPoint),
      "-i", point.mediaPath,
      "-to", String(point.outPoint - point.inPoint),
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      outputPath,
    );
  } else {
    // Re-encode for precise cuts
    args.push(
      "-ss", String(point.inPoint),
      "-i", point.mediaPath,
      "-to", String(point.outPoint - point.inPoint),
      "-c:v", "libx264",
      "-crf", "18",
      "-preset", "medium",
      "-c:a", "aac",
      "-b:a", "192k",
      "-avoid_negative_ts", "make_zero",
      outputPath,
    );
  }

  return args;
}

/**
 * Build ffmpeg args for audio normalization (2-pass loudnorm).
 *
 * Pass 1: Measure loudness (writes stats to stderr)
 * Pass 2: Apply normalization using measured values
 */
export function buildLoudnormMeasureArgs(inputPath: string): string[] {
  return [
    "-i", inputPath,
    "-af", `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`,
    "-f", "null",
    "-",
  ];
}

/**
 * Parse loudnorm measurement output from ffmpeg stderr.
 */
export function parseLoudnormStats(stderr: string): {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
} | null {
  // Find the JSON block in stderr
  const jsonMatch = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!jsonMatch) return null;

  try {
    const data = JSON.parse(jsonMatch[0]);
    return {
      inputI: parseFloat(data.input_i),
      inputTp: parseFloat(data.input_tp),
      inputLra: parseFloat(data.input_lra),
      inputThresh: parseFloat(data.input_thresh),
      targetOffset: parseFloat(data.target_offset),
    };
  } catch {
    return null;
  }
}

/**
 * Build loudnorm apply args using measured stats.
 */
export function buildLoudnormApplyArgs(
  inputPath: string,
  outputPath: string,
  stats: {
    inputI: number;
    inputTp: number;
    inputLra: number;
    inputThresh: number;
    targetOffset: number;
  },
): string[] {
  const filter = [
    `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11`,
    `measured_I=${stats.inputI}`,
    `measured_TP=${stats.inputTp}`,
    `measured_LRA=${stats.inputLra}`,
    `measured_thresh=${stats.inputThresh}`,
    `offset=${stats.targetOffset}`,
    "linear=true",
  ].join(":");

  return [
    "-i", inputPath,
    "-af", filter,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    outputPath,
  ];
}

// ----- Concat -----

/**
 * Build a concat list file for ffmpeg's concat demuxer.
 * Returns the content for the list file.
 */
export function buildConcatList(segmentPaths: string[]): string {
  return segmentPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
}

/**
 * Build ffmpeg args for concatenation.
 */
export function buildConcatArgs(
  listFilePath: string,
  outputPath: string,
  reencode = false,
): string[] {
  if (reencode) {
    return [
      "-f", "concat",
      "-safe", "0",
      "-i", listFilePath,
      "-c:v", "libx264",
      "-crf", "18",
      "-preset", "medium",
      "-c:a", "aac",
      "-b:a", "192k",
      outputPath,
    ];
  }

  return [
    "-f", "concat",
    "-safe", "0",
    "-i", listFilePath,
    "-c", "copy",
    outputPath,
  ];
}

// ----- Transition Support -----

/**
 * Build ffmpeg filter for a dissolve transition between two clips.
 */
export function buildDissolveFilter(
  durationS: number,
  clip1Duration: number,
): string {
  const offset = clip1Duration - durationS;
  return `xfade=transition=fade:duration=${durationS}:offset=${offset}`;
}

/**
 * Build ffmpeg filter for a fade-to-black transition.
 */
export function buildFadeBlackFilter(
  clipDuration: number,
  fadeDuration: number,
): string {
  const start = clipDuration - fadeDuration;
  return `fade=t=out:st=${start}:d=${fadeDuration}`;
}

// ----- SRT from EDL -----

/**
 * Generate SRT subtitles aligned to the edit timeline.
 *
 * Takes the original transcript segments and remaps them to
 * the edited timeline based on the EDL points.
 */
export function generateEditedSrt(
  edl: EditDecisionList,
  transcriptSegments: TranscriptSegment[],
): string {
  const remapped: TranscriptSegment[] = [];
  let timelineOffset = 0;

  for (const point of edl.points) {
    const duration = point.outPoint - point.inPoint;

    // Find transcript segments that overlap this edit point
    const overlapping = transcriptSegments.filter(
      (s) => s.end > point.inPoint && s.start < point.outPoint,
    );

    for (const seg of overlapping) {
      // Remap to timeline position
      const relStart = Math.max(0, seg.start - point.inPoint);
      const relEnd = Math.min(duration, seg.end - point.inPoint);

      if (relEnd > relStart) {
        remapped.push({
          start: timelineOffset + relStart,
          end: timelineOffset + relEnd,
          text: seg.text,
          confidence: seg.confidence,
        });
      }
    }

    timelineOffset += duration;
  }

  // Generate SRT from remapped segments
  return remapped
    .map((seg, i) => {
      const startTime = formatSrtTimecode(seg.start);
      const endTime = formatSrtTimecode(seg.end);
      return `${i + 1}\n${startTime} --> ${endTime}\n${seg.text}\n`;
    })
    .join("\n");
}

/**
 * Format seconds as SRT timecode.
 */
function formatSrtTimecode(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);

  return (
    String(h).padStart(2, "0") + ":" +
    String(m).padStart(2, "0") + ":" +
    String(s).padStart(2, "0") + "," +
    String(ms).padStart(3, "0")
  );
}

// ----- Keyframe Proximity -----

/**
 * Check if a timestamp is near a keyframe.
 * If so, stream copy is safe; otherwise re-encoding is needed for accuracy.
 *
 * Returns true if the difference is within the threshold.
 */
export function isNearKeyframe(
  timestamp: number,
  keyframeInterval: number,
  thresholdS = 0.1,
): boolean {
  if (keyframeInterval <= 0) return false;
  const nearest = Math.round(timestamp / keyframeInterval) * keyframeInterval;
  return Math.abs(timestamp - nearest) <= thresholdS;
}

/**
 * Estimate keyframe interval from FPS and typical GOP size.
 * Most h264 encoders use GOP = 2-4 seconds.
 */
export function estimateKeyframeInterval(fps: number): number {
  if (fps <= 0) return 2; // safe default
  // Typical GOP: 2 seconds or 250 frames, whichever is smaller
  return Math.min(2, 250 / fps);
}

// ----- Edit Point Optimization -----

/**
 * Determine which edit points need re-encoding vs stream copy.
 * Updates needsReencode flag based on keyframe proximity and transitions.
 */
export function optimizeEditPoints(
  points: EditPoint[],
  fps: number,
): EditPoint[] {
  const keyframeInterval = estimateKeyframeInterval(fps);

  return points.map((point) => {
    // Transitions always need re-encoding
    if (point.transitionToNext === "dissolve" || point.transitionToNext === "fade_black") {
      return { ...point, needsReencode: true };
    }

    // B-roll insertions need re-encoding for precise timing
    if (point.role === "broll" || point.role === "cold_open") {
      return { ...point, needsReencode: true };
    }

    // Check keyframe proximity
    const inNear = isNearKeyframe(point.inPoint, keyframeInterval);
    const outNear = isNearKeyframe(point.outPoint, keyframeInterval);

    return { ...point, needsReencode: !inNear || !outNear };
  });
}

// ----- Codec Detection -----

/**
 * Check if all files share the same codec and format.
 * If not, concatenation requires re-encoding.
 */
export function needsConcatReencode(files: MediaFile[]): boolean {
  if (files.length <= 1) return false;

  const codecs = new Set(files.map((f) => f.codec));
  const pixFmts = new Set(files.map((f) => f.pixelFormat));
  const widths = new Set(files.map((f) => f.width));
  const heights = new Set(files.map((f) => f.height));

  return codecs.size > 1 || pixFmts.size > 1 || widths.size > 1 || heights.size > 1;
}
