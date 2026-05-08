/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

/**
 * Installs uv without Python, then uses uv to install Python 3.13.
 *
 * Flow adapted from pioarduino-core-installer/pioinstaller/penv.py:
 * 1. Install uv binary (no Python required) via direct download or official script
 * 2. Use uv to create a venv with Python 3.13 (--python-preference managed)
 * 3. Install PlatformIO Core using uv pip install
 */

import * as core from '../core.js';
import * as proc from '../proc.js';

import crypto from 'crypto';
import fs from 'fs';
import got from 'got';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';

const tar = require('tar'); // eslint-disable-line

const execFile = promisify(require('child_process').execFile);

async function execPowerShell(args, options) {
  try {
    return await execFile('pwsh', args, options);
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('info', 'pwsh not found, falling back to powershell.exe');
      return await execFile('powershell.exe', args, options);
    }
    throw err;
  }
}

// Constants matching penv.py
const UV_INSTALL_SCRIPT_UNIX = 'https://astral.sh/uv/install.sh';
const UV_INSTALL_SCRIPT_WINDOWS = 'https://astral.sh/uv/install.ps1';
const UV_DOWNLOAD_VERSION = '0.11.6';
const PYTHON_VERSION = '3.13';
const UV_EXE = proc.IS_WINDOWS ? 'uv.exe' : 'uv';
const PYTHON_EXE = proc.IS_WINDOWS ? 'python.exe' : 'python3';
const BIN_DIR = proc.IS_WINDOWS ? 'Scripts' : 'bin';
const PIO_CORE_PACKAGE = 'pioarduino';
const PIO_CORE_DEVELOP_URL =
  'https://github.com/pioarduino/platformio-core/archive/pioarduino.zip';

function log(level, message) {
  const timestamp = new Date().toISOString();
  // eslint-disable-next-line no-console
  console[level](`[${timestamp}] [Python-Installer] ${message}`);
}

// ============================================================
// UV Platform Detection (adapted from penv.py _get_uv_platform_tag)
// ============================================================

function getUvPlatformTag() {
  const system = process.platform;
  const arch = process.arch;

  if (system === 'darwin') {
    const archMap = { arm64: 'aarch64', x64: 'x86_64' };
    const uvArch = archMap[arch];
    if (uvArch) {
      return `uv-${uvArch}-apple-darwin`;
    }
  } else if (system === 'linux') {
    const isMusl = detectMuslLinux();
    const archMap = {
      x64: ['x86_64', isMusl ? 'musl' : 'gnu'],
      arm64: ['aarch64', isMusl ? 'musl' : 'gnu'],
      arm: ['armv7', isMusl ? 'musleabihf' : 'gnueabihf'],
    };
    const entry = archMap[arch];
    if (entry) {
      const [uvArch, suffix] = entry;
      return `uv-${uvArch}-unknown-linux-${suffix}`;
    }
  } else if (system === 'win32') {
    const archMap = { x64: 'x86_64', arm64: 'aarch64' };
    const uvArch = archMap[arch];
    if (uvArch) {
      return `uv-${uvArch}-pc-windows-msvc`;
    }
  }

  return null;
}

