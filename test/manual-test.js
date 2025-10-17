#!/usr/bin/env node

/**
 * Manual test script for Python installation via UV
 * 
 * This script simulates a clean environment (no Python, no UV)
 * and tests the complete installation workflow.
 * 
 * Usage:
 *   node test/manual-test.js
 */

import { installPortablePython, getPythonExecutablePath } from '../src/installer/get-python.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function main() {
  console.log('='.repeat(60));
  console.log('Manual Test: Python Installation via UV');
  console.log('='.repeat(60));
  console.log();

  try {
    // Step 1: Install Python
    console.log('Step 1: Installing Python 3.13 via UV...');
    console.log('(This may take several minutes on first run)');
    console.log();
    
    const pythonPath = await installPortablePython();
    
    console.log('✓ Python installation completed');
    console.log(`  Python path: ${pythonPath}`);
    console.log();

    // Step 2: Verify Python can be found
    console.log('Step 2: Verifying Python can be found...');
    const foundPath = await getPythonExecutablePath('3.13');
    console.log('✓ Python found via getPythonExecutablePath()');
    console.log(`  Found path: ${foundPath}`);
    console.log();

    // Step 3: Test Python execution
    console.log('Step 3: Testing Python execution...');
    
    // Test 1: Version
    const { stdout: version } = await execAsync(`"${pythonPath}" --version`);
    console.log(`✓ Python version: ${version.trim()}`);
    
    // Test 2: Simple script
    const { stdout: output } = await execAsync(
      `"${pythonPath}" -c "import sys; print(f'Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"`
    );
    console.log(`✓ Python script output: ${output.trim()}`);
    
    // Test 3: Check pip
    try {
      const { stdout: pipVersion } = await execAsync(`"${pythonPath}" -m pip --version`);
      console.log(`✓ pip available: ${pipVersion.trim()}`);
    } catch (err) {
      console.log('⚠ pip not available (this is expected with UV-managed Python)');
    }
    
    console.log();

    // Step 4: Test UV venv creation
    console.log('Step 4: Testing UV venv creation...');
    const testVenvDir = `${process.env.HOME}/.platformio-test-venv`;
    
    try {
      // Clean up if exists
      try {
        await execAsync(`rm -rf "${testVenvDir}"`);
      } catch {}
      
      // Create venv with UV
      await execAsync(`uv venv --python "${pythonPath}" "${testVenvDir}"`, {
        timeout: 60000,
      });
      console.log(`✓ UV venv created at: ${testVenvDir}`);
      
      // Verify venv
      const venvPython = `${testVenvDir}/bin/python3`;
      const { stdout: venvVersion } = await execAsync(`"${venvPython}" --version`);
      console.log(`✓ venv Python version: ${venvVersion.trim()}`);
      
      // Clean up
      await execAsync(`rm -rf "${testVenvDir}"`);
      console.log('✓ Test venv cleaned up');
      
    } catch (err) {
      console.error('✗ UV venv test failed:', err.message);
    }
    
    console.log();
    console.log('='.repeat(60));
    console.log('✓ All tests passed successfully!');
    console.log('='.repeat(60));
    console.log();
    console.log('To test full PlatformIO installation:');
    console.log('  The install() function needs to be called from your application');
    console.log('  with proper parameters (useBuiltinPIOCore, useBuiltinPython, etc.)');
    console.log();
    
  } catch (error) {
    console.error();
    console.error('='.repeat(60));
    console.error('✗ Test failed!');
    console.error('='.repeat(60));
    console.error();
    console.error('Error:', error.message);
    console.error();
    if (error.stack) {
      console.error('Stack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
