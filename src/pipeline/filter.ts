/**
 * Beauty / skin softening filter for the video pipeline.
 *
 * Extremely subtle -- invisible to casual eye, preserves micro-texture.
 * Uses ffmpeg bilateral filter (edge-preserving blur) + micro-sharpening.
 *
 * Three strength presets, all conservative:
 * - subtle: barely perceptible, just takes the digital edge off
 * - medium: noticeable on pause, invisible in motion
 * - strong: visible smoothing but no "plastic" look
 *
 * Camera-aware defaults via EXIF Make/Model from ingest probe.
 * Bypassed for screen_content, text_overlay, and low-bitrate sources.
 */

import type {
  BeautyConfig,
  BeautyStrength,
  BeautyParams,
  ContentType,
  MediaFile,
} from "./types.ts";

// ----- Strength Presets -----

export const BEAUTY_PRESETS: Record<BeautyStrength, BeautyParams> = {
  subtle: {
    sigmaS: 1.0,
    sigmaR: 0.08,
    unsharpSize: 3,
    unsharpAmount: 0.3,
  },
  medium: {
    sigmaS: 2.0,
    sigmaR: 0.12,
    unsharpSize: 3,
    unsharpAmount: 0.3,
  },
  strong: {
    sigmaS: 3.0,
    sigmaR: 0.15,
    unsharpSize: 3,
    unsharpAmount: 0.3,
  },
};

// ----- Camera Defaults -----

/** Cameras that have built-in beauty filters. */
const BEAUTY_OFF_CAMERAS = new Set([
  "dji",          // DJI Osmo Pocket 3, etc.
  "gopro",        // GoPro has built-in processing
  "insta360",     // Built-in processing
]);

/** Cameras known to benefit from subtle beauty. */
const BEAUTY_ON_CAMERAS = new Set([
  "fujifilm",
  "sony",
  "canon",
  "nikon",
  "panasonic",
  "olympus",
  "apple",        // iPhone
  "samsung",      // Galaxy
  "google",       // Pixel
]);

/**
 * Determine camera-aware beauty default.
 *
 * Rules:
 * - DJI: off (built-in beauty on export)
 * - Known camera brands: on at subtle
 * - Unknown: off (opt-in, never surprise the user)
 */
export function cameraBeautyDefault(
  cameraMake: string | null,
): { enabled: boolean; reason: string } {
  if (!cameraMake) {
    return { enabled: false, reason: "Unknown camera (opt-in only)" };
  }

  const make = cameraMake.toLowerCase().trim();

  if (BEAUTY_OFF_CAMERAS.has(make)) {
    return { enabled: false, reason: `${cameraMake} has built-in processing` };
  }

  // Check if make starts with a known brand
  for (const brand of BEAUTY_ON_CAMERAS) {
    if (make.startsWith(brand)) {
      return { enabled: true, reason: `${cameraMake}: subtle beauty recommended` };
    }
  }

  return { enabled: false, reason: "Unknown camera (opt-in only)" };
}

// ----- Content Type Bypass -----

/** Content types where beauty filter should NOT be applied. */
const BYPASS_CONTENT_TYPES = new Set<ContentType>([
  "screen_content",
  "text_overlay",
]);

/**
 * Check if beauty filter should be bypassed for a content type.
 */
export function shouldBypassForContent(contentType: ContentType): boolean {
  return BYPASS_CONTENT_TYPES.has(contentType);
}

// ----- Bitrate Check -----

/** CRF threshold: skip beauty for heavily compressed sources. */
const LOW_BITRATE_THRESHOLD = 1_000_000; // 1 Mbps

/**
 * Check if source is too compressed for beauty filtering.
 * Filtering artifacts instead of skin at low bitrates.
 */
export function isLowBitrate(file: MediaFile): boolean {
  if (file.bitrate !== null && file.bitrate < LOW_BITRATE_THRESHOLD) {
    return true;
  }

  // Estimate bitrate from file size if not directly available
  if (file.duration > 0 && file.fileSizeBytes > 0) {
    const estimatedBitrate = (file.fileSizeBytes * 8) / file.duration;
    return estimatedBitrate < LOW_BITRATE_THRESHOLD;
  }

  return false;
}

// ----- Config Resolution -----

/**
 * Resolve the beauty config for a file, considering:
 * 1. Task frontmatter override (beauty: true/false, beauty_strength)
 * 2. Environment variable default (DIRECTOR_BEAUTY_DEFAULT)
 * 3. Camera-aware default (from EXIF make)
 * 4. Content type bypass
 * 5. Low bitrate bypass
 */
export function resolveBeautyConfig(
  file: MediaFile,
  contentType: ContentType,
  taskBeauty: boolean | null,
  taskStrength: BeautyStrength | null,
): BeautyConfig {
  // Content type bypass
  if (shouldBypassForContent(contentType)) {
    return {
      enabled: false,
      strength: "subtle",
      reason: `Bypassed for ${contentType} (sharpness matters more)`,
    };
  }

  // Low bitrate bypass
  if (isLowBitrate(file)) {
    return {
      enabled: false,
      strength: "subtle",
      reason: "Bypassed for low-bitrate source (would amplify compression artifacts)",
    };
  }

  // Task-level override
  if (taskBeauty !== null) {
    return {
      enabled: taskBeauty,
      strength: taskStrength ?? "subtle",
      reason: taskBeauty ? "Enabled via task frontmatter" : "Disabled via task frontmatter",
    };
  }

  // Environment variable default
  const envDefault = process.env.DIRECTOR_BEAUTY_DEFAULT;
  if (envDefault === "true") {
    return {
      enabled: true,
      strength: taskStrength ?? "subtle",
      reason: "Enabled via DIRECTOR_BEAUTY_DEFAULT",
    };
  }
  if (envDefault === "false") {
    return {
      enabled: false,
      strength: "subtle",
      reason: "Disabled via DIRECTOR_BEAUTY_DEFAULT",
    };
  }

  // Camera-aware default
  const cameraDefault = cameraBeautyDefault(file.cameraMake);
  return {
    enabled: cameraDefault.enabled,
    strength: taskStrength ?? "subtle",
    reason: cameraDefault.reason,
  };
}

// ----- ffmpeg Filter Generation -----

/**
 * Build the ffmpeg filter string for a beauty preset.
 *
 * bilateral filter (edge-preserving blur) + micro-sharpening pass.
 * Luma only for unsharp (no chroma sharpening).
 */
export function buildBeautyFilter(strength: BeautyStrength): string {
  const params = BEAUTY_PRESETS[strength];
  if (!params) return "";

  const bilateral = `bilateral=sigmaS=${params.sigmaS}:sigmaR=${params.sigmaR}`;
  const unsharp = `unsharp=${params.unsharpSize}:${params.unsharpSize}:${params.unsharpAmount}:${params.unsharpSize}:${params.unsharpSize}:0.0`;

  return `${bilateral},${unsharp}`;
}

/**
 * Build the full beauty filter chain with content-type awareness.
 * Returns the filter string or empty string if bypassed.
 */
export function buildBeautyFilterChain(config: BeautyConfig): string {
  if (!config.enabled) return "";
  return buildBeautyFilter(config.strength);
}
