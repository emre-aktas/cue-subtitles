'use strict';

/* ============================================================
   State
   ============================================================ */

const state = {
  settings: null,
  defaults: null,
  info: null,
  requirements: null,
  models: [],
  vad: { installed: false },
  engines: [],
  recommendedVariant: null,
  file: null, // { path, info }
  job: null, // { id, startedAt }
  result: null,
  cues: [],
  activeCueIndex: -1,
  filter: { query: '', onlyWarnings: false },
  installing: false,
};

const LANGUAGES = [
  ['auto', 'Detect automatically'],
  ['en', 'English'],
  ['tr', 'Turkish'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['pl', 'Polish'],
  ['ru', 'Russian'],
  ['uk', 'Ukrainian'],
  ['ar', 'Arabic'],
  ['fa', 'Persian'],
  ['he', 'Hebrew'],
  ['el', 'Greek'],
  ['hi', 'Hindi'],
  ['id', 'Indonesian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
  ['az', 'Azerbaijani'],
  ['sv', 'Swedish'],
  ['da', 'Danish'],
  ['no', 'Norwegian'],
  ['fi', 'Finnish'],
  ['cs', 'Czech'],
  ['ro', 'Romanian'],
  ['hu', 'Hungarian'],
  ['vi', 'Vietnamese'],
];

const PRESETS = {
  accuracy: {
    beamSize: 5,
    bestOf: 5,
    contextMode: 'balanced',
    vad: true,
    dtw: true,
    flashAttn: false,
    temperature: 0,
    temperatureInc: 0.2,
    detectLanguageBySampling: true,
  },
  balanced: {
    beamSize: 5,
    bestOf: 5,
    contextMode: 'balanced',
    vad: true,
    dtw: false,
    flashAttn: true,
    temperature: 0,
    temperatureInc: 0.2,
    detectLanguageBySampling: true,
  },
  speed: {
    beamSize: 1,
    bestOf: 1,
    contextMode: 'off',
    vad: true,
    dtw: false,
    flashAttn: true,
    temperature: 0,
    temperatureInc: 0.2,
    detectLanguageBySampling: false,
  },
};

const STAGE_ORDER = ['probe', 'extract', 'detect', 'transcribe', 'post', 'write'];
const RING_CIRCUMFERENCE = 2 * Math.PI * 19;

/* ============================================================
   Helpers
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>';
const DOWN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="m7 12 5 5 5-5"/></svg>';

function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 1 ? 1 : 0)} ${units[i]}`;
}

function fmtMB(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function fmtDuration(sec) {
  if (sec == null) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

function fmtTimecode(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(
    t % 1000
  ).padStart(3, '0')}`;
}

function toast(message, kind = '') {
  const node = el('div', `toast${kind ? ` is-${kind}` : ''}`, message);
  $('#toastWrap').appendChild(node);
  setTimeout(
    () => {
      node.classList.add('is-leaving');
      node.addEventListener('transitionend', () => node.remove(), { once: true });
      setTimeout(() => node.remove(), 400);
    },
    kind === 'error' ? 7000 : 3600
  );
}

function randomToken() {
  return Math.random().toString(36).slice(2, 10);
}

/* ============================================================
   Navigation
   ============================================================ */

function showTab(name) {
  $$('.navitem').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $$('.page').forEach((p) => p.classList.toggle('is-active', p.id === `page-${name}`));
  $('.content').scrollTop = 0;
}

$$('.navitem').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));

/* ============================================================
   Sidebar system stats
   ============================================================ */

function renderSysStats() {
  const wrap = $('#sysStats');
  wrap.innerHTML = '';
  const info = state.info;
  if (!info) return;

  const rows = [
    {
      text: info.gpu ? `${info.gpu.name.replace('NVIDIA GeForce ', '')} · ${Math.round((info.gpu.vramMB || 0) / 1024)} GB` : 'CPU only',
      tone: info.gpu ? 'is-good' : '',
      title: info.gpu ? `${info.gpu.name} · driver ${info.gpu.driver}` : 'No NVIDIA GPU detected',
    },
    { text: `${info.cores} threads`, tone: '', title: info.cpu },
    {
      text: state.requirements?.items?.find((i) => i.id === 'ffmpeg')?.ok ? 'ffmpeg ready' : 'ffmpeg missing',
      tone: state.requirements?.items?.find((i) => i.id === 'ffmpeg')?.ok ? 'is-good' : 'is-bad',
      title: 'Media decoder',
    },
  ];

  if (info.disk.freeBytes != null) {
    const low = info.disk.freeBytes < 5 * 1024 ** 3;
    rows.push({
      text: `${fmtBytes(info.disk.freeBytes)} free`,
      tone: low ? 'is-bad' : '',
      title: 'Free space where models are stored',
    });
  }

  for (const r of rows) {
    const row = el('div', 'stat');
    row.title = r.title || '';
    row.appendChild(el('span', `stat-dot ${r.tone}`));
    row.appendChild(el('span', 'stat-text', r.text));
    wrap.appendChild(row);
  }
}

/* ============================================================
   Requirements — the one-click setup list
   ============================================================ */

async function refreshRequirements() {
  state.requirements = await window.api.checkRequirements();
  renderRequirements();
  renderSysStats();
  updateRunButton();
}

