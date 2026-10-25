#!/usr/bin/env node

/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

// Simple unit tests for project-related functionality
// These tests verify the rebuild-aware event filtering and project-scoped settings

console.log('Running project-related tests...');

// Test 1: ProjectPool setProjectSettingsCallback
console.log('\nTest 1: ProjectPool.setProjectSettingsCallback');
try {
  const pkg = require('../dist/index.js');
  const { ProjectPool } = pkg.project;
  const pool = new ProjectPool();

  let callbackCalled = false;
  const mockCallback = (projectDir) => {
    callbackCalled = true;
    return { autoRebuild: true };
  };

  pool.setProjectSettingsCallback(mockCallback);
  if (typeof pool.options.getProjectSettings === 'function') {
    console.log('✓ setProjectSettingsCallback sets the callback function');
  } else {
    console.log('✗ setProjectSettingsCallback did not set the callback function');
    process.exit(1);
  }

  const result = pool.options.getProjectSettings('/mock/project/dir');
  if (callbackCalled && result.autoRebuild === true) {
    console.log('✓ Callback is called and returns correct settings');
  } else {
    console.log('✗ Callback was not called or returned incorrect settings');
    process.exit(1);
  }
} catch (err) {
  console.log('✗ Test 1 failed:', err.message);
  process.exit(1);
}

// Test 2: ProjectObserver getSetting with project-specific settings
console.log('\nTest 2: ProjectObserver.getSetting with project-specific settings');
try {
  const pkg = require('../dist/index.js');
  const { ProjectObserver } = pkg.project;

  const mockOptions = {
    ide: 'vscode',
    intelliSenseBackend: { id: 'cpptools' },
    settings: { autoRebuild: false },
    getProjectSettings: (projectDir) => {
      if (projectDir === '/specific/project') {
        return { autoRebuild: true };
      }
      return undefined;
    },
    api: {
      createFileSystemWatcher: () => ({ onDidCreate: () => {}, onDidChange: () => {} }),
      createDirSystemWatcher: () => ({ onDidCreate: () => {}, onDidChange: () => {}, onDidDelete: () => {} }),
    },
  };

  const observer = new ProjectObserver('/specific/project', mockOptions);

  // Should return project-specific setting
  const specificSetting = observer.getSetting('autoRebuild');
  if (specificSetting === true) {
    console.log('✓ getSetting returns project-specific setting when available');
  } else {
    console.log('✗ getSetting did not return project-specific setting');
    process.exit(1);
  }

  // Should fall back to global setting
  const observer2 = new ProjectObserver('/other/project', mockOptions);
  const globalSetting = observer2.getSetting('autoRebuild');
  if (globalSetting === false) {
    console.log('✓ getSetting falls back to global setting when project-specific not available');
  } else {
    console.log('✗ getSetting did not fall back to global setting');
    process.exit(1);
  }
} catch (err) {
  console.log('✗ Test 2 failed:', err.message);
  process.exit(1);
}

// Test 3: ProjectObserver rebuild-in-progress flag
console.log('\nTest 3: ProjectObserver rebuild-in-progress flag');
try {
  const pkg = require('../dist/index.js');
  const { ProjectObserver } = pkg.project;

  const mockOptions = {
    ide: 'vscode',
    intelliSenseBackend: { id: 'cpptools' },
    settings: { autoRebuild: false },
    api: {
      createFileSystemWatcher: () => ({ onDidCreate: () => {}, onDidChange: () => {} }),
      createDirSystemWatcher: () => ({ onDidCreate: () => {}, onDidChange: () => {}, onDidDelete: () => {} }),
    },
  };

  const observer = new ProjectObserver('/mock/project', mockOptions);

  if (observer._rebuildInProgress === false) {
    console.log('✓ _rebuildInProgress flag initialized to false');
  } else {
    console.log('✗ _rebuildInProgress flag not initialized correctly');
    process.exit(1);
  }

  // Set the flag to true
  observer._rebuildInProgress = true;
  if (observer._rebuildInProgress === true) {
    console.log('✓ _rebuildInProgress flag can be set to true');
  } else {
    console.log('✗ _rebuildInProgress flag cannot be set to true');
    process.exit(1);
  }
} catch (err) {
  console.log('✗ Test 3 failed:', err.message);
  process.exit(1);
}

