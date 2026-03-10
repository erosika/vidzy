/**
 * Transcription module for the video pipeline.
 *
 * Primary: whisper.cpp CLI (local, free)
 * Fallback: OpenAI Whisper API (cloud, paid)
 *
 * Handles:
 * - Audio extraction to 16kHz mono WAV
 * - Long file splitting at silence boundaries (>30min)
 * - SRT and JSON output parsing
 * - Confidence scoring per segment
 * - Silence detection
 */

import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import type { TranscriptSegment, Transcript, MediaFile } from "./types.ts";

// ----- Constants -----

/** Maximum duration (seconds) before splitting for whisper. */
const MAX_CHUNK_DURATION_S = 30 * 60; // 30 minutes

/** Overlap duration when splitting chunks. */
const CHUNK_OVERLAP_S = 5;

/** Confidence threshold below which a segment is considered silence. */
const SILENCE_CONFIDENCE_THRESHOLD = 0.3;

/** Default whisper model. */
const DEFAULT_WHISPER_MODEL = "base.en";

/** Audio extraction timeout. */
const EXTRACT_TIMEOUT_MS = 120_000; // 2 minutes

/** Whisper CLI timeout per chunk. */
const WHISPER_TIMEOUT_MS = 600_000; // 10 minutes

// ----- Audio Extraction -----

/**
 * Extract audio from a media file as 16kHz mono WAV.
 * This is the format whisper.cpp expects.
 */
export async function extractAudio(
  inputPath: string,
  outputPath: string,
): Promise<{ success: boolean; durationMs: number }> {
  const startMs = Date.now();
  const proc = Bun.spawn(
    [
      "ffmpeg", "-y",
      "-i", inputPath,
      "-ar", "16000",    // 16kHz sample rate
      "-ac", "1",        // mono
      "-c:a", "pcm_s16le", // 16-bit PCM
      "-vn",             // no video
      outputPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const timer = setTimeout(() => proc.kill(), EXTRACT_TIMEOUT_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  return {
    success: proc.exitCode === 0,
    durationMs: Date.now() - startMs,
  };
}

// ----- SRT Parser -----

/**
 * Parse an SRT subtitle file into transcript segments.
 *
 * SRT format:
 * ```
 * 1
 * 00:00:01,000 --> 00:00:03,500
 * Hello world
 *
 * 2
 * 00:00:04,000 --> 00:00:06,000
 * Second line
 * ```
 */
export function parseSrt(content: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const blocks = content.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;

    // Line 1: sequence number (skip)
    // Line 2: timecodes
    const timeMatch = lines[1]!.match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/,
    );
    if (!timeMatch) continue;

    const start =
      parseInt(timeMatch[1]!, 10) * 3600 +
      parseInt(timeMatch[2]!, 10) * 60 +
      parseInt(timeMatch[3]!, 10) +
      parseInt(timeMatch[4]!, 10) / 1000;

    const end =
      parseInt(timeMatch[5]!, 10) * 3600 +
      parseInt(timeMatch[6]!, 10) * 60 +
      parseInt(timeMatch[7]!, 10) +
      parseInt(timeMatch[8]!, 10) / 1000;

    // Lines 3+: text
    const text = lines.slice(2).join(" ").trim();
    if (!text) continue;

    segments.push({
      start,
      end,
      text,
      confidence: 1.0, // SRT doesn't have confidence -- default to 1.0
    });
  }

  return segments;
}

// ----- Whisper JSON Parser -----

/** Shape of whisper.cpp JSON output (subset). */
interface WhisperJsonOutput {
  transcription?: Array<{
    timestamps?: { from: string; to: string };
    offsets?: { from: number; to: number };
    text?: string;
    confidence?: number;
  }>;
  segments?: Array<{
    start?: number;
    end?: number;
    t0?: number;
    t1?: number;
    text?: string;
    confidence?: number;
    avg_logprob?: number;
    no_speech_prob?: number;
  }>;
}

/**
 * Parse whisper.cpp JSON output into transcript segments.
 * Handles both the "transcription" format and the "segments" format.
 */
export function parseWhisperJson(content: string): TranscriptSegment[] {
  const data = JSON.parse(content) as WhisperJsonOutput;
  const segments: TranscriptSegment[] = [];

  // Format 1: transcription array (whisper.cpp default)
  if (data.transcription) {
    for (const item of data.transcription) {
      const text = item.text?.trim();
      if (!text) continue;

      let start = 0;
      let end = 0;

      if (item.offsets) {
        start = item.offsets.from / 1000; // ms to seconds
        end = item.offsets.to / 1000;
      } else if (item.timestamps) {
        start = parseTimestamp(item.timestamps.from);
        end = parseTimestamp(item.timestamps.to);
      }

      segments.push({
        start,
        end,
        text,
        confidence: item.confidence ?? 1.0,
      });
    }
    return segments;
  }

  // Format 2: segments array (OpenAI whisper / some whisper.cpp builds)
  if (data.segments) {
    for (const seg of data.segments) {
      const text = seg.text?.trim();
      if (!text) continue;

      const start = seg.start ?? (seg.t0 != null ? seg.t0 / 100 : 0);
      const end = seg.end ?? (seg.t1 != null ? seg.t1 / 100 : 0);

      // Convert avg_logprob to confidence (rough approximation)
      let confidence = seg.confidence ?? 1.0;
      if (seg.avg_logprob !== undefined && seg.confidence === undefined) {
        confidence = Math.exp(seg.avg_logprob); // logprob -> probability
        confidence = Math.max(0, Math.min(1, confidence));
      }

      // no_speech_prob overrides confidence
      if (seg.no_speech_prob !== undefined && seg.no_speech_prob > 0.5) {
        confidence = Math.min(confidence, 1 - seg.no_speech_prob);
      }

      segments.push({ start, end, text, confidence });
    }
    return segments;
  }

  return segments;
}

/**
 * Parse a timestamp string like "00:01:23.456" to seconds.
 */
export function parseTimestamp(ts: string): number {
  const match = ts.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
  if (!match) {
    // Try simpler format "01:23.456"
    const simple = ts.match(/(\d{2}):(\d{2})[.,](\d{3})/);
    if (simple) {
      return (
        parseInt(simple[1]!, 10) * 60 +
        parseInt(simple[2]!, 10) +
        parseInt(simple[3]!, 10) / 1000
      );
    }
    return 0;
  }

  return (
    parseInt(match[1]!, 10) * 3600 +
    parseInt(match[2]!, 10) * 60 +
    parseInt(match[3]!, 10) +
    parseInt(match[4]!, 10) / 1000
  );
}

// ----- Silence Detection -----

/**
 * Detect silence boundaries in a transcript.
 * Returns time ranges where there is no speech.
 */
export function detectSilence(
  segments: TranscriptSegment[],
  totalDuration: number,
  minGapS = 1.0,
): Array<{ start: number; end: number }> {
  if (segments.length === 0) {
    return totalDuration > 0 ? [{ start: 0, end: totalDuration }] : [];
  }

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const gaps: Array<{ start: number; end: number }> = [];

  // Gap before first segment
  if (sorted[0]!.start > minGapS) {
    gaps.push({ start: 0, end: sorted[0]!.start });
  }

  // Gaps between segments
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1]!.end;
    const curStart = sorted[i]!.start;
    if (curStart - prevEnd >= minGapS) {
      gaps.push({ start: prevEnd, end: curStart });
    }
  }

  // Gap after last segment
  const lastEnd = sorted[sorted.length - 1]!.end;
  if (totalDuration - lastEnd >= minGapS) {
    gaps.push({ start: lastEnd, end: totalDuration });
  }

  return gaps;
}