function renderRequirements() {
  const req = state.requirements;
  if (!req) return;

  const list = $('#reqList');
  list.innerHTML = '';

  for (const item of req.items) {
    const row = el('li', `reqitem ${item.ok ? 'is-ok' : 'is-missing'}`);
    row.dataset.req = item.id;

    const mark = el('span', 'req-mark');
    mark.innerHTML = item.ok ? CHECK_SVG : DOWN_SVG;
    row.appendChild(mark);

    const body = el('div', 'req-body');
    body.appendChild(el('div', 'req-label', item.label));
    body.appendChild(el('div', 'req-detail', item.detail));
    row.appendChild(body);

    const side = el('div', 'req-side', item.ok ? 'Ready' : item.installable ? fmtMB(item.sizeMB) : 'Manual');
    row.appendChild(side);

    list.appendChild(row);
  }

  const title = $('#reqTitle');
  const summary = $('#reqSummary');
  const btn = $('#installAllBtn');
  const badge = $('#setupBadge');

  if (req.ready) {
    title.textContent = 'Everything is ready';
    summary.textContent = 'Cue can transcribe offline from here on.';
    btn.classList.add('hidden');
    badge.classList.add('hidden');
  } else {
    const n = req.missingCount;
    title.textContent = `${n} item${n === 1 ? '' : 's'} missing`;
    const free = req.disk.freeBytes != null ? ` · ${fmtBytes(req.disk.freeBytes)} free` : '';
    summary.textContent = `About ${fmtMB(req.missingMB)} to download${free}.`;
    btn.classList.remove('hidden');
    btn.textContent = state.installing ? 'Installing…' : 'Install everything';
    btn.disabled = state.installing;
    badge.textContent = String(n);
    badge.classList.remove('hidden');
  }

  // Mirror the state onto the Transcribe page so the block is obvious there too.
  const callout = $('#setupCallout');
  if (req.ready) {
    callout.classList.add('hidden');
  } else {
    callout.classList.remove('hidden');
    const missing = req.items.filter((i) => !i.ok).map((i) => i.label);
    $('#setupCalloutTitle').textContent = `Setup needed — ${missing.length} item${
      missing.length === 1 ? '' : 's'
    }`;
    $('#setupCalloutText').textContent = `${missing.join(', ')} · about ${fmtMB(req.missingMB)}`;
  }
}

/** Attach a progress bar to a requirement row and return handles to drive it. */
function reqProgressUi(id) {
  const row = $(`.reqitem[data-req="${id}"]`);
  if (!row) return null;
  row.classList.remove('is-missing');
  row.classList.add('is-busy');
  const mark = row.querySelector('.req-mark');
  if (mark) mark.innerHTML = '<span class="spinner"></span>';

  const wrap = el('div', 'req-progress');
  const bar = el('div', 'bar');
  const fill = el('div', 'bar-fill');
  bar.appendChild(fill);
  wrap.appendChild(bar);
  row.appendChild(wrap);

  const side = row.querySelector('.req-side');
  return {
    fill,
    side,
    done() {
      row.classList.remove('is-busy');
      row.classList.add('is-ok');
      if (mark) mark.innerHTML = CHECK_SVG;
      wrap.remove();
      if (side) side.textContent = 'Ready';
    },
    fail() {
      row.classList.remove('is-busy');
      row.classList.add('is-missing');
      if (mark) mark.innerHTML = DOWN_SVG;
      wrap.remove();
    },
  };
}

const activeDownloads = new Map();

window.api.onDownloadProgress((p) => {
  const ui = activeDownloads.get(p.token);
  if (!ui) return;
  if (ui.fill) ui.fill.style.transform = `scaleX(${(p.percent || 0) / 100})`;
  const speed = p.bps ? ` · ${fmtBytes(p.bps)}/s` : '';
  if (ui.status) {
    const size = p.total ? ` · ${fmtBytes(p.received)} / ${fmtBytes(p.total)}` : '';
    ui.status.textContent = `${p.label || ''}${size}${speed}`;
  }
  if (ui.side) {
    ui.side.textContent = p.total
      ? `${Math.round(p.percent || 0)}%${speed}`
      : p.label || `${Math.round(p.percent || 0)}%`;
  }
});

/**
 * Install every missing requirement. The sequencing lives in the main process, so
 * this only reflects the per-item events it reports back.
 */
const setupRows = new Map();

window.api.onSetupItem(({ id, status, reason }) => {
  if (status === 'installing') {
    const ui = reqProgressUi(id);
    if (ui) setupRows.set(id, ui);
    return;
  }
  const ui = setupRows.get(id);
  if (status === 'installed') ui?.done();
  else ui?.fail();
  if (status === 'failed' && reason) {
    const item = state.requirements?.items?.find((i) => i.id === id);
    toast(`${item?.label || id}: ${reason}`, 'error');
  }
  setupRows.delete(id);
});

window.api.onSetupProgress((p) => {
  const ui = setupRows.get(p.id);
  if (!ui) return;
  if (ui.fill) ui.fill.style.transform = `scaleX(${(p.percent || 0) / 100})`;
  if (ui.side) {
    const speed = p.bps ? ` · ${fmtBytes(p.bps)}/s` : '';
    ui.side.textContent = p.total ? `${Math.round(p.percent || 0)}%${speed}` : p.label || '…';
  }
});

async function installAllMissing() {
  if (state.installing) return;
  const req = state.requirements;
  if (!req || req.ready) return;

  state.installing = true;
  const btn = $('#installAllBtn');
  btn.disabled = true;
  btn.textContent = 'Installing…';

  const token = randomToken();
  let outcome = null;
  try {
    outcome = await window.api.installMissing(token);
  } catch (e) {
    toast(`Setup failed: ${e.message}`, 'error');
  }

  state.installing = false;
  setupRows.clear();
  state.settings = await window.api.getSettings();
  state.info = await window.api.getAppInfo();
  await refreshEngines();
  await refreshModels();
  await refreshRequirements();
  fillSettingsForm();
  syncQuickControls();

  const failed = outcome?.results?.filter((r) => r.status === 'failed') || [];
  const skipped = outcome?.results?.filter((r) => r.status === 'skipped') || [];
  if (outcome?.state?.ready) toast('Setup complete — ready to transcribe.', 'good');
  else if (skipped.length) toast('Some components need to be installed manually.', 'error');
  else if (!failed.length) toast('Setup finished.', 'good');
}

