# Tests for pioarduino-node-helpers

This directory contains integration tests for the Python/UV installation workflow.

## Test Overview

| Script | `npm run` | What it tests |
|--------|-----------|---------------|
| `test-uv-only.mjs` | `test:uv` | Full UV lifecycle: bootstrap → venv → uv in penv → cleanup |
| `test-get-python.mjs` | `test:get-python` | All public functions of `src/installer/get-python.js` |
| `test-installer-script.mjs` | `test:installer` | Installer stage pipeline |
| `test-full-installation.mjs` | `test:full` | End-to-end install via built `dist/index.js` |
| `test-uv-platformio-install.mjs` | `test:install` | PlatformIO Core install via uv |
| `manual-test.js` | `test:manual` | Quick manual smoke test |

### `test-get-python.mjs` — what is covered

1. **`getUvExecutable`** — UV found in PATH / penv / cache, or downloaded as fallback
2. **`createVenvWithUv`** — venv created with Python 3.13; uv installed in venv; pip installed (compat); pip ≥ 24.3; pip importable
3. **`moveUvToPenv`** — bootstrap UV removable from cache
4. **`findPythonExecutable`** — PATH search for system Python 3.13
5. **`getPythonExecutablePath`** — penv Python accessible, correct version, mismatch detection
6. **`installPortablePython`** — real penv state verified (Python + uv + pip ≥ 24.3)

## Running Tests

### Prerequisites

- Node.js ≥ 25
- Internet connection (for downloading UV and Python on first run)

### Run All Tests

```bash
npm test
```

### Run Individual Tests

```bash
npm run test:uv
npm run test:get-python
npm run test:installer
npm run test:full
npm run test:install
```

### Run Manual Test

```bash
npm run test:manual
```

## Expected Behaviour

### First Run
UV and Python 3.13 are downloaded and installed automatically.  
This may take several minutes depending on internet speed.

UV is installed to:
- Bootstrap (temporary): `~/.platformio/.cache/uv`
- Permanent: `~/.platformio/penv/bin/uv`

Python 3.13 venv lives at: `~/.platformio/penv/`

### Subsequent Runs
UV and Python are already present — tests complete in seconds.

## Platform Notes

| | Windows | macOS / Linux |
|---|---------|---------------|
| UV binary | `uv.exe` | `uv` |
| Venv bin dir | `Scripts\` | `bin/` |
| Python binary | `python.exe` | `python3` |

## Troubleshooting

### UV Download Fails
- Check internet connection and proxy/firewall settings
- Manual install: https://docs.astral.sh/uv/getting-started/installation/

### Python Not Found After Install
```bash
uv --version
uv python install 3.13
uv python find 3.13
```

### Permission Errors (macOS/Linux)
```bash
chmod 755 ~/.platformio/penv/bin
```

## Cleanup

```bash
# Remove the entire pioarduino environment
rm -rf ~/.platformio/penv
rm -rf ~/.platformio/.cache

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\.platformio\penv"
Remove-Item -Recurse -Force "$env:USERPROFILE\.platformio\.cache"
```

## CI/CD Integration

```yaml
- name: Run Tests
  run: npm test
  timeout-minutes: 20

- name: Cache pioarduino environment
  uses: actions/cache@v4
  with:
    path: ~/.platformio
    key: ${{ runner.os }}-platformio-${{ hashFiles('**/package.json') }}
```
