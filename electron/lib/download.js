'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { spawn } = require('node:child_process');

const UA = 'SubtitleGenerator/1.0 (+electron)';

/**
 * Download a URL to disk, following redirects, resuming a partial `.part` file when
 * possible, and reporting progress. Returns the final path.
 *
 * @param {object} o
 * @param {string} o.url
 * @param {string} o.dest              final file path
 * @param {(p:{received:number,total:number,percent:number,bps:number})=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 */
function downloadFile({ url, dest, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const partPath = `${dest}.part`;

    let startAt = 0;
    try {
      startAt = fs.statSync(partPath).size;
    } catch {
      startAt = 0;
    }

    const startedTs = Date.now();
    let received = startAt;
    let total = 0;
    let lastEmit = 0;
    let out = null;
    let req = null;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        req?.destroy();
      } catch {}
      try {
        out?.destroy();
      } catch {}
      reject(err);
    };

    const onAbort = () => fail(new Error('Download cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });

    const get = (target, redirectsLeft) => {
      if (redirectsLeft < 0) return fail(new Error('Too many redirects'));

      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        return fail(new Error(`Invalid URL: ${target}`));
      }
      const lib = parsed.protocol === 'http:' ? http : https;

      const headers = { 'User-Agent': UA, Accept: '*/*' };
      if (startAt > 0) headers.Range = `bytes=${startAt}-`;

      req = lib.get(parsed, { headers }, (res) => {
        const code = res.statusCode || 0;

        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, parsed).toString(), redirectsLeft - 1);
        }

        // Server ignored our Range request -> start over from scratch.
        if (startAt > 0 && code === 200) {
          startAt = 0;
          received = 0;
          try {
            fs.rmSync(partPath, { force: true });
          } catch {}
        }

        if (code !== 200 && code !== 206) {
          res.resume();
          return fail(new Error(`HTTP ${code} — ${parsed.hostname}`));
        }

        const len = Number(res.headers['content-length'] || 0);
        total = code === 206 ? startAt + len : len;

        out = fs.createWriteStream(partPath, { flags: startAt > 0 ? 'a' : 'w' });

        res.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (onProgress && now - lastEmit > 200) {
            lastEmit = now;
            const elapsed = Math.max(1, now - startedTs) / 1000;
            onProgress({
              received,
              total,
              percent: total ? Math.min(100, (received / total) * 100) : 0,
              bps: (received - startAt) / elapsed,
            });
          }
        });

        res.on('error', fail);
        out.on('error', fail);

        res.pipe(out);

        out.on('finish', () => {
          if (settled) return;
          out.close(() => {
            if (total && received !== total) {
              return fail(new Error(`Incomplete download: ${received}/${total} bytes`));
            }
            try {
              fs.rmSync(dest, { force: true });
              fs.renameSync(partPath, dest);
            } catch (e) {
              return fail(e);
            }
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            onProgress?.({ received, total: total || received, percent: 100, bps: 0 });
            resolve(dest);
          });
        });
      });

      req.on('error', fail);
      req.setTimeout(60_000, () => fail(new Error('Connection timed out')));
    };

    get(url, 10);
  });
}

/**
 * Pick the right tar. Windows 10+ ships bsdtar at System32\tar.exe, which reads zip
 * archives; the GNU tar that comes with Git often shadows it on PATH and cannot read
 * zip at all ("This does not look like a tar archive"). Prefer bsdtar explicitly.
 */
function tarBinary() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'tar';
}

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarBinary(), args, { cwd, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => reject(new Error(`Could not start tar: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not extract archive (tar ${code}): ${stderr.trim().slice(-500)}`));
    });
  });
}

function expandZipWithPowerShell(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${JSON.stringify(
      archivePath
    )} -DestinationPath ${JSON.stringify(destDir)} -Force`;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => reject(new Error(`Could not start Expand-Archive: ${e.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Could not extract archive (Expand-Archive ${code}): ${stderr.slice(-500)}`))
    );
  });
}

/**
 * Extract a .zip or .tar.gz using the system `tar`, which exists on Windows 10+,
 * macOS and Linux — so no archive dependency is needed.
 *
 * Paths are handed to tar as *relative* ones on purpose. `tar` on Windows may be
 * either bsdtar or the GNU tar that ships with Git, and GNU tar reads an argument
 * like `D:\dir\file.zip` as a remote `host:path` spec and fails with
 * "Cannot connect to D: resolve failed". Relative paths contain no colon, so both
 * implementations behave.
 */
async function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  const archiveDir = path.dirname(archivePath);
  const relDest = path.relative(archiveDir, destDir);

  // Same volume: run from the archive's folder and reach the target relatively.
  if (relDest && !relDest.includes(':')) {
    try {
      await runTar(['-xf', path.basename(archivePath), '-C', relDest.split(path.sep).join('/')], archiveDir);
      return destDir;
    } catch (err) {
      // Last resort for zip on Windows when no bsdtar is present.
      if (process.platform === 'win32' && /\.zip$/i.test(archivePath)) {
        await expandZipWithPowerShell(archivePath, destDir);
        return destDir;
      }
      throw err;
    }
  }

  // Different volumes (no colon-free relative path exists): stage the archive next
  // to the target, extract in place, then clean up.
  const staged = path.join(destDir, path.basename(archivePath));
  let renamed = false;
  try {
    fs.renameSync(archivePath, staged);
    renamed = true;
  } catch {
    fs.copyFileSync(archivePath, staged);
  }
  try {
    await runTar(['-xf', path.basename(staged)], destDir);
  } catch (err) {
    if (renamed) {
      try {
        fs.renameSync(staged, archivePath); // keep the download for a retry
      } catch {}
    }
    throw err;
  } finally {
    if (!renamed) {
      try {
        fs.rmSync(staged, { force: true });
      } catch {}
    }
  }
  try {
    fs.rmSync(staged, { force: true });
  } catch {}
  return destDir;
}

module.exports = { downloadFile, extractArchive };
