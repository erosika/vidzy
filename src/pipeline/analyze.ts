/**
 * Scene analysis for the video pipeline.
 *
 * Uses ffmpeg for scene change detection, extracts keyframes,
 * and sends them to LLM (via OpenRouter light tier) for vision analysis.
 *
 * Budget-critical: limits total frames sent to LLM.
 * Uses logarithmic density (more frames near start for hook detection).
 */

import { join, basename } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import type {
  Scene,
  ContentType,
  BoundingBox,
  MediaFile,
  TranscriptSegment,
} from "./types.ts";

// ----- Constants -----

/** Default maximum frames to send to LLM across all files. */
const DEFAULT_MAX_FRAMES = 50;

/** Scene change detection threshold (lower = more sensitive). */
const SCENE_CHANGE_THRESHOLD = 0.3;

/** Minimum scene duration in seconds. */
const MIN_SCENE_DURATION_S = 1.0;

/** Keyframe extraction timeout per frame. */
const FRAME_TIMEOUT_MS = 10_000;

// ----- Scene Detection -----

/**
 * Detect scene boundaries using ffmpeg's scene change filter.
 * Returns timestamps where scene changes occur.
 */
export async function detectSceneChanges(
  filePath: string,
  threshold = SCENE_CHANGE_THRESHOLD,
): Promise<number[]> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i", filePath,
      "-vf", `select='gt(scene,${threshold})',showinfo`,
      "-f", "null",
      "-",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const timer = setTimeout(() => proc.kill(), 120_000);
  let stderr: string;
  try {
    stderr = await new Response(proc.stderr).text();
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  // Parse showinfo output for pts_time
  const timestamps: number[] = [0]; // Always include start
  const regex = /pts_time:\s*([\d.]+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(stderr)) !== null) {
    const time = parseFloat(match[1]!);
    if (Number.isFinite(time) && time > 0) {
      timestamps.push(time);
    }
  }

  return timestamps;
}

/**
 * Build scene boundaries from change points and total duration.
 * Merges scenes that are too short.
 */
export function buildSceneBoundaries(
  changePoints: number[],
  totalDuration: number,
  minDuration = MIN_SCENE_DURATION_S,
): Array<{ start: number; end: number }> {
  if (changePoints.length === 0 || totalDuration <= 0) {
    return totalDuration > 0 ? [{ start: 0, end: totalDuration }] : [];
  }

  const sorted = [...new Set(changePoints)].sort((a, b) => a - b);
  const raw: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    const end = i + 1 < sorted.length ? sorted[i + 1]! : totalDuration;
    raw.push({ start, end });
  }

  // Merge short scenes into previous
  const merged: Array<{ start: number; end: number }> = [];
  for (const scene of raw) {
    const duration = scene.end - scene.start;
    if (duration < minDuration && merged.length > 0) {
      merged[merged.length - 1]!.end = scene.end;
    } else {
      merged.push({ ...scene });
    }
  }

  return merged;
}

// ----- Frame Sampling -----

/**
 * Calculate which frames to extract for LLM analysis.
 * Uses logarithmic density: more frames near the start of each scene
 * (for hook detection), fewer in the middle.
 *
 * Returns timestamps within the scene to sample.
 */
export function calculateFrameSampling(
  sceneDuration: number,
  maxFrames: number,
  sceneStart: number,
): number[] {
  if (maxFrames <= 0 || sceneDuration <= 0) return [];
  if (maxFrames === 1) return [sceneStart];

  const frames: number[] = [];

  // Logarithmic distribution: more density at start
  for (let i = 0; i < maxFrames; i++) {
    // Map i to [0, 1] with log density
    const t = i / (maxFrames - 1);
    // Log curve: more samples early
    const logT = Math.log1p(t * (Math.E - 1)) / 1;
    const time = sceneStart + logT * sceneDuration;
    frames.push(Math.min(time, sceneStart + sceneDuration - 0.01));
  }

  return frames;
}

/**
 * Distribute frame budget across scenes.
 * Longer scenes get more frames, but every scene gets at least 1.
 */
export function distributeFrameBudget(
  scenes: Array<{ start: number; end: number }>,
  totalBudget: number,
): number[] {
  if (scenes.length === 0) return [];

  const totalDuration = scenes.reduce((sum, s) => sum + (s.end - s.start), 0);
  if (totalDuration <= 0) return scenes.map(() => 1);

  // Give each scene at least 1 frame, distribute rest proportionally
  const minPerScene = 1;
  const remaining = Math.max(0, totalBudget - scenes.length * minPerScene);

  return scenes.map((scene) => {
    const duration = scene.end - scene.start;
    const proportion = duration / totalDuration;
    return minPerScene + Math.round(remaining * proportion);
  });
}

// ----- Keyframe Extraction -----

/**
 * Extract a single frame from a video file as JPEG.
 */
