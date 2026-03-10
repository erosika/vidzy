import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isVideoFile, isAudioFile } from "../src/core/ffmpeg.ts";
import { readVideoTasks } from "../src/core/tasks.ts";
import {
  videoTaskToFrontmatter,
  initOrResumeProject,
  shouldRunPhase,
} from "../src/core/runner.ts";
import type { VideoTask } from "../src/core/tasks.ts";
import type { ProjectManifest, PipelinePhase } from "../src/pipeline/types.ts";
import { saveManifest } from "../src/pipeline/project.ts";

// ----- Utility Checks -----

describe("isVideoFile", () => {
  test("recognizes common video extensions", () => {
    expect(isVideoFile("clip.mp4")).toBe(true);
    expect(isVideoFile("raw.mov")).toBe(true);
    expect(isVideoFile("movie.mkv")).toBe(true);
    expect(isVideoFile("stream.webm")).toBe(true);
    expect(isVideoFile("old.avi")).toBe(true);
    expect(isVideoFile("apple.m4v")).toBe(true);
  });

  test("case insensitive", () => {
    expect(isVideoFile("CLIP.MP4")).toBe(true);
    expect(isVideoFile("Raw.MOV")).toBe(true);
  });

  test("rejects non-video files", () => {
    expect(isVideoFile("song.mp3")).toBe(false);
    expect(isVideoFile("readme.md")).toBe(false);
    expect(isVideoFile("image.png")).toBe(false);
    expect(isVideoFile("data.json")).toBe(false);
  });
});

describe("isAudioFile", () => {
  test("recognizes common audio extensions", () => {
    expect(isAudioFile("track.mp3")).toBe(true);
    expect(isAudioFile("sample.wav")).toBe(true);
    expect(isAudioFile("lossless.flac")).toBe(true);
    expect(isAudioFile("compressed.aac")).toBe(true);
    expect(isAudioFile("stream.ogg")).toBe(true);
    expect(isAudioFile("apple.m4a")).toBe(true);
  });

  test("rejects non-audio files", () => {
    expect(isAudioFile("clip.mp4")).toBe(false);
    expect(isAudioFile("readme.md")).toBe(false);
  });
});

// ----- Task Queue -----

let taskRoot: string;
let pendingDir: string;

beforeAll(async () => {
  taskRoot = await mkdtemp(join(tmpdir(), "vidzy-test-"));
  pendingDir = join(taskRoot, "pending");
  await mkdir(pendingDir, { recursive: true });
});

afterAll(async () => {
  await rm(taskRoot, { recursive: true, force: true });
});

describe("readVideoTasks", () => {
  test("returns empty array for nonexistent directory", async () => {
    const tasks = await readVideoTasks("/tmp/vidzy-no-such-dir-999");
    expect(tasks).toEqual([]);
  });

  test("returns empty array for empty directory", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "vidzy-empty-"));
    const tasks = await readVideoTasks(emptyDir);
    expect(tasks).toEqual([]);
    await rm(emptyDir, { recursive: true, force: true });
  });

  test("picks up tasks with type: video frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vidzy-vtype-"));
    await writeFile(
      join(dir, "edit-task.md"),
      `---
type: video
source: /media/raw/clip.mp4
output: /media/renders/clip-final.mp4
priority: 2
---
Trim to 30 seconds and add overlay.`,
    );

    const tasks = await readVideoTasks(dir);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.source).toBe("/media/raw/clip.mp4");
    expect(tasks[0]!.output).toBe("/media/renders/clip-final.mp4");
    expect(tasks[0]!.priority).toBe(2);
    expect(tasks[0]!.description).toContain("Trim to 30 seconds");
    await rm(dir, { recursive: true, force: true });
  });

  test("picks up tasks with video- filename prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vidzy-vprefix-"));
    await writeFile(
      join(dir, "video-thumbnail.md"),
      `---
source: /media/raw/ep01.mp4
---
Extract thumbnail at 00:15.`,
    );

    const tasks = await readVideoTasks(dir);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.filename).toBe("video-thumbnail.md");
    await rm(dir, { recursive: true, force: true });
  });

  test("skips non-video tasks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vidzy-vskip-"));
    await writeFile(
      join(dir, "code-task.md"),
      `---
type: code
repo: /home/eri/project
---
Fix the bug.`,
    );
    await writeFile(join(dir, "plain.md"), "Just a plain file.");

    const tasks = await readVideoTasks(dir);
    expect(tasks.length).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  test("sorts by priority (lower first)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vidzy-vsort-"));
    await writeFile(
      join(dir, "video-low.md"),
      `---
type: video
priority: 10
---
Low priority.`,
    );
    await writeFile(
      join(dir, "video-high.md"),
      `---
type: video
priority: 1
---
High priority.`,
    );

    const tasks = await readVideoTasks(dir);
    expect(tasks.length).toBe(2);
    expect(tasks[0]!.priority).toBe(1);
    expect(tasks[1]!.priority).toBe(10);
    await rm(dir, { recursive: true, force: true });
  });

  test("defaults missing fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vidzy-vdefault-"));
    await writeFile(
      join(dir, "video-bare.md"),
      `---
type: video
---
Minimal task.`,
    );

    const tasks = await readVideoTasks(dir);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.source).toBe("");
    expect(tasks[0]!.output).toBe("");
    expect(tasks[0]!.priority).toBe(5);
    await rm(dir, { recursive: true, force: true });
  });

  test("handles frontmatter values with colons", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vidzy-vcolon-"));
    await writeFile(
      join(dir, "video-remote.md"),
      `---
type: video
source: https://cdn.example.com:8080/clip.mp4
---
Download and convert.`,
    );

    const tasks = await readVideoTasks(dir);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.source).toBe("https://cdn.example.com:8080/clip.mp4");
    await rm(dir, { recursive: true, force: true });
  });
});

