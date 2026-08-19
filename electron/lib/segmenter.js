'use strict';

/**
 * Turns whisper's word stream into broadcast-style subtitle cues.
 *
 * Whisper's own segments are decoder windows, not subtitles: they run up to 30 s,
 * ignore line length, and break mid-clause. This module re-cuts them using the
 * conventions professional subtitlers use — reading speed, line count, line length,
 * minimum duration, and breaking at syntactic boundaries rather than arbitrary ones.
 */

// Sentence-final vs. clause-internal punctuation, plus the ellipsis character.
// Latin-script languages share these marks, so one pattern covers them all.
const STRONG_PUNCT = /[.!?…]["')\]»]?$/;
const WEAK_PUNCT = /[,;:]["')\]»]?$/;

/**
 * Function words and conjunctions, per language.
 *
 * A line break reads better *before* one of these than after it, so the splitter
 * scores candidates against this set. It is transcript data, not interface text —
 * the words here are matched against what the speaker said, in whatever language
 * the audio happens to be.
 */
const FUNCTION_WORDS = [
  // English
  'and', 'or', 'but', 'so', 'because', 'that', 'which', 'who', 'when', 'while',
  'if', 'as', 'than', 'though', 'although', 'after', 'before', 'since', 'unless',
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from',
  // German
  'und', 'oder', 'aber', 'weil', 'dass', 'wenn', 'als', 'der', 'die', 'das',
  'ein', 'eine', 'mit', 'für', 'von', 'zu', 'im', 'auf',
  // Spanish
  'y', 'o', 'pero', 'porque', 'que', 'cuando', 'si', 'el', 'la', 'los', 'las',
  'un', 'una', 'de', 'con', 'para', 'por', 'en',
  // French
  'et', 'ou', 'mais', 'parce', 'que', 'quand', 'si', 'le', 'les', 'un', 'une',
  'des', 'du', 'dans', 'pour', 'avec', 'sur',
  // Italian
  'e', 'ma', 'perché', 'che', 'quando', 'se', 'il', 'lo', 'gli', 'uno', 'del',
  'nel', 'con', 'per', 'da',
  // Portuguese
  'mas', 'porque', 'quando', 'se', 'os', 'as', 'uma', 'com', 'para', 'em', 'do',
  // Dutch
  'en', 'maar', 'omdat', 'dat', 'als', 'het', 'een', 'van', 'voor', 'met', 'op',
  // Turkish
  've', 'veya', 'ya', 'ama', 'fakat', 'lakin', 'ancak', 'çünkü', 'ki', 'da',
  'ile', 'için', 'gibi', 'kadar', 'diye', 'eğer', 'ise', 'yani', 'hem', 'ne',
  'sonra', 'önce', 'rağmen', 'dolayı', 'üzere', 'ayrıca', 'oysa', 'halbuki',
];

const CONJUNCTIONS = new Set(FUNCTION_WORDS);

/**
 * Phrases whisper invents during silence — subtitle-site credits and channel
 * boilerplate absorbed from its training data. Never real dialogue, in any language.
 */
const HALLUCINATION_PATTERNS = [
  /amara\.?org/i,
  /subtitles?\s+by/i,
  /subtitled\s+by/i,
  /translated\s+by/i,
  /transcription\s+outsourcing/i,
  /thanks?\s+for\s+watching/i,
  /like\s+and\s+subscribe/i,
  /www\.[a-z0-9-]+\.(com|org|net|tv)/i,
  /untertitel\s+(von|im auftrag)/i,
  /sous-titr(es|age)\s+(par|:)/i,
  /subtítulos\s+(por|realizados)/i,
  /sottotitoli\s+(e\s+revisione\s+)?a\s+cura/i,
  /legendas?\s+(por|:)/i,
  /altyaz[ıi]\s*[:•]/i,
  /altyaz[ıi]\s+(çeviri|tercüme)/i,
  /abone\s+ol(un)?\b.*\bkanal/i,
];

function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function visibleLength(text) {
  // Reading speed is measured on displayed characters; line breaks don't count.
  return text.replace(/\n/g, '').length;
}

function isConjunction(word) {
  return CONJUNCTIONS.has(word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ''));
}

function joinWords(words) {
  return words
    .map((w) => w.text)
    .join(' ')
    // Whisper occasionally leaves a space before punctuation.
    .replace(/\s+([,.!?;:…])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Step 1 — group words into sentence-like units
 * ------------------------------------------------------------------ */

function groupIntoUnits(words, opts) {
  const units = [];
  let cur = [];

  for (let i = 0; i < words.length; i++) {
    cur.push(words[i]);
    const next = words[i + 1];
    const endsSentence = STRONG_PUNCT.test(words[i].text);
    const pause = next ? next.start - words[i].end : Infinity;

    if (endsSentence || pause >= opts.sentencePauseMs || !next) {
      units.push(cur);
      cur = [];
    }
  }
  if (cur.length) units.push(cur);
  return units;
}

/* ------------------------------------------------------------------ *
 * Step 2 — split oversized units at the best syntactic boundary
 * ------------------------------------------------------------------ */

/**
 * Greedy first-fit wrap, which yields the minimum number of lines a text needs at a
 * given width. A word longer than the width gets its own (overflowing) line — there
 * is nothing else to do with it.
 */
function greedyWrap(text, maxLen) {
  const lines = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (candidate.length <= maxLen || !cur) cur = candidate;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function unitFits(words, opts) {
  const text = joinWords(words);
  const chars = visibleLength(text);
  const durMs = words[words.length - 1].end - words[0].start;

  // Character budget alone is not enough: 84 characters do not always break into two
  // 42-character lines, because the break has to land on a word boundary. Ask the
  // wrapper how many lines the text actually needs.
  if (greedyWrap(text, opts.maxCharsPerLine).length > opts.maxLines) return false;
  if (chars > opts.maxLines * opts.maxCharsPerLine) return false;
  if (durMs > opts.maxCueDurationMs) return false;
  // A cue that is too dense to read has to be split even if it "fits" on screen.
  if (durMs > 0 && chars / (durMs / 1000) > opts.maxCharsPerSec * 1.15) return false;
  return true;
}

/** Score a split after index i (0-based, split between i and i+1). Higher = better. */
function scoreSplit(words, i, opts) {
  const w = words[i];
  const next = words[i + 1];
  if (!next) return -Infinity;

  let score = 0;

  if (STRONG_PUNCT.test(w.text)) score += 120;
  else if (WEAK_PUNCT.test(w.text)) score += 65;

  const pause = Math.max(0, next.start - w.end);
  score += Math.min(pause, 1200) / 1200 * 55;

  if (isConjunction(next.text)) score += 28;
  // Never orphan a conjunction at the end of a cue.
  if (isConjunction(w.text) && !STRONG_PUNCT.test(w.text) && !WEAK_PUNCT.test(w.text)) score -= 45;

  const before = visibleLength(joinWords(words.slice(0, i + 1)));
  const after = visibleLength(joinWords(words.slice(i + 1)));
  const total = before + after || 1;
  score -= (Math.abs(before - after) / total) * 45;

  // Avoid one- or two-word fragments.
  if (i + 1 < 2) score -= 60;
  if (words.length - (i + 1) < 2) score -= 60;

  // Keep each side inside what a cue can physically show.
  const capacity = opts.maxLines * opts.maxCharsPerLine;
  if (before > capacity) score -= 200;
  if (after > capacity) score -= 200;

  return score;
}

function splitUnit(words, opts, depth = 0) {
  if (words.length <= 1 || depth > 24) return [words];
  if (unitFits(words, opts)) return [words];

  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < words.length - 1; i++) {
    const s = scoreSplit(words, i, opts);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return [words];

  const left = words.slice(0, bestIdx + 1);
  const right = words.slice(bestIdx + 1);
  if (!left.length || !right.length) return [words];

  return [...splitUnit(left, opts, depth + 1), ...splitUnit(right, opts, depth + 1)];
}

/* ------------------------------------------------------------------ *
 * Step 3 — wrap cue text into balanced lines
 * ------------------------------------------------------------------ */

function wrapLines(text, opts) {
  const maxLen = opts.maxCharsPerLine;
  const maxLines = opts.maxLines;
  if (text.length <= maxLen) return [text];

  const tokens = text.split(' ');
  if (tokens.length === 1) return [text];

  // Choose the break that balances the two halves while honouring line length,
  // nudged toward punctuation and away from splitting after a conjunction.
  const pick = (words, limit) => {
    let bestI = -1;
    let bestCost = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      if (a.length > limit) break;
      let cost = Math.abs(a.length - b.length);
      if (b.length > limit) cost += 1000 + (b.length - limit) * 10;
      if (WEAK_PUNCT.test(a) || STRONG_PUNCT.test(a)) cost -= 12;
      if (isConjunction(words[i])) cost -= 8;
      if (isConjunction(words[i - 1])) cost += 14;
      if (cost < bestCost) {
        bestCost = cost;
        bestI = i;
      }
    }
    return bestI;
  };

  const lines = [];
  let remaining = tokens;
  while (remaining.length && lines.length < maxLines - 1) {
    const i = pick(remaining, maxLen);
    if (i <= 0) break;
    lines.push(remaining.slice(0, i).join(' '));
    remaining = remaining.slice(i);
    if (remaining.join(' ').length <= maxLen) break;
  }
  if (remaining.length) lines.push(remaining.join(' '));

  // The balanced pass optimises for even line lengths and can leave the tail line
  // over the limit. Line length is a hard constraint, evenness is a preference, so
  // fall back to the greedy wrap whenever the pretty answer breaks the rule.
  const valid = lines.length && lines.length <= maxLines && lines.every((l) => l.length <= maxLen);
  if (valid) return lines;

  const greedy = greedyWrap(text, maxLen);
  return greedy.length ? greedy : [text];
}

/* ------------------------------------------------------------------ *
 * Step 4 — timing pass
 * ------------------------------------------------------------------ */

function applyTiming(cues, opts, mediaDurationMs) {
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const prev = cues[i - 1];
    const next = cues[i + 1];

    const upperBound = next ? next.start - opts.minGapMs : mediaDurationMs || cue.end + opts.maxCueDurationMs;
    const lowerBound = prev ? prev.end + opts.minGapMs : 0;

    if (cue.end <= cue.start) cue.end = cue.start + 200;

    const chars = visibleLength(cue.text);

    // Hold short cues on screen long enough to be readable...
    let wanted = Math.max(cue.end, cue.start + opts.minCueDurationMs);
    // ...and give dense cues the time their character count demands.
    if (opts.maxCharsPerSec > 0) {
      wanted = Math.max(wanted, cue.start + (chars / opts.maxCharsPerSec) * 1000);
    }
    wanted = Math.min(wanted, cue.start + opts.maxCueDurationMs);
    cue.end = Math.min(Math.max(cue.end, wanted), Math.max(upperBound, cue.start + 200));

    // The ceiling is authoritative in both directions: a word whose end timestamp was
    // stretched must not leave a handful of characters parked on screen for 10 s.
    cue.end = Math.min(cue.end, cue.start + opts.maxCueDurationMs);

    // If there is slack before the cue, borrow it rather than overrun the next one.
    if (cue.end - cue.start < opts.minCueDurationMs && cue.start > lowerBound) {
      const deficit = opts.minCueDurationMs - (cue.end - cue.start);
      cue.start = Math.max(lowerBound, cue.start - deficit);
    }

    if (mediaDurationMs && cue.end > mediaDurationMs) cue.end = mediaDurationMs;
    if (cue.end <= cue.start) cue.end = cue.start + 200;
  }

  // Final overlap sweep.
  for (let i = 0; i < cues.length - 1; i++) {
    const a = cues[i];
    const b = cues[i + 1];
    if (a.end > b.start - opts.minGapMs) {
      a.end = Math.max(a.start + 200, b.start - opts.minGapMs);
    }
  }

  return cues;
}

/* ------------------------------------------------------------------ *
 * Step 5 — cleanup + diagnostics
 * ------------------------------------------------------------------ */

function looksHallucinated(text) {
  return HALLUCINATION_PATTERNS.some((re) => re.test(text));
}

/**
 * Collapse cues that pile up on the same instant.
 *
 * When whisper's decoder locks into a loop it emits the phrase again and again, all
 * carrying (nearly) the same timestamp. Healthy output cannot look like this: cues are
 * built sequentially with a mandatory gap, so two cues can only share *both* their
 * start and their end when the underlying word times are degenerate. The first cue of
 * such a pile-up is the plausible transcription of that moment; the rest are noise.
 */
function collapseTimePileups(cues, tolMs = 150) {
  const kept = [];
  const dropped = [];
  let i = 0;

  while (i < cues.length) {
    let j = i + 1;
    while (
      j < cues.length &&
      Math.abs(cues[j].start - cues[i].start) <= tolMs &&
      Math.abs(cues[j].end - cues[i].end) <= tolMs
    ) {
      j += 1;
    }
    kept.push(cues[i]);
    for (let k = i + 1; k < j; k++) dropped.push({ ...cues[k], reason: 'time pile-up' });
    i = j;
  }

  return { kept, dropped };
}

/**
 * Drop repeated text. Handles both the simple case (the same cue over and over) and
 * the alternating case a looped long sentence produces once it is split across two
 * cues — A, B, A, B, A, B — which a consecutive-only check never sees.
 *
 * The density guard keeps real repetition safe: a chorus or a rhetorical repeat is
 * spread over time, whereas a decoder loop crams its copies into a few seconds.
 */
function dropRepetitionLoops(cues, { window = 6, minOccurrences = 3, densityMs = 12_000 } = {}) {
  const kept = [];
  const dropped = [];
  /** @type {Array<{key:string,start:number}>} */
  const recent = [];

  for (const cue of cues) {
    const key = normalize(cue.text);
    if (!key) {
      kept.push(cue);
      continue;
    }

    const hits = recent.filter((r) => r.key === key);
    const packed =
      hits.length + 1 >= minOccurrences && cue.start - hits[0].start <= densityMs;

    if (packed) {
      dropped.push({ ...cue, reason: 'repetition loop' });
      continue;
    }

    kept.push(cue);
    recent.push({ key, start: cue.start });
    if (recent.length > window) recent.shift();
  }

  return { kept, dropped };
}

function annotate(cue, opts) {
  const warnings = [];
  const chars = visibleLength(cue.text);
  const durSec = (cue.end - cue.start) / 1000;
  const cps = durSec > 0 ? chars / durSec : 0;

  if (cps > opts.maxCharsPerSec + 0.5) warnings.push(`fast read (${cps.toFixed(1)} cps)`);
  if (cue.lines.some((l) => l.length > opts.maxCharsPerLine)) warnings.push('line too long');
  if (cue.lines.length > opts.maxLines) warnings.push('too many lines');
  if (durSec < opts.minCueDurationMs / 1000 - 0.01) warnings.push('too short');
  if (durSec > opts.maxCueDurationMs / 1000 + 0.01) warnings.push('too long');
  if (cue.confidence < opts.lowConfidenceThreshold) warnings.push('low confidence');

  cue.cps = Math.round(cps * 10) / 10;
  cue.warnings = warnings;
  return cue;
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * @param {Array<{text:string,start:number,end:number,p:number}>} words  ms timestamps
 * @param {object} settings
 * @param {number} mediaDurationMs
 */
function buildCues(words, settings, mediaDurationMs = 0) {
  const opts = {
    maxCharsPerLine: settings.maxCharsPerLine,
    maxLines: settings.maxLines,
    maxCharsPerSec: settings.maxCharsPerSec,
    minCueDurationMs: settings.minCueDurationMs,
    maxCueDurationMs: settings.maxCueDurationMs,
    minGapMs: settings.minGapMs,
    sentencePauseMs: settings.sentencePauseMs,
    lowConfidenceThreshold: settings.lowConfidenceThreshold,
  };

  const stats = { droppedHallucinations: 0, droppedLoops: 0, droppedLowConfidence: 0 };

  const usable = words.filter((w) => w.text && w.text.trim());
  if (!usable.length) return { cues: [], stats };

  const units = groupIntoUnits(usable, opts);

  let cues = [];
  for (const unit of units) {
    for (const part of splitUnit(unit, opts)) {
      if (!part.length) continue;
      const text = joinWords(part);
      if (!text) continue;

      if (looksHallucinated(text)) {
        stats.droppedHallucinations += 1;
        continue;
      }

      const confidence = part.reduce((s, w) => s + (w.p ?? 1), 0) / part.length;

      if (settings.dropLowConfidence && confidence < settings.lowConfidenceThreshold) {
        stats.droppedLowConfidence += 1;
        continue;
      }

      cues.push({
        start: part[0].start,
        end: part[part.length - 1].end,
        text,
        confidence: Math.round(confidence * 1000) / 1000,
        wordCount: part.length,
      });
    }
  }

  cues.sort((a, b) => a.start - b.start);

  // Run the loop filters before timing: the degenerate timestamps that expose a
  // decoder loop are still intact at this point.
  const loops = dropRepetitionLoops(cues);
  cues = loops.kept;
  const pileups = collapseTimePileups(cues);
  cues = pileups.kept;
  stats.droppedLoops = loops.dropped.length + pileups.dropped.length;

  if (settings.mergeShortCues) cues = mergeTinyCues(cues, opts);

  applyTiming(cues, opts, mediaDurationMs);

  cues = cues.map((cue, i) => {
    cue.index = i + 1;
    cue.lines = wrapLines(cue.text, opts);
    cue.text = cue.lines.join('\n');
    return annotate(cue, opts);
  });

  return { cues, stats };
}

/**
 * Fold a stray one- or two-word cue into its neighbour when the combined cue still
 * fits — avoids the "flicker" of a 1-second cue holding a single word.
 */
function mergeTinyCues(cues, opts) {
  const out = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    const isTiny = cue.wordCount <= 2 && visibleLength(cue.text) <= 14;
    if (prev && isTiny) {
      const gap = cue.start - prev.end;
      const mergedText = `${prev.text} ${cue.text}`.replace(/\s+([,.!?;:…])/g, '$1');
      const mergedDur = cue.end - prev.start;
      const fits =
        greedyWrap(mergedText, opts.maxCharsPerLine).length <= opts.maxLines &&
        mergedDur <= opts.maxCueDurationMs &&
        gap < opts.sentencePauseMs &&
        !STRONG_PUNCT.test(prev.text);
      if (fits) {
        prev.end = cue.end;
        prev.text = mergedText;
        prev.wordCount += cue.wordCount;
        prev.confidence = Math.min(prev.confidence, cue.confidence);
        continue;
      }
    }
    out.push(cue);
  }
  return out;
}

module.exports = {
  buildCues,
  wrapLines,
  greedyWrap,
  joinWords,
  visibleLength,
  looksHallucinated,
  dropRepetitionLoops,
  collapseTimePileups,
};
