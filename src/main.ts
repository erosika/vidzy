/**
 * vidzy -- video production pipeline CLI.
 *
 * Usage:
 *   bun run src/main.ts <source-dir> [--output <dir>] [--platforms <list>] [--beauty] [--music <dir>]
 *   bun run src/main.ts --task <task.md>
 *   bun run src/main.ts --watch <tasks-dir>
 *
 * Examples:
 *   bun run src/main.ts /media/raw/vlog-2026-03 --output /media/renders/vlog --platforms youtube_long,tiktok
 *   bun run src/main.ts --task tasks/video-edit-intro.md
 */

import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";

import { runPipeline, initOrResumeProject, videoTaskToFrontmatter } from "./core/runner.ts";
import { readVideoTasks } from "./core/tasks.ts";
import type { VideoTask } from "./core/tasks.ts";
import type { VidzyConfig } from "./core/runner.ts";
import type { LlmAdapter } from "./core/llm.ts";

// ----- Arg Parsing -----

function parseArgs(argv: string[]): {
  source?: string;
  output?: string;
  platforms?: string;
  beauty?: boolean;
  beautyStrength?: string;
  musicLibrary?: string;
  taskFile?: string;
  watchDir?: string;
  help?: boolean;
} {
  const args: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--beauty") {
      args.beauty = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return {
    source: positional[0],
    output: args.output as string | undefined,
    platforms: args.platforms as string | undefined,
    beauty: args.beauty as boolean | undefined,
    beautyStrength: args["beauty-strength"] as string | undefined,
    musicLibrary: (args.music ?? args["music-library"]) as string | undefined,
    taskFile: args.task as string | undefined,
    watchDir: args.watch as string | undefined,
    help: args.help as boolean | undefined,
  };
}

function printUsage(): void {
  console.log(`vidzy -- video production pipeline

Usage:
  vidzy <source-dir> [options]
  vidzy --task <task.md>

Options:
  --output <dir>           Output directory (default: <source>/../renders/<source-name>)
  --platforms <list>       Comma-separated: youtube_long,youtube_shorts,tiktok,instagram_reels,instagram_feed,raw
  --beauty                 Enable beauty filter
  --beauty-strength <s>    subtle | medium | strong (default: subtle)
  --music <dir>            Music library directory for soundtrack
  --task <file.md>         Run from a task file with frontmatter
  --watch <dir>            Watch a directory for .md task files
  -h, --help               Show this help

Environment:
  OPENAI_API_KEY           Enable OpenAI Whisper API fallback
  WHISPER_BINARY           Path to whisper-cli binary
  WHISPER_MODEL_PATH       Path to whisper model file
  DIRECTOR_BEAUTY_DEFAULT  Default beauty filter (true/false)

Requires: ffmpeg, ffprobe in PATH.
Optional: whisper-cli for local transcription.`);
}

// ----- LLM Setup -----

/**
 * Auto-detect available LLM provider from environment.
 * Returns an adapter or null if none configured.
 */
function detectLlmAdapter(): LlmAdapter | undefined {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    return async (messages, options) => {
      const model = options.model ?? process.env.OPENROUTER_DEFAULT_MODEL ?? "anthropic/claude-3.5-sonnet";
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openrouterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: options.maxTokens ?? 1024,
          temperature: options.temperature ?? 0.5,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };
      const result = data.choices?.[0]?.message?.content ?? "";
      const tokens = data.usage?.total_tokens ?? 0;
      // Rough cost estimate
      const costUsd = tokens * 0.000003;

      return { result, costUsd };
    };
  }

  return undefined;
}

// ----- Main -----

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.source && !args.taskFile && !args.watchDir)) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const llm = detectLlmAdapter();
  const config: VidzyConfig = { llm };

  // Task file mode
  if (args.taskFile) {
    const taskPath = resolve(args.taskFile);
    if (!existsSync(taskPath)) {
      console.error(`Task file not found: ${taskPath}`);
      process.exit(1);
    }

    const content = await Bun.file(taskPath).text();
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const meta: Record<string, string> = {};
    let body = content;

    if (match?.[1]) {
      for (const line of match[1].split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        meta[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
      }
      body = (match[2] ?? content).trim();
    }

    const task: VideoTask = {
      filename: basename(taskPath),
      path: taskPath,
      source: meta.source ?? "",
      output: meta.output ?? "",
      priority: parseInt(meta.priority ?? "5", 10),
      description: body,
      meta,
    };

    const { manifest } = initOrResumeProject(task);
    const result = await runPipeline(manifest, config);
    process.exit(result.success ? 0 : 1);
  }

  // Watch mode
  if (args.watchDir) {
    const watchDir = resolve(args.watchDir);
    console.log(`[vidzy] Watching ${watchDir} for video tasks...`);

    const poll = async () => {
      const tasks = await readVideoTasks(watchDir);
      if (tasks.length > 0) {
        const task = tasks[0]!;
        console.log(`[vidzy] Processing: ${task.filename}`);
        const { manifest } = initOrResumeProject(task);
        await runPipeline(manifest, config);
      }
    };

    await poll();
    setInterval(poll, 30_000);
    // Keep alive
    await new Promise(() => {});
  }

  // Direct source mode
  if (args.source) {
    const source = resolve(args.source);
    if (!existsSync(source)) {
      console.error(`Source not found: ${source}`);
      process.exit(1);
    }

    const task: VideoTask = {
      filename: "cli-task",
      path: "",
      source,
      output: args.output ? resolve(args.output) : "",
      priority: 1,
      description: "",
      meta: {
        type: "video",
        source,
        output: args.output ?? "",
        platforms: args.platforms ?? "youtube_long",
        beauty: args.beauty ? "true" : "false",
        beauty_strength: args.beautyStrength ?? "subtle",
        music_library: args.musicLibrary ?? "",
      },
    };

    const { manifest, resumed } = initOrResumeProject(task);
    if (resumed) {
      console.log(`[vidzy] Resuming from phase: ${manifest.phase}`);
    }

    const result = await runPipeline(manifest, config);
    console.log(`[vidzy] ${result.summary}`);
    process.exit(result.success ? 0 : 1);
  }
}
