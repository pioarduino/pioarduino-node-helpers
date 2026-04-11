/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import * as proc from '../proc.js';
import { callInstallerScript } from './get-pioarduino.js';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFile = promisify(require('child_process').execFile);

/**
 * Simple logger for minimal output with timestamp
 * @param {string} level - Log level ('info', 'warn', 'error')
 * @param {string} message - Log message to output
 */
function log(level, message) {
  const timestamp = new Date().toISOString();
  // eslint-disable-next-line no-console
  console[level](`[${timestamp}] [Python-Installer] ${message}`);
}

/**
 * Check if Python version meets compatibility requirements
 * Only Python 3.13.x is accepted
 * @param {string} pythonVersion - Python version string (e.g., "3.13.1")
 * @returns {boolean} True if version is 3.13.x
 */
function isPythonVersionCompatible(pythonVersion) {
  const versionParts = pythonVersion.split('.');
  const major = parseInt(versionParts[0], 10);
  const minor = parseInt(versionParts[1], 10);

  return major === 3 && minor === 13;
}

/**
 * Search for existing Python 3.13 executable in system PATH with version validation
 * Scans through PATH directories to find a Python 3.13 installation.
 * @returns {Promise<string|null>} Path to first valid Python 3.13 executable or null if not found
 * @throws {Error} If distutils module is missing in found Python installation
 */
export async function findPythonExecutable() {
  const exenames = proc.IS_WINDOWS ? ['python.exe'] : ['python3', 'python'];
  const envPath = process.env.PLATFORMIO_PATH || process.env.PATH;
  const errors = [];

  log('info', 'Searching for Python 3.13 installation');

  // Search through all PATH locations for Python executables with early exit on first match
  for (const location of envPath.split(path.delimiter)) {
    for (const exename of exenames) {
      const executable = path.normalize(path.join(location, exename)).replace(/"/g, '');
      try {
        if (
          fs.existsSync(executable) &&
          (await isValidPythonVersion(executable)) &&
          (await callInstallerScript(executable, ['check', 'python']))
        ) {
          log('info', `Found compatible Python: ${executable}`);
          return executable;
        }
      } catch (err) {
        errors.push(err);
      }
    }
  }

  // Handle specific error conditions that should be propagated
  for (const err of errors) {
    if (err.toString().includes('Could not find distutils module')) {
      throw err;
    }
  }

  log('info', 'No Python 3.13 found on system, will install via UV');
  return null;
}

/**
 * Validate Python executable version - only Python 3.13.x is accepted
 * @param {string} executable - Full path to Python executable
 * @returns {Promise<boolean>} True if Python version is 3.13.x
 */
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

/**
 * Get UV executable path after installation
 * On Windows, UV is installed to %USERPROFILE%\.local\bin
 * On Unix/Linux/macOS, UV is installed to ~/.local/bin
 * @returns {string} Full path to UV executable
 */
function getUVExecutablePath() {
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  const uvExe = proc.IS_WINDOWS ? 'uv.exe' : 'uv';
  return path.join(homeDir, '.local', 'bin', uvExe);
}

/**
 * Check if UV (astral-sh/uv) package manager is available on the system
 * UV is a fast Python package installer and resolver written in Rust
 * Checks both PATH and the default installation location
 * @returns {Promise<boolean>} True if UV is installed and accessible
 */
async function isUVAvailable() {
  // First check if UV is in PATH
  try {
    await execFile('uv', ['--version'], { timeout: 5000 });
    log('info', 'UV is available on system PATH');
    return true;
  } catch {
    // UV not in PATH, check default installation location
    try {
      const uvPath = getUVExecutablePath();
      await execFile(uvPath, ['--version'], { timeout: 5000 });
      log('info', `UV found at: ${uvPath}`);
      return true;
    } catch {
      log('info', 'UV not found on system');
      return false;
    }
  }
}

/**
 * Install UV package manager using official installation scripts
 * Downloads and runs platform-specific installer from astral.sh
 * @returns {Promise<void>}
 * @throws {Error} If UV installation fails
 */
async function installUV() {
  log('info', 'Installing UV package manager');

  try {
    if (proc.IS_WINDOWS) {
      // Windows: Use PowerShell with official installer script
      await execFile(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          'irm https://astral.sh/uv/install.ps1 | iex',
        ],
        { timeout: 120000 },
      );
    } else {
      // Unix/Linux/macOS: Use shell with curl installer
      await execFile('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], {
        timeout: 120000,
      });
    }

    log('info', 'UV installation completed');
  } catch (err) {
    throw new Error(`Failed to install UV: ${err.message}`);
  }
}

/**
 * Get the UV command to use - either from PATH or direct path
 * @returns {Promise<string>} UV command or path to use
 */
