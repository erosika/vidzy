/**
 * Dynamic soundtrack module for the video pipeline.
 *
 * Handles:
 * - Music library scanning and metadata extraction
 * - LLM-driven music selection based on scene mood/energy
 * - Auto-ducking: volume keyframes that duck music under speech
 * - SFX placement at transitions and edit points
 * - Tempo-aware placement
 * - Integration with Composer agent for custom music generation
 *
 * Applied AFTER edit, BEFORE reframe. Operates on the edited timeline.
 */

import { readdir } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import type {
  AudioAsset,
  MusicPlacement,
  DuckKeyframe,
  SoundtrackSpec,
  EditDecisionList,
  TranscriptSegment,
  Scene,
} from "./types.ts";

// ----- Constants -----

const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".wma",
]);

/** Duck volume when speech is present. */
const DUCK_VOLUME = 0.15;

/** Normal music volume (under speech-free sections). */
const FULL_VOLUME = 0.7;

/** Ducking attack time in seconds (how fast to lower volume). */
const DUCK_ATTACK_S = 0.3;

/** Ducking release time in seconds (how fast to restore volume). */
const DUCK_RELEASE_S = 0.5;

/** Default fade in/out for music placements. */
const DEFAULT_FADE_S = 2.0;

/** Minimum gap between speech segments to release duck. */
const MIN_UNDUCK_GAP_S = 1.0;

// ----- Library Scanning -----

/**
 * Scan a directory for audio files and extract basic metadata.
 * Returns AudioAsset objects with probed metadata.
 */
export async function scanMusicLibrary(
  libraryPath: string,
): Promise<AudioAsset[]> {
  let entries: string[];
  try {
    entries = await readdir(libraryPath);
  } catch {
    return [];
  }

  const audioFiles = entries.filter((name) =>
    AUDIO_EXTENSIONS.has(extname(name).toLowerCase()) && !name.startsWith("."),
  );

  const assets: AudioAsset[] = [];
  for (const filename of audioFiles) {
    const filePath = join(libraryPath, filename);
    try {
      const asset = await probeAudioAsset(filePath, filename);
      if (asset) assets.push(asset);
    } catch {
      // Skip unreadable files
    }
  }

  return assets;
}

/**
 * Probe an audio file for metadata.
 */