/* ============================================================
   Settings form
   ============================================================ */

const BINDINGS = [
  ['#sThreads', 'threads', 'number'],
  ['#sUseGpu', 'useGpu', 'bool'],
  ['#sFlashAttn', 'flashAttn', 'bool'],
  ['#sBeamSize', 'beamSize', 'number'],
  ['#sBestOf', 'bestOf', 'number'],
  ['#sContextMode', 'contextMode', 'text'],
  ['#sSuppressNst', 'suppressNonSpeech', 'bool'],
  ['#sDtw', 'dtw', 'bool'],
  ['#sTranslate', 'translateToEnglish', 'bool'],
  ['#sDetectSampling', 'detectLanguageBySampling', 'bool'],
  ['#sPrompt', 'initialPrompt', 'text'],

  ['#sVad', 'vad', 'bool'],
  ['#sVadThreshold', 'vadThreshold', 'float'],
  ['#sVadMinSpeech', 'vadMinSpeechMs', 'number'],
  ['#sVadMinSilence', 'vadMinSilenceMs', 'number'],
  ['#sVadPad', 'vadSpeechPadMs', 'number'],

  ['#sHighpass', 'audioHighpass', 'bool'],
  ['#sLoudnorm', 'audioLoudnorm', 'bool'],
  ['#sDenoise', 'audioDenoise', 'bool'],

  ['#sMaxChars', 'maxCharsPerLine', 'number'],
  ['#sMaxLines', 'maxLines', 'number'],
  ['#sMaxCps', 'maxCharsPerSec', 'number'],
  ['#sMinDur', 'minCueDurationMs', 'number'],
  ['#sMaxDur', 'maxCueDurationMs', 'number'],
  ['#sMinGap', 'minGapMs', 'number'],
  ['#sSentencePause', 'sentencePauseMs', 'number'],
  ['#sMergeShort', 'mergeShortCues', 'bool'],
  ['#sDropLowConf', 'dropLowConfidence', 'bool'],

  ['#sOutputDir', 'outputDir', 'text'],
  ['#sLangSuffix', 'langSuffix', 'bool'],
  ['#sUtf8Bom', 'utf8Bom', 'bool'],
  ['#sFfmpegPath', 'ffmpegPath', 'text'],
  ['#sFfprobePath', 'ffprobePath', 'text'],
];

function fillSettingsForm() {
  const s = state.settings;
  for (const [sel, key, type] of BINDINGS) {
    const node = $(sel);
    if (!node) continue;
    if (type === 'bool') node.checked = Boolean(s[key]);
    else node.value = s[key] ?? '';
  }
}

let saveTimer = null;
function scheduleSave(patch) {
  state.settings = { ...state.settings, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    state.settings = await window.api.setSettings(patch);
    const hint = $('#settingsSaved');
    hint.textContent = 'Saved';
    setTimeout(() => (hint.textContent = ''), 1400);
  }, 220);
}

function wireSettingsForm() {
  for (const [sel, key, type] of BINDINGS) {
    const node = $(sel);
    if (!node) continue;
    const evt = type === 'bool' || node.tagName === 'SELECT' ? 'change' : 'input';
    node.addEventListener(evt, () => {
      let value;
      if (type === 'bool') value = node.checked;
      else if (type === 'number') value = parseInt(node.value, 10);
      else if (type === 'float') value = parseFloat(node.value);
      else value = node.value;
      if ((type === 'number' || type === 'float') && Number.isNaN(value)) return;

      scheduleSave({ [key]: value });

      // Editing an advanced knob means the named profile no longer describes reality.
      if (['beamSize', 'bestOf', 'contextMode', 'vad', 'dtw', 'flashAttn'].includes(key)) {
        $('#qPreset').value = 'custom';
      }
      if (key === 'flashAttn' && value && state.settings.dtw) {
        toast('With DTW on, flash attention stays off — a whisper.cpp limitation.');
      }
      if (['ffmpegPath', 'ffprobePath'].includes(key)) refreshRequirements();
      updateRunButton();
    });
  }

  $('#pickOutputDir').addEventListener('click', async () => {
    const dir = await window.api.pickDir();
    if (dir) {
      $('#sOutputDir').value = dir;
      scheduleSave({ outputDir: dir });
    }
  });

  $('#clearOutputDir').addEventListener('click', () => {
    $('#sOutputDir').value = '';
    scheduleSave({ outputDir: '' });
  });

  $('#resetSettings').addEventListener('click', async () => {
    const keep = {
      engineVariant: state.settings.engineVariant,
      modelId: state.settings.modelId,
      lastOpenDir: state.settings.lastOpenDir,
    };
    state.settings = await window.api.setSettings({ ...state.defaults, ...keep });
    fillSettingsForm();
    syncQuickControls();
    toast('Settings restored to defaults.', 'good');
  });
}

/* ============================================================
   Quick controls
   ============================================================ */

function fillModelSelect() {
  const sel = $('#qModel');
  const prev = state.settings.modelId;
  sel.innerHTML = '';
  const installed = state.models.filter((m) => m.installed);

  if (!installed.length) {
    const opt = el('option', null, 'No model installed yet');
    opt.value = '';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }

  sel.disabled = false;
  for (const m of installed) {
    const opt = el('option', null, `${m.label} · ${fmtMB(m.sizeMB)}`);
    opt.value = m.id;
    sel.appendChild(opt);
  }
  sel.value = installed.some((m) => m.id === prev) ? prev : installed[0].id;
  if (sel.value !== prev) scheduleSave({ modelId: sel.value });
}