export async function extractFrame(
  videoPath: string,
  timestamp: number,
  outputPath: string,
): Promise<boolean> {
  const proc = Bun.spawn(
    [
      "ffmpeg", "-y",
      "-ss", String(timestamp),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "2",
      outputPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const timer = setTimeout(() => proc.kill(), FRAME_TIMEOUT_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  return proc.exitCode === 0;
}

/**
 * Extract multiple keyframes for a scene.
 * Returns paths to extracted JPEG files.
 */
export async function extractKeyframes(
  videoPath: string,
  timestamps: number[],
  outputDir: string,
  prefix: string,
): Promise<string[]> {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const paths: string[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const outputPath = join(outputDir, `${prefix}_${String(i).padStart(3, "0")}.jpg`);
    const success = await extractFrame(videoPath, timestamps[i]!, outputPath);
    if (success && existsSync(outputPath)) {
      paths.push(outputPath);
    }
  }

  return paths;
}

// ----- LLM Analysis Prompt -----

/**
 * Build the analysis prompt for a batch of scene frames.
 */
export function buildAnalysisPrompt(
  sceneIndex: number,
  sceneStart: number,
  sceneEnd: number,
  transcript: string,
  frameCount: number,
): string {
  return `Analyze this video scene (scene ${sceneIndex + 1}, ${sceneStart.toFixed(1)}s - ${sceneEnd.toFixed(1)}s).

${transcript ? `Transcript for this segment:\n"${transcript}"\n` : "No speech in this segment."}

${frameCount} keyframe(s) from this scene are provided.

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "description": "Brief description of what's happening in the scene",
  "contentType": "talking_head|screen_content|establishing|closeup|action|text_overlay|split_focus",
  "subjectBox": {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0} or null,
  "secondaryBox": {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0} or null,
  "energy": 0.5,
  "sensitive": false
}

Rules:
- subjectBox: bounding box of primary subject as fraction of frame (0-1). null if no clear subject.
- secondaryBox: only for split_focus content. null otherwise.
- energy: 0 = very calm/static, 1 = very dynamic/energetic
- sensitive: true if content might be inappropriate (nudity, violence, etc.)
- contentType: choose the BEST match for reframing strategy`;
}

// ----- LLM Response Parser -----

/** Parsed LLM scene analysis result. */
export interface SceneAnalysisResult {
  description: string;
  contentType: ContentType;
  subjectBox: BoundingBox | null;
  secondaryBox: BoundingBox | null;
  energy: number;
  sensitive: boolean;
}

const VALID_CONTENT_TYPES: ContentType[] = [
  "talking_head", "screen_content", "establishing",
  "closeup", "action", "text_overlay", "split_focus",
];

/**
 * Parse the LLM's JSON response for scene analysis.
 * Robust against formatting issues, partial JSON, etc.
 */
export function parseSceneAnalysis(response: string): SceneAnalysisResult | null {
  try {
    // Try to extract JSON from response (might be wrapped in markdown)
    let json = response.trim();
    const jsonMatch = json.match(/\{[\s\S]*\}/);
    if (jsonMatch) json = jsonMatch[0];

    const data = JSON.parse(json);

    // Validate content type
    let contentType: ContentType = "talking_head";
    if (VALID_CONTENT_TYPES.includes(data.contentType)) {
      contentType = data.contentType;
    }

    // Validate bounding box
    const parseBox = (box: unknown): BoundingBox | null => {
      if (!box || typeof box !== "object") return null;
      const b = box as Record<string, unknown>;
      const x = Number(b.x);
      const y = Number(b.y);
      const w = Number(b.w);
      const h = Number(b.h);
      if ([x, y, w, h].some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return null;
      return { x, y, w, h };
    };

    return {
      description: String(data.description ?? ""),
      contentType,
      subjectBox: parseBox(data.subjectBox),
      secondaryBox: parseBox(data.secondaryBox),
      energy: Math.max(0, Math.min(1, Number(data.energy ?? 0.5))),
      sensitive: Boolean(data.sensitive),
    };
  } catch {
    return null;
  }
}

/**
 * Get the transcript text for a time range.
 */
export function getTranscriptForRange(
  segments: TranscriptSegment[],
  start: number,
  end: number,
): string {
  return segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => s.text)
    .join(" ")
    .trim();
}

/**
 * Build Scene objects from boundaries and analysis results.
 */
export function buildScenes(
  boundaries: Array<{ start: number; end: number }>,
  mediaPath: string,
  analyses: Array<SceneAnalysisResult | null>,
  keyframeTimes: number[][],
): Scene[] {
  return boundaries.map((boundary, i) => {
    const analysis = analyses[i] ?? null;

    return {
      index: i,
      start: boundary.start,
      end: boundary.end,
      mediaPath,
      description: analysis?.description ?? "",
      contentType: analysis?.contentType ?? "talking_head",
      subjectBox: analysis?.subjectBox ?? null,
      energy: analysis?.energy ?? 0.5,
      sensitive: analysis?.sensitive ?? false,
      secondaryBox: analysis?.secondaryBox ?? null,
      keyframeTimes: keyframeTimes[i] ?? [],
    };
  });
}
