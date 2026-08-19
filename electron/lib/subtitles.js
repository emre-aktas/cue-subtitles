'use strict';

const fs = require('node:fs');
const path = require('node:path');

function pad(n, width = 2) {
  return String(Math.floor(n)).padStart(width, '0');
}

/** ms -> "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" (VTT). */
function formatTimestamp(ms, sep = ',') {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const msec = total % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(msec, 3)}`;
}

function toSrt(cues) {
  return (
    cues
      .map((cue, i) => {
        const start = formatTimestamp(cue.start, ',');
        const end = formatTimestamp(cue.end, ',');
        const body = (cue.lines?.length ? cue.lines.join('\n') : cue.text).trim();
        return `${i + 1}\n${start} --> ${end}\n${body}\n`;
      })
      .join('\n') + '\n'
  );
}

function toVtt(cues) {
  const body = cues
    .map((cue, i) => {
      const start = formatTimestamp(cue.start, '.');
      const end = formatTimestamp(cue.end, '.');
      const text = (cue.lines?.length ? cue.lines.join('\n') : cue.text).trim();
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}\n`;
}

/** Plain transcript: paragraphs broken on sentence ends, no timings. */
function toTxt(cues) {
  const paragraphs = [];
  let buf = [];
  for (const cue of cues) {
    const flat = (cue.lines?.length ? cue.lines.join(' ') : cue.text).replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    buf.push(flat);
    if (/[.!?…]["')\]»]?$/.test(flat) && buf.join(' ').length > 180) {
      paragraphs.push(buf.join(' '));
      buf = [];
    }
  }
  if (buf.length) paragraphs.push(buf.join(' '));
  return paragraphs.join('\n\n') + '\n';
}

function serialize(cues, format) {
  switch (format) {
    case 'vtt':
      return toVtt(cues);
    case 'txt':
      return toTxt(cues);
    case 'srt':
    default:
      return toSrt(cues);
  }
}

/**
 * Pick a non-colliding output path. Netflix/Plex-style language suffix keeps the
 * file discoverable by players that auto-load sidecar subtitles.
 */
function buildOutputPath({ videoPath, outputDir, format, language, overwrite = false }) {
  const dir = outputDir && outputDir.trim() ? outputDir : path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const lang = language && language !== 'auto' ? `.${language}` : '';
  let candidate = path.join(dir, `${base}${lang}.${format}`);
  if (overwrite) return candidate;

  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}${lang} (${n}).${format}`);
    n += 1;
  }
  return candidate;
}

function writeSubtitleFile({ cues, filePath, format, utf8Bom = false }) {
  const text = serialize(cues, format);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Some legacy Windows players mis-detect UTF-8 Turkish characters without a BOM,
  // so it stays available as an opt-in.
  fs.writeFileSync(filePath, utf8Bom ? `﻿${text}` : text, 'utf8');
  return filePath;
}

module.exports = { formatTimestamp, toSrt, toVtt, toTxt, serialize, buildOutputPath, writeSubtitleFile };