function fillLanguageSelect() {
  const sel = $('#qLanguage');
  sel.innerHTML = '';
  for (const [code, label] of LANGUAGES) {
    const opt = el('option', null, label);
    opt.value = code;
    sel.appendChild(opt);
  }
  sel.value = state.settings.language || 'auto';
}

function detectPresetName() {
  const s = state.settings;
  for (const [name, p] of Object.entries(PRESETS)) {
    if (Object.entries(p).every(([k, v]) => s[k] === v)) return name;
  }
  return 'custom';
}

function syncQuickControls() {
  fillModelSelect();
  fillLanguageSelect();
  $('#qFormat').value = state.settings.outputFormat || 'srt';
  $('#qPreset').value = detectPresetName();
}

function wireQuickControls() {
  $('#qModel').addEventListener('change', (e) => {
    scheduleSave({ modelId: e.target.value });
    updateRunButton();
  });
  $('#qLanguage').addEventListener('change', (e) => scheduleSave({ language: e.target.value }));
  $('#qFormat').addEventListener('change', (e) => scheduleSave({ outputFormat: e.target.value }));
  $('#qPreset').addEventListener('change', (e) => {
    const preset = PRESETS[e.target.value];
    if (!preset) return;
    scheduleSave({ ...preset });
    fillSettingsForm();
    updateRunButton();
    toast(`Profile applied: ${e.target.selectedOptions[0].textContent}`);
  });
}

/* ============================================================
   Advanced setup cards
   ============================================================ */

async function refreshEngines() {
  const { variants } = await window.api.listEngines();
  state.engines = variants;
  renderEngineCards();
}

async function refreshModels() {
  const { models, vad, disk } = await window.api.listModels();
  state.models = models;
  state.vad = vad;
  renderModelCards(disk);
  renderVadCard();
  syncQuickControls();
}

function makeCardProgressUi(card) {
  const bar = el('div', 'bar');
  const fill = el('div', 'bar-fill');
  bar.appendChild(fill);
  const status = el('div', 'dl-status', 'starting…');
  card.appendChild(bar);
  card.appendChild(status);
  return {
    fill,
    status,
    remove() {
      bar.remove();
      status.remove();
    },
  };
}

function renderEngineCards() {
  const wrap = $('#engineList');
  wrap.innerHTML = '';
  const selected = state.settings.engineVariant;

  for (const v of state.engines) {
    const card = el('div', 'minicard');
    if (v.installed) card.classList.add('is-installed');
    else if (v.id === state.recommendedVariant) card.classList.add('is-recommended');

    const head = el('div', 'card-head');
    head.appendChild(el('div', 'card-title', v.label));
    if (v.installed) head.appendChild(el('span', 'badge is-good', 'installed'));
    else if (v.id === state.recommendedVariant) head.appendChild(el('span', 'badge', 'recommended'));
    card.appendChild(head);

    card.appendChild(el('div', 'card-detail', v.detail));

    const meta = el('div', 'card-meta');
    meta.appendChild(el('span', null, `~${fmtMB(v.downloadMB)}`));
    meta.appendChild(el('span', null, v.gpu ? 'GPU accelerated' : 'CPU only'));
    card.appendChild(meta);

    const actions = el('div', 'card-actions');
    if (v.installed) {
      const useBtn = el('button', 'btn btn-sm', selected === v.id ? 'In use' : 'Use this');
      useBtn.disabled = selected === v.id;
      if (selected === v.id) useBtn.classList.add('btn-primary');
      useBtn.addEventListener('click', async () => {
        state.settings = await window.api.setSettings({ engineVariant: v.id });
        renderEngineCards();
        updateRunButton();
        toast(`Engine set to ${v.label}.`, 'good');
      });
      actions.appendChild(useBtn);
    } else {
      const btn = el('button', 'btn btn-sm btn-primary', 'Download');
      const cancelBtn = el('button', 'btn btn-sm btn-ghost hidden', 'Cancel');
      btn.addEventListener('click', async () => {
        const token = randomToken();
        btn.disabled = true;
        cancelBtn.classList.remove('hidden');
        cancelBtn.onclick = () => window.api.cancelDownload(token);
        const ui = makeCardProgressUi(card);
        activeDownloads.set(token, ui);
        try {
          await window.api.installEngine(v.id, token);
          toast(`${v.label} installed.`, 'good');
          if (!state.settings.engineVariant) {
            state.settings = await window.api.setSettings({ engineVariant: v.id });
          }
          await refreshEngines();
          await refreshRequirements();
        } catch (e) {
          toast(`Install failed: ${e.message}`, 'error');
          btn.disabled = false;
          cancelBtn.classList.add('hidden');
          ui.remove();
        } finally {
          activeDownloads.delete(token);
        }
      });
      actions.appendChild(btn);
      actions.appendChild(cancelBtn);
    }
    card.appendChild(actions);
    wrap.appendChild(card);
  }
}

