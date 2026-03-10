/**
 * Editorial planning for the video pipeline.
 *
 * Uses LLM (via OpenRouter light tier) to make creative decisions:
 * - Best take selection
 * - Jump cut detection -> cover with b-roll
 * - Multi-topic detection -> suggest video splits
 * - Cold open selection for short-form
 * - Sensitive content exclusion
 *
 * Pure logic functions + prompt builder. No LLM calls directly --
 * the Director agent calls runLightSession with our prompts.
 */

import type {
  Scene,
  Transcript,
  EditDecisionList,
  EditPoint,
  TranscriptSegment,
  MediaFile,
  ContentType,
} from "./types.ts";

// ----- Take Selection -----

/** Criteria scores for ranking takes. */
export interface TakeScore {
  sceneIndex: number;
  /** Is the sentence complete? */
  completeness: number;
  /** Average transcript confidence. */
  clarity: number;
  /** Scene energy score. */
  energy: number;
  /** Absence of repeated/stuttered words. */
  fluency: number;
  /** Later takes preferred (practice effect). */
  recency: number;
  /** Composite score (0-1). */
  total: number;
}

/**
 * Score a scene as a potential "take" for selection.
 *
 * Criteria:
 * - completeness: ends with sentence-ending punctuation
 * - clarity: average transcript confidence
 * - energy: scene energy score
 * - fluency: no repeated consecutive words (stumbles)
 * - recency: later scenes score higher (speaker improves with practice)
 */
export function scoreTake(
  scene: Scene,
  transcript: TranscriptSegment[],
  sceneIndex: number,
  totalScenes: number,
): TakeScore {
  // Get segments overlapping this scene
  const segments = transcript.filter(
    (s) => s.end > scene.start && s.start < scene.end,
  );

  const text = segments.map((s) => s.text).join(" ").trim();

  // Completeness: ends with sentence-ending punctuation
  const completeness = /[.!?]$/.test(text) ? 1.0 : 0.3;

  // Clarity: average confidence
  const clarity = segments.length > 0
    ? segments.reduce((sum, s) => sum + s.confidence, 0) / segments.length
    : 0;

  // Energy: direct from scene analysis
  const energy = scene.energy;

  // Fluency: check for repeated consecutive words
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  let repeats = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) repeats++;
  }
  const fluency = words.length > 0 ? Math.max(0, 1 - repeats / words.length * 3) : 1;

  // Recency: later takes preferred
  const recency = totalScenes > 1 ? sceneIndex / (totalScenes - 1) : 0.5;

  // Weighted composite
  const total =
    completeness * 0.25 +
    clarity * 0.25 +
    energy * 0.15 +
    fluency * 0.20 +
    recency * 0.15;

  return {
    sceneIndex,
    completeness,
    clarity,
    energy,
    fluency,
    recency,
    total: Math.max(0, Math.min(1, total)),
  };
}

/**
 * Select the best take from a group of similar scenes.
 * Returns the scene index of the best take.
 */
export function selectBestTake(scores: TakeScore[]): number {
  if (scores.length === 0) return -1;

  let best = scores[0]!;
  for (const score of scores) {
    if (score.total > best.total) best = score;
  }
  return best.sceneIndex;
}

// ----- Jump Cut Detection -----

/**
 * Detect jump cuts: consecutive talking_head scenes from the same camera
 * angle with similar framing. These look jarring without b-roll coverage.
 *
 * Returns indices of edit points that should have b-roll inserted.
 */
export function detectJumpCuts(
  scenes: Scene[],
  maxBoxShift = 0.15,
): number[] {
  const jumpIndices: number[] = [];

  for (let i = 1; i < scenes.length; i++) {
    const prev = scenes[i - 1]!;
    const curr = scenes[i]!;

    // Both must be talking_head with subject boxes
    if (
      prev.contentType !== "talking_head" ||
      curr.contentType !== "talking_head" ||
      !prev.subjectBox ||
      !curr.subjectBox
    ) {
      continue;
    }

    // Check if subject position is similar (same framing)
    const dx = Math.abs(prev.subjectBox.x - curr.subjectBox.x);
    const dy = Math.abs(prev.subjectBox.y - curr.subjectBox.y);

    if (dx < maxBoxShift && dy < maxBoxShift) {
      jumpIndices.push(i);
    }
  }

  return jumpIndices;
}

// ----- B-Roll Matching -----

/**
 * Find available b-roll scenes that could cover a jump cut.
 * Returns indices of b-roll scenes sorted by relevance.
 */
export function findBrollCandidates(
  scenes: Scene[],
  usedBroll: Set<number>,
): number[] {
  return scenes
    .filter((s, i) =>
      !s.sensitive &&
      !usedBroll.has(i) &&
      (s.contentType === "establishing" ||
        s.contentType === "closeup" ||
        s.contentType === "action"),
    )
    .map((_, i) => i)
    .filter((i) => !usedBroll.has(i));
}

// ----- Topic Detection -----

