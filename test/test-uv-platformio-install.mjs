#!/usr/bin/env node

/**
 * Test PlatformIO installation using UV (the new way)
 * This tests the actual code path used in pioarduino-core.js
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveUV, BIN_DIR, PYTHON_EXE, UV_EXE } from './uv-helper.mjs';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

let testsPassed = 0;
let testsFailed = 0;

function pass(message) {
  console.log(`✓ ${message}`);
  testsPassed++;
}

function fail(message, error) {
  console.error(`✗ ${message}`);
  if (error) {
    console.error(`  Error: ${error.message}`);
  }
  testsFailed++;
}

async function runTests() {
  console.log('='.repeat(60));
  console.log('UV PlatformIO Installation Test');
  console.log('='.repeat(60));
  console.log();

  // Use a temporary directory so we never destroy the real ~/.platformio/penv
  const penvDir = path.join(os.tmpdir(), `pio-test-pio-install-${Date.now()}`);

  try {
    // Test 1: Find/Install Python via uv python find
    console.log('Test 1: Finding/Installing Python...');
    let uvExe;
    try {
      uvExe = await resolveUV();
      try {
        const { stdout } = await execAsync(`"${uvExe}" python find 3.13`, { timeout: 10000 });
        const python = stdout.trim();
        await fs.access(python);
        pass(`Found UV Python: ${python}`);
      } catch {
        console.log('  UV Python not found, installing...');
        await execAsync(`"${uvExe}" python install 3.13`, { timeout: 300000 });
        console.log('  UV Python installed');

        const { stdout } = await execAsync(`"${uvExe}" python find 3.13`, { timeout: 10000 });
        const python = stdout.trim();
        await fs.access(python);
        pass(`Installed and found UV Python: ${python}`);
      }
    } catch (err) {
      fail('Failed to find/install Python', err);
      return false;
    }
    console.log();

    // Test 2: Create UV venv
    console.log('Test 2: Creating UV virtual environment...');
    try {
      const startTime = Date.now();
      await execFileAsync(
        uvExe,
        ['venv', penvDir, '--python', '3.13', '--python-preference', 'managed'],
        { timeout: 300000 },
      );
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      pass(`UV venv created in ${duration}s`);
    } catch (err) {
      fail('Failed to create UV venv', err);
      return false;
    }
    console.log();

    // Test 3: Install UV into venv/bin
    console.log('Test 3: Installing UV into venv/bin...');
    const venvPy = path.join(penvDir, BIN_DIR, PYTHON_EXE);
    const venvUv = path.join(penvDir, BIN_DIR, UV_EXE);
    try {
      await execFileAsync(
        uvExe,
        ['pip', 'install', 'uv>=0.1.0', `--python=${venvPy}`],
        { timeout: 120000 },
      );
      await fs.access(venvUv);
      pass(`UV installed into venv: ${venvUv}`);
    } catch (err) {
      fail('Failed to install UV into venv', err);
      return false;
    }
    console.log();

    const packageSpec = 'pioarduino';
    // Test 4: Install PlatformIO using UV pip into the venv
    console.log('Test 4: Installing PlatformIO with UV pip into venv...');
    console.log('  This may take several minutes...');
    try {
      const startTime = Date.now();
      const { stdout } = await execFileAsync(
        venvUv,
        ['pip', 'install', `--python=${venvPy}`, packageSpec],
        { timeout: 600000, maxBuffer: 50 * 1024 * 1024 },
      );
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      pass(`PlatformIO installed in ${duration}s`);
      
      if (stdout) {
        const lines = stdout.trim().split('\n');
        console.log('  Output (last 5 lines):');
        lines.slice(-5).forEach(line => console.log('    ' + line));
      }
    } catch (err) {
      fail('PlatformIO installation failed', err);
      if (err.stdout) console.log('  stdout:', err.stdout.trim().split('\n').slice(-5).join('\n  '));
      if (err.stderr) console.log('  stderr:', err.stderr.trim().split('\n').slice(-5).join('\n  '));
      return false;
    }
    console.log();

    // Test 5: Verify penv directory
    console.log('Test 5: Verifying penv directory...');
    try {
      await fs.access(penvDir);
      pass('penv directory exists');
      
      const binDir = path.join(penvDir, BIN_DIR);
      await fs.access(binDir);
      pass('bin directory exists');
      
      const contents = await fs.readdir(binDir);
      pass(`Found ${contents.length} files in bin directory`);

      // Verify UV is in penv/bin
      const uvInBin = contents.includes(UV_EXE);
      if (uvInBin) {
        pass(`${UV_EXE} found in penv/bin`);
      } else {
        fail(`${UV_EXE} NOT found in penv/bin`);
      }
    } catch (err) {
      fail('penv verification failed', err);
      return false;
    }
    console.log();

    // Test 6: Verify PlatformIO executable
    console.log('Test 6: Verifying PlatformIO executable...');
    try {
      const binDir = path.join(penvDir, BIN_DIR);
      const IS_WINDOWS = process.platform === 'win32';
      
      const pioExe = path.join(binDir, IS_WINDOWS ? 'platformio.exe' : 'platformio');
      const pioAlias = path.join(binDir, IS_WINDOWS ? 'pio.exe' : 'pio');
      
      let found = false;
      let exe;
      
      try {
        await fs.access(pioExe);
        exe = pioExe;
        found = true;
        pass('platformio executable exists');
      } catch {
        try {
          await fs.access(pioAlias);
          exe = pioAlias;
          found = true;
          pass('pio executable exists');
        } catch {
          fail('Neither platformio nor pio executable found');
          const contents = await fs.readdir(binDir);
          console.log('  Files in bin:', contents.filter(f => !f.startsWith('.')).slice(0, 20).join(', '));
          return false;
        }
      }
      
      if (found) {
        try {
          const { stdout } = await execAsync(`"${exe}" --version`, { timeout: 30000 });
          pass(`PlatformIO version: ${stdout.trim()}`);
        } catch {
          console.log('  Note: Could not get version (may need first-time setup)');
        }
      }
    } catch (err) {
      fail('PlatformIO verification failed', err);
      return false;
    }
    console.log();

    // Test 7: Verify installation with UV pip list (using venv UV)
    console.log('Test 7: Verifying installation with UV pip list...');
    try {
      const { stdout } = await execAsync(`"${venvUv}" pip list "--python=${venvPy}"`, {
        timeout: 30000,
      });
      
      const lines = stdout.trim().split('\n');
      const platformioLine = lines.find(line => line.toLowerCase().startsWith(packageSpec));
      
      if (platformioLine) {
        pass('PlatformIO found in UV pip list');
        console.log(`  ${platformioLine}`);
      } else {
        fail('PlatformIO not found in UV pip list');
      }
    } catch (err) {
      fail('UV pip list failed', err);
      return false;
    }
    console.log();

    return true;

  } catch (err) {
    console.error('Unexpected error:', err);
    console.error('Stack:', err.stack);
    return false;
  } finally {
    // Always clean up the temp venv
    try {
      const { rmSync } = await import('fs');
      rmSync(penvDir, { recursive: true, force: true });
      console.log(`Cleaned up test venv: ${penvDir}`);
    } catch { /* ignore */ }
  }
}

async function main() {
  const success = await runTests();

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
    console.log();
    console.log('PlatformIO has been successfully installed using UV!');
    console.log(`Installation location: ${path.join(os.homedir(), '.platformio', 'penv')}`);
    process.exit(0);
  }
}

main();
