/**
 * Content-aware reframing for the video pipeline.
 *
 * Generates crop regions for each platform's aspect ratio based on
 * content type analysis. Not blind center-crop -- tracks subjects,
 * zooms into screen content, letterboxes wide shots.
 *
 * Features:
 * - Per-scene strategy selection based on content type
 * - Subject tracking via LLM-analyzed bounding boxes
 * - Crop smoothing: max velocity per second, ease-in-out
 * - Scene cut snaps: crop resets at edit boundaries
 * - Already-vertical footage: passthrough
 * - Split attention: alternates between subject regions
 */

import type {
  Scene,
  ContentType,
  ReframeSpec,
  ReframeStrategy,
  CropKeyframe,
  BoundingBox,
  EditPoint,
  ExportSpec,
} from "./types.ts";

// ----- Constants -----

/** Maximum crop velocity: 10% of frame width per second. */
const MAX_CROP_VELOCITY = 0.10;

/** Epsilon for floating-point aspect ratio comparison. */
const ASPECT_EPSILON = 0.05;

// ----- Strategy Selection -----

/** Map content type to reframe strategy. */
const STRATEGY_MAP: Record<ContentType, ReframeStrategy> = {
  talking_head: "track_subject",
  screen_content: "zoom_region",
  establishing: "letterbox",
  closeup: "center_crop",
  action: "track_subject",
  text_overlay: "center_crop",
  split_focus: "split_focus",
};

/**
 * Select reframe strategy for a scene.
 * May override based on source/target aspect ratios.
 */
export function selectStrategy(
  scene: Scene,
  sourceAspect: number,
  targetAspect: number,
): ReframeStrategy {
  // If source already matches target, passthrough
  if (Math.abs(sourceAspect - targetAspect) < ASPECT_EPSILON) {
    return "passthrough";
  }

  // If source is already vertical and target is vertical, passthrough
  if (sourceAspect < 1 && targetAspect < 1) {
    return "passthrough";
  }

  return STRATEGY_MAP[scene.contentType] ?? "center_crop";
}

// ----- Crop Math -----

/**
 * Calculate the crop region center for a subject bounding box.
 * Centers the crop on the subject's center position.
 */
export function subjectCropCenter(
  subjectBox: BoundingBox,
  targetAspect: number,
  sourceAspect: number,
): { centerX: number; centerY: number } {
  // Subject center
  const cx = subjectBox.x + subjectBox.w / 2;
  const cy = subjectBox.y + subjectBox.h / 2;

  // Calculate crop dimensions as fraction of source
  const cropWidth = targetAspect < sourceAspect
    ? targetAspect / sourceAspect
    : 1;
  const cropHeight = targetAspect > sourceAspect
    ? sourceAspect / targetAspect
    : 1;

  // Clamp center so crop stays within frame
  const halfW = cropWidth / 2;
  const halfH = cropHeight / 2;

  return {
    centerX: Math.max(halfW, Math.min(1 - halfW, cx)),
    centerY: Math.max(halfH, Math.min(1 - halfH, cy)),
  };
}

/**
 * Calculate center crop position (no subject tracking).
 */
export function centerCropPosition(): { centerX: number; centerY: number } {
  return { centerX: 0.5, centerY: 0.5 };
}

/**
 * Calculate crop keyframes for a scene using subject tracking.
 *
 * Generates keyframes every 2 seconds based on interpolated
 * subject position from the scene's bounding box.
 */
export function generateTrackingKeyframes(
  scene: Scene,
  targetAspect: number,
  sourceAspect: number,
  intervalS = 2.0,
): CropKeyframe[] {
  const duration = scene.end - scene.start;
  const keyframes: CropKeyframe[] = [];

  if (!scene.subjectBox) {
    // No subject -- single center keyframe
    return [{ time: 0, ...centerCropPosition(), isSnap: false }];
  }

  // Generate keyframes at regular intervals
  const numKeyframes = Math.max(2, Math.ceil(duration / intervalS) + 1);

  for (let i = 0; i < numKeyframes; i++) {
    const t = (i / (numKeyframes - 1)) * duration;
    // For now, use static subject box (LLM provides one box per scene)
    // Future: interpolate between multiple analyzed frames
    const { centerX, centerY } = subjectCropCenter(
      scene.subjectBox,
      targetAspect,
      sourceAspect,
    );

    keyframes.push({
      time: t,
      centerX,
      centerY,
      isSnap: i === 0, // First keyframe snaps (scene cut)
    });
  }

  return keyframes;
}

// ----- Crop Smoothing -----

/**
 * Apply velocity-limited smoothing to crop keyframes.
 *
 * Limits the crop movement speed to MAX_CROP_VELOCITY per second.
 * Uses linear interpolation with clamped velocity.
 */
export function smoothKeyframes(
  keyframes: CropKeyframe[],
  maxVelocity = MAX_CROP_VELOCITY,
): CropKeyframe[] {
  if (keyframes.length <= 1) return keyframes;

  const smoothed: CropKeyframe[] = [keyframes[0]!];

  for (let i = 1; i < keyframes.length; i++) {
    const prev = smoothed[i - 1]!;
    const curr = keyframes[i]!;

    // Snap keyframes bypass smoothing (scene cuts)
    if (curr.isSnap) {
      smoothed.push(curr);
      continue;
    }

    const dt = curr.time - prev.time;
    if (dt <= 0) {
      smoothed.push(curr);
      continue;
    }

    const maxDelta = maxVelocity * dt;

    const dx = curr.centerX - prev.centerX;
    const dy = curr.centerY - prev.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist <= maxDelta) {
      smoothed.push(curr);
    } else {
      // Limit movement
      const scale = maxDelta / dist;
      smoothed.push({
        time: curr.time,
        centerX: prev.centerX + dx * scale,
        centerY: prev.centerY + dy * scale,
        isSnap: false,
      });
    }
  }

  return smoothed;
}

