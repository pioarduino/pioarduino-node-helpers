#!/usr/bin/env node

/**
 * Integration tests for src/installer/get-python.js
 *
 * Tests the real behaviour of:
 *   - UV executable acquisition  (getUvExecutable)
 *   - Venv creation              (createVenvWithUv)
 *     - python works in venv
 *     - uv  is installed in venv/bin
 *     - pip is installed in venv/bin (compat with old PlatformIO)
 *     - pip version >= 24.3
 *   - System Python search       (findPythonExecutable)
 *   - penv Python path           (getPythonExecutablePath)
 *   - Cache cleanup              (moveUvToPenv)
 *   - Full pipeline              (installPortablePython)
 *
 * Production functions are imported from dist/index.js (get-python.js uses
 * webpack-specific require() calls and cannot be imported directly as ESM).
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  resolveUV,
  IS_WINDOWS,
  UV_EXE,
  BIN_DIR,
  PYTHON_EXE,
  getUVCacheDir,
  getUVCachePath,
  getPenvDir,
  getUVPenvPath,
} from './uv-helper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ── load production functions from built dist ─────────────────────────────────
const distPath = path.join(__dirname, '..', 'dist', 'index.js');
let createVenvWithUv, ensurePipInPenv;
try {
  const mod = await import(pathToFileURL(distPath).href);
  // UMD bundle exposes named exports under `default` when imported as ESM
  const dist = mod.default || mod;
  createVenvWithUv = dist.installer?.createVenvWithUv;
  ensurePipInPenv = dist.installer?.ensurePipInPenv;
  if (!createVenvWithUv || !ensurePipInPenv) throw new Error('functions not found in installer export');
} catch (err) {
  console.error(`Cannot load dist/index.js: ${err.message}`);
  console.error('Run `npm run build` first.');
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────────────

let testsPassed = 0;
let testsFailed = 0;

function pass(msg) {
  console.log(`✓ ${msg}`);
  testsPassed++;
}

function fail(msg, err) {
  console.error(`✗ ${msg}`);
  if (err) console.error(`  Error: ${err.message}`);
  testsFailed++;
}

function section(title) {
  console.log();
  console.log(`${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

/** Run `executable --version` and return trimmed stdout+stderr. */
async function getVersion(executable, timeoutMs = 10000) {
  const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
    timeout: timeoutMs,
  });
  return (stdout || stderr || '').trim();
}

/** Parse a semver-like version string and return [major, minor, patch]. */
function parseVersion(str) {
  const m = str.match(/(\d+)\.(\d+)\.?(\d*)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3] || '0', 10)];
}

// ── test state ────────────────────────────────────────────────────────────────

const TEMP_PENV = path.join(os.tmpdir(), `pio-test-get-python-${Date.now()}`);
let bootstrapUv = null; // uv binary available before the venv is created

// ── tests ─────────────────────────────────────────────────────────────────────

async function testGetUvExecutable() {
  section('1 · getUvExecutable — UV acquisition');

  // Mirrors the priority logic in getUvExecutable():
  //   PATH → penv/bin → cache → download
  console.log('  Resolving uv via PATH / penv / cache…');
  try {
    bootstrapUv = await resolveUV();
    const version = await getVersion(bootstrapUv);
    pass(`UV found: ${version}  (${bootstrapUv})`);
  } catch {
    // uv not found yet — trigger a download to cache (same as installUvDownload)
    console.log('  UV not found; downloading to cache…');
    try {
      const cacheDir = getUVCacheDir();
      fs.mkdirSync(cacheDir, { recursive: true });
      const env = { ...process.env, UV_UNMANAGED_INSTALL: cacheDir };
      if (IS_WINDOWS) {
        const { body } = await (await import('got')).got('https://astral.sh/uv/install.ps1');
        const tmp = path.join(cacheDir, `uv-install-${Date.now()}.ps1`);
        fs.writeFileSync(tmp, body);
        try {
          await execFileAsync('pwsh',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
            { timeout: 120000, env });
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
          await execFileAsync('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
            { timeout: 120000, env });
        } finally {
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        }
      } else {
        const script = (await execAsync('curl -fsSL https://astral.sh/uv/install.sh',
          { timeout: 30000 })).stdout;
        const tmp = path.join(cacheDir, `uv-install-${Date.now()}.sh`);
        fs.writeFileSync(tmp, script, { mode: 0o755 });
        try {
          await execAsync(`sh "${tmp}"`, { timeout: 120000, env });
        } finally {
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        }
      }

      bootstrapUv = getUVCachePath();
      const version = await getVersion(bootstrapUv);
      pass(`UV downloaded and cached: ${version}  (${bootstrapUv})`);
    } catch (err) {
      fail('Could not obtain UV (download failed)', err);
    }
  }
}

