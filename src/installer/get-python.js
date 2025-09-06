/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import * as core from '../core';
import * as proc from '../proc';
import { callInstallerScript } from './get-pioarduino';
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
 * Supports different validation modes for finding existing vs installing new Python
 * @param {string} pythonVersion - Python version string (e.g., "3.13.1")
 * @param {boolean} forInstallation - If true, only allows 3.13.x; if false, allows 3.10-3.13
 * @returns {boolean} True if version is compatible with requirements
 */
function isPythonVersionCompatible(pythonVersion, forInstallation = false) {
  const versionParts = pythonVersion.split('.');
  const major = parseInt(versionParts[0], 10);
  const minor = parseInt(versionParts[1], 10);

  if (major !== 3) {
    return false;
  }

  if (forInstallation) {
    return minor === 13; // Only 3.13.x for new installations
  } else {
    return minor >= 10 && minor <= 13; // 3.10-3.13 for finding existing installations
  }
}

/**
 * Search for existing Python executable in system PATH with version validation
 * Scans through PATH directories to find compatible Python installations.
 * Accepts Python versions 3.10 through 3.13. Returns first valid installation found.
 * @returns {Promise<string|null>} Path to first valid Python executable or null if not found
 * @throws {Error} If distutils module is missing in found Python installation
 */
export async function findPythonExecutable() {
  const exenames = proc.IS_WINDOWS ? ['python.exe'] : ['python3', 'python'];
  const envPath = process.env.PLATFORMIO_PATH || process.env.PATH;
  const errors = [];

  log('info', 'Searching for compatible Python installation (3.10-3.13)');

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

  log('info', 'No compatible system Python found, will install Python 3.13');
  return null;
}

/**
 * Validate Python executable version and basic functionality
 * This function is used for FINDING existing installations, not for installation validation
 * @param {string} executable - Full path to Python executable
 * @returns {Promise<boolean>} True if Python version is acceptable (3.10-3.13)
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

    return isPythonVersionCompatible(versionMatch[1], false); // Allow 3.10-3.13 for finding existing
  } catch {
    return false;
  }
}

/**
 * Check if UV (astral-sh/uv) package manager is available on the system
 * UV is a fast Python package installer and resolver written in Rust
 * @returns {Promise<boolean>} True if UV is installed and accessible via PATH
 */
