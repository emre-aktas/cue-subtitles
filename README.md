# Cue

Pick a video, get a broadcast-quality `.srt`. Everything runs on your own machine —
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) for transcription, ffmpeg for
audio. Audio is never uploaded anywhere; the network is only used once, to download
the engine and the model you choose.

```bash
npm install
npm start
```

---

## What it actually does

```
video ─► ffmpeg ─► 16 kHz mono WAV ─► whisper.cpp ─► words + timings + confidence
                                                            │
                                  ┌─────────────────────────┘
                                  ▼
                    VAD timeline correction ─► cue splitting ─► .srt / .vtt / .txt
```

1. **Inspect** — `ffprobe` reads duration, resolution and audio tracks. Files with
   several audio tracks let you pick which one to transcribe.
2. **Extract** — 16 kHz mono PCM, with optional 60 Hz high-pass, loudness
   normalisation and noise reduction.
3. **Detect language** — on `auto`, three 30-second samples are taken from 12%, 45%
   and 78% of the runtime and voted on. Whisper's default (the first 30 seconds) is
   easily fooled by a musical intro or silence.
4. **Transcribe** — beam search, temperature fallback, Silero VAD, non-speech token
   suppression, custom vocabulary.
5. **Build cues** — word timings are re-cut into subtitles using the rules below.
6. **Write** — `video.en.srt` next to the source, or wherever you point it.

---

## Setup

Requires **Node.js 20+**. Everything else installs itself.

On first launch Cue opens the **Setup** screen, lists what is missing — the media
decoder, the transcription engine, the VAD model, a speech model — and installs all of
it with one button. Each item shows its download size and its own progress bar, and the
choice of engine and model is made from the hardware it detects (CUDA package when an
NVIDIA GPU is present, and a model that fits the available VRAM).

ffmpeg is included in that: if it is not on `PATH`, Cue downloads a build into
`tools-bin/` and uses its own copy. Nothing is added to `PATH` and a system install is
left untouched.

The same flow works from a terminal:

```bash
npm run doctor              # report what is missing
npm run doctor -- --install # install all of it
```

To install a specific component instead:

```bash
npm run setup -- list
npm run setup -- engine cuda12
npm run setup -- model large-v3-turbo-q5
npm run setup -- vad
```

### Engine packages

| id       | When to pick it                            | Download |
| -------- | ------------------------------------------ | -------- |
| `cuda12` | NVIDIA GPU with a current driver — fastest | ~640 MB  |
| `cuda11` | Older NVIDIA drivers                       | ~257 MB  |
| `cpu`    | No GPU; runs anywhere                      | ~20 MB   |

Linux x64/arm64 CPU builds are also available. macOS has no prebuilt CLI in the
whisper.cpp releases — install it with `brew install whisper-cpp` and point the app
at the binary.

### Models

| id                  | Disk    | VRAM    | Notes                                |
| ------------------- | ------- | ------- | ------------------------------------ |
| `large-v3`          | 2952 MB | ~3.9 GB | Highest accuracy                     |
| `large-v3-q5`       | 1031 MB | ~1.9 GB | Near-identical, a third of the size  |
| `large-v3-turbo`    | 1549 MB | ~1.8 GB | ~4× faster, accuracy very close      |
| `large-v3-turbo-q5` | 547 MB  | ~1.1 GB | **Best starting point**              |
| `medium` / `small`  | —       | —       | Previous generation / quick drafts   |
| `base`              | 141 MB  | —       | Testing only                         |

Models and engine binaries land in the **project folder** (`models/`, `engine/`),
not under `%APPDATA%` — multi-gigabyte files should not fill up a system drive.

---

## The settings that drive accuracy

### Quality profiles

| Profile          | beam | DTW | Use for                          |
| ---------------- | ---- | --- | -------------------------------- |
| Highest accuracy | 5    | on  | Deliverables, difficult audio    |
| Balanced         | 5    | off | Day-to-day *(default)*           |
| Fastest          | 1    | off | Quick draft of a long recording  |

### VAD — the one to keep on

Silero VAD hides silent stretches from the model entirely. It is the single most
effective defence against whisper inventing lines like "Subtitles by …" or "Thanks
for watching" over silence. It is 0.8 MB. Install it.

### Context carry-over

Whisper feeds the previous cue's text back in as context. That helps fluency and
raises the risk of a **repetition loop** — the same sentence emitted dozens of times.

- `Off` — lowest loop risk
- `Balanced (64 tokens)` — default
- `Full` — most fluent, loops possible

