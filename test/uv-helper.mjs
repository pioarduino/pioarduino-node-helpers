/**
 * Shared UV helper for tests.
 * UV lives permanently in ~/.platformio/penv/bin/ (installed via uv pip install uv).
 * The cache dir ~/.platformio/.cache is only used for temporary bootstrap.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const execAsync = promisify(exec);

export const IS_WINDOWS = process.platform === 'win32';
export const UV_EXE = IS_WINDOWS ? 'uv.exe' : 'uv';
export const BIN_DIR = IS_WINDOWS ? 'Scripts' : 'bin';
export const PYTHON_EXE = IS_WINDOWS ? 'python.exe' : 'python3';

/**
 * Returns ~/.platformio/.cache — temporary bootstrap location only.
 */
export function getUVCacheDir() {
  return path.join(os.homedir(), '.platformio', '.cache');
}

/**
 * Returns ~/.platformio/penv — the permanent venv directory.
 */
export function getPenvDir() {
  return path.join(os.homedir(), '.platformio', 'penv');
}

/**
 * Full path to the uv executable inside penv/bin (permanent location).
 */
export function getUVPenvPath() {
  return path.join(getPenvDir(), BIN_DIR, UV_EXE);
}

/**
 * Full path to the uv executable inside the cache dir (bootstrap only).
 */
export function getUVCachePath() {
  return path.join(getUVCacheDir(), UV_EXE);
}

/**
 * @deprecated Use getUVPenvPath() instead. Kept for backward compatibility.
 */
export function getUVExePath() {
  return getUVCachePath();
}

/**
 * Returns the uv executable to use.
 * Priority: PATH → penv/bin → cache (bootstrap).
 * Throws if uv is not found anywhere.
 */
export async function resolveUV() {
  // 1. Try PATH — use where/which to get the absolute path
  try {
    const probe = IS_WINDOWS ? `where ${UV_EXE}` : `which ${UV_EXE}`;
    const { stdout } = await execAsync(probe, { timeout: 5000 });
    const found = stdout.trim().split('\n')[0].trim();
    if (found) return found;
  } catch { /* not in PATH */ }

  // 2. Try penv/bin (permanent location after install)
  const penvUv = getUVPenvPath();
  try {
    await execAsync(`"${penvUv}" --version`, { timeout: 5000 });
    return penvUv;
  } catch { /* not in penv */ }

  // 3. Try cache dir (bootstrap location)
  const cached = getUVCachePath();
  try {
    await execAsync(`"${cached}" --version`, { timeout: 5000 });
    return cached;
  } catch { /* not cached */ }

  throw new Error(`uv not found. Checked PATH, ${penvUv}, ${cached}`);
}
