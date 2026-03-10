/**
 * Pipeline runner -- standalone orchestration.
 *
 * Extracted from cosmania's director.ts agent cycle.
 * Drives the full pipeline: ingest -> transcribe -> analyze ->
 * plan -> edit -> soundtrack -> reframe -> filter -> export.
 *
 * LLM calls are injected via the LlmAdapter interface.
 * If no adapter is provided, LLM-dependent phases (analyze, plan)
 * fall back to heuristic-only logic.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename, extname } from "node:path";

import type { LlmAdapter, ContentPart } from "./llm.ts";
import { nullAdapter } from "./llm.ts";
import { runFfmpeg } from "./ffmpeg.ts";
import type { VideoTask } from "./tasks.ts";

import type {
  ProjectManifest,
  PipelinePhase,
  Transcript,
  TranscriptSegment,
  VideoTaskFrontmatter,
} from "../pipeline/types.ts";
import {
  createManifest,
  saveManifest,
  loadManifest,
  advancePhase,
  getResumablePhase,
  parseTaskFrontmatter,
} from "../pipeline/project.ts";
import { calculateProgress, checkDiskSpace } from "../pipeline/progress.ts";
import { resolveBeautyConfig, buildBeautyFilterChain } from "../pipeline/filter.ts";
import {
  buildExportPlans,
  isShortForm,
  getExportSpec,
  buildExportArgs,
  buildThumbnailArgs,
  generateOutputFilename,
  generateSrtFilename,
  generateThumbnailFilename,
  buildVideoFilterChain,
} from "../pipeline/export.ts";
import { ingest } from "../pipeline/ingest.ts";
import {
  extractAudio,
  runWhisperCli,
  transcribeViaApi,
  buildTranscript,
  parseWhisperJson,
  generateSrt,
} from "../pipeline/transcribe.ts";
import {
  detectSceneChanges,
  buildSceneBoundaries,
  distributeFrameBudget,
  calculateFrameSampling,
  extractKeyframes,
  buildAnalysisPrompt,
  parseSceneAnalysis,
  buildScenes,
  getTranscriptForRange,
} from "../pipeline/analyze.ts";
import {
  buildPlanningPrompt,
  parseEditorialPlan,
  buildEditDecisionList,
} from "../pipeline/plan.ts";
import {
  buildCutArgs,
  buildConcatList,
  buildConcatArgs,
  optimizeEditPoints,
  generateEditedSrt,
  needsConcatReencode,
} from "../pipeline/edit.ts";
import { scanMusicLibrary, buildSoundtrackSpec } from "../pipeline/soundtrack.ts";
import {
  buildReframeSpecs,
  buildCropFilter,
  buildLetterboxFilter,
} from "../pipeline/reframe.ts";

// ----- Config -----

export interface VidzyConfig {
  /** LLM adapter for vision analysis + editorial planning. */
  llm?: LlmAdapter;
  /** Vision model for scene analysis (default: "anthropic/claude-3.5-sonnet"). */
  visionModel?: string;
  /** Max frames to send to LLM for analysis (default: 50). */
  maxAnalysisFrames?: number;
  /** Log function (default: console.log). */
  log?: (msg: string) => void;
}

const ANALYSIS_MAX_FRAMES = 50;
const VISION_MODEL = "anthropic/claude-3.5-sonnet";

// ----- Helpers -----

function getLatestPipelineVideo(manifest: ProjectManifest): string {
  const soundtracked = join(manifest.outputDir, "soundtracked.mp4");
  if (existsSync(soundtracked)) return soundtracked;

  const edited = join(manifest.outputDir, "edited.mp4");
  if (existsSync(edited)) return edited;

  const primary = manifest.files.find((f) => f.classification === "primary");
  return primary?.path ?? manifest.files[0]?.path ?? "";
}

function getAllSegments(transcripts: Transcript[]): TranscriptSegment[] {
  return transcripts.flatMap((t) => t.segments);
}

// ----- Public API -----

