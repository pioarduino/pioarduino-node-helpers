/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import * as core from '../core';

import ProjectConfig from './config';
import ProjectIndexer from './indexer';
import { ProjectTasks } from './tasks';
import { disposeSubscriptions } from '../misc';
import path from 'path';

export default class ProjectObserver {
  static WATCH_DIRS_UPDATE_DELAY = 10000; // 10 seconds

  constructor(projectDir, options) {
    this.projectDir = projectDir;
    this.options = options;

    this.subscriptions = [];
    this.dirWatchSubscriptions = [];

    this._cache = new Map();
    this._config = undefined;
    this._indexer = undefined;
    this._projectTasks = new ProjectTasks(
      this.projectDir,
      this.options.ide,
      this.options.intelliSenseBackend,
    );
    this._updateDirWatchersTimeout = undefined;
    this._selectedEnv = undefined;
    this._apiConfigChangedTimeout = undefined;
    this._rebuildInProgress = false;
    this._libDirs = [];
    this._libDirsSnapshotBeforeRebuild = new Map();
    this._pendingRebuildAfterCurrent = false;

    if (this.getSetting('autoRebuild')) {
      this.setupFSWatchers();
    }
  }

  dispose() {
    disposeSubscriptions(this.dirWatchSubscriptions);
    disposeSubscriptions(this.subscriptions);
    if (this._updateDirWatchersTimeout) {
      clearTimeout(this._updateDirWatchersTimeout);
    }
    if (this._indexer) {
      this._indexer.dispose();
    }
    this.resetCache();
  }

  activate() {
    console.info('Activating project', this.projectDir);
    this.rebuildIndex();
  }

  deactivate() {
    console.info('Deactivating project', this.projectDir);
  }

  getSetting(name) {
    // First check if project-specific settings are provided
    if (this.options.getProjectSettings) {
      const projectSettings = this.options.getProjectSettings(this.projectDir);
      if (projectSettings && name in projectSettings) {
        return projectSettings[name];
      }
    }
    // Fall back to global settings
    return (this.options.settings || {})[name];
  }

  resetCache() {
    this._cache.clear();
  }

  async getConfig() {
    if (!this._config) {
      this._config = new ProjectConfig(this.projectDir);
      await this._config.read();
    }
    return this._config;
  }

  rebuildIndex({ force = false, delayed = false } = {}) {
    if (!force && !this.getSetting('autoRebuild')) {
      return;
    }
    if (!this._indexer) {
      this._indexer = new ProjectIndexer(this.projectDir, this.options, this);
    }
    return delayed ? this._indexer.requestRebuild() : this._indexer.rebuild();
  }

  async switchProjectEnv(name) {
    const validNames = (await this.getConfig()).envs();
    if (!validNames.includes(name)) {
      name = undefined;
    }
    this._selectedEnv = name;
  }

  getSelectedEnv() {
    return this._selectedEnv;
  }

  async revealActiveEnvironment() {
    if (this._selectedEnv) {
      return this._selectedEnv;
    }
    const config = await this.getConfig();
    return config.defaultEnv();
  }

  async getDefaultTasks() {
    return this._projectTasks.getDefaultTasks();
  }