function detectMuslLinux() {
  try {
    const { execSync } = require('child_process');
    const output = execSync('ldd --version 2>&1 || true', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.toLowerCase().includes('musl');
  } catch {
    return false;
  }
}

// ============================================================
// SHA256 Verification
// ============================================================

function sha256Hex(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

// ============================================================
// File Download
// ============================================================

async function downloadFile(url, destPath) {
  const writeStream = fs.createWriteStream(destPath);
  await pipeline(
    got.stream(url, { followRedirect: true, timeout: { request: 300000 } }),
    writeStream,
  );
}

// ============================================================
// UV Installation (adapted from penv.py)
// ============================================================

async function validateUv(uvPath) {
  try {
    await execFile(uvPath, ['--version'], { timeout: 10000 });
    return true;
  } catch {
    log('warn', `uv at ${uvPath} is not usable`);
    return false;
  }
}

function findFileRecursive(filename, dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === filename) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = findFileRecursive(filename, fullPath);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

async function installUvDownload(cacheDir) {
  const tag = getUvPlatformTag();
  if (!tag) {
    log(
      'info',
      `Unsupported platform for direct uv download: ${process.platform}/${process.arch}`,
    );
    return null;
  }

  const uvDest = path.join(cacheDir, UV_EXE);
  const archiveName = proc.IS_WINDOWS ? `${tag}.zip` : `${tag}.tar.gz`;
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_DOWNLOAD_VERSION}/${archiveName}`;
  log('info', `Downloading uv from ${url}`);

  const tmpDir = path.join(os.tmpdir(), `uv-download-${Date.now()}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const archivePath = path.join(tmpDir, archiveName);

    await downloadFile(url, archivePath);

    // Verify SHA256
    const shaUrl = `${url}.sha256`;
    const shaResponse = await got(shaUrl, { timeout: { request: 30000 } });
    const rawHash = shaResponse.body.split(/\s+/)[0].trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(rawHash)) {
      log(
        'warn',
        `Invalid SHA256 response (possible CDN error page): ${shaResponse.body.slice(0, 100)}`,
      );
      return null;
    }
    const actualHash = await sha256Hex(archivePath);
    if (actualHash !== rawHash) {
      log('warn', 'uv archive SHA256 mismatch');
      return null;
    }

    // Extract archive
    const extractDir = path.join(tmpDir, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });

    if (proc.IS_WINDOWS) {
      const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
      await execPowerShell(
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath ${psQuote(archivePath)} -DestinationPath ${psQuote(extractDir)} -Force`,
        ],
        { timeout: 60000 },
      );
    } else {
      await tar.extract({ file: archivePath, cwd: extractDir });
    }

    // Find uv binary in extracted files
    const uvBinary = findFileRecursive(UV_EXE, extractDir);
    if (!uvBinary) {
      log('warn', 'uv binary not found in downloaded archive');
      return null;
    }

    // Copy to cache dir
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.copyFileSync(uvBinary, uvDest);
    if (!proc.IS_WINDOWS) {
      fs.chmodSync(uvDest, 0o755);
    }

    log('info', `uv downloaded and installed at ${uvDest}`);
    return uvDest;
  } catch (err) {
    log('warn', `Failed to download uv directly: ${err.message}`);
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

async function installUvWithScript(cacheDir) {
  let tmpScriptDir = null;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const uvDest = path.join(cacheDir, UV_EXE);
    const env = { ...process.env, UV_UNMANAGED_INSTALL: cacheDir };

    tmpScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-install-'));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-installer-'));
    try {
      if (proc.IS_WINDOWS) {
        const scriptPath = path.join(tmpDir, 'install.ps1');
        const { body } = await got(UV_INSTALL_SCRIPT_WINDOWS, {
          timeout: { request: 30000 },
        });
        fs.writeFileSync(scriptPath, body);
        await execFile(
          'powershell',
          ['-ExecutionPolicy', 'ByPass', '-File', scriptPath],
          { timeout: 900000, env },
        );
      } else {
        const scriptPath = path.join(tmpDir, 'install.sh');
        const { body } = await got(UV_INSTALL_SCRIPT_UNIX, {
          timeout: { request: 30000 },
        });
        fs.writeFileSync(scriptPath, body, { mode: 0o755 });
        await execFile('sh', [scriptPath], { timeout: 900000, env });
      }
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }

    if (fs.existsSync(uvDest)) {
      if (!proc.IS_WINDOWS) {
        fs.chmodSync(uvDest, 0o755);
      }
      log('info', `uv installed at ${uvDest}`);
      return uvDest;
    }
  } catch (err) {
    log('warn', `Failed to install uv with official script: ${err.message}`);
  } finally {
    if (tmpScriptDir) {
      try {
        fs.rmSync(tmpScriptDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  return null;
}

// ============================================================
// UV Executable Getter (adapted from penv.py get_uv_executable)
// ============================================================

function findInPath(exename) {
  const envPath = process.env.PLATFORMIO_PATH || process.env.PATH;
  if (!envPath) {
    return null;
  }

  for (const dir of envPath.split(path.delimiter)) {
    const fullPath = path.join(dir, exename);
    try {
      if (proc.IS_WINDOWS) {
        fs.accessSync(fullPath);
      } else {
        fs.accessSync(fullPath, fs.constants.X_OK);
      }
      return fullPath;
    } catch {
      // continue
    }
  }
  return null;
}

export async function getUvExecutable() {
  // 1. Check PATH for uv
  const pathUv = findInPath(UV_EXE);
  if (pathUv && (await validateUv(pathUv))) {
    log('info', `Found uv in PATH: ${pathUv}`);
    return pathUv;
  }

  // 2. Check penv/bin (permanent post-install location)
  const penvUv = path.join(core.getEnvDir(), BIN_DIR, UV_EXE);
  if (fs.existsSync(penvUv)) {
    if (await validateUv(penvUv)) {
      log('info', `Found uv in penv: ${penvUv}`);
      return penvUv;
    }
    log('info', 'penv uv not usable, falling through to cache');
  }

  // 3. Check cached uv in ~/.platformio/.cache/ (bootstrap location)
  const cacheDir = core.getCacheDir();
  const cachedUv = path.join(cacheDir, UV_EXE);
  if (fs.existsSync(cachedUv)) {
    if (await validateUv(cachedUv)) {
      log('info', `Found cached uv: ${cachedUv}`);
      return cachedUv;
    }
    log('info', 'Cached uv not usable, reinstalling');
  }

  // 4. Primary: direct binary download with SHA256 verification
  let uvExe = await installUvDownload(cacheDir);
  if (uvExe && (await validateUv(uvExe))) {
    log('info', `uv downloaded at ${uvExe}`);
    return uvExe;
  }

  // 5. Fallback: official installer script
  uvExe = await installUvWithScript(cacheDir);
  if (uvExe && (await validateUv(uvExe))) {
    log('info', `uv installed at ${uvExe}`);
    return uvExe;
  }

  throw new Error(
    'Failed to install uv. Please check internet connection and try again.',
  );
}

// ============================================================
// Clean up UV bootstrap cache after installation
// ============================================================

export async function moveUvToPenv() {
  const cacheDir = core.getCacheDir();
  const cacheUvPath = path.join(cacheDir, UV_EXE);

  // Remove bootstrap UV binary from cache (uv is now in penv/bin via pip install)
  if (fs.existsSync(cacheUvPath)) {
    try {
      fs.unlinkSync(cacheUvPath);
      log('info', `Removed bootstrap uv from cache: ${cacheUvPath}`);
    } catch (err) {
      log('warn', `Could not remove cached uv: ${err.message}`);
    }
  }

  // Also remove uvx if present
  const cacheUvxPath = path.join(cacheDir, proc.IS_WINDOWS ? 'uvx.exe' : 'uvx');
  if (fs.existsSync(cacheUvxPath)) {
    try {
      fs.unlinkSync(cacheUvxPath);
      log('info', `Removed bootstrap uvx from cache: ${cacheUvxPath}`);
    } catch (err) {
      log('warn', `Could not remove cached uvx: ${err.message}`);
    }
  }

  // Clean up the uv/ installer-metadata subdirectory in cache
  const uvSubdir = path.join(cacheDir, 'uv');
  try {
    if (fs.statSync(uvSubdir).isDirectory()) {
      fs.rmSync(uvSubdir, { recursive: true, force: true });
      log('info', `Removed uv installer cache directory: ${uvSubdir}`);
    }
  } catch {
    // nothing to clean up
  }
}

// ============================================================
// Venv Creation with UV (adapted from penv.py create_venv_with_uv)
// ============================================================

export async function createVenvWithUv(uvExe, penvDir, pythonSpec = null) {
  // If uvExe lives inside penvDir, copy it to a temp location before deleting
  let safeTmpDir = null;
  const resolvedUv = path.resolve(uvExe);
  const resolvedPenv = path.resolve(penvDir);
  if (resolvedUv.startsWith(resolvedPenv + path.sep)) {
    safeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-safe-'));
    const safeUvPath = path.join(safeTmpDir, UV_EXE);
    fs.copyFileSync(resolvedUv, safeUvPath);
    if (!proc.IS_WINDOWS) {
      fs.chmodSync(safeUvPath, 0o755);
    }
    log('info', `Copied penv-resident uv to safe location: ${safeUvPath}`);
    uvExe = safeUvPath;
  }

  // Remove existing directory if it exists
  if (fs.existsSync(penvDir)) {
    fs.rmSync(penvDir, { recursive: true, force: true });
  }

  // Ensure uv dir is in PATH (exact entry match, safe against undefined PATH)
  const uvDir = path.dirname(uvExe);
  const existingPath = process.env.PATH || '';
  const pathEntries = existingPath.split(path.delimiter);
  if (!pathEntries.includes(uvDir)) {
    process.env.PATH = uvDir + path.delimiter + existingPath;
  }

  try {
    // uv venv creates the venv and automatically downloads Python if needed
    // When pythonSpec is an absolute path, omit --python-preference (managed only applies to version specs)
    const venvArgs = ['venv', penvDir, '--python', pythonSpec || PYTHON_VERSION];
    if (!pythonSpec || !path.isAbsolute(pythonSpec)) {
      venvArgs.push('--python-preference', 'managed');
    }
    const result = await execFile(uvExe, venvArgs, { timeout: 900000 });

    log('info', `uv venv output: ${result.stdout || ''} ${result.stderr || ''}`);

    // Verify python exists in the venv
    const expectedPython = path.join(penvDir, BIN_DIR, PYTHON_EXE);
    if (fs.existsSync(expectedPython)) {
      log(
        'info',
        `Successfully created venv at ${penvDir} with Python ${pythonSpec || PYTHON_VERSION}`,
      );

      // Install uv into the venv using uv itself — places uv binary in penv/bin
      try {
        await execFile(
          uvExe,
          ['pip', 'install', 'uv>=0.1.0', `--python=${expectedPython}`],
          {
            timeout: 120000,
          },
        );
        log('info', 'uv installed into penv via uv pip install');
      } catch (uvInstallErr) {
        throw new Error(`Could not install uv into penv: ${uvInstallErr.message}`);
      }

      // Install pip into the venv for compatibility with older PlatformIO versions.
      // Use the venv's own uv binary. Failure is non-fatal.
      try {
        const venvUv = path.join(penvDir, BIN_DIR, UV_EXE);
        await execFile(
          venvUv,
          ['pip', 'install', 'pip>=24.3', `--python=${expectedPython}`],
          { timeout: 120000 },
        );
        log('info', 'pip installed into penv via venv uv for compatibility');
      } catch (pipInstallErr) {
        log(
          'warn',
          `Could not install pip into penv (non-fatal): ${pipInstallErr.message}`,
        );
      }

      return penvDir;
    }

    log('warn', `Expected python not found at ${expectedPython}`);
    return null;
  } catch (err) {
    log('error', `Failed to create venv with uv: ${err.message}`);
    return null;
  } finally {
    if (safeTmpDir) {
      try {
        fs.rmSync(safeTmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

// ============================================================
// Ensure pip is installed in penv (compat migration for existing penvs)
// ============================================================

export async function ensurePipInPenv(penvDir) {
  const pythonExe = path.join(penvDir, BIN_DIR, PYTHON_EXE);
  const venvUv = path.join(penvDir, BIN_DIR, UV_EXE);

  // Quick check: can pip be imported?
  try {
    await execFile(pythonExe, ['-c', 'import pip'], { timeout: 5000 });
    log('info', 'pip already available in penv');
    return;
  } catch {
    // pip missing — install it
  }

  if (!fs.existsSync(venvUv)) {
    log('warn', 'Cannot install pip: venv uv not found in penv');
    return;
  }

  try {
    await execFile(venvUv, ['pip', 'install', 'pip>=24.3', `--python=${pythonExe}`], {
      timeout: 120000,
    });
    log('info', 'pip installed into penv via venv uv (compat migration)');
  } catch (err) {
    log('warn', `Could not install pip into penv (non-fatal): ${err.message}`);
  }
}

// ============================================================
// PlatformIO Installation with UV (adapted from core.py _install_with_uv)
// ============================================================

export async function installPlatformIOWithUv(
  uvExe,
  penvDir,
  develop = false,
  pythonExe = null,
) {
  const venvPython = pythonExe || path.join(penvDir, BIN_DIR, PYTHON_EXE);
  const packageSpec = develop ? PIO_CORE_DEVELOP_URL : PIO_CORE_PACKAGE;

  log('info', `Installing PlatformIO Core using uv (develop=${develop})`);

  try {
    const result = await execFile(
      uvExe,
      ['pip', 'install', '--python', venvPython, packageSpec],
      { timeout: 900000 },
    );
    log('info', `PlatformIO install output: ${result.stdout || ''}`);
  } catch (err) {
    const errorMsg = proc.IS_WINDOWS
      ? `If you have antivirus/firewall/defender software, try to disable it.\n${err.message}`
      : err.message;
    throw new Error(`Could not install pioarduino Core with uv: ${errorMsg}`);
  }
}

// ============================================================
// Python Version Checking
// ============================================================

function isPythonVersionCompatible(pythonVersion) {
  const versionParts = pythonVersion.split('.');
  const major = parseInt(versionParts[0], 10);
  const minor = parseInt(versionParts[1], 10);
  return major === 3 && minor === 13;
}

async function isValidPythonVersion(executable) {
  try {
    const { execSync } = require('child_process');
    const output = execSync(`"${executable}" --version`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const versionMatch = output.match(/Python (\d+\.\d+\.\d+)/);
    if (!versionMatch) {
      return false;
    }

    return isPythonVersionCompatible(versionMatch[1]);
  } catch {
    return false;
  }
}

function checkPythonEnvironment(executable) {
  // Reject Cygwin
  if (process.platform === 'cygwin') {
    return false;
  }
  // Reject Conda
  if (process.env.CONDA_DEFAULT_ENV || process.env.CONDA_PREFIX) {
    return false;
  }
  if (proc.IS_WINDOWS) {
    const exeLower = executable.toLowerCase();
    if (['msys', 'mingw', 'emacs'].some((s) => exeLower.includes(s))) {
      return false;
    }
  }
  return true;
}

// ============================================================
// System Python Search
// ============================================================

export async function findPythonExecutable() {
  const exenames = proc.IS_WINDOWS ? ['python.exe'] : ['python3', 'python'];
  const envPath = process.env.PLATFORMIO_PATH || process.env.PATH || '';

  log('info', 'Searching for Python 3.13 installation');

  for (const location of envPath.split(path.delimiter)) {
    for (const exename of exenames) {
      const executable = path.normalize(path.join(location, exename)).replace(/"/g, '');
      try {
        if (
          fs.existsSync(executable) &&
          (await isValidPythonVersion(executable)) &&
          checkPythonEnvironment(executable)
        ) {
          log('info', `Found compatible Python: ${executable}`);
          return executable;
        }
      } catch (err) {
        // continue searching
      }
    }
  }

  log('info', 'No Python 3.13 found on system');
  return null;
}

// ============================================================
// Main Entry Points
// ============================================================

export async function installPortablePython() {
  log('info', 'Installing uv and creating Python 3.13 virtual environment');

  // Step 1: Get uv executable (installs if needed, no Python required)
  const uvExe = await getUvExecutable();
  log('info', `Using uv: ${uvExe}`);

  // Step 2: Create venv with Python 3.13 (uv downloads Python automatically)
  const penvDir = core.getEnvDir();
  const result = await createVenvWithUv(uvExe, penvDir);
  if (!result) {
    throw new Error(
      'Could not create PIO Core Virtual Environment. Please report to ' +
        'https://github.com/pioarduino/pioarduino-core-installer/issues',
    );
  }

  // Step 3: Clean up UV from cache (now installed in penv via pip)
  await moveUvToPenv();

  const pythonPath = path.join(penvDir, BIN_DIR, PYTHON_EXE);
  log('info', `Python available at: ${pythonPath}`);
  return pythonPath;
}

async function getPythonExecutablePath(pythonVersion) {
  const penvDir = core.getEnvDir();
  const pythonPath = path.join(penvDir, BIN_DIR, PYTHON_EXE);

  try {
    await fs.promises.access(pythonPath, fs.constants.X_OK);
  } catch {
    if (proc.IS_WINDOWS) {
      try {
        await fs.promises.access(pythonPath);
      } catch {
        throw new Error(`Python not found in penv at: ${pythonPath}`);
      }
    } else {
      throw new Error(`Python not found in penv at: ${pythonPath}`);
    }
  }

  if (pythonVersion) {
    // Validate the interpreter version matches the requested version
    const { execFile: execFileCb } = require('child_process');
    const execFileAsync = promisify(execFileCb);
    try {
      const { stdout } = await execFileAsync(pythonPath, ['--version'], {
        timeout: 5000,
      });
      const versionMatch = stdout.trim().match(/Python (\d+\.\d+)/);
      if (!versionMatch) {
        throw new Error(`Could not parse Python version from: ${stdout.trim()}`);
      }
      if (!versionMatch[1].startsWith(pythonVersion.replace(/\.\*$/, ''))) {
        throw new Error(
          `Python version mismatch: found ${versionMatch[1]}, expected ${pythonVersion}`,
        );
      }
    } catch (err) {
      throw new Error(`Python version check failed at ${pythonPath}: ${err.message}`);
    }
  }

  return pythonPath;
}

export { getPythonExecutablePath };
