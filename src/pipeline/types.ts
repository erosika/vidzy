/**
 * Type definitions for the Director video production pipeline.
 *
 * Pipeline flow:
 *   ingest -> transcribe -> analyze -> plan -> edit -> soundtrack -> reframe -> filter -> export
 *
 * Each phase reads/writes a project manifest (JSON on disk).
 * If the agent crashes mid-pipeline, the next cycle resumes from the last saved phase.
 */

// ----- Pipeline Phases -----

export type PipelinePhase =
  | "created"
  | "ingesting"
  | "transcribing"
  | "analyzing"
  | "planning"
  | "editing"
  | "soundtrack"
  | "reframing"
  | "filtering"
  | "exporting"
  | "done"
  | "failed";

/** Valid phase transitions. */
export const PHASE_TRANSITIONS: Record<PipelinePhase, PipelinePhase[]> = {
  created:      ["ingesting"],
  ingesting:    ["transcribing", "failed"],
  transcribing: ["analyzing", "failed"],
  analyzing:    ["planning", "failed"],
  planning:     ["editing", "failed"],
  editing:      ["soundtrack", "failed"],
  soundtrack:   ["reframing", "failed"],
  reframing:    ["filtering", "failed"],
  filtering:    ["exporting", "failed"],
  exporting:    ["done", "failed"],
  done:         [],
  failed:       ["created"], // retry from scratch
};

// ----- Media Files -----

/** Classification of a media file based on content analysis. */
export type MediaClassification =
  | "primary"     // has speech -- main footage
  | "broll"       // no speech -- supplementary footage
  | "voicememo"   // audio only (no video stream)
  | "screencast"  // screen recording (detected via resolution + static regions)
  | "junk";       // corrupt, <1s, or non-media

/** Extended probe result from ffprobe. */
export interface MediaFile {
  /** Absolute path to the source file. */
  path: string;
  /** Original filename. */
  filename: string;
  /** Container format (e.g. "mov,mp4,m4a,3gp,3g2,mj2"). */
  format: string;
  /** Duration in seconds. */
  duration: number;
  /** Video width in pixels. */
  width: number;
  /** Video height in pixels. */
  height: number;
  /** Frames per second. */
  fps: number;
  /** Video codec (e.g. "h264", "hevc"). */
  codec: string;
  /** Pixel format (e.g. "yuv420p"). */
  pixelFormat: string;
  /** Audio codec or null if silent. */
  audioCodec: string | null;
  /** Audio sample rate in Hz, or null if no audio. */
  audioSampleRate: number | null;
  /** Audio channel count, or null if no audio. */
  audioChannels: number | null;
  /** File size in bytes. */
  fileSizeBytes: number;
  /** Creation timestamp (from metadata or filesystem). */
  createdAt: string;
  /** Whether the file has variable frame rate. */
  isVfr: boolean;
  /** Rotation from metadata (0, 90, 180, 270). */
  rotation: number;
  /** Camera make from EXIF/metadata (e.g. "DJI", "FUJIFILM"). */
  cameraMake: string | null;
  /** Camera model from EXIF/metadata. */
  cameraModel: string | null;
  /** Video bitrate in bits/second, or null if unavailable. */
  bitrate: number | null;
  /** Content classification (set after analysis). */
  classification: MediaClassification;
  /** Dedup fingerprint: first-8KB hash + file size. */
  fingerprint: string;
}

// ----- Transcription -----

/** A single segment of transcribed speech. */
export interface TranscriptSegment {
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /** Transcribed text. */
  text: string;
  /** Confidence score (0-1). */
  confidence: number;
}

/** Full transcript for a media file. */
export interface Transcript {
  /** Source media file path. */
  mediaPath: string;
  /** Ordered segments. */
  segments: TranscriptSegment[];
  /** Language code (e.g. "en"). */
  language: string;
  /** Total duration of speech in seconds. */
  speechDuration: number;
  /** Total duration of silence in seconds. */
  silenceDuration: number;
}

