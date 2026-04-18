/**
 * Shared UV helper for tests.
 * UV is always installed into ~/.platformio/.cache (mirrors core.getCacheDir()).
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const execAsync = promisify(exec);

export const IS_WINDOWS = process.platform === 'win32';
export const UV_EXE = IS_WINDOWS ? 'uv.exe' : 'uv';

/**
 * Returns ~/.platformio/.cache — the single location for uv on all platforms.
 */
export function getUVCacheDir() {
  const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(homeDir, '.platformio', '.cache');
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
  // 1. Try PATH
  try {
    await execAsync(`${UV_EXE} --version`);
    return UV_EXE;
  } catch { /* not in PATH */ }

  // 2. Try cache dir
  const cached = getUVExePath();
  try {
    await execAsync(`"${cached}" --version`);
    return cached;
  } catch { /* not cached */ }

  throw new Error(`uv not found. Expected at: ${cached}`);
}
