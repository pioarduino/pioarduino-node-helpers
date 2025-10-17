# Tests for pioarduino-node-helpers

This directory contains tests for the Python installation workflow using UV.

## Test Structure

### Automated Test (`test-uv-only.mjs`)

Isolated test that verifies UV and Python installation without external dependencies:

- Checks UV availability
- Installs UV if not present
- Installs Python 3.13 via UV
- Verifies Python execution
- Platform-independent (Windows/macOS/Linux)

### Manual Test Script (`manual-test.js`)

A simple script for manual testing that:
1. Installs Python 3.13 via UV
2. Verifies Python can be found
3. Tests Python execution with various commands

## Running Tests

### Prerequisites

- Node.js 20 or higher
- Internet connection (for downloading UV and Python)

### Run Automated Tests

```bash
# Run the main test suite
npm test

# Or run directly
node test/test-uv-only.mjs
```

### Run Manual Test

```bash
node test/manual-test.js
```

## Test Assumptions

The tests assume:
- **No Python installed**: Tests simulate a clean environment without Python
- **No UV installed**: Tests will install UV as part of the workflow
- **Internet connection**: Required for downloading UV and Python
- **Sufficient disk space**: ~100MB for UV and Python installation

## Expected Behavior

### First Run
On the first run, the tests will:
1. Install UV to `~/.local/bin/` (or `%USERPROFILE%\.local\bin\` on Windows)
2. Use UV to download and install Python 3.13
3. Verify Python is accessible and functional

This may take 5-10 minutes depending on internet speed.

### Subsequent Runs
On subsequent runs:
- UV is already installed (skips installation)
- Python 3.13 is already available (skips download)
- Tests complete much faster (~10-30 seconds)

## Platform-Specific Notes

### Windows
- UV installs to: `%USERPROFILE%\.local\bin\uv.exe`
- Python path will end with `.exe`
- Paths use backslashes (`\`)

### macOS/Linux
- UV installs to: `~/.local/bin/uv`
- Python path does not have `.exe` extension
- Paths use forward slashes (`/`)

## Troubleshooting

### Test Timeout
If tests timeout, increase the timeout values in the test file:
```javascript
this.timeout(360000); // 6 minutes
```

### UV Installation Fails
- Check internet connection
- Verify firewall/proxy settings
- Try manual UV installation: https://docs.astral.sh/uv/getting-started/installation/

### Python Not Found
- Ensure UV installation completed successfully
- Check UV version: `uv --version`
- Try manual Python installation: `uv python install 3.13`
- Verify Python: `uv python find 3.13`

### Permission Errors
On Unix systems, ensure `~/.local/bin/` is writable:
```bash
mkdir -p ~/.local/bin
chmod 755 ~/.local/bin
```

## Cleanup

To remove installed components:

```bash
# Remove UV
rm -rf ~/.local/bin/uv

# Remove UV-managed Python installations
rm -rf ~/.local/share/uv/python

# On Windows (PowerShell):
# Remove-Item -Recurse -Force "$env:USERPROFILE\.local\bin\uv.exe"
# Remove-Item -Recurse -Force "$env:USERPROFILE\.local\share\uv\python"
```

## CI/CD Integration

For CI/CD pipelines, consider:
- Caching `~/.local/` directory to speed up subsequent runs
- Setting appropriate timeouts (10+ minutes for first run)
- Using matrix testing for multiple platforms (Windows, macOS, Linux)

Example GitHub Actions:
```yaml
- name: Run Python Installation Tests
  run: node --test test/installer/get-python.test.js
  timeout-minutes: 15
  
- name: Cache UV and Python
  uses: actions/cache@v3
  with:
    path: ~/.local
    key: ${{ runner.os }}-uv-python-${{ hashFiles('**/package.json') }}
```
