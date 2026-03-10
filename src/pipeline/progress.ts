/**
 * Progress tracking and disk space monitoring for the video pipeline.
 *
 * Provides progress percentage calculation based on pipeline phase
 * and disk space checks before resource-intensive operations.
 */

import { statSync } from "node:fs";
import type { ProjectManifest, PipelinePhase } from "./types.ts";

// ----- Phase Weights -----

/** Approximate time weight per phase (for progress calculation). */
const PHASE_WEIGHTS: Record<PipelinePhase, number> = {
  created:      0,
  ingesting:    5,
  transcribing: 20,
  analyzing:    15,
  planning:     5,
  editing:      25,
  soundtrack:   5,
  reframing:    10,
  filtering:    5,
  exporting:    10,
  done:         0,
  failed:       0,
};

/** Ordered phases for progress calculation. */
const PHASE_ORDER: PipelinePhase[] = [
  "created",
  "ingesting",
  "transcribing",
  "analyzing",
  "planning",
  "editing",
  "soundtrack",
  "reframing",
  "filtering",
  "exporting",
  "done",
];

// ----- Progress Calculation -----

/**
 * Calculate overall pipeline progress as a percentage (0-100).
 *
 * Completed phases contribute their full weight.
 * The current phase contributes based on phaseProgress (0-1).
 */
export function calculateProgress(
  manifest: ProjectManifest,
  phaseProgress = 0,
): number {
  if (manifest.phase === "done") return 100;
  if (manifest.phase === "failed") return 0;

  const currentIdx = PHASE_ORDER.indexOf(manifest.phase);
  if (currentIdx === -1) return 0;

  const totalWeight = Object.values(PHASE_WEIGHTS).reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return 0;

  let completedWeight = 0;
  for (let i = 0; i < currentIdx; i++) {
    completedWeight += PHASE_WEIGHTS[PHASE_ORDER[i]!] ?? 0;
  }

  const currentWeight = PHASE_WEIGHTS[manifest.phase] ?? 0;
  const partialWeight = currentWeight * Math.min(1, Math.max(0, phaseProgress));

  return Math.round(((completedWeight + partialWeight) / totalWeight) * 100);
}

// ----- Disk Space -----

const BYTES_PER_GB = 1024 * 1024 * 1024;
const MIN_FREE_GB = 10;

/**
 * Check available disk space at a path.
 * Uses Bun.spawn to run `df` since Node.js doesn't have a cross-platform
 * disk space API.
 *
 * Returns available space in bytes, or null if detection fails.
 */
export async function getAvailableSpace(path: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(["df", "-k", path], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => proc.kill(), 5000);
    let stdout: string;
    try {
      stdout = await new Response(proc.stdout).text();
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    // Parse df output: second line, fourth column (Available in 1K blocks)
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) return null;

    const fields = lines[1]!.trim().split(/\s+/);
    if (fields.length < 4) return null;

    const availableKb = parseInt(fields[3]!, 10);
    if (Number.isNaN(availableKb)) return null;

    return availableKb * 1024; // Convert KB to bytes
  } catch {
    return null;
  }
}

/**
 * Check if there's enough disk space for a pipeline phase.
 * Warns if < 10GB available.
 *
 * Returns { ok, availableGb, message }.
 */
export async function checkDiskSpace(
  path: string,
  minGb = MIN_FREE_GB,
): Promise<{ ok: boolean; availableGb: number | null; message: string }> {
  const available = await getAvailableSpace(path);

  if (available === null) {
    return {
      ok: true, // Can't detect, proceed optimistically
      availableGb: null,
      message: "Could not detect available disk space",
    };
  }

  const availableGb = available / BYTES_PER_GB;

  if (availableGb < minGb) {
    return {
      ok: false,
      availableGb,
      message: `Low disk space: ${availableGb.toFixed(1)}GB available (need ${minGb}GB)`,
    };
  }

  return {
    ok: true,
    availableGb,
    message: `${availableGb.toFixed(1)}GB available`,
  };
}

// ----- Estimation -----

/**
 * Estimate total source media size from a manifest's files.
 */
export function estimateSourceSize(manifest: ProjectManifest): number {
  return manifest.files.reduce((sum, f) => sum + f.fileSizeBytes, 0);
}

/**
 * Estimate output size based on source size and target platforms.
 * Rough heuristic: each platform export is ~80% of source size
 * (re-encoding typically reduces size), plus intermediates.
 */
export function estimateOutputSize(manifest: ProjectManifest): number {
  const sourceSize = estimateSourceSize(manifest);
  const platformCount = Math.max(1, manifest.platforms.length);

  // Intermediates (normalized audio, reframed clips): ~1.5x source
  // Per-platform export: ~0.8x source
  return Math.round(sourceSize * 1.5 + sourceSize * 0.8 * platformCount);
}

/**
 * Get a human-readable size string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < BYTES_PER_GB) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / BYTES_PER_GB).toFixed(1)}GB`;
}