// Test 4: ProjectObserver onDidChangeLibDirs queues rebuild during active rebuild
console.log('\nTest 4: ProjectObserver onDidChangeLibDirs queues rebuild during active rebuild');
try {
  const pkg = require('../dist/index.js');
  const { ProjectObserver } = pkg.project;

  const mockOptions = {
    ide: 'vscode',
    intelliSenseBackend: { id: 'cpptools' },
    settings: { autoRebuild: true },
    api: {
      createFileSystemWatcher: () => ({ onDidCreate: () => {}, onDidChange: () => {} }),
      createDirSystemWatcher: () => ({ onDidCreate: () => {}, onDidChange: () => {}, onDidDelete: () => {} }),
    },
  };

  const observer = new ProjectObserver('/mock/project', mockOptions);

  // Set rebuild in progress
  observer._rebuildInProgress = true;
  observer._libDirsChangedSinceBeforeRebuild = () => true;

  // Mock rebuildIndex to track if it's called
  let rebuildCalled = false;
  const originalRebuildIndex = observer.rebuildIndex.bind(observer);
  observer.rebuildIndex = () => {
    rebuildCalled = true;
  };

  // Call onDidChangeLibDirs during rebuild
  observer._processLibDirsChange(observer._libDirsSnapshotBeforeRebuild);

  if (!rebuildCalled) {
    console.log('✓ onDidChangeLibDirs does not trigger immediate rebuild during active rebuild');
  } else {
    console.log('✗ onDidChangeLibDirs triggered immediate rebuild during active rebuild');
    process.exit(1);
  }

  // Check that pending flag is set
  if (observer._pendingRebuildAfterCurrent === true) {
    console.log('✓ onDidChangeLibDirs sets pending rebuild flag during active rebuild');
  } else {
    console.log('✗ onDidChangeLibDirs did not set pending rebuild flag');
    process.exit(1);
  }

  // Reset flag
  observer._rebuildInProgress = false;
  observer._pendingRebuildAfterCurrent = false;
  rebuildCalled = false;

  // Call onDidChangeLibDirs when not in progress
  observer._processLibDirsChange(observer._libDirsSnapshotBeforeRebuild);

  if (rebuildCalled) {
    console.log('✓ onDidChangeLibDirs triggers rebuild when not in progress');
  } else {
    console.log('✗ onDidChangeLibDirs did not trigger rebuild when not in progress');
    process.exit(1);
  }
} catch (err) {
  console.log('✗ Test 4 failed:', err.message);
  process.exit(1);
}