// ----- Scene Analysis -----

/** Content type determines reframe strategy. */
export type ContentType =
  | "talking_head"  // subject speaking to camera -> track subject
  | "screen_content" // screen recording -> zoom into regions
  | "establishing"  // wide/landscape shot -> letterbox or full frame
  | "closeup"       // close-up shot -> center crop
  | "action"        // movement-heavy -> track with high smoothing
  | "text_overlay"  // text on screen -> center crop
  | "split_focus";  // multiple subjects -> alternate regions

/** Bounding box for subject tracking. */
export interface BoundingBox {
  /** X position (0-1, fraction of frame width). */
  x: number;
  /** Y position (0-1, fraction of frame height). */
  y: number;
  /** Width (0-1, fraction of frame width). */
  w: number;
  /** Height (0-1, fraction of frame height). */
  h: number;
}

/** Analysis result for a single scene. */
export interface Scene {
  /** Index in the timeline. */
  index: number;
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /** Source media file path. */
  mediaPath: string;
  /** LLM-generated description of the scene. */
  description: string;
  /** Content type classification. */
  contentType: ContentType;
  /** Primary subject bounding box (if applicable). */
  subjectBox: BoundingBox | null;
  /** Energy score (0-1). Low = calm, high = energetic. */
  energy: number;
  /** Whether scene contains sensitive content (to be excluded). */
  sensitive: boolean;
  /** Secondary focus region for split_focus content. */
  secondaryBox: BoundingBox | null;
  /** Keyframe timestamps (seconds) sampled for LLM analysis. */
  keyframeTimes: number[];
}

// ----- Edit Decision List -----

/** A single edit point in the timeline. */
export interface EditPoint {
  /** Source media file path. */
  mediaPath: string;
  /** In-point in seconds. */
  inPoint: number;
  /** Out-point in seconds. */
  outPoint: number;
  /** Purpose of this segment. */
  role: "main" | "broll" | "cold_open" | "transition";
  /** Scene index this edit references. */
  sceneIndex: number;
  /** Whether this requires re-encoding (false = stream copy). */
  needsReencode: boolean;
  /** Transition type to next segment. */
  transitionToNext: "cut" | "dissolve" | "fade_black" | null;
  /** Transition duration in seconds (if applicable). */
  transitionDuration: number;
}

/** Edit decision list -- the full editorial plan. */
export interface EditDecisionList {
  /** Ordered edit points defining the timeline. */
  points: EditPoint[];
  /** Target total duration in seconds (estimated). */
  targetDuration: number;
  /** Topics detected (for multi-topic split suggestion). */
  topics: string[];
  /** Whether multi-video split is suggested. */
  suggestSplit: boolean;
  /** Cold open selection (first 1-3s hook for short-form). */
  coldOpenIndex: number | null;
  /** LLM reasoning for editorial decisions. */
  reasoning: string;
}

// ----- Reframe -----

/** Reframe strategy per scene. */
export type ReframeStrategy =
  | "track_subject"  // follow subject bounding box
  | "zoom_region"    // zoom into specific region (screen content)
  | "letterbox"      // add bars to preserve full frame
  | "center_crop"    // simple center crop
  | "passthrough"    // already correct aspect ratio
  | "split_focus";   // alternate between subject regions

/** Crop keyframe for smooth reframe animation. */
export interface CropKeyframe {
  /** Time in seconds. */
  time: number;
  /** Center X of crop region (0-1, fraction of source width). */
  centerX: number;
  /** Center Y of crop region (0-1, fraction of source height). */
  centerY: number;
  /** Whether this is a hard cut (snap) vs smooth transition. */
  isSnap: boolean;
}