function renderVadCard() {
  const wrap = $('#vadCard');
  wrap.innerHTML = '';
  const card = el('div', 'minicard');
  if (state.vad.installed) card.classList.add('is-installed');

  const head = el('div', 'card-head');
  head.appendChild(el('div', 'card-title', 'Silero VAD v5.1.2'));
  head.appendChild(
    el(
      'span',
      `badge ${state.vad.installed ? 'is-good' : ''}`,
      state.vad.installed ? 'installed' : 'not installed'
    )
  );
  card.appendChild(head);
  card.appendChild(
    el('div', 'card-detail', 'Keeps the model from inventing lines over silence and tightens cue timing.')
  );

  const actions = el('div', 'card-actions');
  if (state.vad.installed) {
    actions.appendChild(el('span', 'dl-status', 'Toggle it under Settings.'));
  } else {
    const btn = el('button', 'btn btn-sm btn-primary', 'Download (0.8 MB)');
    btn.addEventListener('click', async () => {
      const token = randomToken();
      btn.disabled = true;
      const ui = makeCardProgressUi(card);
      activeDownloads.set(token, ui);
      try {
        await window.api.installVad(token);
        toast('VAD model installed.', 'good');
        await refreshModels();
        await refreshRequirements();
      } catch (e) {
        toast(`Download failed: ${e.message}`, 'error');
        btn.disabled = false;
        ui.remove();
      } finally {
        activeDownloads.delete(token);
      }
    });
    actions.appendChild(btn);
  }
  card.appendChild(actions);
  wrap.appendChild(card);
}

function renderModelCards(disk) {
  const wrap = $('#modelList');
  wrap.innerHTML = '';

  $('#modelDirPath').textContent = state.info?.dirs?.models || 'models/';
  if (disk?.freeBytes != null) {
    const node = $('#diskInfo');
    node.textContent = ` ${fmtBytes(disk.freeBytes)} free.`;
    node.classList.toggle('is-low', disk.freeBytes < 5 * 1024 ** 3);
  }

  const gpuVram = state.info?.gpu?.vramMB || 0;
  const recommended = state.requirements?.items?.find((i) => i.id === 'model')?.target;

  for (const m of state.models) {
    const card = el('div', 'minicard');
    if (m.installed) card.classList.add('is-installed');
    else if (m.id === recommended) card.classList.add('is-recommended');

    const head = el('div', 'card-head');
    head.appendChild(el('div', 'card-title', m.label));
    if (m.installed) head.appendChild(el('span', 'badge is-good', 'installed'));
    else if (m.id === recommended) head.appendChild(el('span', 'badge', 'recommended'));
    else if (m.tier === 'best') head.appendChild(el('span', 'badge', 'most accurate'));
    else if (m.tier === 'fast') head.appendChild(el('span', 'badge', 'fast'));
    card.appendChild(head);

    card.appendChild(el('div', 'card-detail', m.detail));

    const meta = el('div', 'card-meta');
    meta.appendChild(el('span', null, fmtMB(m.sizeMB)));
    meta.appendChild(el('span', null, `~${(m.vramMB / 1024).toFixed(1)} GB VRAM`));
    if (gpuVram && m.vramMB > gpuVram) meta.appendChild(el('span', 'badge is-bad', 'may exceed VRAM'));
    card.appendChild(meta);

    const actions = el('div', 'card-actions');
    if (m.installed) {
      const useBtn = el('button', 'btn btn-sm', state.settings.modelId === m.id ? 'Selected' : 'Use this');
      useBtn.disabled = state.settings.modelId === m.id;
      if (state.settings.modelId === m.id) useBtn.classList.add('btn-primary');
      useBtn.addEventListener('click', async () => {
        state.settings = await window.api.setSettings({ modelId: m.id });
        renderModelCards(disk);
        syncQuickControls();
        updateRunButton();
      });
      actions.appendChild(useBtn);

      const delBtn = el('button', 'btn btn-sm btn-ghost', 'Delete');
      delBtn.addEventListener('click', async () => {
        await window.api.deleteModel(m.id);
        toast(`${m.label} deleted.`);
        await refreshModels();
        await refreshRequirements();
      });
      actions.appendChild(delBtn);
    } else {
      const btn = el('button', 'btn btn-sm btn-primary', 'Download');
      const cancelBtn = el('button', 'btn btn-sm btn-ghost hidden', 'Cancel');
      btn.addEventListener('click', async () => {
        const token = randomToken();
        btn.disabled = true;
        cancelBtn.classList.remove('hidden');
        cancelBtn.onclick = () => window.api.cancelDownload(token);
        const ui = makeCardProgressUi(card);
        activeDownloads.set(token, ui);
        try {
          await window.api.installModel(m.id, token);
          toast(`${m.label} downloaded.`, 'good');
          if (!state.settings.modelId) {
            state.settings = await window.api.setSettings({ modelId: m.id });
          }
          await refreshModels();
          await refreshRequirements();
        } catch (e) {
          toast(`Download failed: ${e.message}`, 'error');
          btn.disabled = false;
          cancelBtn.classList.add('hidden');
          ui.remove();
        } finally {
          activeDownloads.delete(token);
        }
      });
      actions.appendChild(btn);
      actions.appendChild(cancelBtn);
    }
    card.appendChild(actions);
    wrap.appendChild(card);
  }
}

/* ============================================================
   File selection
   ============================================================ */

async function setFile(filePath) {
  if (!filePath) return;
  try {
    const info = await window.api.probe(filePath);
    state.file = { path: filePath, info };
    renderFileCard();
    $('#dropzone').classList.add('hidden');
    $('#fileCard').classList.remove('hidden');
    $('#resultPanel').classList.add('hidden');
    $('#progressPanel').classList.add('hidden');
    state.result = null;
    state.cues = [];
    updateRunButton();
  } catch (e) {
    toast(`Could not read the file: ${e.message}`, 'error');
  }
}