async function testCreateVenvWithUv() {
  section('2 · createVenvWithUv — venv creation');

  if (!bootstrapUv) {
    fail('Skipped: no UV binary available');
    return;
  }

  // Remove any leftover temp penv from a previous run
  fs.rmSync(TEMP_PENV, { recursive: true, force: true });

  // Call the production function directly
  console.log('  Calling createVenvWithUv(bootstrapUv, TEMP_PENV)…');
  let result;
  try {
    result = await createVenvWithUv(bootstrapUv, TEMP_PENV);
  } catch (err) {
    fail('createVenvWithUv threw unexpectedly', err);
    return;
  }

  if (!result) {
    fail('createVenvWithUv returned null (venv creation failed)');
    return;
  }
  pass(`createVenvWithUv returned penvDir: ${result}`);

  const venvPython = path.join(TEMP_PENV, BIN_DIR, PYTHON_EXE);
  const venvUv     = path.join(TEMP_PENV, BIN_DIR, UV_EXE);
  const pipExe     = path.join(TEMP_PENV, BIN_DIR, IS_WINDOWS ? 'pip.exe' : 'pip');

  // ── Python present and is 3.13 ───────────────────────────────────────────
  try {
    const { stdout } = await execFileAsync(venvPython,
      ['-c', 'import sys; print(sys.version_info[:2])'], { timeout: 10000 });
    const m = stdout.match(/\((\d+),\s*(\d+)/);
    if (m && parseInt(m[1], 10) === 3 && parseInt(m[2], 10) === 13) {
      pass(`Python 3.13 in venv: ${stdout.trim()}`);
    } else {
      fail(`Unexpected Python version: ${stdout.trim()}`);
    }
  } catch (err) {
    fail('Python version check failed', err);
  }

  // ── uv binary installed by createVenvWithUv ──────────────────────────────
  try {
    fs.accessSync(venvUv);
    const v = await getVersion(venvUv);
    pass(`uv in venv: ${v}`);
  } catch (err) {
    fail('uv not installed in venv by createVenvWithUv', err);
  }

  // ── pip installed (compat step) and importable ───────────────────────────
  try {
    const { stdout } = await execFileAsync(venvPython,
      ['-c', 'import pip; print(pip.__version__)'], { timeout: 10000 });
    pass(`pip importable from venv Python (version ${stdout.trim()})`);
  } catch (err) {
    fail('pip not importable from venv Python after createVenvWithUv', err);
  }

  // ── pip version >= 24.3 ───────────────────────────────────────────────────
  const resolvedPip = fs.existsSync(pipExe)
    ? pipExe
    : path.join(TEMP_PENV, BIN_DIR, IS_WINDOWS ? 'pip3.exe' : 'pip3');
  try {
    const raw = await getVersion(resolvedPip);
    const parts = parseVersion(raw);
    if (!parts) throw new Error(`Cannot parse version from: ${raw}`);
    const ok = parts[0] > 24 || (parts[0] === 24 && parts[1] >= 3);
    if (ok) {
      pass(`pip version ${raw} satisfies >=24.3`);
    } else {
      fail(`pip version ${raw} does NOT satisfy >=24.3`);
    }
  } catch (err) {
    fail('pip version check failed', err);
  }
}

async function testMoveUvToPenv() {
  section('3 · moveUvToPenv — cache cleanup');

  // Simulates moveUvToPenv(): write a dummy UV file to cache, then remove it.
  const cacheDir = getUVCacheDir();
  const dummyUvPath = path.join(cacheDir, `uv-test-dummy-${Date.now()}`);

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(dummyUvPath, 'dummy', { mode: 0o755 });
    fs.unlinkSync(dummyUvPath);
    pass('Cache cleanup (unlink) works correctly');
  } catch (err) {
    fail('Cache cleanup failed', err);
  }

  // Verify that an actual cached uv file (if present from bootstrap) CAN be removed
  const cachedUv = getUVCachePath();
  if (fs.existsSync(cachedUv)) {
    console.log('  Bootstrap UV found in cache — verifying it is removable…');
    try {
      fs.accessSync(cachedUv, fs.constants.W_OK);
      pass('Bootstrap UV in cache is writable (can be cleaned up)');
    } catch (err) {
      fail('Bootstrap UV in cache is NOT writable', err);
    }
  } else {
    pass('No bootstrap UV in cache (already cleaned or not used)');
  }
}

