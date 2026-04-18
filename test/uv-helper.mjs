/**
 * Shared UV helper for tests.
 * UV is always installed into ~/.platformio/.cache (mirrors core.getCacheDir()).
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const execAsync = promisify(exec);

export const IS_WINDOWS = process.platform === 'win32';
export const UV_EXE = IS_WINDOWS ? 'uv.exe' : 'uv';

/**
 * Returns ~/.platformio/.cache — the single location for uv on all platforms.
 */
export function getUVCacheDir() {
  return path.join(os.homedir(), '.platformio', '.cache');
}

/**
 * Full path to the uv executable inside the cache dir.
 */
export function getUVExePath() {
  return path.join(getUVCacheDir(), UV_EXE);
}

/**
 * Returns the uv executable to use: PATH first, then cache dir.
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

  // 2. Try cache dir
  const cached = getUVExePath();
  try {
    await execAsync(`"${cached}" --version`, { timeout: 5000 });
    return cached;
  } catch { /* not cached */ }

  throw new Error(`uv not found. Expected at: ${cached}`);
}
