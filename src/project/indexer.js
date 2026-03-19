/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import { getPIOCommandOutput } from '../core';
import path from 'path';
import { resolveRebuildArgs } from './rebuild-args';
import { terminateCmdsInQueue } from '../proc';

export default class ProjectIndexer {
  static AUTO_REBUILD_DELAY = 3; // 3 seconds
  static FLOOD_TIME_WINDOW = 60 * 10; // 10 minutes
  static FLOOD_MAX_ATTEMPTS = 30;

  constructor(projectDir, options, observer) {
    this.projectDir = projectDir;
    this.options = options;
    this.observer = observer;

    this._rebuildTimeout = undefined;
    this._inProgress = false;
    this._floodStartedAt = Date.now();
    this._floodAttempts = 0;
  }

  dispose() {
    if (this._rebuildTimeout) {
      clearTimeout(this._rebuildTimeout);
    }
  }

  requestRebuild() {
    if (Date.now() - this._floodStartedAt < ProjectIndexer.FLOOD_TIME_WINDOW * 1000) {
      this._floodAttempts++;
    } else {
      this._floodAttempts = 0;
      this._floodStartedAt = Date.now();
    }
    if (this._rebuildTimeout) {
      clearTimeout(this._rebuildTimeout);
      this._rebuildTimeout = undefined;
    }

    if (this._floodAttempts >= ProjectIndexer.FLOOD_MAX_ATTEMPTS) {
      if (
        this._floodAttempts === ProjectIndexer.FLOOD_MAX_ATTEMPTS &&
        this.options.api.onDidNotifyError
      ) {
        const msg =
          `Multiple requests to rebuild the project "${path.basename(
            this.projectDir,
          )}" index have been received!\n` +
          `Automatic index rebuilding process has been terminated for ${
            ProjectIndexer.FLOOD_TIME_WINDOW / 60
          } minutes.`;
        this.options.api.onDidNotifyError(msg, new Error(msg));
      }
      return;
    }

    this._rebuildTimeout = setTimeout(
      this.rebuild.bind(this),
      ProjectIndexer.AUTO_REBUILD_DELAY * 1000,
    );
  }

  rebuild() {
    if (this._inProgress) {
      return;
    }
    return this.options.api.withIndexRebuildingProgress(
      this._rebuildWithProgress.bind(this),
    );
  }

  async _rebuildWithProgress(withProgress = undefined, token = undefined) {
    if (!withProgress) {
      withProgress = () => {};
    }
    this._inProgress = true;
    if (this.options.api.logOutputChannel) {
      this.options.api.logOutputChannel.clear();
    }
    const logMessage = (value, isError = false) => {
      withProgress(value.toString().trim());
      if (this.options.api.logOutputChannel) {
        this.options.api.logOutputChannel.append(value.toString());
        if (isError) {
          this.options.api.logOutputChannel.show();
        }
        if (isError) {
          this.options.api.logOutputChannel.appendLine('');
        }
      }
    };

    try {
      const selectedEnv = this.observer.getSelectedEnv();
      const args = resolveRebuildArgs(
        selectedEnv,
        this.options.ide,
        this.options.intelliSenseBackend,
      );
      await getPIOCommandOutput(args, {
        projectDir: this.projectDir,
        runInQueue: true,
        onProcCreated: (subprocess) => {
          if (token) {
            token.onCancellationRequested(() => {
              logMessage('Configuration process has been terminated!', true);
              terminateCmdsInQueue();
              subprocess.kill();
            });
          }
        },
        onProcStdout: (data) => logMessage(data),
        onProcStderr: (data) => logMessage(data, true),
      });

      // Notify that rebuild is complete (isolated error handling)
      if (this.options.api.onDidRebuildIndex) {
        Promise.resolve()
          .then(() => this.options.api.onDidRebuildIndex(this.projectDir))
          .catch((callbackErr) => {
            const msg = `onDidRebuildIndex callback failed for project ${this.projectDir}:`;
            if (this.options.api.onDidNotifyError) {
              this.options.api.onDidNotifyError(msg, callbackErr);
            } else {
              console.error(msg, callbackErr);
            }
          });
      }
    } catch (err) {
      console.warn(err);
      if (!token || !token.isCancellationRequested) {
        logMessage(err, true);
      }
    } finally {
      this._inProgress = false;
    }
  }
}
