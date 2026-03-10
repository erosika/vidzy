/**
 * Platform-specific export for the video pipeline.
 *
 * Handles:
 * - Platform encoding (YouTube, TikTok, Instagram, raw)
 * - Audio loudness normalization (2-pass loudnorm)
 * - Caption burn-in for short-form platforms
 * - Sidecar SRT generation for long-form
 * - Thumbnail extraction
 * - Intermediate cleanup
 */

import { join, basename, extname } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import type {
  ExportPlatform,
  ExportSpec,
  ProjectManifest,
  ReframeSpec,
  BeautyConfig,
} from "./types.ts";
import { PLATFORM_SPECS } from "./types.ts";

// ----- ffmpeg Encoding Args -----

/**
 * Build ffmpeg encoding args for a platform export.
 *
 * Combines: video filter chain (reframe + beauty) + encoding params.
 */
export function buildExportArgs(
  inputPath: string,
  outputPath: string,
  spec: ExportSpec,
  videoFilter: string,
  srtPath?: string,
): string[] {
  const args: string[] = ["-i", inputPath];

  // Raw export: stream copy
  if (spec.platform === "raw") {
    args.push("-c", "copy", outputPath);
    return args;
  }

  // Add subtitle input for burn-in (skip empty SRT files)
  if (srtPath && spec.captions === "burned" && existsSync(srtPath)) {
    if (statSync(srtPath).size > 0) {
      const subtitleFilter = `subtitles='${srtPath.replace(/'/g, "'\\''")}'`;
      videoFilter = videoFilter
        ? `${videoFilter},${subtitleFilter}`
        : subtitleFilter;
    }
  }

  // Video filter
  if (videoFilter) {
    args.push("-vf", videoFilter);
  }

  // Video encoding
  args.push(
    "-c:v", "libx264",
    "-crf", String(spec.crf),
    "-preset", "medium",
    "-profile:v", "high",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  );

  // Audio encoding
  if (spec.audioCodec !== "copy") {
    args.push(
      "-c:a", spec.audioCodec,
      "-b:a", spec.audioBitrate,
      "-ar", "48000",
    );
  } else {
    args.push("-c:a", "copy");
  }

  args.push(outputPath);
  return args;
}

/**
 * Build audio loudness normalization filter for a target LUFS.
 */
export function buildLoudnessFilter(targetLufs: number): string {
  return `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`;
}

// ----- Output Naming -----

/**
 * Generate output filename for a platform export.
 * Format: {project-name}_{platform}.mp4
 */
export function generateOutputFilename(
  projectName: string,
  platform: ExportPlatform,
): string {
  const safe = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  const ext = platform === "raw" ? ".mp4" : ".mp4";
  return `${safe}_${platform}${ext}`;
}

/**
 * Generate SRT filename matching the video output.
 */
export function generateSrtFilename(videoFilename: string): string {
  return videoFilename.replace(/\.[^.]+$/, ".srt");
}

/**
 * Generate thumbnail filename.
 */
export function generateThumbnailFilename(videoFilename: string): string {
  return videoFilename.replace(/\.[^.]+$/, "_thumb.jpg");
}

// ----- Thumbnail Extraction -----

/**
 * Build ffmpeg args for thumbnail extraction.
 * Extracts a frame at the specified timestamp.
 */
export function buildThumbnailArgs(
  inputPath: string,
  outputPath: string,
  timestamp: number,
  width = 1280,
): string[] {
  return [
    "-ss", String(timestamp),
    "-i", inputPath,
    "-frames:v", "1",
    "-vf", `scale=${width}:-1`,
    "-q:v", "2",
    outputPath,
  ];
}

// ----- Video Filter Chain -----

/**
 * Combine reframe, beauty, and platform-specific filters
 * into a single ffmpeg -vf chain.
 *
 * Order: reframe (crop+scale) -> beauty (bilateral+unsharp) -> platform scale
 */
export function buildVideoFilterChain(
  reframeFilter: string,
  beautyFilter: string,
  spec: ExportSpec,
): string {
  const filters: string[] = [];

  if (reframeFilter) {
    filters.push(reframeFilter);
  }

  if (beautyFilter) {
    filters.push(beautyFilter);
  }

  // Ensure final output matches platform resolution
  if (spec.platform !== "raw" && spec.width > 0 && spec.height > 0) {
    // Only add scale if not already handled by reframe
    if (!reframeFilter.includes("scale=")) {
      filters.push(`scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease`);
      filters.push(`pad=${spec.width}:${spec.height}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }
  }

  return filters.join(",");
}

// ----- Export Plan -----

/** Export plan for a single platform. */
export interface ExportPlan {
  platform: ExportPlatform;
  spec: ExportSpec;
  outputFilename: string;
  srtFilename: string | null;
  thumbnailFilename: string;
  videoFilter: string;
  needsSrt: boolean;
  needsThumbnail: boolean;
}

/**
 * Build export plans for all target platforms.
 */
export function buildExportPlans(
  manifest: ProjectManifest,
  reframeFilter: (platform: ExportPlatform) => string,
  beautyFilter: (platform: ExportPlatform) => string,
): ExportPlan[] {
  const projectName = basename(manifest.outputDir);

  return manifest.platforms.map((platform) => {
    const spec = PLATFORM_SPECS[platform] ?? PLATFORM_SPECS.youtube_long;
    const outputFilename = generateOutputFilename(projectName, platform);
    const videoFilter = buildVideoFilterChain(
      reframeFilter(platform),
      beautyFilter(platform),
      spec,
    );

    return {
      platform,
      spec,
      outputFilename,
      srtFilename: spec.captions === "sidecar" ? generateSrtFilename(outputFilename) : null,
      thumbnailFilename: generateThumbnailFilename(outputFilename),
      videoFilter,
      needsSrt: spec.captions === "sidecar" || spec.captions === "burned",
      needsThumbnail: platform !== "raw",
    };
  });
}

// ----- Cleanup -----

/**
 * List intermediate files that can be cleaned up after export.
 * Includes extracted audio, keyframes, segment files, etc.
 */
export function listIntermediateFiles(
  outputDir: string,
  patterns: string[] = ["*.wav", "*.concat.txt", "seg_*.mp4"],
): string[] {
  // This is a best-effort cleanup -- files matching patterns in outputDir
  // Actual implementation would use glob, but we keep it simple for the module
  return patterns.map((p) => join(outputDir, p));
}

// ----- Platform Helpers -----

/**
 * Check if a platform is short-form (needs reframing to vertical).
 */
export function isShortForm(platform: ExportPlatform): boolean {
  return ["youtube_shorts", "tiktok", "instagram_reels", "twitter_vertical"].includes(platform);
}

/**
 * Check if a platform needs caption burn-in.
 */
export function needsCaptionBurnIn(platform: ExportPlatform): boolean {
  const spec = PLATFORM_SPECS[platform];
  return spec?.captions === "burned";
}

/**
 * Get the export spec for a platform.
 */
export function getExportSpec(platform: ExportPlatform): ExportSpec {
  return PLATFORM_SPECS[platform] ?? PLATFORM_SPECS.youtube_long;
}
