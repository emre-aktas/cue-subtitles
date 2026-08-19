'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeVadMapper, parseWhisperJson } = require('../electron/lib/engine');
const {
  buildCues,
  wrapLines,
  visibleLength,
  dropRepetitionLoops,
  collapseTimePileups,
} = require('../electron/lib/segmenter');
const { toSrt, toVtt, formatTimestamp } = require('../electron/lib/subtitles');
const { DEFAULT_SETTINGS } = require('../electron/lib/config');

/* ================================================================
   VAD timeline remapping

   whisper.cpp maps *segment* boundaries back to the original timeline
   but leaves *token* timestamps in the shortened one. These tests pin
   the correction, because getting it wrong shifts every cue.
   ================================================================ */

// Two speech bursts with ~8 s of silence removed between them, in the shape
// whisper.cpp reports through its `vad_segment_info` log lines.
const CHUNKS = [
  { vadStart: 0.0, vadEnd: 8.27, origStart: 0.29, origEnd: 8.56 },
  { vadStart: 8.47, vadEnd: 10.29, origStart: 16.35, origEnd: 18.17 },
];

test('vad mapper: shifts times inside a chunk by that chunk offset', () => {
  const map = makeVadMapper(CHUNKS);
  assert.strictEqual(map(0), 290);
  assert.strictEqual(map(1000), 1290);
  assert.strictEqual(map(9000, 'start'), 16880); // 0.53 s into the second burst
});

test('vad mapper: a start inside removed silence moves to the next burst', () => {
  const map = makeVadMapper(CHUNKS);
  assert.strictEqual(map(8400, 'start'), 16350);
});

test('vad mapper: an end inside removed silence stays with the previous burst', () => {
  const map = makeVadMapper(CHUNKS);
  assert.strictEqual(map(8400, 'end'), 8560);
});

test('vad mapper: the segment window overrides a snap that leaves the segment', () => {
  const map = makeVadMapper(CHUNKS);
  // Sentence-final punctuation often lands in the silence after the phrase.
  // Snapping it forward would throw it 8 s into the future, so the segment
  // bounds have to pull it back.
  assert.strictEqual(map(8400, 'start', { lo: 290, hi: 12330 }), 8560);
  // Without the guard it really does jump forward — that is the regression.
  assert.strictEqual(map(8400, 'start'), 16350);
});

test('vad mapper: returns null when there is no chunk map', () => {
  assert.strictEqual(makeVadMapper([]), null);
  assert.strictEqual(makeVadMapper(null), null);
});

/* ================================================================
   Whisper JSON parsing
   ================================================================ */

function tok(text, from, to, p = 0.9, tDtw = -1) {
  return { text, offsets: { from, to }, p, t_dtw: tDtw, id: 1 };
}

