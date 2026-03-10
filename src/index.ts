/**
 * vidzy -- public API.
 *
 * Import from here when using vidzy as a library:
 *
 *   import { runPipeline, initOrResumeProject } from "vidzy";
 */

// Core
export { runPipeline, initOrResumeProject, shouldRunPhase, videoTaskToFrontmatter } from "./core/runner.ts";
export type { VidzyConfig } from "./core/runner.ts";
export type { LlmAdapter, LlmMessage, LlmResult, ContentPart } from "./core/llm.ts";
export { nullAdapter } from "./core/llm.ts";
export { probeMedia, runFfmpeg, isVideoFile, isAudioFile } from "./core/ffmpeg.ts";
export type { MediaProbe } from "./core/ffmpeg.ts";
export { readVideoTasks } from "./core/tasks.ts";
export type { VideoTask } from "./core/tasks.ts";

// Pipeline types
export type {
  ProjectManifest,
  PipelinePhase,
  MediaFile,
  MediaClassification,
  Transcript,
  TranscriptSegment,
  Scene,
  ContentType,
  BoundingBox,
  EditDecisionList,
  EditPoint,
  ReframeSpec,
  ReframeStrategy,
  CropKeyframe,
  BeautyConfig,
  BeautyStrength,
  BeautyParams,
  SoundtrackSpec,
  MusicPlacement,
  DuckKeyframe,
  AudioAsset,
  ExportPlatform,
  ExportSpec,
  VideoTaskFrontmatter,
} from "./pipeline/types.ts";

// Pipeline modules (for advanced usage)
export { createManifest, saveManifest, loadManifest, advancePhase, getResumablePhase } from "./pipeline/project.ts";
export { calculateProgress, checkDiskSpace } from "./pipeline/progress.ts";
export { ingest } from "./pipeline/ingest.ts";
export { extractAudio, runWhisperCli, transcribeViaApi, buildTranscript, generateSrt } from "./pipeline/transcribe.ts";
export { detectSceneChanges, buildSceneBoundaries, buildAnalysisPrompt, parseSceneAnalysis } from "./pipeline/analyze.ts";
export { buildPlanningPrompt, parseEditorialPlan, buildEditDecisionList } from "./pipeline/plan.ts";
export { buildCutArgs, buildConcatList, buildConcatArgs, generateEditedSrt } from "./pipeline/edit.ts";
export { scanMusicLibrary, buildSoundtrackSpec } from "./pipeline/soundtrack.ts";
export { buildReframeSpecs, buildCropFilter, buildLetterboxFilter } from "./pipeline/reframe.ts";
export { resolveBeautyConfig, buildBeautyFilterChain } from "./pipeline/filter.ts";
export { buildExportArgs, isShortForm, getExportSpec } from "./pipeline/export.ts";