/**
 * Calculate speech/silence durations from a transcript.
 */
export function calculateSpeechStats(
  segments: TranscriptSegment[],
  totalDuration: number,
): { speechDuration: number; silenceDuration: number } {
  const speechDuration = segments
    .filter((s) => s.confidence >= SILENCE_CONFIDENCE_THRESHOLD)
    .reduce((sum, s) => sum + (s.end - s.start), 0);

  return {
    speechDuration: Math.min(speechDuration, totalDuration),
    silenceDuration: Math.max(0, totalDuration - speechDuration),
  };
}

// ----- Chunk Splitting -----

/**
 * Calculate split points for long files.
 * Tries to split at silence boundaries, with overlap.
 */
export function calculateChunkBoundaries(
  totalDuration: number,
  silences: Array<{ start: number; end: number }>,
  maxChunkDuration = MAX_CHUNK_DURATION_S,
  overlap = CHUNK_OVERLAP_S,
): Array<{ start: number; end: number }> {
  if (totalDuration <= maxChunkDuration) {
    return [{ start: 0, end: totalDuration }];
  }

  const chunks: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  while (cursor < totalDuration) {
    const idealEnd = cursor + maxChunkDuration;

    if (idealEnd >= totalDuration) {
      chunks.push({ start: cursor, end: totalDuration });
      break;
    }

    // Find the nearest silence boundary to the ideal end
    let bestSplit = idealEnd;
    let bestDist = Infinity;

    for (const silence of silences) {
      const mid = (silence.start + silence.end) / 2;
      const dist = Math.abs(mid - idealEnd);
      if (dist < bestDist && mid > cursor + 60 && mid < idealEnd + 60) {
        bestSplit = mid;
        bestDist = dist;
      }
    }

    chunks.push({ start: cursor, end: bestSplit });
    cursor = Math.max(0, bestSplit - overlap);
  }

  return chunks;
}