// Test 5: ProjectIndexer sets flag in rebuild() and clears on flood limit
console.log('\nTest 5: ProjectIndexer sets flag in rebuild() and clears on flood limit');
try {
  const pkg = require('../dist/index.js');
  const { ProjectIndexer, ProjectObserver } = pkg.project;

  const mockObserverOptions = {
    ide: 'vscode',
    intelliSenseBackend: { id: 'cpptools' },
    settings: { autoRebuild: false },
    api: {
      createFileSystemWatcher: () => ({ onDidCreate: () => {}, onDidChange: () => {} }),
      createDirSystemWatcher: () => ({ onDidCreate: () => {}, onDidChange: () => {}, onDidDelete: () => {} }),
    },
  };

  const observer = new ProjectObserver('/mock/project', mockObserverOptions);

  const mockIndexerOptions = {
    ide: 'vscode',
    intelliSenseBackend: { id: 'cpptools' },
    api: {
      withIndexRebuildingProgress: async (task) => {
        await task(() => {}, { isCancellationRequested: false });
      },
      logOutputChannel: {
        clear: () => {},
        append: () => {},
        appendLine: () => {},
        show: () => {},
      },
    },
  };

  const indexer = new ProjectIndexer('/mock/project', mockIndexerOptions, observer);

  if (indexer.observer === observer) {
    console.log('✓ ProjectIndexer has observer reference');
  } else {
    console.log('✗ ProjectIndexer does not have observer reference');
    process.exit(1);
  }

  // Verify the file snapshot sees edits in the root and nested directories,
  // while ignoring directory and symlink metadata changes.
  console.log('\nTest 5a: Library file snapshots detect content changes');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pio-observer-'));
  const nestedDir = path.join(snapshotDir, 'nested');
  fs.mkdirSync(nestedDir);
  const rootFile = path.join(snapshotDir, 'root.txt');
  const nestedFile = path.join(nestedDir, 'nested.txt');
  fs.writeFileSync(rootFile, 'before');
  fs.writeFileSync(nestedFile, 'before');
  observer._libDirs = [snapshotDir];
  observer._captureLibDirsSnapshot();
  if (!observer._libDirsChangedSinceBeforeRebuild()) {
    console.log('✓ Unchanged library files match the captured snapshot');
  } else {
    console.log('✗ Unchanged library files differ from the captured snapshot');
    process.exit(1);
  }
  fs.writeFileSync(rootFile, 'root changed');
  if (observer._libDirsChangedSinceBeforeRebuild()) {
    console.log('✓ Edits to existing root files are detected');
  } else {
    console.log('✗ Edits to existing root files were not detected');
    process.exit(1);
  }
  observer._captureLibDirsSnapshot();
  fs.writeFileSync(nestedFile, 'nested changed');
  if (observer._libDirsChangedSinceBeforeRebuild()) {
    console.log('✓ Edits to nested files are detected');
  } else {
    console.log('✗ Edits to nested files were not detected');
    process.exit(1);
  }
  observer._captureLibDirsSnapshot();
  let symlinkCreated = false;
  try {
    fs.symlinkSync(rootFile, path.join(snapshotDir, 'dependency-link'));
    symlinkCreated = true;
  } catch (err) {
    if (
      process.platform === 'win32' &&
      (err.code === 'EPERM' || err.code === 'EACCES')
    ) {
      console.log(
        '↷ Skipping symlink assertion: symlink creation requires elevated privileges on Windows',
      );
    } else {
      throw err;
    }
  }
  if (symlinkCreated) {
    if (!observer._libDirsChangedSinceBeforeRebuild()) {
      console.log('✓ Symlink updates are excluded from the file snapshot');
    } else {
      console.log('✗ Symlink updates changed the file snapshot');
      process.exit(1);
    }
  }
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  observer._libDirs = [];

  // Test that rebuild() does NOT set the flag (flag is set in _rebuildWithProgress)
  observer._rebuildInProgress = false;
  indexer._inProgress = false;
  // Mock withIndexRebuildingProgress to avoid actual rebuild
  const originalWithProgress = mockIndexerOptions.api.withIndexRebuildingProgress;
  mockIndexerOptions.api.withIndexRebuildingProgress = (task) => {
    // Run the task immediately (synchronously) to check the flag
    task(() => {}, { isCancellationRequested: false });
    // Check the flag is set after the task runs
    if (observer._rebuildInProgress === true) {
      console.log('✓ _rebuildWithProgress sets _rebuildInProgress flag');
    } else {
      console.log('✗ _rebuildWithProgress did not set _rebuildInProgress flag');
      process.exit(1);
    }
    return Promise.resolve();
  };
  indexer.rebuild();
  // Restore original
  mockIndexerOptions.api.withIndexRebuildingProgress = originalWithProgress;

  // Test that flood limit clears the flag
  observer._rebuildInProgress = true;
  indexer._floodAttempts = ProjectIndexer.FLOOD_MAX_ATTEMPTS;
  indexer.requestRebuild();
  if (observer._rebuildInProgress === false) {
    console.log('✓ Flood limit clears _rebuildInProgress flag');
  } else {
    console.log('✗ Flood limit did not clear _rebuildInProgress flag');
    process.exit(1);
  }

  // Test that pending rebuild is triggered after rebuild completes
  observer._rebuildInProgress = true;
  observer._pendingRebuildAfterCurrent = true;
  observer._libDirsChangedSinceBeforeRebuild = () => true;
  // Stub rebuildIndex to track if it's called
  let rebuildIndexCalled = false;
  let rebuildIndexOptions;
  const originalRebuildIndex = observer.rebuildIndex.bind(observer);
  observer.rebuildIndex = (options) => {
    rebuildIndexCalled = true;
    rebuildIndexOptions = options;
    if (options && options.delayed === true) {
      console.log('✓ rebuildIndex called with { delayed: true }');
    }
  };
  // Simulate rebuild completion by calling _triggerPendingRebuild
  observer._rebuildInProgress = false;
  observer._triggerPendingRebuild();
  if (rebuildIndexCalled && rebuildIndexOptions && rebuildIndexOptions.delayed === true) {
    console.log('✓ Pending rebuild triggers rebuildIndex with { delayed: true }');
  } else {
    console.log('✗ Pending rebuild did not trigger rebuildIndex with { delayed: true }');
    process.exit(1);
  }
  if (observer._pendingRebuildAfterCurrent === false) {
    console.log('✓ Pending rebuild flag is cleared');
  } else {
    console.log('✗ Pending rebuild flag was not cleared');
    process.exit(1);
  }

  // Test that rebuild-originated events do NOT queue follow-up rebuild
  console.log('\nTest 5b: Rebuild-originated events do not queue follow-up rebuild');
  try {
    observer._rebuildInProgress = true;
    observer._pendingRebuildAfterCurrent = false;
    observer._libDirsChangedSinceBeforeRebuild = () => false;
    observer._processLibDirsChange(observer._libDirsSnapshotBeforeRebuild);
    if (observer._pendingRebuildAfterCurrent === true) {
      console.log('✗ Rebuild-originated event queued pending rebuild');
      process.exit(1);
    }
    console.log('✓ Rebuild-originated event does not queue pending rebuild when files are unchanged');
  } catch (err) {
    console.log('✗ Test 5b failed:', err.message);
    process.exit(1);
  }

  // Test that user-originated events DO queue follow-up rebuild
  console.log('\nTest 5c: User-originated events queue follow-up rebuild');
  try {
    observer._rebuildInProgress = true;
    observer._pendingRebuildAfterCurrent = false;
    observer._libDirsChangedSinceBeforeRebuild = () => true;
    observer._processLibDirsChange(observer._libDirsSnapshotBeforeRebuild);
    if (observer._pendingRebuildAfterCurrent === true) {
      console.log('✓ User-originated event queues pending rebuild');
    } else {
      console.log('✗ User-originated event did not queue pending rebuild');
      process.exit(1);
    }
  } catch (err) {
    console.log('✗ Test 5c failed:', err.message);
    process.exit(1);
  }

  // Test that rebuild-originated events delivered after rebuild do NOT trigger rebuild
  console.log('\nTest 5d: Rebuild-originated events delivered after rebuild do not trigger rebuild');
  try {
    observer._rebuildInProgress = false;
    observer._pendingRebuildAfterCurrent = false;
    observer._libDirsChangedSinceBeforeRebuild = () => false;
    let postRebuildCalled = false;
    observer.rebuildIndex = () => {
      postRebuildCalled = true;
    };
    observer._processLibDirsChange(observer._libDirsSnapshotBeforeRebuild);
    if (!postRebuildCalled) {
      console.log('✓ Rebuild-originated event delivered after rebuild does not trigger rebuild');
    } else {
      console.log('✗ Rebuild-originated event delivered after rebuild triggered rebuild');
      process.exit(1);
    }
  } catch (err) {
    console.log('✗ Test 5d failed:', err.message);
    process.exit(1);
  }

  // Test that user-originated events delivered after rebuild DO trigger rebuild
  console.log('\nTest 5e: User-originated events delivered after rebuild trigger rebuild');
  try {
    observer._rebuildInProgress = false;
    observer._pendingRebuildAfterCurrent = false;
    observer._libDirsChangedSinceBeforeRebuild = () => true;
    let userEventRebuildCalled = false;
    observer.rebuildIndex = () => {
      userEventRebuildCalled = true;
    };
    observer._processLibDirsChange(observer._libDirsSnapshotBeforeRebuild);
    if (userEventRebuildCalled) {
      console.log('✓ User-originated event delivered after rebuild triggers rebuild');
    } else {
      console.log('✗ User-originated event delivered after rebuild did not trigger rebuild');
      process.exit(1);
    }
  } catch (err) {
    console.log('✗ Test 5e failed:', err.message);
    process.exit(1);
  }
} catch (err) {
  console.log('✗ Test 5 failed:', err.message);
  process.exit(1);
}

