#!/usr/bin/env node

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('============================================================');
console.log('PlatformIO Installation Test Using Python Installer Script');
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
  }
}

async function main() {
  // Test 1: Clean up existing installation
  await runTest('Test 1: Cleaning up existing installation', async () => {
    try {
      await fs.rm(penvDir, { recursive: true, force: true });
      console.log('  Removed existing penv directory');
    } catch (err) {
      console.log('  No existing penv directory');
    }
  });

  // Test 2: Import the built module
  await runTest('Test 2: Importing built module', async () => {
    const distPath = path.join(__dirname, '..', 'dist', 'index.js');
    await fs.access(distPath);
  });

  // Test 3: Find Python
  let pythonPath;
  await runTest('Test 3: Finding UV-managed Python', async () => {
    // Find UV-managed Python
    const uvPythonDir = path.join(homeDir, '.local', 'share', 'uv', 'python');
    const pythonDirs = await fs.readdir(uvPythonDir);
    const python313Dir = pythonDirs.find(dir => dir.includes('cpython-3.13'));
    
    if (!python313Dir) {
      throw new Error('Python 3.13 not found in UV directory');
    }
    
    pythonPath = path.join(uvPythonDir, python313Dir, 'bin', 'python3.13');
    await fs.access(pythonPath);
    console.log(`\n  Found Python: ${pythonPath}`);
  });

  // Test 4: Get installer script
  let scriptPath;
  await runTest('Test 4: Getting installer script', async () => {
    const { getInstallerScript } = await import('../dist/index.js');
    scriptPath = await getInstallerScript();
    await fs.access(scriptPath);
    console.log(`\n  Installer script: ${scriptPath}`);
  });

  // Test 5: Test installer script with --help
  await runTest('Test 5: Testing installer script', async () => {
    const { stdout } = await execAsync(`"${pythonPath}" "${scriptPath}" --help`);
    if (!stdout.includes('Usage:')) {
      throw new Error('Installer script help output not found');
    }
    console.log('  Installer script is executable');
  });

  // Test 6: Install PlatformIO using the installer script
  await runTest('Test 6: Installing PlatformIO with installer script', async () => {
    console.log('\n  Installing PlatformIO (this may take a few minutes)...');
    const { stdout, stderr } = await execAsync(`"${pythonPath}" "${scriptPath}" install core`, {
      timeout: 600000, // 10 minutes
    });
    console.log('  Installation completed');
    if (stderr && !stderr.includes('Successfully')) {
      console.log('  Stderr:', stderr.substring(0, 200));
    }
  });

  // Test 7: Verify penv directory exists
  await runTest('Test 7: Verifying penv directory', async () => {
    await fs.access(penvDir);
    const binDir = path.join(penvDir, 'bin');
    await fs.access(binDir);
    console.log(`  penv directory exists at: ${penvDir}`);
  });

  // Test 8: Check if UV is installed in penv
  await runTest('Test 8: Checking if UV is installed in penv', async () => {
    const { stdout } = await execAsync(`uv pip list --python ${path.join(penvDir, 'bin', 'python')}`);
    
    if (!stdout.includes('uv ')) {
      throw new Error('UV not found in penv!');
    }
    
    const uvLine = stdout.split('\n').find(line => line.trim().startsWith('uv '));
    console.log(`\n  ${uvLine.trim()}`);
  });

  // Test 9: Verify PlatformIO is installed
  await runTest('Test 9: Verifying PlatformIO installation', async () => {
    const pioExe = path.join(penvDir, 'bin', 'platformio');
    await fs.access(pioExe);
    
    const { stdout } = await execAsync(`"${pioExe}" --version`);
    console.log(`\n  ${stdout.trim()}`);
  });

  console.log('\n============================================================');
  console.log('Test Summary');
  console.log('============================================================');
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log('');

  if (testsFailed === 0) {
    console.log('✓ All tests passed!\n');
    console.log('UV has been successfully installed in penv by the Python installer script!');
    console.log(`Installation location: ${penvDir}\n`);
    process.exit(0);
  } else {
    console.log('✗ Some tests failed!\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