// ----- ffmpeg Filter Generation -----

/**
 * Convert normalized crop center (0-1) to pixel coordinates
 * for ffmpeg's crop filter.
 *
 * crop=w:h:x:y
 */
export function cropCenterToPixels(
  centerX: number,
  centerY: number,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): { x: number; y: number; w: number; h: number } {
  // Calculate crop size in source pixels
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;

  let cropW: number;
  let cropH: number;

  if (targetAspect < sourceAspect) {
    // Target is taller -> crop width
    cropH = sourceHeight;
    cropW = Math.round(cropH * targetAspect);
  } else {
    // Target is wider -> crop height
    cropW = sourceWidth;
    cropH = Math.round(cropW / targetAspect);
  }

  // Ensure even dimensions (ffmpeg requirement)
  cropW = cropW - (cropW % 2);
  cropH = cropH - (cropH % 2);

  // Calculate top-left from center
  const x = Math.max(0, Math.min(
    sourceWidth - cropW,
    Math.round(centerX * sourceWidth - cropW / 2),
  ));
  const y = Math.max(0, Math.min(
    sourceHeight - cropH,
    Math.round(centerY * sourceHeight - cropH / 2),
  ));

  return { x, y, w: cropW, h: cropH };
}

/**
 * Build ffmpeg crop + scale filter for a static crop position.
 */
export function buildCropFilter(
  centerX: number,
  centerY: number,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): string {
  const { x, y, w, h } = cropCenterToPixels(
    centerX, centerY,
    sourceWidth, sourceHeight,
    targetWidth, targetHeight,
  );

  return `crop=${w}:${h}:${x}:${y},scale=${targetWidth}:${targetHeight}`;
}

/**
 * Build ffmpeg letterbox filter (pad to target aspect with black bars).
 */
export function buildLetterboxFilter(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): string {
  // Scale source to fit within target, then pad
  return `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

// ----- Reframe Spec Builder -----

/**
 * Build reframe specs for all edit points for a given platform.
 */
export function buildReframeSpecs(
  editPoints: EditPoint[],
  scenes: Scene[],
  sourceWidth: number,
  sourceHeight: number,
  exportSpec: ExportSpec,
): ReframeSpec[] {
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = exportSpec.aspect;

  return editPoints.map((point, editIdx) => {
    const scene = scenes.find((s) => s.index === point.sceneIndex);
    if (!scene) {
      // Fallback: center crop
      return {
        editIndex: editIdx,
        strategy: "center_crop" as ReframeStrategy,
        keyframes: [{ time: 0, centerX: 0.5, centerY: 0.5, isSnap: true }],
        targetAspect,
        targetWidth: exportSpec.width,
        targetHeight: exportSpec.height,
      };
    }

    const strategy = selectStrategy(scene, sourceAspect, targetAspect);

    let keyframes: CropKeyframe[];

    switch (strategy) {
      case "passthrough":
        keyframes = [{ time: 0, centerX: 0.5, centerY: 0.5, isSnap: false }];
        break;

      case "track_subject":
        keyframes = generateTrackingKeyframes(scene, targetAspect, sourceAspect);
        keyframes = smoothKeyframes(keyframes);
        break;

      case "zoom_region":
        // For screen content, zoom into center (future: LLM-selected region)
        keyframes = [{ time: 0, centerX: 0.5, centerY: 0.5, isSnap: true }];
        break;

      case "letterbox":
        keyframes = [{ time: 0, centerX: 0.5, centerY: 0.5, isSnap: false }];
        break;

      case "center_crop":
        keyframes = [{ time: 0, centerX: 0.5, centerY: 0.5, isSnap: true }];
        break;

      case "split_focus": {
        // Alternate between primary and secondary subject
        const duration = scene.end - scene.start;
        const primary = scene.subjectBox ?? { x: 0.3, y: 0.2, w: 0.2, h: 0.6 };
        const secondary = scene.secondaryBox ?? { x: 0.6, y: 0.2, w: 0.2, h: 0.6 };

        const p1 = subjectCropCenter(primary, targetAspect, sourceAspect);
        const p2 = subjectCropCenter(secondary, targetAspect, sourceAspect);

        keyframes = [
          { time: 0, ...p1, isSnap: true },
          { time: duration * 0.4, ...p1, isSnap: false },
          { time: duration * 0.5, ...p2, isSnap: true },
          { time: duration * 0.9, ...p2, isSnap: false },
          { time: duration, ...p1, isSnap: true },
        ];
        break;
      }

      default:
        keyframes = [{ time: 0, centerX: 0.5, centerY: 0.5, isSnap: true }];
    }

    return {
      editIndex: editIdx,
      strategy,
      keyframes,
      targetAspect,
      targetWidth: exportSpec.width,
      targetHeight: exportSpec.height,
    };
  });
}