function renderFileCard() {
  const { path: p, info } = state.file;
  $('#fcName').textContent = info.fileName;
  $('#fcName').title = p;

  const meta = $('#fcMeta');
  meta.innerHTML = '';
  meta.appendChild(el('span', null, fmtDuration(info.durationSec)));
  if (info.video) meta.appendChild(el('span', null, `${info.video.width}×${info.video.height}`));
  if (info.video?.fps) meta.appendChild(el('span', null, `${info.video.fps} fps`));
  meta.appendChild(el('span', null, fmtBytes(info.sizeBytes)));
  meta.appendChild(
    el('span', null, `${info.audioStreams.length} audio track${info.audioStreams.length === 1 ? '' : 's'}`)
  );

  const trackField = $('#audioTrackField');
  const trackSel = $('#audioTrack');
  trackSel.innerHTML = '';
  if (info.audioStreams.length > 1) {
    info.audioStreams.forEach((a, i) => {
      const bits = [`#${i + 1}`, a.codec, `${a.channels} ch`];
      if (a.language) bits.push(a.language);
      if (a.title) bits.push(a.title);
      const opt = el('option', null, bits.join(' · '));
      opt.value = String(i);
      trackSel.appendChild(opt);
    });
    trackSel.value = String(Math.max(0, info.audioStreams.findIndex((a) => a.isDefault)));
    trackField.classList.remove('hidden');
  } else {
    trackField.classList.add('hidden');
  }
}

function wireFilePicking() {
  const dz = $('#dropzone');
  const pick = async () => {
    const p = await window.api.pickVideo();
    if (p) setFile(p);
  };
  dz.addEventListener('click', pick);
  $('#changeFile').addEventListener('click', pick);

  ['dragenter', 'dragover'].forEach((evt) =>
    document.addEventListener(evt, (e) => {
      e.preventDefault();
      dz.classList.add('is-over');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    document.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === 'dragleave' && e.relatedTarget) return;
      dz.classList.remove('is-over');
    })
  );

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const p = window.api.getPathForFile(file);
    if (p) setFile(p);
    else toast('Could not resolve that path — please pick the file instead.', 'error');
  });
}

/* ============================================================
   Run
   ============================================================ */

function updateRunButton() {
  const s = state.settings;
  const model = state.models.find((m) => m.id === s?.modelId);
  const engineOk = state.engines.some((v) => v.id === s?.engineVariant && v.installed);
  const ffmpegOk = state.requirements?.items?.find((i) => i.id === 'ffmpeg')?.ok;
  const ready = Boolean(state.file && model?.installed && engineOk && ffmpegOk);

  $('#runBtn').disabled = !ready || Boolean(state.job);

  const hint = $('#runHint');
  if (state.job) hint.textContent = '';
  else if (!ffmpegOk) hint.textContent = 'ffmpeg is required — install it from Setup.';
  else if (!engineOk) hint.textContent = 'No engine installed.';
  else if (!model?.installed) hint.textContent = 'No model installed.';
  else if (!state.file) hint.textContent = 'Choose a file to start.';
  else hint.textContent = '';

  $('#estimateHint').textContent = ready ? estimateRuntime() || '' : '';
}

/** Rough wall-clock estimate from measured realtime multiples. */
function estimateRuntime() {
  if (!state.file?.info?.durationSec) return null;
  const model = state.models.find((m) => m.id === state.settings.modelId);
  if (!model) return null;

  const variant = state.engines.find((v) => v.id === state.settings.engineVariant);
  const gpuPath = Boolean(state.info?.gpu && state.settings.useGpu && variant?.gpu);

  const base = {
    'large-v3': 4,
    'large-v3-q5': 6,
    'large-v3-turbo': 24,
    'large-v3-turbo-q5': 28,
    medium: 14,
    small: 30,
    base: 70,
  };
  let factor = base[model.id] || 12;
  if (!gpuPath) factor /= 12;
  if (state.settings.dtw) factor *= 0.6;
  if (state.settings.beamSize <= 1) factor *= 1.5;

  const minutes = state.file.info.durationSec / 60 / factor;
  if (minutes < 1) return 'Estimated under a minute';
  if (minutes < 60) return `Estimated ${Math.round(minutes)} min`;
  return `Estimated ${(minutes / 60).toFixed(1)} h`;
}

function setProgress(percent) {
  const pct = Math.max(0, Math.min(100, percent));
  $('#barFill').style.transform = `scaleX(${pct / 100})`;
  $('#ringValue').style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - pct / 100));
  $('#progressNum').textContent = `${Math.round(pct)}%`;
  $('#progressBar').setAttribute('aria-valuenow', String(Math.round(pct)));
}

function setStage(stageKey) {
  const idx = STAGE_ORDER.indexOf(stageKey);
  $$('#stepper li').forEach((li) => {
    const i = STAGE_ORDER.indexOf(li.dataset.stage);
    li.classList.toggle('is-active', i === idx);
    li.classList.toggle('is-done', idx >= 0 && i < idx);
  });
  if (stageKey === 'done') {
    $$('#stepper li').forEach((li) => {
      li.classList.remove('is-active');
      li.classList.add('is-done');
    });
  }
}

function resetProgressUi() {
  $('#progressPanel').classList.remove('hidden');
  $('#resultPanel').classList.add('hidden');
  setProgress(0);
  setStage('probe');
  $('#stageLabel').textContent = 'Preparing…';
  $('#stageSub').textContent = '';
  $('#progressSide').textContent = '';
  $('#liveFeed').innerHTML = '<div class="feed-empty">Lines appear here as the model produces them.</div>';
  $('#logBox').textContent = '';
  $('#logBox').classList.add('hidden');
  $('#toggleLog').textContent = 'Show engine log';
}

