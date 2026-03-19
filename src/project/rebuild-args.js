/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

/**
 * Resolves rebuild arguments based on the IntelliSense backend configuration.
 * Centralizes the logic for generating rebuild command arguments.
 *
 * @param {string|undefined} selectedEnv - The selected environment name
 * @param {string} ide - The IDE identifier (e.g., 'vscode')
 * @param {object|undefined} backend - The IntelliSense backend object with rebuildArgs method
 * @returns {string[]} Array of command arguments for rebuilding the index
 */
export function resolveRebuildArgs(selectedEnv, ide, backend) {
  // If backend exists and has a valid rebuildArgs function, use it
  if (backend && typeof backend.rebuildArgs === 'function') {
    return backend.rebuildArgs(selectedEnv);
  }

  // Fallback to default behavior
  const args = ['project', 'init', '--ide', ide];
  if (selectedEnv) {
    args.push('--environment', selectedEnv);
  }
  return args;
}