### DTW word timing

Aligns word timings acoustically instead of heuristically. **whisper.cpp only
computes DTW when flash attention is off**, so enabling it passes `-nfa` and costs
speed. Left on with flash attention, `t_dtw` silently comes back as `-1` — the app
enforces that dependency for you rather than letting it fail quietly.

### Custom vocabulary

Put proper nouns, brand names and jargon in Settings → *Custom vocabulary*. It is
passed as whisper's initial prompt and measurably improves how those terms are spelled.

---

## Subtitle formatting

Whisper's own segments are not subtitles: they run up to 30 seconds, ignore line
length, and break mid-clause. Cue rebuilds them from word timings:

- **42** characters per line, at most **2** lines (configurable)
- reading speed capped at **20** characters per second
- cue duration **1–7 s**, at least **84 ms** between cues (~2 frames)
- break preference: sentence-final punctuation → comma/semicolon → before a
  conjunction → longest pause
- two-line cues are balanced, single words are not left stranded
- a pause longer than 700 ms starts a new cue

Function-word lists for English, German, Spanish, French, Italian, Portuguese, Dutch
and Turkish inform where breaks read best.

### Automatic cleanup

- **Invented lines** — subtitle-site credits and channel boilerplate ("amara.org",
  "Subtitles by …", "Thanks for watching"), across several languages
- **Repetition loops** — both the same line repeated and the alternating A,B,A,B
  pattern a looped long sentence produces once it is split across two cues
- **Time pile-ups** — cues stacked on one instant, a reliable sign of broken output

Every removal is counted and shown in the result panel. Nothing disappears silently.

---

## Result panel

An editable cue list beside a video preview:

- click a timecode to jump the preview there; the active cue highlights during playback
- each cue shows its duration, reading speed and model confidence
- rule violations are tagged (*fast read*, *line too long*, *low confidence* …)
- edit text inline and **Save edits** writes back to the same file
- export as SRT / WebVTT / plain text, or copy to the clipboard

---

## Command line

The same pipeline the UI uses, without opening a window:

```bash
npm run cli -- "C:\videos\interview.mp4" --language en --preset accuracy
npm run cli -- talk.mkv --model large-v3 --format vtt --out C:\subs
npm run cli -- clip.mp4 --verbose
```

Flags: `--language` `--model` `--preset` `--format` `--out` `--no-vad` `--verbose`.
They apply to that run only and never modify `settings.json`.

Tests and diagnostics:

```bash
npm test                       # 27 unit tests
npm run doctor                 # what is installed, what is missing
npm run selftest -- video.mp4  # formatting audit + SRT dump
```

---

## Notes

- **The first GPU run is slow.** Initialising the CUDA context and loading the cuBLAS
  DLLs adds a one-off 30–60 seconds. Later runs are at full speed.
- **Measured throughput** (RTX 2060, 6 GB): `large-v3-turbo-q5` at ~27–30× realtime
  (a one-hour video in about two minutes), `large-v3` at ~2.5–3×.
- **6 GB of VRAM** fits `large-v3`. If it does not fit, use `large-v3-q5` or a turbo build.
- **No speaker diarization** — the output does not say who is talking.
- **Nothing installs outside the project folder.** Engine binaries, models and ffmpeg
  all live under `engine/`, `models/` and `tools-bin/`, so uninstalling is deleting a
  directory, and a nearly-full system drive is not a problem.
- If a legacy player garbles accented characters, enable Settings → *Write UTF-8 BOM*.

## Layout

```
electron/
  main.js            window, IPC, job management
  preload.js         contextBridge surface
  lib/
    config.js        paths + persisted settings
    download.js      resumable downloads + archive extraction
    media.js         ffprobe / ffmpeg
    engine.js        whisper.cpp install, run, JSON + VAD time correction
    requirements.js  what is missing + one-click install orchestration
    segmenter.js     words -> subtitle cues
    subtitles.js     SRT / VTT / TXT
    pipeline.js      the staged job that ties it together
renderer/            UI — plain HTML/CSS/JS, no bundler
tools/               doctor.js · install.js · run.js · selftest.js
test/core.test.js    unit tests
```

## Credits

Built on [whisper.cpp](https://github.com/ggml-org/whisper.cpp) by Georgi Gerganov and
contributors, OpenAI's Whisper models, [Silero VAD](https://github.com/snakers4/silero-vad),
and [ffmpeg](https://ffmpeg.org/). Interface conventions follow
[shadcn/ui](https://ui.shadcn.com/).

MIT licensed.