/** Reframe specification for a single edit point. */
export interface ReframeSpec {
  /** Index into EditDecisionList.points. */
  editIndex: number;
  /** Chosen strategy. */
  strategy: ReframeStrategy;
  /** Crop keyframes (interpolated during render). */
  keyframes: CropKeyframe[];
  /** Target aspect ratio (e.g. 16/9, 9/16, 1/1). */
  targetAspect: number;
  /** Target resolution width. */
  targetWidth: number;
  /** Target resolution height. */
  targetHeight: number;
}

// ----- Beauty / Skin Filter -----

export type BeautyStrength = "subtle" | "medium" | "strong";

/** Beauty filter configuration. */
export interface BeautyConfig {
  /** Whether beauty filter is enabled. */
  enabled: boolean;
  /** Filter strength preset. */
  strength: BeautyStrength;
  /** Reason for the default choice. */
  reason: string;
}

/** Bilateral + unsharp parameters per strength level. */
export interface BeautyParams {
  /** bilateral sigmaS (spatial). */
  sigmaS: number;
  /** bilateral sigmaR (range). */
  sigmaR: number;
  /** unsharp luma matrix size. */
  unsharpSize: number;
  /** unsharp luma amount. */
  unsharpAmount: number;
}

// ----- Soundtrack -----

/** A music or sound effect file in the library. */
export interface AudioAsset {
  /** Absolute path to audio file. */
  path: string;
  /** Filename. */
  filename: string;
  /** Duration in seconds. */
  duration: number;
  /** Audio codec. */
  codec: string;
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Channels. */
  channels: number;
  /** BPM if detected, null otherwise. */
  bpm: number | null;
  /** Tags from filename or metadata (e.g. "ambient", "upbeat"). */
  tags: string[];
}

/** A music placement in the timeline. */
export interface MusicPlacement {
  /** Audio asset path. */
  assetPath: string;
  /** Start time in the video timeline (seconds). */
  startTime: number;
  /** End time in the video timeline (seconds). */
  endTime: number;
  /** Base volume (0-1). */
  volume: number;
  /** Whether to apply fade in. */
  fadeIn: number;
  /** Whether to apply fade out. */
  fadeOut: number;
  /** Whether to loop if shorter than placement. */
  loop: boolean;
}

/** Speech-aware volume keyframe for ducking. */
export interface DuckKeyframe {
  /** Time in seconds. */
  time: number;
  /** Volume multiplier (0-1). 1 = full, 0.15 = ducked under speech. */
  volume: number;
}

/** Full soundtrack specification. */
export interface SoundtrackSpec {
  /** Music placements on the timeline. */
  music: MusicPlacement[];
  /** Volume ducking keyframes (applied to all music). */
  duckKeyframes: DuckKeyframe[];
  /** Sound effect placements. */
  sfx: MusicPlacement[];
  /** LLM reasoning for soundtrack choices. */
  reasoning: string;
}

// ----- Platform Export -----

/** Target platform for export. */
export type ExportPlatform =
  | "youtube_long"
  | "youtube_shorts"
  | "tiktok"
  | "instagram_reels"
  | "instagram_feed"
  | "twitter"
  | "twitter_vertical"
  | "raw";

/** Export specification for a single platform. */
export interface ExportSpec {
  /** Target platform. */
  platform: ExportPlatform;
  /** Aspect ratio (width / height). */
  aspect: number;
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. */
  height: number;
  /** CRF value (lower = higher quality). */
  crf: number;
  /** Audio codec. */
  audioCodec: string;
  /** Audio bitrate (e.g. "192k"). */
  audioBitrate: string;
  /** Target loudness in LUFS. */
  targetLufs: number;
  /** Caption handling. */
  captions: "burned" | "sidecar" | "optional" | "none";
}

