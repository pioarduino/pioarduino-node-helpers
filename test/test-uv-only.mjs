#!/usr/bin/env node

/**
 * Isolated test for UV installation only
 * Tests UV installation without loading other dependencies
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine if Windows
const IS_WINDOWS = process.platform === 'win32';

/**
 * Get UV executable path
 */
function getUVExecutablePath() {
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  const uvExe = IS_WINDOWS ? 'uv.exe' : 'uv';
  return path.join(homeDir, '.local', 'bin', uvExe);
}

/**
 * Check if UV is available
 */
async function isUVAvailable() {
  // First check if UV is in PATH
  try {
    await execAsync('uv --version');
    console.log('✓ UV is available on system PATH');
    return true;
  } catch {
    // UV not in PATH, check default installation location
    try {
      const uvPath = getUVExecutablePath();
      await execAsync(`"${uvPath}" --version`);
      console.log(`✓ UV found at: ${uvPath}`);
      return true;
    } catch {
      console.log('✗ UV not found on system');
      return false;
    }
  }
}

/**
 * Install UV
 */
async function installUV() {
  console.log('Installing UV package manager...');

  try {
    if (IS_WINDOWS) {
      // Windows: Use PowerShell
      await execAsync(
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"',
        { timeout: 120000 }
      );
    } else {
      // Unix/Linux/macOS: Use shell
      await execAsync('curl -LsSf https://astral.sh/uv/install.sh | sh', {
        timeout: 120000,
      });
    }

    console.log('✓ UV installation completed');
  } catch (err) {
    throw new Error(`Failed to install UV: ${err.message}`);
  }
}

/**
 * Get UV command
 */
async function getUVCommand() {
  try {
    await execAsync('uv --version');
    return 'uv';
  } catch {
    return getUVExecutablePath();
  }
}

/**
 * Install Python via UV
 */
async function installPython() {
  console.log('Installing Python 3.13 via UV...');

  const uvCommand = await getUVCommand();
  console.log(`Using UV command: ${uvCommand}`);

  try {
    // Check if Python is already installed
    try {
      const result = await execAsync(`"${uvCommand}" python find 3.13`);
      const pythonPath = result.stdout.trim();
      if (pythonPath) {
        console.log(`✓ Python 3.13 already available at: ${pythonPath}`);
        return pythonPath;
      }
    } catch {
      console.log('Python 3.13 not found, installing...');
    }

    // Install Python
    await execAsync(`"${uvCommand}" python install 3.13`, {
      timeout: 300000, // 5 minutes
    });

    // Get Python path
    const result = await execAsync(`"${uvCommand}" python find 3.13`);
    const pythonPath = result.stdout.trim();

    if (!pythonPath) {
      throw new Error('UV did not return a Python path');
    }

    console.log(`✓ Python 3.13 installed at: ${pythonPath}`);
    return pythonPath;
  } catch (err) {
    throw new Error(`Python installation failed: ${err.message}`);
  }
}

/**
 * Test Python execution
 */
async function testPython(pythonPath) {
  console.log('Testing Python execution...');

  try {
    // Test version
    const { stdout: version } = await execAsync(`"${pythonPath}" --version`);
    console.log(`✓ Python version: ${version.trim()}`);

    // Test script
    const { stdout: output } = await execAsync(
      `"${pythonPath}" -c "import sys; print(f'Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"`
    );
    console.log(`✓ Python script output: ${output.trim()}`);

    return true;
  } catch (err) {
    console.error(`✗ Python test failed: ${err.message}`);
    return false;
  }
}

/**
 * Main test function
 */
async function runTests() {
  console.log('='.repeat(60));
  console.log('UV and Python Installation Test');
  console.log('='.repeat(60));
  console.log();

  let testsPassed = 0;
  let testsFailed = 0;

  try {
    // Test 1: Check UV availability
    console.log('Test 1: Checking UV availability...');
    let uvAvailable = await isUVAvailable();
    
    if (!uvAvailable) {
      console.log('UV not found, installing...');
      await installUV();
      uvAvailable = await isUVAvailable();
    }

    if (uvAvailable) {
      console.log('✓ UV is available');
      testsPassed++;
    } else {
      console.error('✗ UV installation failed');
      testsFailed++;
      return;
    }
    console.log();

    // Test 2: Install Python
    console.log('Test 2: Installing Python 3.13...');
    const pythonPath = await installPython();
    
    if (pythonPath) {
      console.log('✓ Python installation successful');
      testsPassed++;
    } else {
      console.error('✗ Python installation failed');
      testsFailed++;
      return;
    }
    console.log();

    // Test 3: Test Python
    console.log('Test 3: Testing Python execution...');
    const pythonWorks = await testPython(pythonPath);
    
    if (pythonWorks) {
      console.log('✓ Python execution successful');
      testsPassed++;
    } else {
      console.error('✗ Python execution failed');
      testsFailed++;
    }
    console.log();

  } catch (error) {
    console.error('✗ Test suite failed:', error.message);
    console.error();
    console.error('Stack trace:');
    console.error(error.stack);
    testsFailed++;
  }

  // Summary
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
    process.exit(0);
  }
}

runTests();