/** Convert a VideoTask into VideoTaskFrontmatter. */
export function videoTaskToFrontmatter(task: VideoTask): VideoTaskFrontmatter {
  return parseTaskFrontmatter(task.meta, task.description);
}

/** Initialize or resume a project manifest for a video task. */
export function initOrResumeProject(
  task: VideoTask,
): { manifest: ProjectManifest; resumed: boolean } {
  const outputDir = task.output || join(task.source, "..", "renders", basename(task.source));

  const existing = loadManifest(outputDir);
  if (existing) {
    const resumePhase = getResumablePhase(existing);
    return { manifest: existing, resumed: true };
  }

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const frontmatter = videoTaskToFrontmatter(task);
  const manifest = createManifest(frontmatter, outputDir);
  saveManifest(manifest);
  return { manifest, resumed: false };
}

/** Check if a phase needs to run based on manifest state. */
export function shouldRunPhase(manifest: ProjectManifest, phase: PipelinePhase): boolean {
  const phaseOrder: PipelinePhase[] = [
    "created", "ingesting", "transcribing", "analyzing", "planning",
    "editing", "soundtrack", "reframing", "filtering", "exporting",
  ];

  const currentIdx = phaseOrder.indexOf(manifest.phase);
  const targetIdx = phaseOrder.indexOf(phase);

  if (targetIdx < 0) return false;
  if (currentIdx < 0) return false;

  return currentIdx <= targetIdx;
}

function logProgress(manifest: ProjectManifest, phaseProgress: number, log: (msg: string) => void): void {
  const pct = calculateProgress(manifest, phaseProgress);
  log(`[vidzy] [${manifest.id}] Progress: ${pct.toFixed(0)}%`);
}

// ----- Pipeline Runner -----

/**
 * Run the full video pipeline for a project.
 *
 * Each phase advances the manifest atomically.
 * On crash, getResumablePhase() picks up from where it left off.
 */