// ----- Whisper CLI -----

/**
 * Find the whisper binary path.
 * Checks WHISPER_BINARY env, then common locations.
 */
export function findWhisperBinary(): string | null {
  const envPath = process.env.WHISPER_BINARY;
  if (envPath && existsSync(envPath)) return envPath;

  // Common installation paths
  const candidates = [
    "whisper-cli",
    "whisper",
    "whisper.cpp",
    "/usr/local/bin/whisper-cli",
    "/usr/local/bin/whisper",
    "/opt/homebrew/bin/whisper-cli",
    "/opt/homebrew/bin/whisper",
  ];

  // We can't easily check PATH without spawning, so just return first candidate
  // that exists as a file. In practice, whisper-cli will be in PATH.
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && existsSync(candidate)) return candidate;
  }

  // Return the default command name -- let the OS resolve it
  return "whisper-cli";
}

/**
 * Run whisper.cpp on an audio file.
 * Returns raw output (SRT or JSON depending on flags).
 */
export async function runWhisperCli(
  audioPath: string,
  outputFormat: "srt" | "json" = "json",
  modelPath?: string,
): Promise<{ success: boolean; output: string; durationMs: number }> {
  const whisper = findWhisperBinary();
  if (!whisper) {
    return { success: false, output: "whisper binary not found", durationMs: 0 };
  }

  const model = modelPath ?? process.env.WHISPER_MODEL_PATH;
  const args = [whisper];

  if (model) {
    args.push("-m", model);
  }

  args.push(
    "-f", audioPath,
    "--output-" + outputFormat,
    "-l", "auto",
  );

  if (outputFormat === "json") {
    args.push("--output-json-full");
  }

  const startMs = Date.now();
  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => proc.kill(), WHISPER_TIMEOUT_MS);
    let stdout: string;
    let stderr: string;
    try {
      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    return {
      success: proc.exitCode === 0,
      output: stdout || stderr,
      durationMs: Date.now() - startMs,
    };
  } catch {
    return { success: false, output: "whisper binary not available", durationMs: 0 };
  }
}

// ----- OpenAI Whisper API Fallback -----

/** OpenAI transcription response (subset). */
interface OpenAiTranscriptionResponse {
  text?: string;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
    avg_logprob?: number;
    no_speech_prob?: number;
  }>;
  language?: string;
}

/**
 * Transcribe via OpenAI Whisper API.
 * Requires OPENAI_API_KEY environment variable.
 */
export async function transcribeViaApi(
  audioPath: string,
): Promise<{ success: boolean; segments: TranscriptSegment[]; language: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { success: false, segments: [], language: "" };
  }

  try {
    const file = Bun.file(audioPath);
    const formData = new FormData();
    formData.append("file", file, basename(audioPath));
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");
    formData.append("timestamp_granularities[]", "segment");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      return { success: false, segments: [], language: "" };
    }

    const data = (await response.json()) as OpenAiTranscriptionResponse;
    const segments: TranscriptSegment[] = (data.segments ?? []).map((seg) => {
      let confidence = 1.0;
      if (seg.avg_logprob !== undefined) {
        confidence = Math.exp(seg.avg_logprob);
        confidence = Math.max(0, Math.min(1, confidence));
      }
      if (seg.no_speech_prob !== undefined && seg.no_speech_prob > 0.5) {
        confidence = Math.min(confidence, 1 - seg.no_speech_prob);
      }

      return {
        start: seg.start,
        end: seg.end,
        text: seg.text.trim(),
        confidence,
      };
    });

    return {
      success: true,
      segments,
      language: data.language ?? "en",
    };
  } catch {
    return { success: false, segments: [], language: "" };
  }
}

// ----- Build Transcript -----

/**
 * Build a complete Transcript object from segments and media info.
 */
export function buildTranscript(
  mediaPath: string,
  segments: TranscriptSegment[],
  totalDuration: number,
  language = "en",
): Transcript {
  const { speechDuration, silenceDuration } = calculateSpeechStats(segments, totalDuration);

  return {
    mediaPath,
    segments,
    language,
    speechDuration,
    silenceDuration,
  };
}

// ----- SRT Generation -----

/**
 * Format seconds as SRT timecode: HH:MM:SS,mmm
 */
export function formatSrtTime(seconds: number): string {
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

/**
 * Generate SRT content from transcript segments.
 */
export function generateSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((seg, i) => {
      return [
        String(i + 1),
        `${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}`,
        seg.text,
        "",
      ].join("\n");
    })
    .join("\n");
}
