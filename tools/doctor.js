'use strict';

/**
 * Report what Cue needs and optionally install whatever is missing — the same code
 * the Setup screen drives, runnable without opening the app.
 *
 *   node tools/doctor.js            # report only
 *   node tools/doctor.js --install  # install everything missing
 */

const config = require('../electron/lib/config');
const requirements = require('../electron/lib/requirements');

function fmtMB(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 1 ? 1 : 0)} ${u[i]}`;
}

function bar(percent) {
  const w = 26;
  const f = Math.round((percent / 100) * w);
  return `[${'#'.repeat(f)}${'.'.repeat(w - f)}]`;
}

function report(state) {
  console.log('');
  for (const item of state.items) {
    const mark = item.ok ? ' ok ' : item.installable ? 'MISS' : 'MANUAL';
    const size = item.ok ? '' : `  (${fmtMB(item.sizeMB)})`;
    console.log(`  [${mark}] ${item.label.padEnd(22)} ${item.detail}${size}`);
  }
  console.log('');
  console.log(`  GPU        : ${state.gpu ? `${state.gpu.name} · ${state.gpu.vramMB} MB` : 'none detected'}`);
  console.log(`  free space : ${fmtBytes(state.disk.freeBytes)}`);
  console.log(
    state.ready
      ? '  status     : ready'
      : `  status     : ${state.missingCount} missing · ${fmtMB(state.missingMB)} to download`
  );
  console.log('');
}

async function main() {
  config.ensureDirs();

  const before = await requirements.check();
  console.log('=== Cue doctor ===');
  report(before);

  if (!process.argv.includes('--install')) {
    if (!before.ready) console.log('Run with --install to fix the missing items.\n');
    return;
  }
  if (before.ready) return;

  let lastLine = 0;
  const { results, state } = await requirements.installMissing({
    onItem: ({ id, status, reason }) => {
      if (status === 'installing') process.stdout.write(`\ninstalling ${id}\n`);
      else process.stdout.write(`\n  ${id}: ${status}${reason ? ` — ${reason}` : ''}\n`);
    },
    onProgress: (p) => {
      const now = Date.now();
      if (now - lastLine < 400 && (p.percent || 0) < 100) return;
      lastLine = now;
      const speed = p.bps ? ` ${fmtBytes(p.bps)}/s` : '';
      process.stdout.write(`\r  ${bar(p.percent || 0)} ${(p.percent || 0).toFixed(1)}%${speed}     `);
    },
  });

  console.log('\n=== after install ===');
  report(state);
  for (const r of results) {
    if (r.status !== 'installed') console.log(`  ${r.id}: ${r.status}${r.reason ? ` — ${r.reason}` : ''}`);
  }
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`);
  process.exit(1);
});