// Test 6: setProjectSettingsCallback reconciles watcher state
console.log('\nTest 6: setProjectSettingsCallback reconciles watcher state');
try {
  const pkg = require('../dist/index.js');
  const { ProjectPool, ProjectObserver } = pkg.project;

  const mockOptions = {
    ide: 'vscode',
    intelliSenseBackend: { id: 'cpptools' },
    settings: { autoRebuild: false },
    api: {
      createFileSystemWatcher: () => ({ onDidCreate: () => {}, onDidChange: () => {} }),
      createDirSystemWatcher: () => ({ onDidCreate: () => {}, onDidChange: () => {}, onDidDelete: () => {} }),
    },
  };

  const pool = new ProjectPool(mockOptions);
  const observer1 = pool.getObserver('/project1');
  const observer2 = pool.getObserver('/project2');

  // Initially, autoRebuild is false, so no subscriptions should be set up
  if (observer1.subscriptions.length === 0) {
    console.log('✓ Observer 1 has no subscriptions initially');
  } else {
    console.log('✗ Observer 1 has subscriptions initially');
    process.exit(1);
  }

  // Set callback that enables autoRebuild for project1
  pool.setProjectSettingsCallback((projectDir) => {
    if (projectDir === '/project1') {
      return { autoRebuild: true };
    }
    return { autoRebuild: false };
  });

  // Observer 1 should now have subscriptions (setupFSWatchers called)
  if (observer1.subscriptions.length > 0) {
    console.log('✓ Observer 1 now has subscriptions after callback enables autoRebuild');
  } else {
    console.log('✗ Observer 1 does not have subscriptions after callback enables autoRebuild');
    process.exit(1);
  }

  // Observer 2 should still have no subscriptions
  if (observer2.subscriptions.length === 0) {
    console.log('✓ Observer 2 still has no subscriptions');
  } else {
    console.log('✗ Observer 2 has subscriptions');
    process.exit(1);
  }
} catch (err) {
  console.log('✗ Test 6 failed:', err.message);
  process.exit(1);
}

