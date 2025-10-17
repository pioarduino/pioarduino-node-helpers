#!/usr/bin/env node

/**
 * Test that actually executes the Python installer script and installs PlatformIO
 * This is a full end-to-end test
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
    console.log('Python Installer Execution Test (Full Installation)');
    console.log('='.repeat(60));
    console.log();

    const coreDir = path.join(os.homedir(), '.platformio');
    const penvDir = path.join(coreDir, 'penv');

    let tmpScript;

    try {
        // Test 1: Extract and prepare Python script
        console.log('Test 1: Extracting Python installer script...');
        try {
            const scriptPath = path.join(__dirname, '..', 'src', 'installer', 'get-pioarduino.js');
            const scriptContent = await fs.readFile(scriptPath, 'utf-8');

            const match = scriptContent.match(/const PYTHON_SCRIPT_CODE = `([\s\S]*?)`;/);
            if (!match) {
                throw new Error('Could not extract Python script');
            }

            const pythonScript = match[1];

            const tmpDir = os.tmpdir();
            tmpScript = path.join(tmpDir, 'pioarduino-installer.py');
            await fs.writeFile(tmpScript, pythonScript);

            pass('Python installer script extracted and written');
        } catch (err) {
            fail('Failed to extract Python script', err);
            return false;
        }
        console.log();

        // Test 2: Find Python
        console.log('Test 2: Finding Python...');
        let python;
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
                throw new Error('UV Python 3.13 not found');
            }
        } catch (err) {
            fail('Failed to find Python', err);
            return false;
        }
        console.log();

        // Test 3: Clean up existing installation
        console.log('Test 3: Cleaning up existing installation...');
        try {
            await fs.rm(penvDir, { recursive: true, force: true });
            pass('Removed existing penv directory');
        } catch {
            pass('No existing penv to remove');
        }
        console.log();

        // Test 4: Run installer with "check core --auto-upgrade"
        console.log('Test 4: Running Python installer (this may take a few minutes)...');
        console.log('  Command: python installer.py check core --auto-upgrade');
        console.log('  This will:');
        console.log('    1. Create a virtual environment at ~/.platformio/penv');
        console.log('    2. Install PlatformIO in that environment');
        console.log();

        try {
            const env = { ...process.env, PLATFORMIO_CORE_DIR: coreDir };
            const startTime = Date.now();

            const { stdout, stderr } = await execAsync(
                `"${python}" "${tmpScript}" check core --auto-upgrade`,
                {
                    env,
                    timeout: 600000, // 10 minutes
                    maxBuffer: 50 * 1024 * 1024,
                }
            );

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            pass(`Python installer completed in ${duration}s`);

            if (stdout) {
                const lines = stdout.trim().split('\n');
                console.log('  Output (last 10 lines):');
                lines.slice(-10).forEach(line => console.log('    ' + line));
            }

            if (stderr && !stderr.includes('WARNING')) {
                console.log('  stderr:', stderr.trim().split('\n').slice(0, 5).join('\n  '));
            }

        } catch (err) {
            fail('Python installer execution failed', err);
            if (err.stdout) {
                console.log('  stdout:', err.stdout.trim().split('\n').slice(-10).join('\n  '));
            }
            if (err.stderr) {
                console.log('  stderr:', err.stderr.trim().split('\n').slice(-10).join('\n  '));
            }
            return false;
        }
        console.log();

        // Test 5: Verify penv directory was created
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
            fail('penv directory verification failed', err);
            return false;
        }
        console.log();

        // Test 6: Verify Python in penv
        console.log('Test 6: Verifying Python in penv...');
        try {
            const binDir = process.platform === 'win32'
                ? path.join(penvDir, 'Scripts')
                : path.join(penvDir, 'bin');

            const pythonExe = process.platform === 'win32'
                ? path.join(binDir, 'python.exe')
                : path.join(binDir, 'python3');

            await fs.access(pythonExe);
            pass('Python executable exists in penv');

            const { stdout: version } = await execAsync(`"${pythonExe}" --version`);
            pass(`Python version: ${version.trim()}`);

        } catch (err) {
            fail('Python verification failed', err);
            return false;
        }
        console.log();

        // Test 7: Verify PlatformIO was installed
        console.log('Test 7: Verifying PlatformIO installation...');
        try {
            const binDir = process.platform === 'win32'
                ? path.join(penvDir, 'Scripts')
                : path.join(penvDir, 'bin');

            // Check for platformio or pio executable
            const pioExe = process.platform === 'win32'
                ? path.join(binDir, 'platformio.exe')
                : path.join(binDir, 'platformio');

            const pioAlias = process.platform === 'win32'
                ? path.join(binDir, 'pio.exe')
                : path.join(binDir, 'pio');

            let found = false;
            try {
                await fs.access(pioExe);
                pass('platformio executable exists');
                found = true;
            } catch {
                try {
                    await fs.access(pioAlias);
                    pass('pio executable exists');
                    found = true;
                } catch {
                    fail('Neither platformio nor pio executable found');
                    return false;
                }
            }

            if (found) {
                // Try to run platformio --version
                const exe = await fs.access(pioExe).then(() => pioExe).catch(() => pioAlias);
                try {
                    const { stdout: pioVersion } = await execAsync(`"${exe}" --version`, {
                        timeout: 30000,
                    });
                    pass(`PlatformIO version: ${pioVersion.trim()}`);
                } catch (err) {
                    console.log('  Note: Could not get PlatformIO version (may need first-time setup)');
                }
            }

        } catch (err) {
            fail('PlatformIO verification failed', err);
            return false;
        }
        console.log();

        // Test 8: List installed packages
        console.log('Test 8: Listing installed packages...');
        try {
            const binDir = process.platform === 'win32'
                ? path.join(penvDir, 'Scripts')
                : path.join(penvDir, 'bin');

            const pythonExe = process.platform === 'win32'
                ? path.join(binDir, 'python.exe')
                : path.join(binDir, 'python3');

            const { stdout } = await execAsync(`"${pythonExe}" -m pip list`, {
                timeout: 30000,
            });

            const lines = stdout.trim().split('\n');
            const platformioLine = lines.find(line => line.toLowerCase().includes('platformio'));

            if (platformioLine) {
                pass('PlatformIO package found in pip list');
                console.log(`  ${platformioLine}`);
            } else {
                console.log('  Note: PlatformIO not found in pip list (may be installed differently)');
            }

        } catch (err) {
            console.log('  Note: Could not list packages:', err.message);
        }
        console.log();

        return true;

    } catch (err) {
        console.error('Unexpected error:', err);
        console.error('Stack:', err.stack);
        return false;
    } finally {
        // Cleanup
        if (tmpScript) {
            try {
                await fs.unlink(tmpScript);
            } catch { }
        }
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
        console.log('PlatformIO has been successfully installed!');
        console.log(`Installation location: ${path.join(os.homedir(), '.platformio', 'penv')}`);
        process.exit(0);
    }
}

main();
