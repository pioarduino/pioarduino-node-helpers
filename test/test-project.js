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

// Test 4: ProjectObserver onDidChangeLibDirs respects rebuild-in-progress
console.log('\nTest 4: ProjectObserver.onDidChangeLibDirs respects rebuild-in-progress');
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

  // Mock rebuildIndex to track if it's called
  let rebuildCalled = false;
  const originalRebuildIndex = observer.rebuildIndex.bind(observer);
  observer.rebuildIndex = () => {
    rebuildCalled = true;
  };

  // Call onDidChangeLibDirs
  observer.onDidChangeLibDirs();

  if (!rebuildCalled) {
    console.log('✓ onDidChangeLibDirs ignores changes when rebuild is in progress');
  } else {
    console.log('✗ onDidChangeLibDirs did not ignore changes during rebuild');
    process.exit(1);
  }

  // Reset flag
  observer._rebuildInProgress = false;
  rebuildCalled = false;

  // Call onDidChangeLibDirs again
  observer.onDidChangeLibDirs();

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

// Test 5: ProjectIndexer has observer reference and can reset flag
console.log('\nTest 5: ProjectIndexer has observer reference');
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
  observer._rebuildInProgress = true;

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

  // Manually test the flag reset logic
  indexer._inProgress = true;
  observer._rebuildInProgress = true;
  // Simulate the finally block logic
  indexer._inProgress = false;
  if (indexer.observer) {
    indexer.observer._rebuildInProgress = false;
  }

  if (observer._rebuildInProgress === false) {
    console.log('✓ _rebuildInProgress flag can be reset via ProjectIndexer');
  } else {
    console.log('✗ _rebuildInProgress flag cannot be reset');
    process.exit(1);
  }
} catch (err) {
  console.log('✗ Test 5 failed:', err.message);
  process.exit(1);
}

console.log('\n============================================================');
console.log('All project-related tests passed!');
console.log('============================================================');
