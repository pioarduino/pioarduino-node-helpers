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
  findPythonExecutable,
  getPythonExecutablePath,
  installPortablePython,
} from '../get-python';

import BaseStage from './base';
import { callInstallerScript } from '../get-pioarduino';
import { promises as fs } from 'fs';
import { lookup } from 'dns';
import path from 'path';
import { promisify } from 'util';

const dnsLookup = promisify(lookup);

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
    const stateJSONPath = path.join(
      core.getTmpDir(),
      `core-dump-${Math.round(Math.random() * 100000)}.json`,
    );
    const scriptArgs = [];
    if (this.useDevCore()) {
      scriptArgs.push('--dev');
    }
    scriptArgs.push(
      ...[
        'check',
        'core',
        this.params.disableAutoUpdates || !this.params.useBuiltinPIOCore
          ? '--no-auto-upgrade'
          : '--auto-upgrade',
      ],
    );
    if (this.params.pioCoreVersionSpec) {
      scriptArgs.push(...['--version-spec', this.params.pioCoreVersionSpec]);
    }
    if (!this.params.useBuiltinPIOCore) {
      scriptArgs.push('--global');
    }
    scriptArgs.push(...['--dump-state', stateJSONPath]);
    console.info(await callInstallerScript(await this.whereIsPython(), scriptArgs));

    // Load PIO Core state
    const coreState = await misc.loadJSON(stateJSONPath);
    console.info('PIO Core State', coreState);
    core.setCoreState(coreState);
    await fs.unlink(stateJSONPath); // cleanup
    return true;
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

        // Check if Python >= 3.9
        if (major === 3 && minor >= 9) {
          console.info(`Python ${versionMatch[0]} detected (offline check)`);
          return versionMatch[0];
        } else {
          throw new Error(
            `Python ${versionMatch[0]} found, but Python >= 3.9 required`,
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
        if (!/^3\.(9|[1-9][0-9]+)\./.test(coreState.python_version)) {
          throw new Error('Python < 3.9 in penv (Python >= 3.9 required)');
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
      if (err.message.includes('Python < 3.9')) {
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
    throw new Error(
      'Can not find Python Interpreter. Please install Python 3.9 or above',
    );
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
      let uvPythonPath = null;
      if (this.params.useBuiltinPython) {
        withProgress('Installing Python 3.13 using UV', 10);
        try {
          // installPortablePython now returns the Python executable path directly
          uvPythonPath = await installPortablePython();
          console.info('UV-managed Python installed at:', uvPythonPath);
        } catch (err) {
          console.warn('UV Python installation failed:', err);
          throw err;
        }
      }

      withProgress('Installing pioarduino Core', 20);

      // Use the Python installer script to set up penv with UV
      const pythonToUse = uvPythonPath || (await this.whereIsPython({ prompt: true }));
      console.info('Using Python for PlatformIO installation:', pythonToUse);

      // Use the installer script to create penv and install PlatformIO
      withProgress('Creating virtual environment and installing PlatformIO', 30);

      // Note: The 'install' command doesn't support --dev, --version-spec, or --no-auto-upgrade
      // These options are only available for the 'check' command
      const scriptArgs = ['install'];

      console.info('Running installer script with args:', scriptArgs);
      const installOutput = await callInstallerScript(pythonToUse, scriptArgs);
      console.info('PlatformIO installation output:', installOutput);

      // Load the core state from the installer script
      withProgress('Loading pioarduino Core state', 80);
      await this.loadCoreState();

      withProgress('Installing pioarduino Home', 80);
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