  async getLoadedEnvTasks(name, options = { preload: false }) {
    const cacheKey = `envTasks${name}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }
    const lazyLoading =
      options.preload ||
      this.getSetting('autoPreloadEnvTasks') ||
      this._selectedEnv === name ||
      (await this.getConfig()).envs().length === 1;
    if (!lazyLoading) {
      return undefined;
    }
    return await this.loadEnvTasks(name);
  }

  async loadEnvTasks(name) {
    const cacheKey = `envTasks${name}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }
    this._cache.set(cacheKey, []); // avoid multiple loadings...
    this._cache.set(
      cacheKey,
      await this.options.api.withTasksLoadingProgress(
        async () => await this._projectTasks.fetchEnvTasks(name),
      ),
    );
    return this._cache.get(cacheKey);
  }

  onDidChangeProjectConfig() {
    this._config = undefined;
    // reset to `undefined` if env was removed from conf
    this.resetCache();
    this.requestUpdateDirWatchers();
    if ((this.options.api || {}).onDidChangeProjectConfig) {
      this.options.api.onDidChangeProjectConfig(
        path.join(this.projectDir, 'platformio.ini'),
      );
    }
  }

  onDidChangeLibDirs() {
    // Ignore library directory changes that occur during a rebuild
    // to prevent the rebuild from triggering itself (issue #105)
    // Queue a follow-up rebuild only when tracked library files have changed
    if (this._rebuildInProgress) {
      if (
        !this._pendingRebuildAfterCurrent &&
        this._libDirsChangedSinceBeforeRebuild()
      ) {
        this._pendingRebuildAfterCurrent = true;
      }
      return;
    }
    // Suppress rebuild-originated notifications delivered after rebuild completion
    // if library directory contents have not changed since the post-rebuild snapshot
    if (!this._libDirsChangedSinceBeforeRebuild()) {
      return;
    }
    this._captureLibDirsSnapshot();
    this.rebuildIndex({ delayed: true });
  }

  _triggerPendingRebuild() {
    const libDirsChanged =
      this._pendingRebuildAfterCurrent && this._libDirsChangedSinceBeforeRebuild();
    this._pendingRebuildAfterCurrent = false;
    // Refresh after every rebuild so later watcher notifications for rebuild
    // output are compared against the resulting filesystem state.
    this._captureLibDirsSnapshot();
    if (libDirsChanged) {
      this.rebuildIndex({ delayed: true });
    }
  }

  _captureLibDirsSnapshot() {
    this._libDirsSnapshotBeforeRebuild = this._readLibDirsSnapshot();
  }

  _readLibDirsSnapshot() {
    const fs = require('fs');
    const snapshot = new Map();
    const addFiles = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        return;
      }
      entries.forEach((entry) => {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          addFiles(filePath);
        } else if (entry.isFile()) {
          try {
            const stats = fs.lstatSync(filePath);
            snapshot.set(
              path.resolve(filePath),
              `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`,
            );
          } catch (err) {
            // Ignore files removed while taking the snapshot
          }
        }
        // Do not follow symlinks: dependency links can be rewritten by a
        // rebuild, and following them can traverse outside the watched tree.
      });
    };

    this._libDirs.forEach(addFiles);
    return snapshot;
  }

  _libDirsChangedSinceBeforeRebuild() {
    const before = this._libDirsSnapshotBeforeRebuild;
    const current = this._readLibDirsSnapshot();
    if (current.size !== before.size) {
      return true;
    }
    for (const [filePath, signature] of before) {
      if (current.get(filePath) !== signature) {
        return true;
      }
    }
    return false;
  }

  setupFSWatchers() {
    const watcher = this.options.api.createFileSystemWatcher(
      path.join(this.projectDir, 'platformio.ini'),
    );
    this.subscriptions.push(
      watcher,
      watcher.onDidCreate(() => this.onDidChangeProjectConfig()),
      watcher.onDidChange(() => this.onDidChangeProjectConfig()),
      // watcher.onDidDelete(() => undefined)
    );
    this.requestUpdateDirWatchers();
  }

  requestUpdateDirWatchers() {
    if (this._updateDirWatchersTimeout) {
      clearTimeout(this._updateDirWatchersTimeout);
    }
    this._updateDirWatchersTimeout = setTimeout(
      this.updateDirWatchers.bind(this),
      ProjectObserver.WATCH_DIRS_UPDATE_DELAY,
    );
  }

  async updateDirWatchers() {
    disposeSubscriptions(this.dirWatchSubscriptions);
    try {
      this._libDirs = await this.fetchLibDirs();
      this._captureLibDirsSnapshot();
      this._libDirs.forEach((dir) => {
        const watcher = this.options.api.createDirSystemWatcher(dir);
        this.dirWatchSubscriptions.push(
          watcher,
          watcher.onDidCreate(() => this.onDidChangeLibDirs()),
          watcher.onDidChange(() => this.onDidChangeLibDirs()),
          watcher.onDidDelete(() => this.onDidChangeLibDirs()),
        );
      });
    } catch (err) {
      console.warn(err);
    }
  }

  async fetchLibDirs() {
    const script = `
import json
from platformio.public import get_project_watch_lib_dirs
print(json.dumps(get_project_watch_lib_dirs()))
`;
    const output = await core.getCorePythonCommandOutput(['-c', script], {
      projectDir: this.projectDir,
    });
    return JSON.parse(output.trim());
  }
}