export async function runPipeline(
  manifest: ProjectManifest,
  config: VidzyConfig = {},
): Promise<{ success: boolean; summary: string; phasesCompleted: string[]; costUsd: number }> {
  const llm = config.llm ?? nullAdapter;
  const visionModel = config.visionModel ?? VISION_MODEL;
  const maxFrames = config.maxAnalysisFrames ?? ANALYSIS_MAX_FRAMES;
  const log = config.log ?? console.log;

  const completed: string[] = [];
  const startPhase = manifest.phase;
  let totalCostUsd = 0;

  const tmpDir = join(manifest.outputDir, "tmp");
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }

  try {
    // Phase 1: Ingesting
    if (shouldRunPhase(manifest, "ingesting")) {
      advancePhase(manifest, "ingesting");
      log(`[vidzy] [${manifest.id}] Ingesting from ${manifest.sourceDir}`);

      const diskOk = await checkDiskSpace(manifest.outputDir);
      if (!diskOk.ok) {
        log(`[vidzy] Warning: ${diskOk.message}`);
      }

      const ingestResult = await ingest(manifest.sourceDir, (current, total, file) => {
        log(`[vidzy]   Probing ${current}/${total}: ${file}`);
      });

      manifest.files = ingestResult.files;
      saveManifest(manifest);

      if (ingestResult.files.length === 0) {
        throw new Error("No valid media files found in source directory");
      }

      log(
        `[vidzy]   Found ${ingestResult.files.length} files` +
          (ingestResult.duplicates.length ? `, ${ingestResult.duplicates.length} duplicates skipped` : "") +
          (ingestResult.junk.length ? `, ${ingestResult.junk.length} junk skipped` : ""),
      );
      completed.push("ingesting");
      logProgress(manifest, 0, log);
    }

    // Phase 2: Transcribing
    if (shouldRunPhase(manifest, "transcribing")) {
      advancePhase(manifest, "transcribing");
      const transcribable = manifest.files.filter(
        (f) => f.classification !== "junk" && f.classification !== "broll",
      );
      log(`[vidzy] [${manifest.id}] Transcribing ${transcribable.length} files`);

      const transcripts: Transcript[] = [];

      for (const file of transcribable) {
        const wavPath = join(tmpDir, basename(file.path, extname(file.path)) + ".wav");
        log(`[vidzy]   Extracting audio: ${file.filename}`);
        const audioResult = await extractAudio(file.path, wavPath);

        if (!audioResult.success) {
          log(`[vidzy]   Audio extraction failed for ${file.filename}, skipping`);
          continue;
        }

        let segments: TranscriptSegment[] = [];
        let language = "en";

        const whisperResult = await runWhisperCli(wavPath, "json");
        if (whisperResult.success && whisperResult.output.trim()) {
          try {
            segments = parseWhisperJson(whisperResult.output);
            log(`[vidzy]   Whisper: ${segments.length} segments (${whisperResult.durationMs}ms)`);
          } catch {
            log(`[vidzy]   Whisper JSON parse failed, trying API fallback`);
          }
        }

        if (segments.length === 0) {
          log(`[vidzy]   Trying OpenAI Whisper API for ${file.filename}`);
          const apiResult = await transcribeViaApi(wavPath);
          if (apiResult.success) {
            segments = apiResult.segments;
            language = apiResult.language || "en";
            log(`[vidzy]   API: ${segments.length} segments`);
          }
        }

        transcripts.push(buildTranscript(file.path, segments, file.duration, language));
      }

      manifest.transcripts = transcripts;
      saveManifest(manifest);
      completed.push("transcribing");
      logProgress(manifest, 0, log);
    }

    // Phase 3: Analyzing (LLM vision)
    if (shouldRunPhase(manifest, "analyzing")) {
      advancePhase(manifest, "analyzing");
      log(`[vidzy] [${manifest.id}] Analyzing scenes`);

      const allSegments = getAllSegments(manifest.transcripts);
      const videoFiles = manifest.files.filter((f) => f.width > 0 && f.height > 0);
      const framesDir = join(tmpDir, "frames");

      for (const file of videoFiles) {
        log(`[vidzy]   Detecting scenes in ${file.filename}`);
        const changePoints = await detectSceneChanges(file.path);
        const boundaries = buildSceneBoundaries(changePoints, file.duration);
        const frameBudget = distributeFrameBudget(boundaries, maxFrames);

        const analyses: Array<ReturnType<typeof parseSceneAnalysis>> = [];
        const allKeyframeTimes: number[][] = [];

        for (let si = 0; si < boundaries.length; si++) {
          const boundary = boundaries[si]!;
          const sceneDuration = boundary.end - boundary.start;
          const frameCount = frameBudget[si] ?? 1;
          const timestamps = calculateFrameSampling(sceneDuration, frameCount, boundary.start);
          allKeyframeTimes.push(timestamps);

          const prefix = `${basename(file.path, extname(file.path))}_s${si}`;
          const framePaths = await extractKeyframes(file.path, timestamps, framesDir, prefix);

          if (framePaths.length === 0) {
            analyses.push(null);
            continue;
          }

          const transcriptText = getTranscriptForRange(allSegments, boundary.start, boundary.end);
          const textPrompt = buildAnalysisPrompt(si, boundary.start, boundary.end, transcriptText, framePaths.length);

          const contentParts: ContentPart[] = [
            { type: "text", text: textPrompt },
          ];
          for (const fp of framePaths) {
            try {
              const imgBuffer = readFileSync(fp);
              const b64 = Buffer.from(imgBuffer).toString("base64");
              contentParts.push({
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${b64}` },
              });
            } catch {
              // Skip unreadable frames
            }
          }

          try {
            const llmResult = await llm(
              [{ role: "user", content: contentParts }],
              { model: visionModel, maxTokens: 512, temperature: 0.3 },
            );
            totalCostUsd += llmResult.costUsd;
            analyses.push(parseSceneAnalysis(llmResult.result));
          } catch (err) {
            log(`[vidzy]   LLM analysis failed for scene ${si}: ${err}`);
            analyses.push(null);
          }
        }

        const scenes = buildScenes(boundaries, file.path, analyses, allKeyframeTimes);
        manifest.scenes.push(...scenes);
      }

      saveManifest(manifest);
      log(`[vidzy]   ${manifest.scenes.length} scenes analyzed ($${totalCostUsd.toFixed(4)})`);
      completed.push("analyzing");
      logProgress(manifest, 0, log);
    }

    // Phase 4: Planning (LLM editorial decisions)
    if (shouldRunPhase(manifest, "planning")) {
      advancePhase(manifest, "planning");
      log(`[vidzy] [${manifest.id}] Planning edit`);

      const allSegments = getAllSegments(manifest.transcripts);
      const prompt = buildPlanningPrompt(
        manifest.scenes,
        manifest.transcripts,
        manifest.files,
        manifest.description,
      );

      try {
        const llmResult = await llm(
          [{ role: "user", content: prompt }],
          { maxTokens: 2048, temperature: 0.5 },
        );
        totalCostUsd += llmResult.costUsd;

        const editorialPlan = parseEditorialPlan(llmResult.result);
        if (editorialPlan) {
          log(`[vidzy]   Plan: ${editorialPlan.narrativeStructure.slice(0, 100)}`);
        }
      } catch (err) {
        log(`[vidzy]   LLM planning failed, using heuristic EDL: ${err}`);
      }

      const hasShortForm = manifest.platforms.some(isShortForm);
      manifest.edl = buildEditDecisionList(manifest.scenes, allSegments, {
        excludeSensitive: true,
        insertBroll: true,
        includeColdOpen: hasShortForm,
      });

      saveManifest(manifest);
      log(`[vidzy]   EDL: ${manifest.edl.points.length} edit points, ${manifest.edl.targetDuration.toFixed(1)}s target`);
      completed.push("planning");
      logProgress(manifest, 0, log);
    }

    // Phase 5: Editing (ffmpeg cut + concat)
    if (shouldRunPhase(manifest, "editing")) {
      advancePhase(manifest, "editing");
      log(`[vidzy] [${manifest.id}] Executing edit`);

      if (!manifest.edl || manifest.edl.points.length === 0) {
        throw new Error("No edit decision list available");
      }

      const segDir = join(manifest.outputDir, "segments");
      if (!existsSync(segDir)) {
        mkdirSync(segDir, { recursive: true });
      }

      const primaryFile = manifest.files.find((f) => f.classification === "primary");
      const fps = primaryFile?.fps ?? 30;
      manifest.edl.points = optimizeEditPoints(manifest.edl.points, fps);

      const segmentPaths: string[] = [];
      for (let i = 0; i < manifest.edl.points.length; i++) {
        const point = manifest.edl.points[i]!;
        const segPath = join(segDir, `seg_${String(i).padStart(3, "0")}.mp4`);
        const cutArgs = buildCutArgs(point, segPath, point.needsReencode);
        const cutResult = await runFfmpeg(cutArgs);

        if (!cutResult.success) {
          log(`[vidzy]   Cut failed for segment ${i}: ${cutResult.stderr.slice(0, 200)}`);
          const reencodeArgs = buildCutArgs(point, segPath, true);
          const retryResult = await runFfmpeg(reencodeArgs);
          if (!retryResult.success) {
            throw new Error(`Segment ${i} cut failed: ${retryResult.stderr.slice(0, 200)}`);
          }
        }
        segmentPaths.push(segPath);
      }

      const concatListContent = buildConcatList(segmentPaths);
      const concatListPath = join(tmpDir, "concat.txt");
      writeFileSync(concatListPath, concatListContent, "utf-8");

      const editedPath = join(manifest.outputDir, "edited.mp4");
      const reencode = needsConcatReencode(manifest.files);
      const concatArgs = buildConcatArgs(concatListPath, editedPath, reencode);
      const concatResult = await runFfmpeg(concatArgs, 600_000);

      if (!concatResult.success) {
        throw new Error(`Concat failed: ${concatResult.stderr.slice(0, 200)}`);
      }

      const allSegments = getAllSegments(manifest.transcripts);
      const srtContent = generateEditedSrt(manifest.edl, allSegments);
      const srtPath = join(manifest.outputDir, "edited.srt");
      writeFileSync(srtPath, srtContent, "utf-8");

      saveManifest(manifest);
      log(`[vidzy]   ${segmentPaths.length} segments -> ${editedPath}`);
      completed.push("editing");
      logProgress(manifest, 0, log);
    }

    // Phase 6: Soundtrack
    if (shouldRunPhase(manifest, "soundtrack")) {
      advancePhase(manifest, "soundtrack");
      log(`[vidzy] [${manifest.id}] Building soundtrack`);

      if (manifest.musicLibrary && manifest.edl) {
        const musicAssets = await scanMusicLibrary(manifest.musicLibrary);
        const allSegments = getAllSegments(manifest.transcripts);

        const spec = buildSoundtrackSpec(
          manifest.edl, allSegments, manifest.scenes, musicAssets, [],
        );

        manifest.soundtrack = spec;

        if (spec.music.length > 0) {
          const inputVideo = getLatestPipelineVideo(manifest);
          const outputPath = join(manifest.outputDir, "soundtracked.mp4");
          const musicPath = spec.music[0]!.assetPath;

          const mixArgs = [
            "-i", inputVideo,
            "-i", musicPath,
            "-filter_complex",
            `[1:a]volume=${spec.music[0]!.volume},afade=t=in:d=${spec.music[0]!.fadeIn},afade=t=out:st=${Math.max(0, manifest.edl.targetDuration - spec.music[0]!.fadeOut)}:d=${spec.music[0]!.fadeOut}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
            "-map", "0:v",
            "-map", "[aout]",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            outputPath,
          ];

          const mixResult = await runFfmpeg(mixArgs, 600_000);
          if (mixResult.success) {
            log(`[vidzy]   Music mixed: ${basename(musicPath)}`);
          } else {
            log(`[vidzy]   Music mix failed, continuing without: ${mixResult.stderr.slice(0, 200)}`);
            manifest.soundtrack = null;
          }
        } else {
          log(`[vidzy]   No matching music found, audio passthrough`);
        }
      } else {
        log(`[vidzy]   No music library configured, audio passthrough`);
        manifest.soundtrack = null;
      }

      saveManifest(manifest);
      completed.push("soundtrack");
      logProgress(manifest, 0, log);
    }

    // Phase 7: Reframing
    if (shouldRunPhase(manifest, "reframing")) {
      advancePhase(manifest, "reframing");
      log(`[vidzy] [${manifest.id}] Reframing for ${manifest.platforms.length} platforms`);

      const primaryFile = manifest.files.find((f) => f.classification === "primary");
      const sourceW = primaryFile?.width ?? 1920;
      const sourceH = primaryFile?.height ?? 1080;

      for (const platform of manifest.platforms) {
        const spec = getExportSpec(platform);
        if (manifest.edl) {
          const reframeSpecs = buildReframeSpecs(
            manifest.edl.points, manifest.scenes, sourceW, sourceH, spec,
          );
          manifest.reframes[platform] = reframeSpecs;
          log(`[vidzy]   ${platform}: ${reframeSpecs.length} reframe specs`);
        }
      }

      saveManifest(manifest);
      completed.push("reframing");
      logProgress(manifest, 0, log);
    }

    // Phase 8: Filtering
    if (shouldRunPhase(manifest, "filtering")) {
      advancePhase(manifest, "filtering");
      log(`[vidzy] [${manifest.id}] Applying filters`);

      const primaryFile = manifest.files.find((f) => f.classification === "primary");
      for (const platform of manifest.platforms) {
        if (primaryFile) {
          const contentType = manifest.scenes[0]?.contentType ?? "talking_head";
          const beautyConfig = resolveBeautyConfig(
            primaryFile, contentType, manifest.beauty, manifest.beautyStrength,
          );
          manifest.beautyConfigs[platform] = beautyConfig;
          const filterChain = buildBeautyFilterChain(beautyConfig);
          log(
            `[vidzy]   ${platform}: beauty=${beautyConfig.enabled}` +
              (filterChain ? ` (${beautyConfig.strength})` : ` (${beautyConfig.reason})`),
          );
        }
      }

      saveManifest(manifest);
      completed.push("filtering");
      logProgress(manifest, 0, log);
    }

    // Phase 9: Exporting
    if (shouldRunPhase(manifest, "exporting")) {
      advancePhase(manifest, "exporting");
      log(`[vidzy] [${manifest.id}] Exporting to ${manifest.platforms.length} platforms`);

      const inputPath = getLatestPipelineVideo(manifest);
      const srtPath = join(manifest.outputDir, "edited.srt");
      const hasSrt = existsSync(srtPath);
      const primaryFile = manifest.files.find((f) => f.classification === "primary");
      const sourceW = primaryFile?.width ?? 1920;
      const sourceH = primaryFile?.height ?? 1080;
      const projectName = basename(manifest.outputDir);

      for (const platform of manifest.platforms) {
        const spec = getExportSpec(platform);
        const outputFilename = generateOutputFilename(projectName, platform);
        const outputPath = join(manifest.outputDir, outputFilename);

        let reframeFilter = "";
        const reframeSpecs = manifest.reframes[platform];
        if (reframeSpecs && reframeSpecs.length > 0 && spec.width > 0) {
          const firstSpec = reframeSpecs[0]!;
          if (firstSpec.strategy === "letterbox") {
            reframeFilter = buildLetterboxFilter(sourceW, sourceH, spec.width, spec.height);
          } else if (firstSpec.strategy !== "passthrough") {
            const kf = firstSpec.keyframes[0] ?? { centerX: 0.5, centerY: 0.5 };
            reframeFilter = buildCropFilter(kf.centerX, kf.centerY, sourceW, sourceH, spec.width, spec.height);
          }
        }

        const beautyConfig = manifest.beautyConfigs[platform];
        const beautyFilter = beautyConfig ? buildBeautyFilterChain(beautyConfig) : "";
        const videoFilter = buildVideoFilterChain(reframeFilter, beautyFilter, spec);

        const exportArgs = buildExportArgs(
          inputPath, outputPath, spec, videoFilter,
          hasSrt ? srtPath : undefined,
        );

        log(`[vidzy]   Encoding ${platform}: ${outputFilename}`);
        const exportResult = await runFfmpeg(exportArgs, 1_200_000);

        if (!exportResult.success) {
          log(`[vidzy]   Export failed for ${platform}: ${exportResult.stderr.slice(0, 500)}`);
          continue;
        }

        manifest.exports[platform] = outputPath;

        const thumbFilename = generateThumbnailFilename(outputFilename);
        const thumbPath = join(manifest.outputDir, thumbFilename);
        const duration = primaryFile?.duration ?? 10;
        const thumbArgs = buildThumbnailArgs(outputPath, thumbPath, duration / 3);
        await runFfmpeg(thumbArgs);

        if (spec.captions === "sidecar" && hasSrt) {
          const srtOutFilename = generateSrtFilename(outputFilename);
          const srtOutPath = join(manifest.outputDir, srtOutFilename);
          const srtContent = readFileSync(srtPath, "utf-8");
          writeFileSync(srtOutPath, srtContent, "utf-8");
        }

        log(`[vidzy]   ${platform}: done`);
      }

      saveManifest(manifest);
      completed.push("exporting");
      logProgress(manifest, 0, log);
    }

    // Cleanup
    try {
      const { rmSync } = await import("node:fs");
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Non-fatal
    }

    advancePhase(manifest, "done");
    log(`[vidzy] [${manifest.id}] Pipeline complete`);

    return {
      success: true,
      summary: `Pipeline complete: ${completed.length} phases from ${startPhase}`,
      phasesCompleted: completed,
      costUsd: totalCostUsd,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[vidzy] [${manifest.id}] Pipeline failed at ${manifest.phase}: ${msg}`);

    try {
      advancePhase(manifest, "failed", msg);
    } catch {
      // Already terminal
    }

    return {
      success: false,
      summary: `Failed at ${manifest.phase}: ${msg}`,
      phasesCompleted: completed,
      costUsd: totalCostUsd,
    };
  }
}
