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
import os from 'node:os';
import fs from 'node:fs';
import https from 'node:https';
import {
  getUVCacheDir, getUVCachePath, resolveUV,
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
  try {
    return await resolveUV();
  } catch { /* not found anywhere */ }

  // Download bootstrap into cache
  await bootstrapUV();
  const cachedUv = getUVCachePath();
  await execAsync(`"${cachedUv}" --version`, { timeout: 5000 });
  return cachedUv;
  return cachedUv;
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
  // Test 2: Create venv with Python 3.13 (in temp dir)
  // -----------------------------------------------------------
  console.log('Test 2: Creating venv with Python 3.13...');
  try {
    fs.rmSync(testPenvDir, { recursive: true, force: true });
    await execFileAsync(
      uvExe,
      ['venv', testPenvDir, '--python', '3.13', '--python-preference', 'managed'],
      { timeout: 300000 },
    );
    const venvPython = path.join(testPenvDir, BIN_DIR, PYTHON_EXE);
    fs.accessSync(venvPython);
    const { stdout } = await execAsync(`"${venvPython}" --version`, { timeout: 10000 });
    pass(`Venv created — ${stdout.trim()}`);
  } catch (err) {
    fail('Failed to create venv', err);
    return;
  }
  console.log();

  // -----------------------------------------------------------
  // Test 3: Install UV permanently into venv via uv pip install
  // -----------------------------------------------------------
  console.log('Test 3: Installing UV into venv/bin...');
  const venvPython = path.join(testPenvDir, BIN_DIR, PYTHON_EXE);
  const testUvPath = path.join(testPenvDir, BIN_DIR, UV_EXE);
  try {
    await execFileAsync(
      uvExe,
      ['pip', 'install', 'uv>=0.1.0', `--python=${venvPython}`],
      { timeout: 120000 },
    );
    fs.accessSync(testUvPath);
    const { stdout } = await execAsync(`"${testUvPath}" --version`, { timeout: 5000 });
    pass(`UV installed in venv: ${stdout.trim()}`);
  } catch (err) {
    fail('Failed to install UV into venv', err);
    return;
  }
  console.log();

  // -----------------------------------------------------------
  // Test 4: Verify UV from venv/bin works standalone
  // -----------------------------------------------------------
  console.log('Test 4: Verifying venv UV works standalone...');
  try {
    const { stdout } = await execAsync(`"${testUvPath}" --version`, { timeout: 5000 });
    pass(`venv UV works: ${stdout.trim()}`);
  } catch (err) {
    fail('venv UV not functional', err);
  }
  console.log();

  // -----------------------------------------------------------
  // Test 5: Verify Python in venv works
  // -----------------------------------------------------------
  console.log('Test 5: Verifying venv Python...');
  try {
    const { stdout } = await execAsync(
      `"${venvPython}" -c "import sys; print(f'Python {sys.version}')"`,
      { timeout: 10000 },
    );
    pass(`venv Python: ${stdout.trim()}`);
  } catch (err) {
    fail('venv Python not functional', err);
  }
  console.log();

  // -----------------------------------------------------------
  // Test 6: Cleanup test venv and ensure real penv exists
  // -----------------------------------------------------------
  console.log('Test 6: Cleaning up test venv...');
  try {
    fs.rmSync(testPenvDir, { recursive: true, force: true });
    pass('Test venv removed');
  } catch {
    console.log('  Note: Could not remove test venv');
  }
  console.log();

  // -----------------------------------------------------------
  // Test 7: Ensure ~/.platformio/penv has UV for other tests
  // -----------------------------------------------------------
  console.log('Test 7: Ensuring real penv has UV...');
  const realPenvDir = path.join(os.homedir(), '.platformio', 'penv');
  const realPenvUv = path.join(realPenvDir, BIN_DIR, UV_EXE);
  try {
    // Check if penv already has a working UV
    fs.accessSync(realPenvUv);
    await execAsync(`"${realPenvUv}" --version`, { timeout: 5000 });
    pass('Real penv already has UV');
  } catch {
    // Need to create penv with UV
    console.log('  Setting up real penv...');
    try {
      fs.rmSync(realPenvDir, { recursive: true, force: true });
      await execFileAsync(
        uvExe,
        ['venv', realPenvDir, '--python', '3.13', '--python-preference', 'managed'],
        { timeout: 300000 },
      );
      const realPenvPython = path.join(realPenvDir, BIN_DIR, PYTHON_EXE);
      await execFileAsync(
        uvExe,
        ['pip', 'install', 'uv>=0.1.0', `--python=${realPenvPython}`],
        { timeout: 120000 },
      );
      fs.accessSync(realPenvUv);
      pass('Real penv created with UV');
    } catch (err) {
      fail('Could not set up real penv', err);
    }
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