// ----- Pipeline Integration -----

describe("videoTaskToFrontmatter", () => {
  const makeTask = (overrides: Partial<VideoTask> = {}): VideoTask => ({
    filename: "video-vlog.md",
    path: "/tasks/pending/video-vlog.md",
    source: "/media/raw/vlog",
    output: "/media/renders/vlog",
    priority: 1,
    description: "February vlog content.",
    meta: {
      type: "video",
      source: "/media/raw/vlog",
      output: "/media/renders/vlog",
    },
    ...overrides,
  });

  test("converts to frontmatter with defaults", () => {
    const fm = videoTaskToFrontmatter(makeTask());
    expect(fm.type).toBe("video");
    expect(fm.source).toBe("/media/raw/vlog");
    expect(fm.output).toBe("/media/renders/vlog");
    expect(fm.description).toContain("February vlog");
  });

  test("extracts platforms from meta", () => {
    const fm = videoTaskToFrontmatter(
      makeTask({ meta: { type: "video", source: "/src", output: "/out", platforms: "youtube_long, tiktok" } }),
    );
    expect(fm.platforms).toContain("youtube_long");
    expect(fm.platforms).toContain("tiktok");
  });

  test("handles beauty settings", () => {
    const fm = videoTaskToFrontmatter(
      makeTask({ meta: { type: "video", source: "/src", output: "/out", beauty: "true", beauty_strength: "medium" } }),
    );
    expect(fm.beauty).toBe(true);
    expect(fm.beautyStrength).toBe("medium");
  });
});

describe("initOrResumeProject", () => {
  test("creates new project when no manifest exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vidzy-proj-"));
    const outputDir = join(dir, "renders");

    const task: VideoTask = {
      filename: "video-test.md",
      path: "/tasks/pending/video-test.md",
      source: dir,
      output: outputDir,
      priority: 1,
      description: "Test project.",
      meta: { type: "video", source: dir, output: outputDir },
    };

    const { manifest, resumed } = initOrResumeProject(task);
    expect(resumed).toBe(false);
    expect(manifest.phase).toBe("created");
    expect(manifest.outputDir).toBe(outputDir);
    expect(manifest.sourceDir).toBe(dir);

    await rm(dir, { recursive: true, force: true });
  });

  test("resumes existing project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vidzy-resume-"));
    const outputDir = join(dir, "renders");
    await mkdir(outputDir, { recursive: true });

    const existingManifest: ProjectManifest = {
      id: "test-resume-id",
      phase: "analyzing",
      sourceDir: dir,
      outputDir,
      platforms: ["youtube_long"],
      beauty: null,
      beautyStrength: null,
      musicLibrary: null,
      description: "In-progress project.",
      createdAt: "2026-02-10T00:00:00Z",
      updatedAt: "2026-02-10T00:00:00Z",
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
    saveManifest(existingManifest);

    const task: VideoTask = {
      filename: "video-test.md",
      path: "/tasks/pending/video-test.md",
      source: dir,
      output: outputDir,
      priority: 1,
      description: "Test project.",
      meta: { type: "video", source: dir, output: outputDir },
    };

    const { manifest, resumed } = initOrResumeProject(task);
    expect(resumed).toBe(true);
    expect(manifest.id).toBe("test-resume-id");
    expect(manifest.phase).toBe("analyzing");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("shouldRunPhase", () => {
  function makeManifest(phase: PipelinePhase): ProjectManifest {
    return {
      id: "test",
      phase,
      sourceDir: "/src",
      outputDir: "/out",
      platforms: ["youtube_long"],
      beauty: null,
      beautyStrength: null,
      musicLibrary: null,
      description: "",
      createdAt: "",
      updatedAt: "",
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

  test("runs ingesting from created", () => {
    expect(shouldRunPhase(makeManifest("created"), "ingesting")).toBe(true);
  });

  test("runs all phases from created", () => {
    const m = makeManifest("created");
    expect(shouldRunPhase(m, "ingesting")).toBe(true);
    expect(shouldRunPhase(m, "transcribing")).toBe(true);
    expect(shouldRunPhase(m, "exporting")).toBe(true);
  });

  test("skips already-completed phases", () => {
    const m = makeManifest("editing");
    expect(shouldRunPhase(m, "ingesting")).toBe(false);
    expect(shouldRunPhase(m, "transcribing")).toBe(false);
    expect(shouldRunPhase(m, "analyzing")).toBe(false);
    expect(shouldRunPhase(m, "planning")).toBe(false);
  });

  test("runs current and future phases on resume", () => {
    const m = makeManifest("editing");
    expect(shouldRunPhase(m, "editing")).toBe(true);
    expect(shouldRunPhase(m, "soundtrack")).toBe(true);
    expect(shouldRunPhase(m, "exporting")).toBe(true);
  });

  test("rejects terminal phases", () => {
    expect(shouldRunPhase(makeManifest("done"), "ingesting")).toBe(false);
    expect(shouldRunPhase(makeManifest("failed"), "ingesting")).toBe(false);
  });
});
