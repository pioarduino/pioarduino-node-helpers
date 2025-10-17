#!/usr/bin/env node

/**
 * Test PlatformIO installation using UV (the new way)
 * This tests the actual code path used in pioarduino-core.js
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execAsync = promisify(exec);

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

  const coreDir = path.join(os.homedir(), '.platformio');
  const penvDir = path.join(coreDir, 'penv');

  try {
    // Test 1: Find/Install Python (using the same logic as installPortablePython)
    console.log('Test 1: Finding/Installing Python...');
    let python;
    try {
      // This replicates the logic from installPortablePython
      try {
        const uvPythonDir = path.join(os.homedir(), '.local', 'share', 'uv', 'python');
        const dirs = await fs.readdir(uvPythonDir);
        const python313Dir = dirs.find(d => d.includes('cpython-3.13'));
        if (python313Dir) {
          const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
          python = path.join(uvPythonDir, python313Dir, binDir, 'python3.13');
          await fs.access(python);
          pass(`Found UV Python: ${python}`);
        } else {
          throw new Error('UV Python not found');
        }
      } catch {
        // If UV Python not found, install it
        console.log('  UV Python not found, installing...');
        await execAsync('uv python install 3.13', {
          timeout: 300000,
        });
        console.log('  UV Python installed');
        
        // Try again
        const uvPythonDir = path.join(os.homedir(), '.local', 'share', 'uv', 'python');
        const dirs = await fs.readdir(uvPythonDir);
        const python313Dir = dirs.find(d => d.includes('cpython-3.1'));
        if (python313Dir) {
          const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
          python = path.join(uvPythonDir, python313Dir, binDir, 'python3.13');
          await fs.access(python);
          pass(`Installed and found UV Python: ${python}`);
        } else {
          throw new Error('Failed to install UV Python');
        }
      }
    } catch (err) {
      fail('Failed to find/install Python', err);
      return false;
    }
    console.log();

    // Test 2: Clean up existing installation
    console.log('Test 2: Cleaning up existing installation...');
    try {
      await fs.rm(penvDir, { recursive: true, force: true });
      pass('Removed existing penv directory');
    } catch {
      pass('No existing penv to remove');
    }
    console.log();

    // Test 3: Create UV venv (simulating pioarduino-core.js)
    console.log('Test 3: Creating UV virtual environment...');
    try {
      const startTime = Date.now();
      await execAsync(`uv venv --python "${python}" "${penvDir}"`, {
        timeout: 60000,
      });
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      pass(`UV venv created in ${duration}s`);
    } catch (err) {
      fail('Failed to create UV venv', err);
      return false;
    }
    console.log();

    // Test 4: Install PlatformIO using UV pip into the venv
    console.log('Test 4: Installing PlatformIO with UV pip into venv...');
    console.log('  This may take several minutes...');
    try {
      const binDir = process.platform === 'win32' 
        ? path.join(penvDir, 'Scripts')
        : path.join(penvDir, 'bin');
      
      const venvPython = process.platform === 'win32'
        ? path.join(binDir, 'python.exe')
        : path.join(binDir, 'python3');
      
      const startTime = Date.now();
      const { stdout, stderr } = await execAsync(
        `uv pip install --python "${venvPython}" platformio`,
        {
          timeout: 600000, // 10 minutes
          maxBuffer: 50 * 1024 * 1024,
        }
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
      
      const binDir = process.platform === 'win32' 
        ? path.join(penvDir, 'Scripts')
        : path.join(penvDir, 'bin');
      
      await fs.access(binDir);
      pass('bin directory exists');
      
      const contents = await fs.readdir(binDir);
      pass(`Found ${contents.length} files in bin directory`);
    } catch (err) {
      fail('penv verification failed', err);
      return false;
    }
    console.log();

    // Test 6: Verify PlatformIO executable
    console.log('Test 6: Verifying PlatformIO executable...');
    try {
      const binDir = process.platform === 'win32' 
        ? path.join(penvDir, 'Scripts')
        : path.join(penvDir, 'bin');
      
      const pioExe = process.platform === 'win32'
        ? path.join(binDir, 'platformio.exe')
        : path.join(binDir, 'platformio');
      
      const pioAlias = process.platform === 'win32'
        ? path.join(binDir, 'pio.exe')
        : path.join(binDir, 'pio');
      
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
          
          // List what's actually in bin
          const contents = await fs.readdir(binDir);
          console.log('  Files in bin:', contents.filter(f => !f.startsWith('.')).slice(0, 20).join(', '));
          return false;
        }
      }
      
      if (found) {
        // Try to get version
        try {
          const { stdout } = await execAsync(`"${exe}" --version`, {
            timeout: 30000,
          });
          pass(`PlatformIO version: ${stdout.trim()}`);
        } catch (err) {
          console.log('  Note: Could not get version (may need first-time setup)');
        }
      }
    } catch (err) {
      fail('PlatformIO verification failed', err);
      return false;
    }
    console.log();

    // Test 7: Verify installation with UV pip list
    console.log('Test 7: Verifying installation with UV pip list...');
    try {
      const binDir = process.platform === 'win32' 
        ? path.join(penvDir, 'Scripts')
        : path.join(penvDir, 'bin');
      
      const venvPython = process.platform === 'win32'
        ? path.join(binDir, 'python.exe')
        : path.join(binDir, 'python3');
      
      const { stdout } = await execAsync(`uv pip list --python "${venvPython}"`, {
        timeout: 30000,
      });
      
      const lines = stdout.trim().split('\n');
      const platformioLine = lines.find(line => line.toLowerCase().includes('platformio'));
      
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