async function isUVAvailable() {
  try {
    await execFile('uv', ['--version'], { timeout: 5000 });
    log('info', 'UV is available on system');
    return true;
  } catch {
    log('info', 'UV not found on system');
    return false;
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
 * Install Python using UV package manager
 * Uses UV to download and install Python from astral-sh/python-build-standalone
 * Automatically handles platform detection, download, verification, and extraction
 * @param {string} destinationDir - Target installation directory
 * @param {string} pythonVersion - Python version to install (default: "3.13")
 * @returns {Promise<string>} Path to installed Python directory
 * @throws {Error} If UV installation or Python installation fails
 */
async function installPythonWithUV(destinationDir, pythonVersion = '3.13') {
  log('info', `Installing Python ${pythonVersion} using UV`);

  // Ensure UV is available, install if necessary
  if (!(await isUVAvailable())) {
    await installUV();
  }

  // Clean up any existing installation to avoid conflicts
  try {
    await fs.promises.rm(destinationDir, { recursive: true, force: true });
  } catch (err) {
    // Ignore cleanup errors (directory might not exist)
  }

  // Create destination directory structure
  await fs.promises.mkdir(destinationDir, { recursive: true });

  try {
    // Configure environment for UV Python installation
    const env = {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: destinationDir,
      UV_CACHE_DIR: path.join(core.getTmpDir(), 'uv-cache'),
    };

    // Execute UV Python installation command
    await execFile('uv', ['python', 'install', pythonVersion], {
      env,
      timeout: 300000, // 5 minutes timeout for download and installation
      cwd: destinationDir,
    });

    // Verify that Python executable was successfully installed
    await ensurePythonExeExists(destinationDir, pythonVersion);

    log('info', `Python ${pythonVersion} installation completed: ${destinationDir}`);
    return destinationDir;
  } catch (err) {
    throw new Error(`UV Python installation failed: ${err.message}`);
  }
}

/**
 * Verify that Python executable exists in the installed directory
 * Searches through common installation paths where UV might place Python executables
 * @param {string} pythonDir - Directory containing Python installation
 * @param {string} pythonVersion - Python version for path construction (default: "3.13")
 * @returns {Promise<boolean>} True if executable exists and is accessible
 * @throws {Error} If no Python executable found in expected locations
 */
async function ensurePythonExeExists(pythonDir, pythonVersion = '3.13') {
  // UV typically installs to subdirectories organized by version
  const possiblePaths = [
    pythonDir, // Direct installation in target directory
    path.join(pythonDir, 'python'),
    path.join(pythonDir, `python-${pythonVersion}`),
    path.join(pythonDir, pythonVersion),
  ];

  const executables = proc.IS_WINDOWS ? ['python.exe'] : ['python3', 'python'];

  for (const basePath of possiblePaths) {
    // Check for executable in root of installation path
    for (const exeName of executables) {
      try {
        await fs.promises.access(path.join(basePath, exeName));
        return true;
      } catch (err) {
        // Continue trying other combinations
      }
    }

    // Check for executable in bin subdirectory (Unix-style layout)
    const binDir = path.join(basePath, 'bin');
    for (const exeName of executables) {
      try {
        await fs.promises.access(path.join(binDir, exeName));
        return true;
      } catch (err) {
        // Continue trying other combinations
      }
    }
  }

  throw new Error('Python executable does not exist after UV installation!');
}

/**
 * Main entry point for installing Python distribution using UV
 * This replaces the legacy complex installation logic with a simple UV-based approach
 * @param {string} destinationDir - Target installation directory
 * @param {object} options - Optional configuration (kept for API compatibility)
 * @returns {Promise<string>} Path to installed Python directory
 * @throws {Error} If Python installation fails for any reason
 */
export async function installPortablePython(destinationDir) {
  log('info', 'Starting Python 3.13 installation');

  // UV-based installation is now the only supported method
  try {
    return await installPythonWithUV(destinationDir, '3.13');
  } catch (uvError) {
    log('error', `UV installation failed: ${uvError.message}`);
    throw new Error(
      `Python installation failed: ${uvError.message}. Please ensure UV can be installed and internet connection is available.`,
    );
  }
}

/**
 * Locate Python executable in an installed Python directory
 * Searches through common locations where UV might install Python executables
 * @param {string} pythonDir - Python installation directory to search
 * @returns {Promise<string>} Full path to Python executable
 * @throws {Error} If no executable found in the directory
 */
function getPythonExecutablePath(pythonDir) {
  const executables = proc.IS_WINDOWS ? ['python.exe'] : ['python3', 'python'];

  // Check common locations where UV might install Python
  const searchPaths = [
    pythonDir,
    path.join(pythonDir, 'bin'),
    path.join(pythonDir, 'python'),
    path.join(pythonDir, 'python-3.13'),
    path.join(pythonDir, '3.13'),
    path.join(pythonDir, '3.13', 'bin'),
  ];

  for (const searchPath of searchPaths) {
    for (const exeName of executables) {
      const fullPath = path.join(searchPath, exeName);
      try {
        fs.accessSync(fullPath, fs.constants.X_OK);
        log('info', `Found Python executable: ${fullPath}`);
        return fullPath;
      } catch (err) {
        // Continue searching through all combinations
      }
    }
  }

  throw new Error(`Could not find Python executable in ${pythonDir}`);
}

// Export utility functions for external use
export { isPythonVersionCompatible, isUVAvailable, installUV, getPythonExecutablePath };
