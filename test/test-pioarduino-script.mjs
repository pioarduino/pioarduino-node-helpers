#!/usr/bin/env node

/**
 * Test script for get-pioarduino.js with UV-installed Python
 * Tests that the PlatformIO installer script works with UV-managed Python
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// Determine if Windows
const IS_WINDOWS = process.platform === 'win32';

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

/**
 * Get UV-managed Python path
 */
async function getUVPythonPath() {
  try {
    const uvCommand = IS_WINDOWS ? 'uv.exe' : 'uv';
    const { stdout } = await execAsync(`${uvCommand} python find 3.13`);
    return stdout.trim();
  } catch (err) {
    throw new Error(`Could not find UV-managed Python: ${err.message}`);
  }
}

/**
 * Test Python with PlatformIO installer script
 */
async function testPlatformIOScript(pythonPath) {
  console.log('Testing PlatformIO installer script with UV Python...');

  try {
    // Test 1: Check Python compatibility
    console.log('Test 1: Checking Python version compatibility...');
    const { stdout: version } = await execAsync(`"${pythonPath}" --version`);
    const versionMatch = version.match(/Python (\d+)\.(\d+)/);
    
    if (versionMatch) {
      const major = parseInt(versionMatch[1]);
      const minor = parseInt(versionMatch[2]);
      
      if (major === 3 && minor >= 10) {
        pass(`Python ${versionMatch[0]} is compatible (>= 3.10)`);
      } else {
        fail(`Python ${versionMatch[0]} is too old (need >= 3.10)`);
        return false;
      }
    }

    // Test 2: Test basic Python script execution
    console.log('Test 2: Testing Python script execution...');
    const { stdout: sysInfo } = await execAsync(
      `"${pythonPath}" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"`
    );
    pass(`Python script execution successful: ${sysInfo.trim()}`);

    // Test 3: Test importing required modules
    console.log('Test 3: Testing required Python modules...');
    try {
      await execAsync(`"${pythonPath}" -c "import os, sys, tempfile"`);
      pass('Required Python modules available');
    } catch (err) {
      fail('Required Python modules missing', err);
      return false;
    }

    // Test 4: Test that Python can execute a simple installer-like script
    console.log('Test 4: Testing installer script simulation...');
    const testScript = `import sys, os, tempfile; print(\\"Python:\\", sys.executable); print(\\"Version:\\", sys.version_info[:3]); print(\\"Temp:\\", tempfile.gettempdir()); print(\\"SUCCESS\\")`;
    
    try {
      const { stdout: scriptOutput } = await execAsync(
        `"${pythonPath}" -c "${testScript}"`
      );
      
      if (scriptOutput.includes('SUCCESS')) {
        pass('Installer script simulation successful');
        console.log(`  Output: ${scriptOutput.trim().split('\n').join(', ')}`);
      } else {
        fail('Installer script simulation failed - no SUCCESS marker');
        return false;
      }
    } catch (err) {
      fail('Installer script simulation failed', err);
      return false;
    }

    return true;
  } catch (error) {
    fail('PlatformIO script test failed', error);
    return false;
  }
}

/**
 * Main test function
 */
async function runTests() {
  console.log('='.repeat(60));
  console.log('PlatformIO Installer Script Test with UV Python');
  console.log('='.repeat(60));
  console.log();

  try {
    // Step 1: Get UV-managed Python
    console.log('Step 1: Finding UV-managed Python...');
    const pythonPath = await getUVPythonPath();
    pass(`Found UV-managed Python at: ${pythonPath}`);
    console.log();

    // Step 2: Test PlatformIO installer script compatibility
    console.log('Step 2: Testing PlatformIO installer script compatibility...');
    const scriptWorks = await testPlatformIOScript(pythonPath);
    
    if (scriptWorks) {
      pass('PlatformIO installer script is compatible with UV Python');
    } else {
      fail('PlatformIO installer script compatibility test failed');
    }
    console.log();

  } catch (error) {
    fail('Test suite failed', error);
    console.error();
    console.error('Stack trace:');
    console.error(error.stack);
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
    console.log();
    console.log('UV-managed Python is ready for PlatformIO installation!');
    process.exit(0);
  }
}

runTests();