console.log('\n============================================================');
const { ProjectObserver } = require('../dist/index.js').project;
const debounceObserver = new ProjectObserver('/mock/project', {
  ide: 'vscode',
  intelliSenseBackend: { id: 'cpptools' },
  settings: { autoRebuild: false },
  api: {},
});
const fs = require('fs');
const os = require('os');
const path = require('path');
const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pio-observer-debounce-'));
const rebuiltFile = path.join(snapshotDir, 'rebuilt.txt');
fs.writeFileSync(rebuiltFile, 'before rebuild');
debounceObserver._libDirs = [snapshotDir];
debounceObserver._captureLibDirsSnapshot();
let snapshotReadCount = 0;
const readSnapshot = debounceObserver._readLibDirsSnapshot.bind(debounceObserver);
debounceObserver._readLibDirsSnapshot = () => {
  snapshotReadCount++;
  return readSnapshot();
};
let debounceRebuildCalled = false;
debounceObserver.rebuildIndex = () => {
  debounceRebuildCalled = true;
};
// Ensure rapid watcher notifications share a single snapshot comparison.
debounceObserver._rebuildInProgress = true;
debounceObserver.onDidChangeLibDirs();
debounceObserver.onDidChangeLibDirs();
fs.writeFileSync(rebuiltFile, 'rebuild output');
debounceObserver._rebuildInProgress = false;
debounceObserver._triggerPendingRebuild();
snapshotReadCount = 0;
setTimeout(() => {
  if (snapshotReadCount === 1 && !debounceRebuildCalled) {
    console.log(
      '✓ Rebuild notifications are coalesced and suppressed against the post-rebuild snapshot',
    );
    console.log('All project-related tests passed!');
  } else {
    console.log(`✗ Watcher event burst caused ${snapshotReadCount} snapshot reads`);
    process.exit(1);
  }
  debounceObserver.dispose();
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  console.log('============================================================');
}, ProjectObserver.LIB_DIRS_CHANGE_DELAY + 10);