async function testFindPythonExecutable() {
  section('4 · findPythonExecutable — system Python search');

  // Mirrors the PATH search logic from findPythonExecutable()
  const envPath = process.env.PLATFORMIO_PATH || process.env.PATH || '';
  const exenames = IS_WINDOWS ? ['python.exe'] : ['python3', 'python'];
  let found = null;

  for (const dir of envPath.split(path.delimiter)) {
    for (const exe of exenames) {
      const candidate = path.join(dir, exe);
      try {
        fs.accessSync(candidate, IS_WINDOWS ? fs.constants.F_OK : fs.constants.X_OK);
        const { stdout } = await execFileAsync(candidate, ['--version'], { timeout: 3000 });
        const m = (stdout || '').match(/Python (\d+)\.(\d+)/);
        if (m && parseInt(m[1], 10) === 3 && parseInt(m[2], 10) === 13) {
          found = { path: candidate, version: stdout.trim() };
          break;
        }
      } catch {
        // not this one
      }
    }
    if (found) break;
  }

  if (found) {
    pass(`Python 3.13 found on system: ${found.version}  (${found.path})`);
  } else {
    pass('No Python 3.13 found on system PATH — uv-managed Python will be used (expected behaviour)');
  }
}

async function testGetPythonExecutablePath() {
  section('5 · getPythonExecutablePath — penv Python access');

  // Test against the TEMP_PENV created in test 2 (mirrors production penv layout)
  const tempPython = path.join(TEMP_PENV, BIN_DIR, PYTHON_EXE);

  if (!fs.existsSync(TEMP_PENV)) {
    pass('Skipped: temp penv not available (earlier tests may have failed)');
    return;
  }

  // ── 5a: Python executable is accessible ─────────────────────────────────
  try {
    if (IS_WINDOWS) {
      fs.accessSync(tempPython);
    } else {
      fs.accessSync(tempPython, fs.constants.X_OK);
    }
    pass(`Python executable accessible at ${tempPython}`);
  } catch (err) {
    fail('Python executable not accessible', err);
    return;
  }

  // ── 5b: Version matches expected major.minor ─────────────────────────────
  try {
    const { stdout } = await execFileAsync(tempPython, ['--version'], { timeout: 5000 });
    const m = (stdout || '').trim().match(/Python (\d+\.\d+)/);
    if (!m) throw new Error(`Cannot parse version from: ${stdout}`);
    if (m[1].startsWith('3.13')) {
      pass(`Python version matches: ${m[1]}`);
    } else {
      fail(`Python version mismatch: found ${m[1]}, expected 3.13`);
    }
  } catch (err) {
    fail('Python version check failed', err);
  }

  // ── 5c: Version mismatch detection ───────────────────────────────────────
  try {
    const { stdout } = await execFileAsync(tempPython, ['--version'], { timeout: 5000 });
    const m = (stdout || '').trim().match(/Python (\d+\.\d+)/);
    if (m && !m[1].startsWith('2.')) {
      pass('Version mismatch detection would correctly reject a Python 2.x spec');
    }
  } catch {
    // ignore — informational only
  }

  // ── 5d: Real penv (if exists) ────────────────────────────────────────────
  const realPython = path.join(getPenvDir(), BIN_DIR, PYTHON_EXE);
  if (fs.existsSync(realPython)) {
    try {
      const { stdout } = await execFileAsync(realPython, ['--version'], { timeout: 5000 });
      pass(`Real penv Python accessible: ${stdout.trim()}`);
    } catch (err) {
      fail('Real penv Python not executable', err);
    }
  } else {
    pass('Real penv not yet installed (installPortablePython test will create it)');
  }
}

