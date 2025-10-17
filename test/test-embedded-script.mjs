#!/usr/bin/env node

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('============================================================');
console.log('Testing Embedded Python Installer Script');
console.log('============================================================\n');

const homeDir = process.env.HOME || process.env.USERPROFILE;
const penvDir = path.join(homeDir, '.platformio', 'penv');

let testsPassed = 0;
let testsFailed = 0;

async function runTest(name, fn) {
  try {
    process.stdout.write(`${name}...`);
    await fn();
    console.log(' ✓');
    testsPassed++;
  } catch (err) {
    console.log(' ✗');
    console.error(`  Error: ${err.message}`);
    testsFailed++;
    throw err; // Stop on first error
  }
}

async function main() {
  // Test 1: Clean up
  await runTest('Test 1: Cleaning up', async () => {
    await fs.rm(penvDir, { recursive: true, force: true });
    console.log('  Removed existing penv');
  });

  // Test 2: Extract Python script from get-pioarduino.js
  let scriptContent;
  await runTest('Test 2: Extracting embedded Python script', async () => {
    const getPioPath = path.join(__dirname, '..', 'src', 'installer', 'get-pioarduino.js');
    const content = await fs.readFile(getPioPath, 'utf-8');
    
    // Extract the Python script between the backticks
    const match = content.match(/const PYTHON_SCRIPT_CODE = `\n([\s\S]*?)\n`;/);
    if (!match) {
      throw new Error('Could not find PYTHON_SCRIPT_CODE in get-pioarduino.js');
    }
    
    scriptContent = match[1];
    console.log(`\n  Extracted ${scriptContent.length} characters`);
  });

  // Test 3: Write script to temp file
  let scriptPath;
  await runTest('Test 3: Writing script to temp file', async () => {
    scriptPath = path.join(__dirname, 'temp-get-pioarduino.py');
    await fs.writeFile(scriptPath, scriptContent, 'utf-8');
    console.log(`\n  Written to: ${scriptPath}`);
  });

  // Test 4: Find Python
  let pythonPath;
  await runTest('Test 4: Finding Python', async () => {
    const uvPythonDir = path.join(homeDir, '.local', 'share', 'uv', 'python');
    const pythonDirs = await fs.readdir(uvPythonDir);
    const python313Dir = pythonDirs.find(dir => dir.includes('cpython-3.13'));
    
    if (!python313Dir) {
      throw new Error('Python 3.13 not found');
    }
    
    pythonPath = path.join(uvPythonDir, python313Dir, 'bin', 'python3.13');
    console.log(`\n  Python: ${pythonPath}`);
  });

  // Test 5: Test script with --help
  await runTest('Test 5: Testing script --help', async () => {
    const { stdout } = await execAsync(`"${pythonPath}" "${scriptPath}" --help`);
    if (!stdout.includes('Usage:')) {
      throw new Error('Help output not found');
    }
    console.log('  Script is valid');
  });

  // Test 6: Install PlatformIO
  await runTest('Test 6: Installing PlatformIO', async () => {
    console.log('\n  Running: install core');
    console.log('  This may take several minutes...\n');
    
    const { stdout, stderr } = await execAsync(
      `"${pythonPath}" "${scriptPath}" install core`,
      { 
        timeout: 600000, // 10 minutes
        env: {
          ...process.env,
          PLATFORMIO_CORE_DIR: path.join(homeDir, '.platformio')
        }
      }
    );
    
    console.log('  Installation output:');
    console.log(stdout.split('\n').slice(-10).join('\n'));
    
    if (stderr) {
      console.log('  Stderr:', stderr.substring(0, 200));
    }
  });

  // Test 7: Verify penv exists
  await runTest('Test 7: Verifying penv directory', async () => {
    await fs.access(penvDir);
    const binDir = path.join(penvDir, 'bin');
    await fs.access(binDir);
    console.log(`\n  penv exists at: ${penvDir}`);
  });

  // Test 8: Check if UV is in penv
  await runTest('Test 8: Checking if UV is in penv', async () => {
    const { stdout } = await execAsync(
      `uv pip list --python ${path.join(penvDir, 'bin', 'python')}`
    );
    
    const lines = stdout.split('\n');
    const uvLine = lines.find(line => line.trim().startsWith('uv '));
    
    if (!uvLine) {
      console.log('\n  Installed packages:');
      console.log(stdout);
      throw new Error('UV not found in penv!');
    }
    
    console.log(`\n  ✓ ${uvLine.trim()}`);
  });

  // Test 9: Verify PlatformIO
  await runTest('Test 9: Verifying PlatformIO', async () => {
    const pioExe = path.join(penvDir, 'bin', 'platformio');
    await fs.access(pioExe);
    
    const { stdout } = await execAsync(`"${pioExe}" --version`);
    console.log(`\n  ${stdout.trim()}`);
  });

  // Cleanup
  await runTest('Test 10: Cleanup', async () => {
    await fs.unlink(scriptPath);
    console.log('  Removed temp script');
  });

  console.log('\n============================================================');
  console.log('Test Summary');
  console.log('============================================================');
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log('');

  if (testsFailed === 0) {
    console.log('✓ All tests passed!\n');
    console.log('✓ UV has been successfully installed in penv!');
    console.log(`Installation location: ${penvDir}\n`);
    process.exit(0);
  } else {
    console.log('✗ Some tests failed!\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