async function runJob() {
  if (!state.file || state.job) return;

  const overrides = {};
  if (!$('#audioTrackField').classList.contains('hidden')) {
    overrides.audioOrder = parseInt($('#audioTrack').value, 10) || 0;
  }

  resetProgressUi();
  $('#runBtn').disabled = true;
  $('#cancelBtn').classList.remove('hidden');

  const model = state.models.find((m) => m.id === state.settings.modelId);
  $('#progressSide').textContent = model ? `${model.label} · ${state.settings.engineVariant}` : '';

  try {
    const { jobId } = await window.api.startJob(state.file.path, overrides);
    state.job = { id: jobId, startedAt: Date.now() };
  } catch (e) {
    toast(`Could not start: ${e.message}`, 'error');
    $('#cancelBtn').classList.add('hidden');
    updateRunButton();
  }
}

function handleJobEvent(ev) {
  if (!state.job || ev.jobId !== state.job.id) return;

  switch (ev.type) {
    case 'stage':
      $('#stageLabel').textContent = ev.label;
      setStage(ev.stage);
      break;

    case 'progress': {
      setProgress(ev.percent);
      const elapsed = (Date.now() - state.job.startedAt) / 1000;
      if (ev.percent > 3 && ev.percent < 100) {
        const remain = Math.max(0, elapsed / (ev.percent / 100) - elapsed);
        $('#stageSub').textContent = `${fmtDuration(elapsed)} elapsed · about ${fmtDuration(remain)} left`;
      }
      break;
    }

    case 'language':
      $('#stageSub').textContent = `Detected language: ${ev.language}`;
      toast(`Language detected: ${ev.language}`);
      break;

    case 'segment': {
      const feed = $('#liveFeed');
      feed.querySelector('.feed-empty')?.remove();
      const line = el('div', 'feed-line');
      line.appendChild(el('span', 'feed-time', fmtTimecode(ev.segment.startMs).slice(0, 8)));
      line.appendChild(el('span', null, ev.segment.text));
      feed.appendChild(line);
      feed.scrollTop = feed.scrollHeight;
      while (feed.childElementCount > 300) feed.firstElementChild.remove();
      break;
    }

    case 'log': {
      const box = $('#logBox');
      box.textContent = `${box.textContent}${ev.line}\n`.slice(-8000);
      box.scrollTop = box.scrollHeight;
      break;
    }

    case 'done':
      state.job = null;
      $('#cancelBtn').classList.add('hidden');
      setStage('done');
      showResult(ev.result);
      updateRunButton();
      break;

    case 'error':
      state.job = null;
      $('#cancelBtn').classList.add('hidden');
      $('#stageLabel').textContent = 'Failed';
      $('#stageSub').textContent = ev.message;
      toast(ev.message, 'error');
      updateRunButton();
      break;
  }
}

/* ============================================================
   Result + editor
   ============================================================ */

async function showResult(result) {
  state.result = result;
  state.cues = result.cues;

  $('#progressPanel').classList.add('hidden');
  $('#resultPanel').classList.remove('hidden');

  const st = result.stats;
  $('#resultTitle').textContent = result.outputPath.split(/[\\/]/).pop();
  $('#resultPath').textContent = result.outputPath;
  $('#resultPath').title = result.outputPath;

  const tiles = $('#resultTiles');
  tiles.innerHTML = '';
  const tileData = [
    [String(st.cueCount), 'cues'],
    [String(st.wordCount), 'words'],
    [(result.language || '—').toUpperCase(), 'language'],
    [fmtDuration(st.elapsedSec), 'processing time'],
    [st.speedFactor ? `${st.speedFactor}×` : '—', 'realtime'],
    [st.model, 'model'],
  ];
  for (const [value, label] of tileData) {
    const tile = el('div', 'tile');
    tile.appendChild(el('div', 'tile-value', value));
    tile.appendChild(el('div', 'tile-label', label));
    tiles.appendChild(tile);
  }

  const dropped =
    (st.droppedHallucinations || 0) + (st.droppedLoops || 0) + (st.droppedLowConfidence || 0);
  const warned = state.cues.filter((c) => c.warnings?.length).length;
  const note = $('#cleanupNote');
  const parts = [];
  if (dropped) {
    parts.push(
      `${dropped} line${dropped === 1 ? '' : 's'} removed — ${st.droppedHallucinations || 0} invented, ${
        st.droppedLoops || 0
      } repetition loops, ${st.droppedLowConfidence || 0} low confidence`
    );
  }
  if (warned) parts.push(`${warned} cue${warned === 1 ? '' : 's'} flagged for review`);
  if (parts.length) {
    note.textContent = parts.join(' · ');
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }

  const video = $('#videoPreview');
  try {
    video.src = await window.api.fileUrl(result.videoPath);
  } catch {
    /* preview is optional */
  }
  $('#cueOverlay').innerHTML = '<span class="overlay-hint">Play to preview cues</span>';

  renderCueList();
}