async function probeAudioAsset(
  filePath: string,
  filename: string,
): Promise<AudioAsset | null> {
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

  const timer = setTimeout(() => proc.kill(), 10_000);
  let stdout: string;
  try {
    stdout = await new Response(proc.stdout).text();
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  if (proc.exitCode !== 0) return null;

  const data = JSON.parse(stdout);
  const audioStream = data.streams?.find(
    (s: Record<string, unknown>) => s.codec_type === "audio",
  );
  const format = data.format ?? {};

  if (!audioStream) return null;

  // Extract tags from filename (e.g. "ambient-chill-120bpm.mp3")
  const tags = extractTagsFromFilename(filename);

  return {
    path: filePath,
    filename,
    duration: parseFloat(format.duration ?? "0"),
    codec: audioStream.codec_name ?? "unknown",
    sampleRate: parseInt(audioStream.sample_rate ?? "44100", 10),
    channels: audioStream.channels ?? 2,
    bpm: extractBpmFromFilename(filename),
    tags,
  };
}

/**
 * Extract tags from a filename by splitting on common separators.
 * "ambient-chill-120bpm.mp3" -> ["ambient", "chill"]
 */
export function extractTagsFromFilename(filename: string): string[] {
  const name = basename(filename, extname(filename));
  return name
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter((tag) => tag.length > 1 && !/^\d+$/.test(tag) && !tag.includes("bpm"));
}

/**
 * Extract BPM from filename if present.
 * "track-120bpm.mp3" -> 120
 */
export function extractBpmFromFilename(filename: string): number | null {
  const match = filename.match(/(\d{2,3})\s*bpm/i);
  if (match) {
    const bpm = parseInt(match[1]!, 10);
    if (bpm >= 40 && bpm <= 300) return bpm;
  }
  return null;
}

// ----- Music Selection -----

/**
 * Match music assets to scene mood/energy using simple heuristics.
 * Returns assets sorted by relevance.
 */
export function matchMusicToMood(
  assets: AudioAsset[],
  energy: number,
  contentTypes: Set<string>,
): AudioAsset[] {
  // Score each asset
  const scored = assets.map((asset) => {
    let score = 0;

    // Energy matching via tags
    if (energy < 0.3) {
      // Calm scenes: prefer ambient, chill, soft
      if (asset.tags.some((t) => ["ambient", "chill", "soft", "calm", "peaceful"].includes(t))) {
        score += 2;
      }
    } else if (energy > 0.7) {
      // High energy: prefer upbeat, energetic, fast
      if (asset.tags.some((t) => ["upbeat", "energetic", "fast", "dynamic", "hype"].includes(t))) {
        score += 2;
      }
    } else {
      // Medium: prefer neutral, background
      if (asset.tags.some((t) => ["background", "neutral", "moderate"].includes(t))) {
        score += 1;
      }
    }

    // Content type matching
    if (contentTypes.has("establishing") && asset.tags.includes("cinematic")) {
      score += 1;
    }
    if (contentTypes.has("action") && asset.tags.includes("intense")) {
      score += 1;
    }

    // BPM matching: higher BPM for higher energy
    if (asset.bpm) {
      if (energy > 0.7 && asset.bpm > 120) score += 1;
      if (energy < 0.3 && asset.bpm < 90) score += 1;
    }

    return { asset, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .map((s) => s.asset);
}

// ----- Auto-Ducking -----

/**
 * Generate volume duck keyframes from transcript segments.
 *
 * During speech: volume drops to DUCK_VOLUME.
 * During silence: volume restores to FULL_VOLUME.
 * Transitions use DUCK_ATTACK_S and DUCK_RELEASE_S for smoothing.
 */
export function generateDuckKeyframes(
  segments: TranscriptSegment[],
  totalDuration: number,
): DuckKeyframe[] {
  if (segments.length === 0) {
    return [{ time: 0, volume: FULL_VOLUME }];
  }

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const keyframes: DuckKeyframe[] = [];

  // Start at full volume
  keyframes.push({ time: 0, volume: FULL_VOLUME });

  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i]!;

    // Duck before speech starts
    const duckStart = Math.max(0, seg.start - DUCK_ATTACK_S);
    if (keyframes.length === 0 || keyframes[keyframes.length - 1]!.volume !== DUCK_VOLUME) {
      keyframes.push({ time: duckStart, volume: FULL_VOLUME });
      keyframes.push({ time: seg.start, volume: DUCK_VOLUME });
    }

    // Check if there's a gap to the next segment
    const nextSeg = sorted[i + 1];
    if (!nextSeg || nextSeg.start - seg.end >= MIN_UNDUCK_GAP_S) {
      // Release after speech ends
      keyframes.push({ time: seg.end, volume: DUCK_VOLUME });
      keyframes.push({ time: seg.end + DUCK_RELEASE_S, volume: FULL_VOLUME });
    }
  }

  // Ensure we end at the total duration
  if (keyframes[keyframes.length - 1]!.time < totalDuration) {
    keyframes.push({ time: totalDuration, volume: FULL_VOLUME });
  }

  return keyframes;
}

// ----- SFX Placement -----

/**
 * Generate sound effect placements at edit transitions.
 * Adds subtle transition sounds at dissolve and fade points.
 */
export function generateTransitionSfx(
  edl: EditDecisionList,
  sfxLibrary: AudioAsset[],
): MusicPlacement[] {
  if (sfxLibrary.length === 0) return [];

  const placements: MusicPlacement[] = [];
  let timelineOffset = 0;

  // Find a whoosh/transition SFX
  const transitionSfx = sfxLibrary.find((a) =>
    a.tags.some((t) => ["whoosh", "transition", "swipe", "swoosh"].includes(t)),
  );

  for (const point of edl.points) {
    const duration = point.outPoint - point.inPoint;

    if (point.transitionToNext === "dissolve" || point.transitionToNext === "fade_black") {
      if (transitionSfx) {
        placements.push({
          assetPath: transitionSfx.path,
          startTime: timelineOffset + duration - point.transitionDuration,
          endTime: timelineOffset + duration,
          volume: 0.3,
          fadeIn: 0.1,
          fadeOut: 0.1,
          loop: false,
        });
      }
    }

    timelineOffset += duration;
  }

  return placements;
}

// ----- Music Placement Builder -----

/**
 * Build a music placement for the full video duration.
 * Handles looping for short tracks and fade in/out.
 */
export function buildMusicPlacement(
  asset: AudioAsset,
  videoDuration: number,
  volume = FULL_VOLUME,
  fadeIn = DEFAULT_FADE_S,
  fadeOut = DEFAULT_FADE_S,
): MusicPlacement {
  return {
    assetPath: asset.path,
    startTime: 0,
    endTime: videoDuration,
    volume,
    fadeIn,
    fadeOut,
    loop: asset.duration < videoDuration,
  };
}

// ----- ffmpeg Filter Builders -----

/**
 * Build ffmpeg audio filter for music mixing with ducking.
 *
 * Uses volume keyframes for ducking and amerge for mixing.
 */
export function buildDuckingFilter(
  keyframes: DuckKeyframe[],
): string {
  if (keyframes.length === 0) return "volume=0.7";

  // Build volume filter with keyframe interpolation
  const points = keyframes
    .map((kf) => `${kf.time}:${kf.volume.toFixed(2)}`)
    .join(":");

  return `volume='if(between(t,0,${keyframes[keyframes.length - 1]!.time}),interp(${points}),${FULL_VOLUME})'`;
}

/**
 * Build simple volume-based ducking filter using ffmpeg's
 * volume filter with enable expressions.
 */
export function buildSimpleDuckingFilter(
  speechRanges: Array<{ start: number; end: number }>,
  duckVolume = DUCK_VOLUME,
  normalVolume = FULL_VOLUME,
): string {
  if (speechRanges.length === 0) {
    return `volume=${normalVolume}`;
  }

  // Build enable-based volume filter
  const conditions = speechRanges
    .map((r) => `between(t,${r.start.toFixed(2)},${r.end.toFixed(2)})`)
    .join("+");

  return `volume='if(${conditions},${duckVolume},${normalVolume})'`;
}

/**
 * Build the full music mixing ffmpeg filter chain.
 */
export function buildMusicMixFilter(
  placement: MusicPlacement,
  duckFilter: string,
): string[] {
  const filters: string[] = [];

  // Apply fade in/out to music
  if (placement.fadeIn > 0) {
    filters.push(`afade=t=in:d=${placement.fadeIn}`);
  }
  if (placement.fadeOut > 0) {
    const fadeStart = placement.endTime - placement.startTime - placement.fadeOut;
    filters.push(`afade=t=out:st=${Math.max(0, fadeStart)}:d=${placement.fadeOut}`);
  }

  // Apply ducking
  filters.push(duckFilter);

  return filters;
}

// ----- Soundtrack Spec Builder -----

/**
 * Build a complete SoundtrackSpec from available assets and timeline info.
 *
 * This is the pure-logic builder. The LLM-augmented version in the Director
 * agent provides the reasoning field.
 */
export function buildSoundtrackSpec(
  edl: EditDecisionList,
  segments: TranscriptSegment[],
  scenes: Scene[],
  musicAssets: AudioAsset[],
  sfxAssets: AudioAsset[],
): SoundtrackSpec {
  // Calculate average energy
  const avgEnergy = scenes.length > 0
    ? scenes.reduce((sum, s) => sum + s.energy, 0) / scenes.length
    : 0.5;

  // Collect content types
  const contentTypes = new Set(scenes.map((s) => s.contentType));

  // Select music
  const ranked = matchMusicToMood(musicAssets, avgEnergy, contentTypes);
  const music: MusicPlacement[] = [];

  if (ranked.length > 0) {
    music.push(buildMusicPlacement(ranked[0]!, edl.targetDuration));
  }

  // Generate ducking
  const duckKeyframes = generateDuckKeyframes(segments, edl.targetDuration);

  // Generate SFX
  const sfx = generateTransitionSfx(edl, sfxAssets);

  return {
    music,
    duckKeyframes,
    sfx,
    reasoning: "",
  };
}

// ----- LLM Soundtrack Prompt -----

/**
 * Build the soundtrack selection prompt for LLM.
 */
export function buildSoundtrackPrompt(
  scenes: Scene[],
  edl: EditDecisionList,
  availableMusic: AudioAsset[],
  description: string,
): string {
  const sceneList = scenes.map((s, i) =>
    `  ${i + 1}. [${s.contentType}] energy: ${s.energy.toFixed(2)} | ${s.description || "no description"}`,
  ).join("\n");

  const musicList = availableMusic.map((a) =>
    `  - ${a.filename}: ${a.duration.toFixed(1)}s | tags: ${a.tags.join(", ")}${a.bpm ? ` | ${a.bpm}bpm` : ""}`,
  ).join("\n");

  return `You are the Director agent selecting music for a video project.

## Project
${description || "Video project."}
Total duration: ${edl.targetDuration.toFixed(1)}s

## Scenes
${sceneList}

## Available Music
${musicList || "No music library available."}

## Task
Select background music and describe the soundtrack approach. Respond with ONLY JSON:

{
  "music_selection": "filename of selected track or null",
  "volume": 0.7,
  "reasoning": "Why this track fits the mood and energy of the video",
  "sfx_notes": "Any notes about sound effects or ambient audio"
}

Rules:
- Match music energy to scene content
- Prefer tracks that are close to the video duration (avoid excessive looping)
- If no good match, suggest null (no music is better than wrong music)
- Lower volume (0.3-0.5) for speech-heavy content, higher (0.6-0.8) for b-roll/establishing`;
}
