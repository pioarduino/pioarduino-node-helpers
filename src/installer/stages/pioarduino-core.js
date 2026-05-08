/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import * as core from '../../core';
import * as misc from '../../misc';
import * as proc from '../../proc';
import {
  createVenvWithUv,
  ensurePipInPenv,
  findPythonExecutable,
  getPythonExecutablePath,
  getUvExecutable,
  installPlatformIOWithUv,
  installPortablePython,
  moveUvToPenv,
} from '../get-python';

import BaseStage from './base';
import { promises as fs } from 'fs';
import { lookup } from 'dns';
import path from 'path';
import { promisify } from 'util';
import semver from 'semver';

const dnsLookup = promisify(lookup);
const execFile = promisify(require('child_process').execFile);
const INSTALLER_VERSION = require('../../../package.json').version;

export default class pioarduinoCoreStage extends BaseStage {
  static getBuiltInPythonDir() {
    return path.join(core.getCoreDir(), 'penv');
  }

  static getBuiltInPythonBinDir() {
    const penvDir = pioarduinoCoreStage.getBuiltInPythonDir();
    return proc.IS_WINDOWS ? path.join(penvDir, 'Scripts') : path.join(penvDir, 'bin');
  }

  static async findBuiltInPythonExe() {
    const penvDir = pioarduinoCoreStage.getBuiltInPythonDir();

    if (proc.IS_WINDOWS) {
      // On Windows, check both root directory and Scripts subdirectory
      const pythonExe = 'python.exe';
      const possiblePaths = [
        path.join(penvDir, pythonExe), // Direct in penv (portable install)
        path.join(penvDir, 'Scripts', pythonExe), // In Scripts (venv style)
      ];

      for (const pythonPath of possiblePaths) {
        try {
          await fs.access(pythonPath);
          return pythonPath;
        } catch (err) {
          // Continue to next path
        }
      }

      // If neither exists, return the first one for error reporting
      return possiblePaths[0];
    } else {
      // Unix: always in bin subdirectory
      return path.join(penvDir, 'bin', 'python3');
    }
  }

  static getBuiltInPythonExe() {
    const penvDir = pioarduinoCoreStage.getBuiltInPythonDir();

    if (proc.IS_WINDOWS) {
      // For synchronous calls, return the most likely path (portable install style)
      return path.join(penvDir, 'python.exe');
    } else {
      // Unix: always in bin subdirectory
      return path.join(penvDir, 'bin', 'python3');
    }
  }

  constructor() {
    super(...arguments);
    // Don't configure built-in Python here - will be done in check()
  }

  get name() {
    return 'pioarduino Core';
  }

  async hasInternetConnection() {
    try {
      // DNS lookup to Cloudflare's 1.1.1.1 (fast and reliable)
      await dnsLookup('1.1.1.1');
      return true;
    } catch (err) {
      console.info('No internet connection detected');
      return false;
    }
  }

  async checkPlatformIOOnline() {
    try {
      // Try to run platformio --version to verify it works
      const output = await proc.getCommandOutput('platformio', ['--version'], {
        timeout: 10000,
      });
      console.info('PlatformIO online check successful:', output.trim());
      return true;
    } catch (err) {
      console.warn('PlatformIO online check failed:', err.message);
      return false;
    }
  }