function renderCueList() {
  const list = $('#cueList');
  list.innerHTML = '';
  const q = state.filter.query.toLowerCase();

  state.cues.forEach((cue, i) => {
    if (state.filter.onlyWarnings && !cue.warnings?.length) return;
    if (q && !cue.text.toLowerCase().includes(q)) return;

    const row = el('div', 'cue');
    row.dataset.index = String(i);
    if (cue.warnings?.length) row.classList.add('has-warn');

    row.appendChild(el('div', 'cue-idx', String(i + 1)));

    const time = el('button', 'cue-time');
    time.type = 'button';
    time.textContent = `${fmtTimecode(cue.start)}\n${fmtTimecode(cue.end)}`;
    time.title = 'Jump the preview here';
    time.addEventListener('click', () => {
      const video = $('#videoPreview');
      if (video.src) {
        video.currentTime = cue.start / 1000;
        video.play().catch(() => {});
      }
    });
    row.appendChild(time);

    const body = el('div', 'cue-body');
    const ta = el('textarea', 'cue-text');
    ta.value = cue.lines?.length ? cue.lines.join('\n') : cue.text;
    ta.rows = Math.max(1, cue.lines?.length || 1);
    ta.setAttribute('aria-label', `Cue ${i + 1} text`);
    ta.addEventListener('input', () => {
      cue.lines = ta.value.split('\n');
      cue.text = ta.value;
      $('#applyEditsBtn').textContent = 'Save edits •';
    });
    body.appendChild(ta);

    const tags = el('div', 'cue-tags');
    tags.appendChild(el('span', 'tag', `${((cue.end - cue.start) / 1000).toFixed(1)}s`));
    if (cue.cps) tags.appendChild(el('span', 'tag', `${cue.cps} cps`));
    if (cue.confidence != null) {
      tags.appendChild(el('span', 'tag', `${Math.round(cue.confidence * 100)}% conf`));
    }
    (cue.warnings || []).forEach((w) => tags.appendChild(el('span', 'tag is-warn', w)));
    body.appendChild(tags);

    row.appendChild(body);
    list.appendChild(row);
  });

  if (!list.childElementCount) {
    list.appendChild(el('div', 'cuelist-empty', 'No cues match the filter.'));
  }
}

function wireResultActions() {
  $('#cueSearch').addEventListener('input', (e) => {
    state.filter.query = e.target.value;
    renderCueList();
  });
  $('#onlyWarnings').addEventListener('change', (e) => {
    state.filter.onlyWarnings = e.target.checked;
    renderCueList();
  });

  $('#toggleLog').addEventListener('click', () => {
    const box = $('#logBox');
    const hidden = box.classList.toggle('hidden');
    $('#toggleLog').textContent = hidden ? 'Show engine log' : 'Hide engine log';
  });

  $('#revealBtn').addEventListener('click', () => {
    if (state.result) window.api.showItemInFolder(state.result.outputPath);
  });

  $('#copyBtn').addEventListener('click', async () => {
    if (!state.cues.length) return;
    const text = await window.api.previewSubtitle({
      cues: state.cues,
      format: state.settings.outputFormat,
    });
    await navigator.clipboard.writeText(text);
    toast('Subtitle copied to the clipboard.', 'good');
  });

  $('#saveAsBtn').addEventListener('click', async () => {
    if (!state.cues.length) return;
    const format = state.settings.outputFormat;
    const target = await window.api.saveSubtitleAs({ defaultPath: state.result?.outputPath, format });
    if (!target) return;
    await window.api.exportSubtitle({ cues: state.cues, filePath: target, format });
    toast(`Saved to ${target}`, 'good');
  });

  $('#applyEditsBtn').addEventListener('click', async () => {
    if (!state.result) return;
    await window.api.exportSubtitle({
      cues: state.cues,
      filePath: state.result.outputPath,
      format: state.settings.outputFormat,
    });
    $('#applyEditsBtn').textContent = 'Save edits';
    toast('Edits written to the file.', 'good');
  });

  // Highlight whichever cue is on screen during playback.
  $('#videoPreview').addEventListener('timeupdate', (e) => {
    const ms = e.target.currentTime * 1000;
    const idx = state.cues.findIndex((c) => ms >= c.start && ms <= c.end);
    if (idx === state.activeCueIndex) return;
    state.activeCueIndex = idx;

    $$('.cue.is-active').forEach((n) => n.classList.remove('is-active'));
    const overlay = $('#cueOverlay');
    if (idx >= 0) {
      overlay.textContent = state.cues[idx].lines?.join('\n') || state.cues[idx].text;
      const row = $(`.cue[data-index="${idx}"]`);
      if (row) {
        row.classList.add('is-active');
        row.scrollIntoView({ block: 'nearest' });
      }
    } else {
      overlay.innerHTML = '<span class="overlay-hint">Play to preview cues</span>';
    }
  });
}

/* ============================================================
   Boot
   ============================================================ */

async function boot() {
  state.settings = await window.api.getSettings();
  state.defaults = await window.api.getDefaults();
  state.info = await window.api.getAppInfo();
  state.recommendedVariant = await window.api.recommendVariant();

  $('#whisperVer').textContent = state.info.whisperRelease;

  if (!state.settings.threads || state.settings.threads < 1) {
    state.settings = await window.api.setSettings({ threads: state.info.cores });
  }

  fillSettingsForm();
  wireSettingsForm();
  wireQuickControls();
  wireFilePicking();
  wireResultActions();

  await refreshEngines();
  await refreshModels();
  await refreshRequirements();

  $('#installAllBtn').addEventListener('click', installAllMissing);
  $('#runBtn').addEventListener('click', runJob);
  $('#cancelBtn').addEventListener('click', async () => {
    if (state.job) {
      await window.api.cancelJob(state.job.id);
      toast('Cancelling…');
    }
  });

  window.api.onJobEvent(handleJobEvent);
  // A later launch with --open pushes here; the initial one is pulled below.
  window.api.onOpenFile((filePath) => setFile(filePath));

  const pending = await window.api.getPendingOpen();
  if (pending) await setFile(pending);

  // Land on Setup when the app cannot run yet.
  if (!state.requirements?.ready) showTab('setup');
}

boot().catch((e) => {
  document.body.innerHTML =
    '<pre style="padding:24px;color:#e5484d;white-space:pre-wrap;font:13px ui-monospace,monospace">' +
    `Startup failed:\n\n${e.stack || e.message}</pre>`;
});