test('parser: drops control tokens, including numbered timestamp tokens', (t) => {
  const file = path.join(os.tmpdir(), `cue-test-${process.pid}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      result: { language: 'en' },
      transcription: [
        {
          offsets: { from: 0, to: 2000 },
          text: ' Hello there.',
          tokens: [
            tok('[_BEG_]', 0, 0),
            tok(' Hello', 100, 600),
            tok(' there', 600, 1200),
            tok('.', 1200, 1200),
            tok('[_TT_290]', 1300, 1300),
            tok('[_EOT_]', 1300, 1300),
          ],
        },
      ],
    })
  );
  t.after(() => fs.rmSync(file, { force: true }));

  const parsed = parseWhisperJson(file);
  assert.strictEqual(parsed.language, 'en');
  assert.deepStrictEqual(
    parsed.words.map((w) => w.text),
    ['Hello', 'there.']
  );
  // No control-token debris glued onto a word.
  assert.ok(!parsed.words.some((w) => /\[_/.test(w.text)));
});

/* ================================================================
   Cue segmentation
   ================================================================ */

/** Build a synthetic word stream at a steady speaking rate. */
function words(text, { startMs = 0, msPerWord = 350, p = 0.9 } = {}) {
  return text.split(' ').map((w, i) => ({
    text: w,
    start: startMs + i * msPerWord,
    end: startMs + i * msPerWord + msPerWord - 40,
    p,
  }));
}

const S = { ...DEFAULT_SETTINGS };

test('segmenter: keeps a short sentence as a single cue', () => {
  const { cues } = buildCues(words('The weather is lovely today.'), S, 60_000);
  assert.strictEqual(cues.length, 1);
  assert.strictEqual(cues[0].text, 'The weather is lovely today.');
});

test('segmenter: never exceeds the configured line length or line count', () => {
  const long =
    'This sentence is deliberately long because we need to check that the ' +
    'subtitle engine respects both the line length rule and the maximum line ' +
    'count rule, and that takes quite a lot of words to demonstrate properly.';
  const { cues } = buildCues(words(long), S, 300_000);

  assert.ok(cues.length > 1, 'long text must be split');
  for (const cue of cues) {
    assert.ok(cue.lines.length <= S.maxLines, `line count: ${cue.lines.length}`);
    for (const line of cue.lines) {
      assert.ok(line.length <= S.maxCharsPerLine, `line length ${line.length}: "${line}"`);
    }
  }
});

test('segmenter: honours minimum duration and never overlaps cues', () => {
  const { cues } = buildCues(words('Yes. No. Maybe. Fine. Sure.', { msPerWord: 400 }), S, 60_000);
  for (let i = 0; i < cues.length; i++) {
    assert.ok(cues[i].end > cues[i].start, 'end must follow start');
    const next = cues[i + 1];
    if (next) {
      assert.ok(cues[i].end <= next.start, `overlap: ${cues[i].end} > ${next.start}`);
    }
  }
});

test('segmenter: respects the reading-speed ceiling where timing allows', () => {
  // Dense text spoken fast, with empty timeline afterwards to expand into.
  const { cues } = buildCues(words('One two three four five six seven eight.', { msPerWord: 120 }), S, 60_000);
  for (const cue of cues) {
    const cps = visibleLength(cue.text) / ((cue.end - cue.start) / 1000);
    assert.ok(cps <= S.maxCharsPerSec + 0.5, `reading speed ${cps.toFixed(1)} cps`);
  }
});

test('segmenter: caps cue duration at the configured maximum', () => {
  // A single short word whose end timestamp was stretched far past the speech.
  const stretched = [{ text: 'Right.', start: 1000, end: 20_000, p: 0.9 }];
  const { cues } = buildCues(stretched, S, 40_000);
  assert.strictEqual(cues.length, 1);
  assert.ok(
    cues[0].end - cues[0].start <= S.maxCueDurationMs,
    `duration ${cues[0].end - cues[0].start} ms exceeds the cap`
  );
});

test('segmenter: splits on a long pause even without punctuation', () => {
  const first = words('first group of words', { startMs: 0 });
  const second = words('second group of words', { startMs: 5000 });
  const { cues } = buildCues([...first, ...second], S, 30_000);
  assert.strictEqual(cues.length, 2);
  assert.ok(cues[1].start >= 5000);
});

test('segmenter: removes subtitle-credit hallucinations', () => {
  const { cues, stats } = buildCues(
    [
      ...words('This is a real sentence.'),
      // Slow enough to stay one cue, so the drop count is unambiguous.
      ...words('Subtitles by amara.org community', { startMs: 8000, msPerWord: 700 }),
    ],
    S,
    30_000
  );
  assert.strictEqual(stats.droppedHallucinations, 1);
  assert.ok(!cues.some((c) => /amara/i.test(c.text)));
  assert.ok(cues.some((c) => /real sentence/.test(c.text)), 'real speech must survive');
});

test('segmenter: collapses a decoder repetition loop', () => {
  let all = [];
  for (let i = 0; i < 6; i++) {
    all = all.concat(words('the same line over again.', { startMs: i * 3000 }));
  }
  const { cues, stats } = buildCues(all, S, 40_000);
  assert.ok(stats.droppedLoops >= 3, `dropped: ${stats.droppedLoops}`);
  assert.ok(cues.length <= 3);
});

test('segmenter: handles an empty word list without throwing', () => {
  const { cues } = buildCues([], S, 1000);
  assert.deepStrictEqual(cues, []);
});

/* ================================================================
   Loop / pile-up filters
   ================================================================ */

test('loop filter: collapses cues piled onto one instant', () => {
  // What a decoder loop looks like after line splitting: the same sentence
  // emitted six times, every copy stamped 104.25 -> 104.45.
  const piled = ['first half', 'second half', 'first half', 'second half', 'first half', 'second half'].map(
    (text) => ({ start: 104_250, end: 104_450, text })
  );
  const { kept, dropped } = collapseTimePileups(piled);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(dropped.length, 5);
});

test('loop filter: leaves normal sequential cues alone', () => {
  const normal = [
    { start: 0, end: 2000, text: 'one' },
    { start: 2100, end: 4000, text: 'two' },
    { start: 4100, end: 6000, text: 'three' },
  ];
  const { kept, dropped } = collapseTimePileups(normal);
  assert.strictEqual(kept.length, 3);
  assert.strictEqual(dropped.length, 0);
});

test('loop filter: catches an alternating A/B repetition pattern', () => {
  const cues = [];
  for (let i = 0; i < 4; i++) {
    cues.push({ start: i * 1200, end: i * 1200 + 900, text: 'the first half here' });
    cues.push({ start: i * 1200 + 600, end: i * 1200 + 1100, text: 'the second half here' });
  }
  const { dropped } = dropRepetitionLoops(cues);
  assert.ok(dropped.length >= 4, `dropped: ${dropped.length}`);
});

test('loop filter: keeps repetition that is spread out over time', () => {
  // A refrain returning every 30 s is real content, not a decoder loop.
  const cues = [0, 30_000, 60_000, 90_000].map((start) => ({
    start,
    end: start + 2000,
    text: 'the same refrain again',
  }));
  const { kept, dropped } = dropRepetitionLoops(cues);
  assert.strictEqual(dropped.length, 0);
  assert.strictEqual(kept.length, 4);
});

/* ================================================================
   Line wrapping
   ================================================================ */

test('wrapLines: balances two lines instead of filling the first', () => {
  const text = 'This sentence should break across two lines and the lines should look even';
  const lines = wrapLines(text, { maxCharsPerLine: 42, maxLines: 2 });
  assert.strictEqual(lines.length, 2);
  assert.ok(Math.abs(lines[0].length - lines[1].length) < 22, `unbalanced: ${JSON.stringify(lines)}`);
  assert.strictEqual(lines.join(' '), text);
});

test('wrapLines: leaves a short line untouched', () => {
  assert.deepStrictEqual(wrapLines('Short line', { maxCharsPerLine: 42, maxLines: 2 }), ['Short line']);
});

test('wrapLines: falls back to greedy wrapping rather than overflowing', () => {
  // A balanced break is impossible here without exceeding the width.
  const text = 'antidisestablishmentarianism plus a few more trailing words to force a wrap';
  const lines = wrapLines(text, { maxCharsPerLine: 30, maxLines: 2 });
  const overflow = lines.filter((l) => l.length > 30 && l.includes(' '));
  assert.strictEqual(overflow.length, 0, `overflowing lines: ${JSON.stringify(lines)}`);
});

/* ================================================================
   Requirements
   ================================================================ */

const requirements = require('../electron/lib/requirements');

test('recommendModel: scales the default model to available VRAM', () => {
  assert.strictEqual(requirements.recommendModel({ vramMB: 24000 }), 'large-v3-turbo-q5');
  assert.strictEqual(requirements.recommendModel({ vramMB: 6144 }), 'large-v3-turbo-q5');
  assert.strictEqual(requirements.recommendModel({ vramMB: 3000 }), 'small');
  assert.strictEqual(requirements.recommendModel({ vramMB: 1024 }), 'base');
  // No GPU at all: the smallest capable package, since CPU decoding is the bottleneck.
  assert.strictEqual(requirements.recommendModel(null), 'large-v3-turbo-q5');
});

test('requirements.check: reports the four components in dependency order', async () => {
  const state = await requirements.check();
  assert.deepStrictEqual(
    state.items.map((i) => i.id),
    ['ffmpeg', 'engine', 'vad', 'model']
  );
  for (const item of state.items) {
    assert.strictEqual(typeof item.label, 'string');
    assert.strictEqual(typeof item.detail, 'string');
    assert.strictEqual(typeof item.ok, 'boolean');
    assert.strictEqual(typeof item.installable, 'boolean');
    assert.strictEqual(typeof item.sizeMB, 'number');
  }
  assert.strictEqual(state.ready, state.missingCount === 0);
  assert.strictEqual(
    state.missingCount,
    state.items.filter((i) => !i.ok).length
  );
});

/* ================================================================
   Serialisation
   ================================================================ */

test('formatTimestamp: SRT uses a comma, WebVTT a period', () => {
  assert.strictEqual(formatTimestamp(3_661_500, ','), '01:01:01,500');
  assert.strictEqual(formatTimestamp(3_661_500, '.'), '01:01:01.500');
  assert.strictEqual(formatTimestamp(0, ','), '00:00:00,000');
});

test('toSrt: renumbers sequentially and preserves line breaks', () => {
  const cues = [
    { start: 0, end: 1500, lines: ['First line', 'second line'], text: 'First line\nsecond line' },
    { start: 2000, end: 3000, lines: ['Single line'], text: 'Single line' },
  ];
  const srt = toSrt(cues);
  assert.match(srt, /^1\r?\n00:00:00,000 --> 00:00:01,500\r?\nFirst line\r?\nsecond line/);
  assert.match(srt, /\n2\r?\n00:00:02,000 --> 00:00:03,000\r?\nSingle line/);
});

test('toVtt: emits the WEBVTT header', () => {
  const vtt = toVtt([{ start: 0, end: 1000, lines: ['Hello'], text: 'Hello' }]);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.match(vtt, /00:00:00\.000 --> 00:00:01\.000/);
});