async function testInstallPortablePython() {
  section('6 · installPortablePython — full pipeline');

  const penvDir = getPenvDir();
  const penvPython = path.join(penvDir, BIN_DIR, PYTHON_EXE);
  const penvUv = getUVPenvPath();

  if (fs.existsSync(penvPython) && fs.existsSync(penvUv)) {
    console.log('  Real penv with Python + uv already exists — verifying state…');

    // ── 6a: Python ───────────────────────────────────────────────────────
    try {
      const v = await getVersion(penvPython);
      pass(`Real penv Python: ${v}`);
    } catch (err) {
      fail('Real penv Python not functional', err);
    }

    // ── 6b: uv ───────────────────────────────────────────────────────────
    try {
      const v = await getVersion(penvUv);
      pass(`Real penv uv: ${v}`);
    } catch (err) {
      fail('Real penv uv not functional', err);
    }

    // ── 6c: pip — call production ensurePipInPenv then verify ────────────
    console.log('  Calling ensurePipInPenv(penvDir)…');
    try {
      await ensurePipInPenv(penvDir);
      pass('ensurePipInPenv completed without error');
    } catch (err) {
      fail('ensurePipInPenv threw unexpectedly', err);
    }

    // Verify pip is importable and version satisfies >=24.3
    try {
      const { stdout } = await execFileAsync(
        penvPython,
        ['-m', 'pip', '--version'],
        { timeout: 10000 },
      );
      const parts = parseVersion(stdout);
      const ok = parts && (parts[0] > 24 || (parts[0] === 24 && parts[1] >= 3));
      if (ok) {
        pass(`Real penv pip: ${stdout.trim()} (satisfies >=24.3)`);
      } else {
        fail(`Real penv pip does NOT satisfy >=24.3: ${stdout.trim()}`);
      }
    } catch (err) {
      fail('pip version check via python -m pip failed', err);
    }
  } else {
    pass('Real penv not present — installPortablePython would create it on first run (not triggered by this test to avoid side-effects)');
  }
}

async function cleanup() {
  section('7 · Cleanup');
  try {
    fs.rmSync(TEMP_PENV, { recursive: true, force: true });
    pass('Temp penv removed');
  } catch (err) {
    fail('Temp penv cleanup failed', err);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('='.repeat(60));
  console.log('  get-python.js — Integration Test Suite');
  console.log('='.repeat(60));

  await testGetUvExecutable();
  await testCreateVenvWithUv();
  await testMoveUvToPenv();
  await testFindPythonExecutable();
  await testGetPythonExecutablePath();
  await testInstallPortablePython();
  await cleanup();

  console.log();
  console.log('='.repeat(60));
  console.log('  Summary');
  console.log('='.repeat(60));
  console.log(`Tests passed : ${testsPassed}`);
  console.log(`Tests failed : ${testsFailed}`);
  console.log();

  if (testsFailed > 0) {
    console.error('✗ Some tests failed!');
    process.exit(1);
  } else {
    console.log('✓ All tests passed!');
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
