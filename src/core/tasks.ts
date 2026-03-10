/**
 * Video task queue reader.
 *
 * Reads .md files with YAML frontmatter from a directory.
 * Task format:
 *
 * ```yaml
 * ---
 * type: video
 * source: /path/to/source/media
 * output: /path/to/output
 * platforms: youtube_long, youtube_shorts, tiktok
 * beauty: true
 * beauty_strength: subtle
 * music_library: /path/to/music
 * priority: 1
 * ---
 * # Task description here
 * ```
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// ----- Types -----

export interface VideoTask {
  filename: string;
  path: string;
  source: string;
  output: string;
  priority: number;
  description: string;
  meta: Record<string, string>;
}

// ----- Frontmatter Parser -----

function parseVideoFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match?.[1]) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    meta[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
  }
  return { meta, body: (match[2] ?? content).trim() };
}

// ----- Reader -----

/** Read pending video tasks from a directory. */
export async function readVideoTasks(dir: string): Promise<VideoTask[]> {
  try {
    await stat(dir);
  } catch {
    return [];
  }

  const entries = await readdir(dir);
  const tasks: VideoTask[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const filePath = join(dir, entry);
    const content = await Bun.file(filePath).text();
    const { meta, body } = parseVideoFrontmatter(content);

    if (meta.type !== "video" && !entry.startsWith("video-")) continue;

    tasks.push({
      filename: entry,
      path: filePath,
      source: meta.source ?? "",
      output: meta.output ?? "",
      priority: parseInt(meta.priority ?? "5", 10),
      description: body,
      meta,
    });
  }

  tasks.sort((a, b) => a.priority - b.priority);
  return tasks;
}