  async check() {
    // Handle both useBuiltinPIOCore true and false cases
    if (this.params.useBuiltinPIOCore) {
      // Built-in PIO Core: check .platformio/penv directory
      try {
        const penvDir = path.join(core.getCoreDir(), 'penv');
        await fs.access(penvDir);
        console.info('PlatformIO installation detected at:', penvDir);

        // Setup `platformio` CLI globally BEFORE testing it
        const penvBinDir = pioarduinoCoreStage.getBuiltInPythonBinDir();
        proc.extendOSEnvironPath('PLATFORMIO_PATH', [
          penvBinDir,
          path.join(core.getCoreDir(), 'penv'),
        ]);

        // Initialize minimal core state for getPIOCommandOutput to work
        const pythonPath = await pioarduinoCoreStage.findBuiltInPythonExe();

        // Validate Python exists before setting core state
        try {
          await fs.access(pythonPath);
          core.setCoreState({
            core_dir: core.getCoreDir(),
            python_exe: pythonPath,
            penv_bin_dir: penvBinDir,
          });
        } catch (err) {
          console.warn('Python executable not found at:', pythonPath);
          throw new Error(
            'pioarduino Core installation is incomplete - Python not found!',
          );
        }

        // Check Python offline if enabled
        if (this.params.useBuiltinPython) {
          const pythonOk = await this.checkPythonOffline();
          if (!pythonOk) {
            console.warn(
              'Python check failed, but continuing with existing installation',
            );
          }
          // Ensure pip is installed for compatibility with older PlatformIO versions
          await ensurePipInPenv(penvDir);
        }

        // Test PlatformIO functionality if internet connection is available
        const hasInternet = await this.hasInternetConnection();
        if (hasInternet) {
          const pioOk = await this.checkPlatformIOOnline();
          if (!pioOk) {
            console.warn('PlatformIO online check failed, triggering reinstall...');
            this.status = BaseStage.STATUS_FAILED;
            throw new Error(
              'PlatformIO installation is corrupted and needs to be reinstalled!',
            );
          }
        } else {
          console.info('Skipping PlatformIO online check (no internet connection)');
        }
      } catch (err) {
        // Check if it's a directory access error (not installed)
        if (
          err.code === 'ENOENT' ||
          err.message.includes('ENOENT') ||
          err.message.includes('no such file') ||
          err.message.includes('not been installed')
        ) {
          throw new Error('pioarduino Core has not been installed yet!');
        }
        // Re-throw other errors (like the reinstall trigger)
        throw err;
      }
    } else {
      // Global PIO Core: Set minimal core state first, then test
      try {
        // For global PIO, find Python and set minimal core state FIRST
        const pythonPath = await findPythonExecutable();
        if (!pythonPath) {
          throw new Error('No Python found for global PlatformIO');
        }

        core.setCoreState({
          core_dir: core.getCoreDir(),
          python_exe: pythonPath,
        });
        console.info('Using system Python for global PlatformIO:', pythonPath);

        // Now test PlatformIO functionality if internet connection is available
        const hasInternet = await this.hasInternetConnection();
        if (hasInternet) {
          const pioOk = await this.checkPlatformIOOnline();
          if (!pioOk) {
            throw new Error(
              'Could not find compatible pioarduino Core. Please enable `pioarduino-ide.useBuiltinPIOCore` setting and restart IDE.',
            );
          }
        } else {
          // Offline: Core state already set, just log
          console.info('Offline mode: assuming global PlatformIO installation exists');
        }
      } catch (err) {
        console.warn('Global PIO setup failed:', err.message);
        throw new Error(
          'Could not find compatible pioarduino Core. Please enable `pioarduino-ide.useBuiltinPIOCore` setting and restart IDE.',
        );
      }
    }

    this.status = BaseStage.STATUS_SUCCESSED;
    return true;
  }
  async loadCoreState() {
    const penvDir = core.getEnvDir();
    const penvBinDir = core.getEnvBinDir();
    const isGlobal = !this.params.useBuiltinPIOCore;

    // Resolve python and platformio executables
    const pythonExe = isGlobal
      ? await this.whereIsPython()
      : await pioarduinoCoreStage.findBuiltInPythonExe();
    const platformioExe = isGlobal
      ? proc.whereIsProgram(proc.IS_WINDOWS ? 'platformio.exe' : 'platformio')
      : path.join(penvBinDir, proc.IS_WINDOWS ? 'platformio.exe' : 'platformio');

    if (!platformioExe) {
      if (isGlobal) {
        throw new Error(
          `pioarduino executable \`${proc.IS_WINDOWS ? 'platformio.exe' : 'platformio'}\` not found on system PATH (searched via proc.whereIsProgram)`,
        );
      } else {
        throw new Error(`pioarduino executable not found in \`${penvBinDir}\``);
      }
    }
    try {
      await fs.access(platformioExe);
    } catch {
      if (isGlobal) {
        throw new Error(
          `pioarduino executable \`${platformioExe}\` not found on system PATH`,
        );
      } else {
        throw new Error(
          `pioarduino executable not found at \`${platformioExe}\` in ${penvBinDir}`,
        );
      }
    }

    // Verify platformio works
    try {
      await execFile(platformioExe, ['--help'], { timeout: 30000 });
    } catch (err) {
      throw new Error(
        `Could not run \`${platformioExe} --help\`. Error: ${err.message}`,
      );
    }

    // Fetch core version and python version via inline Python
    let coreVersion, pythonVersion;
    try {
      ({ coreVersion, pythonVersion } = await this.probePioCoreVersion(pythonExe));
    } catch (err) {
      throw new Error(`Could not import pioarduino module. Error: ${err.message}`);
    }

    const develop = this.useDevCore() || (coreVersion || '').includes('-');

    const coreState = {
      core_version: coreVersion,
      python_version: pythonVersion,
      core_dir: core.getCoreDir(),
      cache_dir: core.getCacheDir(),
      penv_dir: penvDir,
      penv_bin_dir: penvBinDir,
      platformio_exe: platformioExe,
      installer_version: INSTALLER_VERSION,
      python_exe: pythonExe,
      system: proc.getSysType(),
      is_develop_core: develop,
    };

    // Validate version spec if provided
    if (this.params.pioCoreVersionSpec && coreVersion) {
      const validVersion = semver.valid(coreVersion) || semver.coerce(coreVersion);
      if (
        validVersion &&
        !semver.satisfies(validVersion, this.params.pioCoreVersionSpec, {
          includePrerelease: true,
        })
      ) {
        throw new Error(
          `pioarduino Core version ${coreVersion} does not match version requirements ${this.params.pioCoreVersionSpec}.`,
        );
      }
    }

    // Auto-upgrade if enabled
    if (!isGlobal && !this.params.disableAutoUpdates) {
      await this.autoUpgradeCore(platformioExe, develop);
      // Re-fetch state after upgrade
      try {
        const refreshed = await this.probePioCoreVersion(pythonExe);
        coreState.core_version = refreshed.coreVersion;
        coreState.python_version = refreshed.pythonVersion;
      } catch {
        // keep existing state
      }
    }

    console.info('PIO Core State', coreState);
    core.setCoreState(coreState);
    return true;
  }

