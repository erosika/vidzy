# vidzy

Video production pipeline. Takes raw footage through nine phases to finished platform-ready exports.

```
ingest -> transcribe -> analyze -> plan -> edit -> soundtrack -> reframe -> filter -> export
```

Zero npm dependencies. Bun + TypeScript + ffmpeg. Optional LLM vision for scene analysis and editorial planning.

## Requirements

- [Bun](https://bun.sh) runtime
- `ffmpeg` and `ffprobe` in PATH
- Optional: `whisper-cli` for local transcription
- Optional: OpenAI API key for Whisper API fallback
- Optional: OpenRouter API key for LLM scene analysis

## Usage

### CLI

```sh
# Process a directory of footage
bun run src/main.ts /media/raw/vlog-2026-03 --output /media/renders/vlog --platforms youtube_long,tiktok

# Run from a task file
bun run src/main.ts --task video-edit-intro.md

# Watch a directory for task files
bun run src/main.ts --watch tasks/
```

### Task files

Drop `.md` files with YAML frontmatter:

```yaml
---
type: video
source: /media/raw/vlog
output: /media/renders/vlog
platforms: youtube_long, youtube_shorts, tiktok
beauty: true
beauty_strength: subtle
music_library: /media/music
priority: 1
---
February vlog -- trim dead air, add cold open for shorts.
```

### Library

```ts
import { runPipeline, initOrResumeProject } from "./src/index.ts";
import type { LlmAdapter, VidzyConfig } from "./src/index.ts";

const llm: LlmAdapter = async (messages, options) => {
  // your LLM provider here
  return { result: "...", costUsd: 0 };
};

const task = {
  filename: "vlog.md",
  path: "",
  source: "/media/raw/vlog",
  output: "/media/renders/vlog",
  priority: 1,
  description: "February vlog",
  meta: { type: "video", source: "/media/raw/vlog", platforms: "youtube_long,tiktok" },
};

const { manifest } = initOrResumeProject(task);
const result = await runPipeline(manifest, { llm });
```

## Pipeline phases

| Phase | What it does | Requires LLM |
|-------|-------------|--------------|
| **ingest** | Discover media, probe with ffprobe, detect VFR, dedup, classify | no |
| **transcribe** | Extract audio, run whisper (local or API), build transcript | no |
| **analyze** | Scene detection, keyframe extraction, content type classification | optional |
| **plan** | Editorial decisions -- take selection, jump cuts, b-roll, cold opens | optional |
| **edit** | ffmpeg cut + concat from edit decision list, SRT generation | no |
| **soundtrack** | Music selection, auto-ducking under speech, SFX at transitions | no |
| **reframe** | Content-aware cropping per platform aspect ratio (16:9, 9:16, 1:1) | no |
| **filter** | Camera-aware beauty filter (bilateral + unsharp, three presets) | no |
| **export** | Platform encoding, caption burn-in, thumbnails, sidecar SRT | no |

Without an LLM adapter, analyze and plan phases use heuristic-only logic. Everything still works.

## Platform exports

| Platform | Aspect | Resolution | Captions |
|----------|--------|------------|----------|
| youtube_long | 16:9 | 1920x1080 | sidecar SRT |
| youtube_shorts | 9:16 | 1080x1920 | burned |
| tiktok | 9:16 | 1080x1920 | burned |
| instagram_reels | 9:16 | 1080x1920 | burned |
| instagram_feed | 1:1 | 1080x1080 | optional |
| raw | original | original | sidecar SRT |

## Crash recovery

Pipeline state is persisted as a JSON manifest (`project.json`) in the output directory. Atomic writes (tmp + rename) prevent corruption. If the process crashes mid-pipeline, the next run resumes from the last completed phase.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | LLM for scene analysis + editorial planning |
| `OPENROUTER_DEFAULT_MODEL` | Model override (default: anthropic/claude-3.5-sonnet) |
| `OPENAI_API_KEY` | Whisper API fallback for transcription |
| `WHISPER_BINARY` | Path to whisper-cli binary |
| `WHISPER_MODEL_PATH` | Path to whisper model file |
| `DIRECTOR_BEAUTY_DEFAULT` | Default beauty filter (true/false) |

## Tests

```sh
bun test
```

## License

MIT
