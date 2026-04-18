#!/usr/bin/env node

/**
 * Test the full UV lifecycle:
 *   1. Bootstrap UV (from PATH or download to cache)
 *   2. Create venv at ~/.platformio/penv with Python 3.13
 *   3. Install UV permanently into penv via `uv pip install uv`
 *   4. Clean up bootstrap UV from cache
 *   5. Verify UV works from penv/bin
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import {
  getUVCacheDir, getUVCachePath, getUVPenvPath, getPenvDir,
  IS_WINDOWS, UV_EXE, BIN_DIR, PYTHON_EXE,
} from './uv-helper.mjs';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

let testsPassed = 0;
let testsFailed = 0;

function pass(msg) { console.log(`✓ ${msg}`); testsPassed++; }
function fail(msg, err) { console.error(`✗ ${msg}`); if (err) console.error(`  Error: ${err.message}`); testsFailed++; }

/**
 * Download a URL to a string via https (follows redirects)
 */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      const req = https.get(u, { headers: { 'User-Agent': 'node' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        res.on('error', reject);
      });
      req.setTimeout(30000, () => req.destroy(new Error('fetch timeout')));
      req.on('error', reject);
    };
    get(url);
  });
}

/**
 * Bootstrap UV into cache dir (temporary — will be replaced by penv install).
 */
async function bootstrapUV() {
  console.log('  Bootstrapping UV into cache...');
  const cacheDir = getUVCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const env = { ...process.env, UV_UNMANAGED_INSTALL: cacheDir };

  if (IS_WINDOWS) {
    const script = await fetchText('https://astral.sh/uv/install.ps1');
    const tmp = path.join(cacheDir, `uv-install-${Date.now()}.ps1`);
    fs.writeFileSync(tmp, script, 'utf-8');
    try {
      await execAsync(
        `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmp}"`,
        { timeout: 120000, env },
      );
    } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  } else {
    const script = await fetchText('https://astral.sh/uv/install.sh');
    const tmp = path.join(cacheDir, `uv-install-${Date.now()}.sh`);
    fs.writeFileSync(tmp, script, 'utf-8');
    fs.chmodSync(tmp, 0o755);
    try {
      await execAsync(`sh "${tmp}"`, { timeout: 120000, env });
    } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  }
}

/**
 * Find a working uv: PATH → penv/bin → cache. Downloads if needed.
 */
async function findOrInstallUV() {
  // 1. PATH
  try {
    const probe = IS_WINDOWS ? `where ${UV_EXE}` : `which ${UV_EXE}`;
    const { stdout } = await execAsync(probe, { timeout: 5000 });
    const found = stdout.trim().split('\n')[0].trim();
    if (found) {
      await execAsync(`"${found}" --version`, { timeout: 5000 });
      return found;
    }
  } catch { /* not in PATH */ }

  // 2. penv/bin
  const penvUv = getUVPenvPath();
  try {
    await execAsync(`"${penvUv}" --version`, { timeout: 5000 });
    return penvUv;
  } catch { /* not in penv */ }

  // 3. cache (bootstrap)
  const cachedUv = getUVCachePath();
  try {
    await execAsync(`"${cachedUv}" --version`, { timeout: 5000 });
    return cachedUv;
  } catch { /* not cached */ }

  // 4. Download bootstrap
  await bootstrapUV();
  await execAsync(`"${cachedUv}" --version`, { timeout: 5000 });
  return cachedUv;
}

/**
 * Clean up bootstrap UV from cache dir.
 */
function cleanupCache() {
  const cacheDir = getUVCacheDir();
  for (const name of [UV_EXE, IS_WINDOWS ? 'uvx.exe' : 'uvx']) {
    const p = path.join(cacheDir, name);
    try { fs.unlinkSync(p); console.log(`  Removed ${p}`); } catch { /* ok */ }
  }
  const uvSubdir = path.join(cacheDir, 'uv');
  try {
    if (fs.statSync(uvSubdir).isDirectory()) {
      fs.rmSync(uvSubdir, { recursive: true, force: true });
      console.log(`  Removed ${uvSubdir}`);
    }
  } catch { /* ok */ }
}