/** Platform export configuration table. */
export const PLATFORM_SPECS: Record<ExportPlatform, ExportSpec> = {
  youtube_long: {
    platform: "youtube_long",
    aspect: 16 / 9,
    width: 1920,
    height: 1080,
    crf: 18,
    audioCodec: "aac",
    audioBitrate: "192k",
    targetLufs: -14,
    captions: "sidecar",
  },
  youtube_shorts: {
    platform: "youtube_shorts",
    aspect: 9 / 16,
    width: 1080,
    height: 1920,
    crf: 20,
    audioCodec: "aac",
    audioBitrate: "128k",
    targetLufs: -14,
    captions: "burned",
  },
  tiktok: {
    platform: "tiktok",
    aspect: 9 / 16,
    width: 1080,
    height: 1920,
    crf: 23,
    audioCodec: "aac",
    audioBitrate: "128k",
    targetLufs: -14,
    captions: "burned",
  },
  instagram_reels: {
    platform: "instagram_reels",
    aspect: 9 / 16,
    width: 1080,
    height: 1920,
    crf: 22,
    audioCodec: "aac",
    audioBitrate: "128k",
    targetLufs: -14,
    captions: "burned",
  },
  instagram_feed: {
    platform: "instagram_feed",
    aspect: 1,
    width: 1080,
    height: 1080,
    crf: 22,
    audioCodec: "aac",
    audioBitrate: "128k",
    targetLufs: -14,
    captions: "optional",
  },
  twitter: {
    platform: "twitter",
    aspect: 16 / 9,
    width: 1280,
    height: 720,
    crf: 20,
    audioCodec: "aac",
    audioBitrate: "192k",
    targetLufs: -14,
    captions: "sidecar",
  },
  twitter_vertical: {
    platform: "twitter_vertical",
    aspect: 9 / 16,
    width: 720,
    height: 1280,
    crf: 22,
    audioCodec: "aac",
    audioBitrate: "128k",
    targetLufs: -14,
    captions: "burned",
  },
  raw: {
    platform: "raw",
    aspect: 0, // preserve original
    width: 0,
    height: 0,
    crf: 0, // copy
    audioCodec: "copy",
    audioBitrate: "copy",
    targetLufs: 0,
    captions: "sidecar",
  },
};

// ----- Project Manifest -----

/** Complete project state, persisted as JSON on disk. */
export interface ProjectManifest {
  /** Unique project ID. */
  id: string;
  /** Current pipeline phase. */
  phase: PipelinePhase;
  /** Source directory containing raw media. */
  sourceDir: string;
  /** Output directory for renders. */
  outputDir: string;
  /** Target platforms for export. */
  platforms: ExportPlatform[];
  /** Beauty filter setting. */
  beauty: boolean | null;
  /** Beauty filter strength override. */
  beautyStrength: BeautyStrength | null;
  /** Music library path (for soundtrack). */
  musicLibrary: string | null;
  /** Task description from frontmatter. */
  description: string;
  /** Timestamp of manifest creation. */
  createdAt: string;
  /** Timestamp of last update. */
  updatedAt: string;
  /** Error message if phase is "failed". */
  error: string | null;

  // ----- Phase Outputs (populated as pipeline progresses) -----

  /** Discovered and probed media files. */
  files: MediaFile[];
  /** Transcripts per media file. */
  transcripts: Transcript[];
  /** Detected scenes across all media. */
  scenes: Scene[];
  /** Edit decision list. */
  edl: EditDecisionList | null;
  /** Soundtrack specification. */
  soundtrack: SoundtrackSpec | null;
  /** Reframe specifications per edit point per platform. */
  reframes: Record<string, ReframeSpec[]>;
  /** Beauty config resolved per platform. */
  beautyConfigs: Record<string, BeautyConfig>;
  /** Export outputs (platform -> file path). */
  exports: Record<string, string>;
}

/** Frontmatter from a video task file. */
export interface VideoTaskFrontmatter {
  type: "video";
  source: string;
  output: string;
  platforms: ExportPlatform[];
  beauty: boolean | null;
  beautyStrength: BeautyStrength | null;
  musicLibrary: string | null;
  priority: number;
  description: string;
}
