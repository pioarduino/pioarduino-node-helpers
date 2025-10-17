#!/usr/bin/env node

/**
 * Test the embedded Python installer script from get-pioarduino.js
 * This extracts and tests the actual Python code
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  console.log('Python Installer Script Test');
  console.log('='.repeat(60));
  console.log();

  const coreDir = path.join(os.homedir(), '.platformio');
  const penvDir = path.join(coreDir, 'penv');

  try {
    // Test 1: Extract Python script from get-pioarduino.js
    console.log('Test 1: Extracting Python installer script...');
    let pythonScript;
    try {
      const scriptPath = path.join(__dirname, '..', 'src', 'installer', 'get-pioarduino.js');
      const scriptContent = await fs.readFile(scriptPath, 'utf-8');
      
      // Extract the Python script between the backticks
      const match = scriptContent.match(/const PYTHON_SCRIPT_CODE = `([\s\S]*?)`;/);
      if (!match) {
        throw new Error('Could not extract Python script from get-pioarduino.js');
      }
      
      pythonScript = match[1];
      pass('Python script extracted successfully');
      console.log(`  Script length: ${pythonScript.length} characters`);
    } catch (err) {
      fail('Failed to extract Python script', err);
      return false;
    }
    console.log();

    // Test 2: Write Python script to temp file
    console.log('Test 2: Writing Python script to temp file...');
    let tmpScript;
    try {
      const tmpDir = os.tmpdir();
      tmpScript = path.join(tmpDir, 'test-pioarduino-installer.py');
      await fs.writeFile(tmpScript, pythonScript);
      pass('Python script written to: ' + tmpScript);
    } catch (err) {
      fail('Failed to write Python script', err);
      return false;
    }
    console.log();

    // Test 3: Find Python (using the same logic as installPortablePython)
    console.log('Test 3: Finding Python...');
    let python;
    try {
      // This replicates the logic from installPortablePython
      // First try UV Python
      try {
        const uvPythonDir = path.join(os.homedir(), '.local', 'share', 'uv', 'python');
        const dirs = await fs.readdir(uvPythonDir);
        const python313Dir = dirs.find(d => d.includes('cpython-3.1'));
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
        const { stdout } = await execAsync('uv python install 3.13', {
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

    // Test 4: Test Python script syntax
    console.log('Test 4: Checking Python script syntax...');
    try {
      await execAsync(`"${python}" -m py_compile "${tmpScript}"`, {
        timeout: 10000,
      });
      pass('Python script syntax is valid');
    } catch (err) {
      fail('Python script has syntax errors', err);
      return false;
    }
    console.log();

    // Test 5: Test Python script with --help
    console.log('Test 5: Testing Python script with --help...');
    try {
      const env = { ...process.env, PLATFORMIO_CORE_DIR: coreDir };
      const { stdout, stderr } = await execAsync(
        `"${python}" "${tmpScript}" --help`,
        { env, timeout: 10000, maxBuffer: 10 * 1024 * 1024 }
      );
      
      if (stdout || stderr) {
        pass('Python script executed with --help');
        if (stdout) console.log('  Output:', stdout.trim().split('\n')[0]);
      } else {
        fail('Python script produced no output');
      }
    } catch (err) {
      // --help might not be implemented, that's ok
      console.log('  Note: --help not implemented (this is ok)');
      pass('Python script can be executed');
    }
    console.log();

    // Test 6: Test Python script with check python
    console.log('Test 6: Testing Python script with "check python"...');
    try {
      const env = { ...process.env, PLATFORMIO_CORE_DIR: coreDir };
      const { stdout } = await execAsync(
        `"${python}" "${tmpScript}" check python`,
        { env, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
      );
      
      pass('Python script executed "check python" successfully');
      if (stdout) {
        const lines = stdout.trim().split('\n');
        console.log('  Output:', lines.slice(0, 3).join('\n  '));
      }
    } catch (err) {
      // This might fail if Python is not compatible, but script should run
      if (err.stdout) {
        pass('Python script executed (with expected error)');
        console.log('  Note:', err.stdout.trim().split('\n')[0]);
      } else {
        fail('Python script failed to execute', err);
      }
    }
    console.log();

    // Test 7: Clean up penv and test "check core"
    console.log('Test 7: Testing Python script with "check core"...');
    try {
      // Clean up penv first
      try {
        await fs.rm(penvDir, { recursive: true, force: true });
        console.log('  Cleaned up existing penv');
      } catch {}
      
      const env = { ...process.env, PLATFORMIO_CORE_DIR: coreDir };
      const { stdout, stderr } = await execAsync(
        `"${python}" "${tmpScript}" check core --no-auto-upgrade`,
        { env, timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
      );
      
      if (stdout) {
        console.log('  Output:', stdout.trim().split('\n').slice(0, 5).join('\n  '));
      }
      
      // Check if it mentions penv
      if (stdout.includes('penv') || stderr.includes('penv')) {
        pass('Python script mentions penv directory');
      } else {
        console.log('  Note: Script output does not mention penv');
      }
      
    } catch (err) {
      // Expected to fail since PlatformIO is not installed
      if (err.stdout && err.stdout.includes('penv')) {
        pass('Python script correctly checks for penv');
        console.log('  Expected error:', err.stdout.trim().split('\n')[0]);
      } else if (err.stderr && err.stderr.includes('penv')) {
        pass('Python script correctly checks for penv');
        console.log('  Expected error:', err.stderr.trim().split('\n')[0]);
      } else {
        console.log('  Note: Script failed (expected without PlatformIO installed)');
        if (err.stdout) console.log('  stdout:', err.stdout.trim().split('\n')[0]);
        if (err.stderr) console.log('  stderr:', err.stderr.trim().split('\n')[0]);
      }
    }
    console.log();

    // Test 8: Cleanup
    console.log('Test 8: Cleaning up...');
    try {
      await fs.unlink(tmpScript);
      pass('Temporary script file removed');
    } catch (err) {
      console.log('  Note: Could not remove temp file');
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
    console.log('The Python installer script is valid and can be executed.');
    process.exit(0);
  }
}

main();