  async probePioCoreVersion(pythonExe) {
    const { stdout } = await execFile(
      pythonExe,
      [
        '-c',
        'import json, platform, platformio; print(json.dumps({"core_version": platformio.__version__, "python_version": platform.python_version()}))',
      ],
      { timeout: 15000 },
    );
    const parsed = JSON.parse(stdout.trim());
    return { coreVersion: parsed.core_version, pythonVersion: parsed.python_version };
  }

  async autoUpgradeCore(platformioExe, develop) {
    const UPDATE_INTERVAL = 60 * 60 * 24 * 31; // 31 days
    // Store state outside the virtualenv so it survives venv recreation
    const statePath = path.join(core.getCoreDir(), 'state.json');
    let state = {};
    try {
      const raw = await fs.readFile(statePath, 'utf-8');
      state = JSON.parse(raw);
    } catch {
      // no state file yet
    }

    const timeNow = Math.round(Date.now() / 1000);
    const lastCheck = state.last_piocore_version_check;
    if (lastCheck && timeNow - lastCheck < UPDATE_INTERVAL) {
      return;
    }

    if (!lastCheck) {
      // First run: record the timestamp but skip the upgrade
      state.last_piocore_version_check = timeNow;
      await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
      return;
    }

    const args = ['upgrade'];
    if (develop) {
      args.push('--dev');
    }
    try {
      await execFile(platformioExe, args, { timeout: 300000 });
      console.info('PlatformIO Core upgraded successfully');
    } catch (err) {
      console.warn(`Could not upgrade pioarduino Core: ${err.message}`);
    }

    // Record the attempt regardless of success/failure
    state.last_piocore_version_check = timeNow;
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  useDevCore() {
    return (
      this.params.useDevelopmentPIOCore ||
      (this.params.pioCoreVersionSpec || '').includes('-')
    );
  }

  async checkPythonOffline() {
    if (!this.params.useBuiltinPython) {
      return true;
    }

    try {
      const builtInPythonDir = pioarduinoCoreStage.getBuiltInPythonDir();
      await fs.access(builtInPythonDir);

      // Use consistent path construction via static methods
      const pythonPath = await pioarduinoCoreStage.findBuiltInPythonExe();
      await fs.access(pythonPath);

      // Check version offline
      const version = await this.checkPythonVersionOffline(pythonPath);
      console.info(`Built-in Python ${version} is valid for offline use`);
      return true;
    } catch (err) {
      console.warn('Built-in Python check failed:', err.message);
      return false;
    }
  }

  async checkPythonVersionOffline(pythonPath) {
    try {
      // Get Python version directly without calling PlatformIO installer
      const output = await proc.getCommandOutput(
        pythonPath,
        ['-c', 'import sys; print(sys.version)'],
        {
          timeout: 5000,
        },
      );

      const versionMatch = output.match(/^(\d+)\.(\d+)\.(\d+)/);
      if (versionMatch) {
        const major = parseInt(versionMatch[1]);
        const minor = parseInt(versionMatch[2]);

        // Only Python 3.13.x is accepted
        if (major === 3 && minor === 13) {
          console.info(`Python ${versionMatch[0]} detected (offline check)`);
          return versionMatch[0];
        } else {
          throw new Error(
            `Python ${versionMatch[0]} found, but Python 3.13 is required`,
          );
        }
      }
      throw new Error('Could not determine Python version');
    } catch (err) {
      throw new Error(`Python version check failed: ${err.message}`);
    }
  }

  async isBuiltinPythonOutdated() {
    if (!this.params.useBuiltinPython) {
      return false;
    }
    const builtInPythonDir = pioarduinoCoreStage.getBuiltInPythonDir();
    try {
      await fs.access(builtInPythonDir);
      const coreState = core.getCoreState();
      // If we have a valid Python version in core state, check it
      if (coreState.python_version) {
        if (!/^3\.13\./.test(coreState.python_version)) {
          throw new Error('Python is not 3.13 in penv (Python 3.13 required)');
        }
        // Python version is valid, no need to upgrade
        return false;
      }
      // If no version info available, assume it's valid to avoid unnecessary upgrades
      console.info(
        'No Python version info available, assuming existing installation is valid',
      );
      return false;
    } catch (err) {
      // If Python directory doesn't exist or version check fails, it needs to be installed/upgraded
      if (err.message.includes('Python is not 3.13')) {
        console.info('Upgrading built-in Python...');
        return true;
      }
      return false;
    }
  }

  async whereIsPython({ prompt = false } = {}) {
    let status = this.params.pythonPrompt.STATUS_TRY_AGAIN;

    if (!prompt) {
      // First try to find UV-managed Python if built-in Python is enabled
      if (this.params.useBuiltinPython) {
        try {
          const pythonPath = await getPythonExecutablePath('3.13');
          console.info('Using UV-managed Python:', pythonPath);
          return pythonPath;
        } catch (err) {
          console.info('UV-managed Python not found, searching system PATH');
        }
      }
      return await findPythonExecutable();
    }

    do {
      // First try to find UV-managed Python if enabled
      if (this.params.useBuiltinPython) {
        try {
          const pythonPath = await getPythonExecutablePath('3.13');
          console.info('Using UV-managed Python:', pythonPath);
          return pythonPath;
        } catch (err) {
          console.info('UV-managed Python not found, searching system PATH');
        }
      }

      const pythonExecutable = await findPythonExecutable();
      if (pythonExecutable) {
        return pythonExecutable;
      }
      const result = await this.params.pythonPrompt.prompt();
      status = result.status;
      if (
        status === this.params.pythonPrompt.STATUS_CUSTOMEXE &&
        result.pythonExecutable
      ) {
        proc.extendOSEnvironPath('PLATFORMIO_PATH', [
          path.dirname(result.pythonExecutable),
        ]);
      }
    } while (status !== this.params.pythonPrompt.STATUS_ABORT);

    this.status = BaseStage.STATUS_FAILED;
    throw new Error('Can not find Python Interpreter. Please install Python 3.13');
  }

  async install(withProgress = undefined) {
    if (this.status === BaseStage.STATUS_SUCCESSED) {
      return true;
    }
    if (!this.params.useBuiltinPIOCore) {
      this.status = BaseStage.STATUS_FAILED;
      throw new Error(
        'Could not find compatible pioarduino Core. Please enable `pioarduino-ide.useBuiltinPIOCore` setting and restart IDE.',
      );
    }
    this.status = BaseStage.STATUS_INSTALLING;

    if (!withProgress) {
      withProgress = () => {};
    }
    withProgress('Preparing for installation', 10);
    try {
      // Step 1: Install UV without Python (direct binary download)
      withProgress('Installing UV package manager', 20);
      let uvExe = await getUvExecutable();
      console.info('UV available at:', uvExe);

      // Step 2: Create venv with Python 3.13 using UV or find system Python
      let pythonToUse;
      if (this.params.useBuiltinPython) {
        withProgress('Creating virtual environment with Python 3.13', 40);
        pythonToUse = await installPortablePython(); // also moves UV to penv
        console.info('Python installed at:', pythonToUse);
      } else {
        // Even without built-in Python, create a venv at penvDir so PlatformIO
        // lands in penvBinDir (required by loadCoreState when useBuiltinPIOCore=true)
        const systemPython = await this.whereIsPython({ prompt: true });
        withProgress('Creating virtual environment with system Python', 40);
        const venvPenvDir = core.getEnvDir();
        await createVenvWithUv(uvExe, venvPenvDir, systemPython);
        await moveUvToPenv();
        const penvBinDir = pioarduinoCoreStage.getBuiltInPythonBinDir();
        pythonToUse = path.join(penvBinDir, proc.IS_WINDOWS ? 'python.exe' : 'python3');
        console.info('Venv created with system Python, Python at:', pythonToUse);
      }

      // Re-resolve UV: it may have moved from cache to penv/bin
      uvExe = await getUvExecutable();

      // Step 3: Install PlatformIO Core using UV
      withProgress('Installing PlatformIO Core', 60);
      const penvDir = core.getEnvDir();
      await installPlatformIOWithUv(uvExe, penvDir, this.useDevCore(), pythonToUse);
      console.info('PlatformIO Core installed successfully');

      // Step 4: Load core state
      withProgress('Loading pioarduino Core state', 80);
      await this.loadCoreState();

      withProgress('Installing pioarduino Home', 90);
      await this.installPIOHome();
    } catch (err) {
      misc.reportError(err);
      throw err;
    }

    withProgress('Completed!', 100);
    return true;
  }

  async installPIOHome() {
    try {
      await core.getPIOCommandOutput(['home', '--host', '__do_not_start__']);
    } catch (err) {
      console.warn(err);
    }
  }
}