/**
 * Detect topic boundaries in the transcript.
 * Simple heuristic: significant silence gaps (>3s) suggest topic changes.
 * Returns approximate topic boundaries as scene indices.
 */
export function detectTopicBoundaries(
  scenes: Scene[],
  transcriptSegments: TranscriptSegment[],
  minGapS = 3.0,
): number[] {
  const boundaries: number[] = [];

  for (let i = 1; i < scenes.length; i++) {
    const prev = scenes[i - 1]!;
    const curr = scenes[i]!;

    // Check for significant silence between scenes
    const prevEnd = prev.end;
    const currStart = curr.start;

    if (currStart - prevEnd >= minGapS) {
      boundaries.push(i);
      continue;
    }

    // Check for transcript gap at the scene boundary
    const gapSegments = transcriptSegments.filter(
      (s) => s.start >= prevEnd - 0.5 && s.end <= currStart + 0.5,
    );

    if (gapSegments.length === 0 && currStart - prevEnd >= minGapS * 0.5) {
      boundaries.push(i);
    }
  }

  return boundaries;
}

// ----- Cold Open Selection -----

/**
 * Select a cold open for short-form content.
 * Finds the most engaging 1-3 second clip from the first quarter of footage.
 * Returns the scene index and suggested in/out points, or null.
 */
export function selectColdOpen(
  scenes: Scene[],
  maxDurationS = 3.0,
): { sceneIndex: number; inPoint: number; outPoint: number } | null {
  // Only consider first quarter of scenes
  const candidateCount = Math.max(1, Math.ceil(scenes.length / 4));
  const candidates = scenes.slice(0, candidateCount);

  let best: { sceneIndex: number; energy: number; inPoint: number; outPoint: number } | null = null;

  for (const scene of candidates) {
    if (scene.sensitive) continue;

    const duration = Math.min(maxDurationS, scene.end - scene.start);
    if (duration < 0.5) continue;

    if (!best || scene.energy > best.energy) {
      best = {
        sceneIndex: scene.index,
        energy: scene.energy,
        inPoint: scene.start,
        outPoint: scene.start + duration,
      };
    }
  }

  return best ? { sceneIndex: best.sceneIndex, inPoint: best.inPoint, outPoint: best.outPoint } : null;
}

// ----- EDL Builder -----

/**
 * Build an edit decision list from scenes, analysis, and editorial choices.
 * This is the pure-logic version. The LLM-augmented version adds reasoning.
 */
export function buildEditDecisionList(
  scenes: Scene[],
  transcriptSegments: TranscriptSegment[],
  opts: {
    excludeSensitive?: boolean;
    insertBroll?: boolean;
    includeColdOpen?: boolean;
  } = {},
): EditDecisionList {
  const { excludeSensitive = true, insertBroll = true, includeColdOpen = false } = opts;

  const points: EditPoint[] = [];
  const usedBroll = new Set<number>();

  // Filter sensitive scenes
  const validScenes = excludeSensitive
    ? scenes.filter((s) => !s.sensitive)
    : scenes;

  // Detect jump cuts
  const jumpCuts = insertBroll ? detectJumpCuts(validScenes) : [];
  const jumpCutSet = new Set(jumpCuts);

  // Cold open
  let coldOpenIndex: number | null = null;
  if (includeColdOpen) {
    const coldOpen = selectColdOpen(validScenes);
    if (coldOpen) {
      coldOpenIndex = points.length;
      points.push({
        mediaPath: validScenes[coldOpen.sceneIndex]!.mediaPath,
        inPoint: coldOpen.inPoint,
        outPoint: coldOpen.outPoint,
        role: "cold_open",
        sceneIndex: coldOpen.sceneIndex,
        needsReencode: true,
        transitionToNext: "cut",
        transitionDuration: 0,
      });
    }
  }

  // Build main timeline
  for (let i = 0; i < validScenes.length; i++) {
    const scene = validScenes[i]!;

    // Insert b-roll before jump cuts
    if (jumpCutSet.has(i) && insertBroll) {
      const brollCandidates = findBrollCandidates(scenes, usedBroll);
      if (brollCandidates.length > 0) {
        const brollIdx = brollCandidates[0]!;
        const brollScene = scenes[brollIdx]!;
        usedBroll.add(brollIdx);

        // Use up to 3s of b-roll
        const brollDuration = Math.min(3, brollScene.end - brollScene.start);
        points.push({
          mediaPath: brollScene.mediaPath,
          inPoint: brollScene.start,
          outPoint: brollScene.start + brollDuration,
          role: "broll",
          sceneIndex: brollIdx,
          needsReencode: true,
          transitionToNext: "dissolve",
          transitionDuration: 0.5,
        });
      }
    }

    // Main edit point
    points.push({
      mediaPath: scene.mediaPath,
      inPoint: scene.start,
      outPoint: scene.end,
      role: "main",
      sceneIndex: scene.index,
      needsReencode: false, // Prefer stream copy
      transitionToNext: i < validScenes.length - 1 ? "cut" : null,
      transitionDuration: 0,
    });
  }

  // Calculate target duration
  const targetDuration = points.reduce(
    (sum, p) => sum + (p.outPoint - p.inPoint),
    0,
  );

  // Detect topics
  const topicBoundaries = detectTopicBoundaries(validScenes, transcriptSegments);
  const topics = topicBoundaries.map((idx) => `Topic break at scene ${idx}`);

  return {
    points,
    targetDuration,
    topics,
    suggestSplit: topicBoundaries.length >= 3,
    coldOpenIndex,
    reasoning: "",
  };
}

