/**
 * Project manifest management for the video pipeline.
 *
 * Handles CRUD, state machine transitions, and crash recovery.
 * Manifest is persisted as JSON on disk with atomic writes
 * (write to .tmp, then rename) to prevent corruption on crash.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ProjectManifest,
  PipelinePhase,
  ExportPlatform,
  BeautyStrength,
  VideoTaskFrontmatter,
} from "./types.ts";
import { PHASE_TRANSITIONS } from "./types.ts";

// ----- Constants -----

const MANIFEST_FILENAME = "project.json";

// ----- Factory -----

/**
 * Create a new project manifest from task frontmatter.
 * Does NOT write to disk -- call saveManifest() after creation.
 */
export function createManifest(task: VideoTaskFrontmatter, outputDir: string): ProjectManifest {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    phase: "created",
    sourceDir: task.source,
    outputDir,
    platforms: task.platforms.length > 0 ? task.platforms : ["youtube_long"],
    beauty: task.beauty,
    beautyStrength: task.beautyStrength,
    musicLibrary: task.musicLibrary,
    description: task.description,
    createdAt: now,
    updatedAt: now,
    error: null,
    files: [],
    transcripts: [],
    scenes: [],
    edl: null,
    soundtrack: null,
    reframes: {},
    beautyConfigs: {},
    exports: {},
  };
}

// ----- Persistence -----

/** Get the manifest file path for a project output directory. */
export function manifestPath(outputDir: string): string {
  return join(outputDir, MANIFEST_FILENAME);
}

/**
 * Save manifest to disk atomically.
 * Writes to a .tmp file first, then renames to prevent corruption.
 */
export function saveManifest(manifest: ProjectManifest): void {
  const dir = manifest.outputDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const target = manifestPath(dir);
  const tmp = target + ".tmp";

  manifest.updatedAt = new Date().toISOString();
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf-8");
  renameSync(tmp, target);
}

/**
 * Load manifest from disk.
 * Returns null if the manifest file doesn't exist.
 */
export function loadManifest(outputDir: string): ProjectManifest | null {
  const path = manifestPath(outputDir);
  if (!existsSync(path)) return null;

  try {
    const text = readFileSync(path, "utf-8");
    return JSON.parse(text) as ProjectManifest;
  } catch {
    return null;
  }
}

// ----- State Machine -----

/**
 * Check if a phase transition is valid.
 */
export function isValidTransition(from: PipelinePhase, to: PipelinePhase): boolean {
  const allowed = PHASE_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Advance the manifest to a new phase.
 * Throws if the transition is invalid.
 * Saves to disk atomically.
 */
export function advancePhase(
  manifest: ProjectManifest,
  to: PipelinePhase,
  error?: string,
): ProjectManifest {
  if (!isValidTransition(manifest.phase, to)) {
    throw new Error(
      `Invalid phase transition: ${manifest.phase} -> ${to}`,
    );
  }

  manifest.phase = to;
  manifest.error = to === "failed" ? (error ?? "Unknown error") : null;
  saveManifest(manifest);
  return manifest;
}

/**
 * Get the resumable phase for a manifest.
 * If the manifest is in a processing phase (e.g. "ingesting"),
 * it means the previous run crashed mid-phase. Return the phase
 * to re-run. If "done" or "created", return the phase as-is.
 */
export function getResumablePhase(manifest: ProjectManifest): PipelinePhase {
  // Processing phases should be retried
  const processingPhases: PipelinePhase[] = [
    "ingesting", "transcribing", "analyzing", "planning",
    "editing", "soundtrack", "reframing", "filtering", "exporting",
  ];

  if (processingPhases.includes(manifest.phase)) {
    return manifest.phase;
  }

  return manifest.phase;
}

/**
 * Get the next phase to execute based on current phase.
 * Returns null if the project is done or failed.
 */
export function getNextPhase(current: PipelinePhase): PipelinePhase | null {
  const transitions = PHASE_TRANSITIONS[current];
  if (!transitions || transitions.length === 0) return null;

  // Return the first non-failed transition (the happy path)
  for (const t of transitions) {
    if (t !== "failed") return t;
  }
  return null;
}

// ----- Task Frontmatter Parsing -----

/**
 * Parse video task frontmatter into typed structure.
 */
export function parseTaskFrontmatter(
  meta: Record<string, string>,
  body: string,
): VideoTaskFrontmatter {
  const platforms = (meta.platforms ?? "youtube_long")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as ExportPlatform[];

  let beauty: boolean | null = null;
  if (meta.beauty === "true") beauty = true;
  else if (meta.beauty === "false") beauty = false;

  let beautyStrength: BeautyStrength | null = null;
  const strengthVal = meta.beauty_strength ?? meta.beautyStrength;
  if (strengthVal === "subtle" || strengthVal === "medium" || strengthVal === "strong") {
    beautyStrength = strengthVal;
  }

  return {
    type: "video",
    source: meta.source ?? "",
    output: meta.output ?? "",
    platforms,
    beauty,
    beautyStrength,
    musicLibrary: meta.music_library ?? meta.musicLibrary ?? null,
    priority: parseInt(meta.priority ?? "5", 10),
    description: body,
  };
}