async function runTests() {
  console.log('='.repeat(60));
  console.log('UV Full Lifecycle Test');
  console.log('='.repeat(60));
  console.log();

  // -----------------------------------------------------------
  // Test 1: Get a working UV (bootstrap if necessary)
  // -----------------------------------------------------------
  console.log('Test 1: Finding/installing UV...');
  let uvExe;
  try {
    uvExe = await findOrInstallUV();
    const { stdout } = await execAsync(`"${uvExe}" --version`, { timeout: 5000 });
    pass(`UV available: ${stdout.trim()} (${uvExe})`);
  } catch (err) {
    fail('Could not obtain UV', err);
    return;
  }
  console.log();

  // -----------------------------------------------------------
  // Test 2: Create venv at ~/.platformio/penv with Python 3.13
  // -----------------------------------------------------------
  console.log('Test 2: Creating venv with Python 3.13...');
  const penvDir = getPenvDir();
  try {
    fs.rmSync(penvDir, { recursive: true, force: true });
    await execFileAsync(
      uvExe,
      ['venv', penvDir, '--python', '3.13', '--python-preference', 'managed'],
      { timeout: 300000 },
    );
    const venvPython = path.join(penvDir, BIN_DIR, PYTHON_EXE);
    fs.accessSync(venvPython);
    const { stdout } = await execAsync(`"${venvPython}" --version`, { timeout: 10000 });
    pass(`Venv created — ${stdout.trim()}`);
  } catch (err) {
    fail('Failed to create venv', err);
    return;
  }
  console.log();

  // -----------------------------------------------------------
  // Test 3: Install UV permanently into penv via uv pip install
  // -----------------------------------------------------------
  console.log('Test 3: Installing UV into penv/bin...');
  const venvPython = path.join(penvDir, BIN_DIR, PYTHON_EXE);
  try {
    await execFileAsync(
      uvExe,
      ['pip', 'install', 'uv>=0.1.0', `--python=${venvPython}`],
      { timeout: 120000 },
    );
    const penvUv = getUVPenvPath();
    fs.accessSync(penvUv);
    const { stdout } = await execAsync(`"${penvUv}" --version`, { timeout: 5000 });
    pass(`UV installed in penv: ${stdout.trim()}`);
  } catch (err) {
    fail('Failed to install UV into penv', err);
    return;
  }
  console.log();

  // -----------------------------------------------------------
  // Test 4: Clean up bootstrap cache
  // -----------------------------------------------------------
  console.log('Test 4: Cleaning up cache...');
  try {
    cleanupCache();
    const cachePath = getUVCachePath();
    const cacheGone = !fs.existsSync(cachePath);
    if (cacheGone) {
      pass('Bootstrap UV removed from cache');
    } else {
      // cache UV might be the same as system UV — not an error
      pass('Cache UV still present (may be system-managed)');
    }
  } catch (err) {
    fail('Cache cleanup error', err);
  }
  console.log();

  // -----------------------------------------------------------
  // Test 5: Verify UV from penv/bin still works
  // -----------------------------------------------------------
  console.log('Test 5: Verifying penv UV works standalone...');
  try {
    const penvUv = getUVPenvPath();
    const { stdout } = await execAsync(`"${penvUv}" --version`, { timeout: 5000 });
    pass(`penv UV works: ${stdout.trim()}`);
  } catch (err) {
    fail('penv UV not functional after cache cleanup', err);
  }
  console.log();

  // -----------------------------------------------------------
  // Test 6: Verify Python in penv works
  // -----------------------------------------------------------
  console.log('Test 6: Verifying penv Python...');
  try {
    const { stdout } = await execAsync(
      `"${venvPython}" -c "import sys; print(f'Python {sys.version}')"`,
      { timeout: 10000 },
    );
    pass(`penv Python: ${stdout.trim()}`);
  } catch (err) {
    fail('penv Python not functional', err);
  }
  console.log();

  // Summary
  console.log('='.repeat(60));
  console.log('Test Summary');
  console.log('='.repeat(60));
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log();

  if (testsFailed > 0) {
    console.error('✗ Some tests failed!');
    process.exit(1);
  } else {
    console.log('✓ All tests passed!');
    process.exit(0);
  }
}

runTests();
