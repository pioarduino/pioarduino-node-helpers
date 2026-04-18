#!/usr/bin/env node

/**
 * Test the uv-based installer flow (replaces old Python installer script test)
 * Tests: uv available, venv creation, PlatformIO installation
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveUV, IS_WINDOWS, UV_EXE, PYTHON_EXE, BIN_DIR } from './uv-helper.mjs';

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
  if (error) console.error(`  Error: ${error.message}`);
  testsFailed++;
}

async function findUv() {
  return resolveUV();
}

async function runTests() {
  console.log('='.repeat(60));
  console.log('UV Installer Flow Test');
  console.log('='.repeat(60));
  console.log();

  const testVenvDir = path.join(os.tmpdir(), `pio-test-venv-${Date.now()}`);
  let uvExe;

  // Test 1: Find uv
  console.log('Test 1: Finding uv executable...');
  try {
    uvExe = await findUv();
    const { stdout } = await execAsync(`"${uvExe}" --version`);
    pass(`uv found: ${stdout.trim()}`);
  } catch (err) {
    fail('uv not found', err);
    return false;
  }
  console.log();

  // Test 2: Find Python 3.13 via uv
  console.log('Test 2: Finding Python 3.13 via uv...');
  let pythonExe;
  try {
    const { stdout } = await execAsync(`"${uvExe}" python find 3.13`, { timeout: 10000 });
    pythonExe = stdout.trim();
    await fs.access(pythonExe);
    pass(`Python 3.13 found: ${pythonExe}`);
  } catch {
    console.log('  Python 3.13 not found, installing via uv...');
    try {
      await execAsync(`"${uvExe}" python install 3.13`, { timeout: 300000 });
      const { stdout } = await execAsync(`"${uvExe}" python find 3.13`, { timeout: 10000 });
      pythonExe = stdout.trim();
      await fs.access(pythonExe);
      pass(`Python 3.13 installed and found: ${pythonExe}`);
    } catch (err) {
      fail('Failed to find/install Python 3.13', err);
      return false;
    }
  }
  console.log();

  // Test 3: Create venv with uv
  console.log('Test 3: Creating virtual environment with uv...');
  try {
    await fs.rm(testVenvDir, { recursive: true, force: true });
    await execFileAsync(
      uvExe,
      ['venv', testVenvDir, '--python', '3.13', '--python-preference', 'managed'],
      { timeout: 120000 },
    );
    const venvPython = path.join(testVenvDir, BIN_DIR, PYTHON_EXE);
    await fs.access(venvPython);
    pass(`Venv created at ${testVenvDir}`);
  } catch (err) {
    fail('Failed to create venv', err);
    await fs.rm(testVenvDir, { recursive: true, force: true }).catch(() => {});
    return false;
  }
  console.log();

  // Test 4: Install uv into venv (mirrors createVenvWithUv production code)
  console.log('Test 4: Installing uv into venv via uv pip install...');
  const venvPython = path.join(testVenvDir, BIN_DIR, PYTHON_EXE);
  const venvUv = path.join(testVenvDir, BIN_DIR, UV_EXE);
  try {
    await execFileAsync(
      uvExe,
      ['pip', 'install', 'uv>=0.1.0', `--python=${venvPython}`],
      { timeout: 120000 },
    );
    await fs.access(venvUv);
    pass(`uv installed into venv: ${venvUv}`);
  } catch (err) {
    fail('Failed to install uv into venv', err);
    await fs.rm(testVenvDir, { recursive: true, force: true }).catch(() => {});
    return false;
  }
  console.log();

  // Test 5: Verify venv Python version
  console.log('Test 5: Verifying venv Python...');
  try {
    const { stdout } = await execAsync(`"${venvPython}" --version`, { timeout: 10000 });
    const version = stdout.trim();
    if (!version.includes('3.13')) {
      throw new Error(`Expected Python 3.13, got: ${version}`);
    }
    pass(`Venv Python version: ${version}`);
  } catch (err) {
    fail('Venv Python verification failed', err);
    await fs.rm(testVenvDir, { recursive: true, force: true }).catch(() => {});
    return false;
  }
  console.log();

  // Test 6: Verify venv Python executes scripts
  console.log('Test 6: Checking venv Python script execution...');
  try {
    await execAsync(`"${venvPython}" -c "import sys; print(sys.version)"`, { timeout: 10000 });
    pass('Venv Python can execute scripts');
  } catch (err) {
    fail('Venv Python script execution failed', err);
  }
  console.log();

  // Test 7: Verify uv in venv works
  console.log('Test 7: Verifying uv in venv works...');
  try {
    const { stdout } = await execAsync(`"${venvUv}" --version`, { timeout: 10000 });
    pass(`Venv uv version: ${stdout.trim()}`);
  } catch (err) {
    fail('Venv uv not functional', err);
  }
  console.log();

  // Test 8: Cleanup
  console.log('Test 8: Cleaning up...');
  try {
    await fs.rm(testVenvDir, { recursive: true, force: true });
    pass('Test venv cleaned up');
  } catch {
    console.log('  Note: Could not remove test venv');
  }
  console.log();

  return true;
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
    console.log('The uv-based installer flow is working correctly.');
    process.exit(0);
  }
}

main();