// ----- LLM Planning Prompt -----

/**
 * Build the editorial planning prompt for LLM.
 * Sends scene summaries, transcript excerpts, and asks for
 * editorial decisions about structure, pacing, and narrative.
 */
export function buildPlanningPrompt(
  scenes: Scene[],
  transcripts: Transcript[],
  files: MediaFile[],
  description: string,
): string {
  const sceneList = scenes.map((s, i) => {
    const duration = (s.end - s.start).toFixed(1);
    return `  ${i + 1}. [${s.contentType}] ${duration}s | energy: ${s.energy.toFixed(2)} | ${s.description || "no description"}${s.sensitive ? " [SENSITIVE]" : ""}`;
  }).join("\n");

  const transcriptSummary = transcripts.map((t) => {
    const excerpt = t.segments.slice(0, 5).map((s) => s.text).join(" ");
    return `  ${t.mediaPath}: ${t.segments.length} segments, ${t.speechDuration.toFixed(0)}s speech | "${excerpt.slice(0, 100)}..."`;
  }).join("\n");

  const fileList = files.map((f) => {
    return `  ${f.filename}: ${f.codec} ${f.width}x${f.height} ${f.duration.toFixed(1)}s | ${f.classification}${f.cameraMake ? ` | ${f.cameraMake} ${f.cameraModel ?? ""}` : ""}`;
  }).join("\n");

  return `You are the Director agent making editorial decisions for a video project.

## Project Brief
${description || "No specific brief provided."}

## Source Files
${fileList}

## Scenes Detected (${scenes.length} total)
${sceneList}

## Transcripts
${transcriptSummary || "No transcripts available."}

## Your Task
Analyze the footage and provide an editorial plan. Respond with ONLY a JSON object:

{
  "narrative_structure": "brief description of the story arc",
  "recommended_order": [scene indices in recommended order],
  "exclude_scenes": [scene indices to exclude, with reasons],
  "broll_placements": [{"after_scene": N, "broll_scene": M, "reason": "..."}],
  "cold_open_scene": scene index or null,
  "suggested_topics": ["topic 1", "topic 2"],
  "should_split": true/false,
  "split_points": [scene indices where to split into separate videos],
  "pacing_notes": "any notes on rhythm, timing, energy flow",
  "estimated_duration_s": estimated final video length
}

Rules:
- Exclude scenes marked [SENSITIVE]
- Prefer later takes when content is repeated (practice effect)
- Use b-roll to cover jump cuts (same framing, different takes)
- For short-form (< 60s), pick ONE strong moment, add cold open hook
- Keep pacing dynamic: vary scene lengths, energy levels
- If multiple distinct topics found, suggest splitting into separate videos`;
}

// ----- LLM Response Parser -----

/** Parsed editorial plan from LLM. */
export interface EditorialPlan {
  narrativeStructure: string;
  recommendedOrder: number[];
  excludeScenes: number[];
  brollPlacements: Array<{ afterScene: number; brollScene: number; reason: string }>;
  coldOpenScene: number | null;
  suggestedTopics: string[];
  shouldSplit: boolean;
  splitPoints: number[];
  pacingNotes: string;
  estimatedDurationS: number;
}

/**
 * Parse the LLM's editorial plan response.
 */
export function parseEditorialPlan(response: string): EditorialPlan | null {
  try {
    let json = response.trim();
    const match = json.match(/\{[\s\S]*\}/);
    if (match) json = match[0];

    const data = JSON.parse(json);

    return {
      narrativeStructure: String(data.narrative_structure ?? ""),
      recommendedOrder: Array.isArray(data.recommended_order) ? data.recommended_order : [],
      excludeScenes: Array.isArray(data.exclude_scenes) ? data.exclude_scenes : [],
      brollPlacements: Array.isArray(data.broll_placements)
        ? data.broll_placements.map((p: Record<string, unknown>) => ({
            afterScene: Number(p.after_scene ?? 0),
            brollScene: Number(p.broll_scene ?? 0),
            reason: String(p.reason ?? ""),
          }))
        : [],
      coldOpenScene: data.cold_open_scene != null ? Number(data.cold_open_scene) : null,
      suggestedTopics: Array.isArray(data.suggested_topics) ? data.suggested_topics.map(String) : [],
      shouldSplit: Boolean(data.should_split),
      splitPoints: Array.isArray(data.split_points) ? data.split_points : [],
      pacingNotes: String(data.pacing_notes ?? ""),
      estimatedDurationS: Number(data.estimated_duration_s ?? 0),
    };
  } catch {
    return null;
  }
}
