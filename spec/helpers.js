'use babel';

import * as path from 'path';
import * as fs from 'fs';
import { tmpdir } from 'os';

/**
 * Async helper to copy a file from one place to another on the filesystem.
 * @param  {string} fileToCopyPath  Path of the file to be copied
 * @param  {string} destinationDir  Directory to paste the file into
 * @return {Promise<string>}        path of the file in copy destination
 */
export function copyFileToDir(fileToCopyPath, destinationDir, newFileName = null) {
  return new Promise((resolve, reject) => {
    const destinationPath = path.join(
      destinationDir,
      newFileName || path.basename(fileToCopyPath)
    );
    const rs = fs.createReadStream(fileToCopyPath);
    const ws = fs.createWriteStream(destinationPath);

    ws.on('close', () => resolve(destinationPath));
    ws.on('error', (error) => reject(error));

    rs.pipe(ws);
  });
}

/**
 * Utility helper to copy a file into the OS temp directory.
 *
 * @param  {string} fileToCopyPath  Path of the file to be copied
 * @return {Promise<string>}        path of the file in copy destination
 */
// eslint-disable-next-line import/prefer-default-export
export async function copyFileToTempDir(fileToCopyPath, newFileName = null) {
  const tempFixtureDir = fs.mkdtempSync(tmpdir() + path.sep);
  return copyFileToDir(fileToCopyPath, tempFixtureDir, newFileName);
}

export async function openAndSetProjectDir (fileName, projectDir) {
  let editor = await atom.workspace.open(fileName);
  atom.project.setPaths([projectDir]);
  await race(
    atom.project.getWatcherPromise(projectDir),
    wait(1000)
  );
  return editor;
}

export function getNotification (expectedMessage = null) {
  let promise = new Promise((resolve, reject) => {
    let notificationSub;
    let newNotification = notification => {
      if (expectedMessage && notification.getMessage()) {
        return;
      }
      if (notificationSub !== undefined) {
        notificationSub.dispose();
        resolve(notification);
      } else {
        reject();
      }
    };
    notificationSub = atom.notifications.onDidAddNotification(newNotification);
  });
  return race(promise, wait(3000));
}

// Grab this before it gets wrapped.
const _setTimeout = window.setTimeout;
export function wait (ms) {
  return new Promise((resolve) => {
    _setTimeout(resolve, ms);
  });
}

export function setTimeout (...args) {
  return _setTimeout(...args);
}

export function race (...promises) {
  let count = promises.length;
  let rejectedCount = 0;
  return new Promise((resolve, reject) => {
    for (let promise of promises) {
      // Resolve whenever the first one resolves.
      promise.then(resolve);
      // Reject if they all reject.
      promise.catch(() => {
        rejectedCount++;
        if (rejectedCount === count) { reject(); }
      });
    }
  });
}