async function getUVCommand() {
  // Try UV in PATH first
  try {
    await execFile('uv', ['--version'], { timeout: 5000 });
    return 'uv';
  } catch {
    // Use direct path to UV installation
    return getUVExecutablePath();
  }
}

/**
 * Ensure Python is available via UV
 * UV will automatically download and manage Python if needed
 * @param {string} pythonVersion - Python version to ensure (default: "3.13")
 * @returns {Promise<string>} Path to UV-managed Python executable
 * @throws {Error} If UV installation or Python download fails
 */
async function ensurePythonWithUV(pythonVersion = '3.13') {
  log('info', `Ensuring Python ${pythonVersion} is available via UV`);

  // Ensure UV is available, install if necessary
  if (!(await isUVAvailable())) {
    await installUV();
  }

  // Get the correct UV command (from PATH or direct path)
  const uvCommand = await getUVCommand();
  log('info', `Using UV command: ${uvCommand}`);

  try {
    // First check if Python is already installed
    try {
      const existingPath = await getUVPythonPath(pythonVersion);
      log('info', `Python ${pythonVersion} already available at: ${existingPath}`);
      return existingPath;
    } catch {
      // Python not found, need to install
      log('info', `Python ${pythonVersion} not found, installing...`);
    }

    // Use 'uv python install' to ensure Python is available
    // UV will download and manage Python automatically
    const installResult = await execFile(
      uvCommand,
      ['python', 'install', pythonVersion],
      {
        timeout: 300000, // 5 minutes timeout for download
      },
    );

    log('info', `UV Python install output: ${installResult.stdout}`);

    // Get the path to the UV-managed Python
    const pythonPath = await getUVPythonPath(pythonVersion);
    log('info', `UV-managed Python ${pythonVersion} installed at: ${pythonPath}`);
    return pythonPath;
  } catch (err) {
    throw new Error(`UV Python installation failed: ${err.message}`);
  }
}

/**
 * Get the path to UV-managed Python executable
 * @param {string} pythonVersion - Python version (default: "3.13")
 * @returns {Promise<string>} Path to UV-managed Python executable
 * @throws {Error} If Python is not found
 */
async function getUVPythonPath(pythonVersion = '3.13') {
  const uvCommand = await getUVCommand();

  try {
    const result = await execFile(uvCommand, ['python', 'find', pythonVersion], {
      timeout: 10000,
    });

    let pythonPath = result.stdout.trim();
    if (!pythonPath) {
      throw new Error('UV did not return a Python path');
    }

    // Normalize path for the current platform
    pythonPath = path.normalize(pythonPath);

    // Verify the executable exists
    try {
      await fs.promises.access(pythonPath, fs.constants.X_OK);
    } catch (accessErr) {
      // On Windows, try adding .exe if not present
      if (proc.IS_WINDOWS && !pythonPath.endsWith('.exe')) {
        const pythonPathWithExe = pythonPath + '.exe';
        try {
          await fs.promises.access(pythonPathWithExe, fs.constants.X_OK);
          pythonPath = pythonPathWithExe;
        } catch {
          throw new Error(`Python executable not accessible at: ${pythonPath}`);
        }
      } else {
        throw new Error(`Python executable not accessible at: ${pythonPath}`);
      }
    }

    log('info', `Verified UV-managed Python at: ${pythonPath}`);
    return pythonPath;
  } catch (err) {
    throw new Error(`Could not find UV-managed Python: ${err.message}`);
  }
}

/**
 * Main entry point for ensuring Python is available via UV
 * UV will download and manage Python automatically, no venv needed
 * @returns {Promise<string>} Path to UV-managed Python executable
 * @throws {Error} If Python installation fails for any reason
 */
export async function installPortablePython() {
  log('info', 'Ensuring Python 3.13 is available via UV');

  try {
    // Ensure Python is available via UV (will download if needed)
    const pythonPath = await ensurePythonWithUV('3.13');
    log('info', `Python available at: ${pythonPath}`);
    return pythonPath;
  } catch (uvError) {
    log('error', `UV Python setup failed: ${uvError.message}`);
    throw new Error(
      `Python installation failed: ${uvError.message}. Please ensure UV can be installed and internet connection is available.`,
    );
  }
}

/**
 * Get the path to UV-managed Python executable
 * @param {string} pythonVersion - Python version (default: "3.13")
 * @returns {Promise<string>} Path to UV-managed Python executable
 */
async function getPythonExecutablePath(pythonVersion = '3.13') {
  return await getUVPythonPath(pythonVersion);
}

// Export utility functions for external use
export {
  isPythonVersionCompatible,
  isUVAvailable,
  installUV,
  getPythonExecutablePath,
  getUVCommand,
};
