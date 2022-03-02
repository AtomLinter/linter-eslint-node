'use babel';

import Path from 'path';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';

import NodePathTester from './node-path-tester';
import console from './console';
import Config from './config';
import ndjson from 'ndjson';

function generateKey () {
  return randomBytes(5).toString('hex');
}

class WorkerUnknownError extends Error {
  constructor (err) {
    super(`Unknown worker error`);
    this.name = 'WorkerUnknownError';
    this.error = err;
  }
}

class InvalidWorkerError extends Error {
  constructor () {
    super(`Worker was never created because of invalid nodeBin setting`);
    this.name = 'InvalidWorkerError';
  }
}

class JobManager {
  constructor () {
    this.handlersForJobs = new Map();
    this.worker = null;
    this.workerPath = Path.join(__dirname, 'worker.js');

    this.createWorker();
  }

  dispose () {
    this.killWorker();
  }

  createWorker () {
    console.log('JobManager creating worker at:', nodeBin, this.workerPath);
    let nodeBin = Config.get('nodeBin');
    this.killWorker();

    // We should not try to start the worker without testing the value we have
    // for `nodeBin`.
    //
    // When the setting is changed after initialization, we test it
    // asynchronously before calling `createWorker` again. In those cases,
    // `testSync` just looks up the result of that test so we don't duplicate
    // effort.
    //
    // But on startup, we don't want to defer creation of this worker while we
    // perform an async test of `nodeBin`. So in that one scenario, `testSync`
    // will do an `execSync` on this value to perform a sanity check. Like the
    // async version, we remember this result, so further calls to `testSync`
    // with the same value won't block while we run a shell command.
    //
    // TODO: See if there's a way to use the async test logic on startup
    // without putting us in async/promise hell.
    if (!NodePathTester.testSync(nodeBin)) {
      console.error('Invalid nodeBin!');
      this.worker = false;
      return false;
    }

    this.worker = spawn(nodeBin, [this.workerPath]);

    this.worker.stdout
      .pipe(ndjson.parse())
      .on('data', this.receiveMessage.bind(this));

    // Even unanticipated runtime errors will get sent as newline-delimited
    // JSON.
    this.worker.stderr
      .pipe(ndjson.parse())
      .on('data', this.receiveError.bind(this));

    this.worker.on('close', () => {
      if (this.worker.killed === false) {
        this.createWorker();
      }
    });

    console.log('Created worker:', this.worker);
  }

  killWorker () {
    if (!this.worker || this.worker.exitCode) { return; }
    this.worker.removeAllListeners();
    this.worker.kill();
  }

  ensureWorker () {
    if (!this.worker || this.worker.exitCode !== null) {
      throw new Error(`linter-eslint-node: Worker is dead`);
    }
  }

  receiveMessage (data) {
    if (data.log) {
      console.log('WORKER LOG:', data.log);
      return;
    }
    let key = data.key;
    if (!key) {
      throw new Error(`Received message from worker without key`);
    }
    let [resolve, reject] = this.handlersForJobs.get(key);
    this.handlersForJobs.delete(key);
    if (data.error) {
      return reject(data);
    } else {
      return resolve(data);
    }
  }

  // The worker only writes to stderr when something exceptional happens that
  // the worker didn't anticipate to check for. So there's no guarantee that
  // there will be an associated job key. For the ones that have no key, we
  // just throw an error and let it get handled elsewhere.
  receiveError (data) {
    if (typeof data === 'object' && data.key) {
      if (!this.handlersForJobs.has(data.key)) {
        // Assume this has already been handled and silently fail.
        return;
      }
      let [, reject] = this.handlersForJobs.get(data.key);
      this.handlersForJobs.delete(data.key);
      reject(data);
    } else {
      throw new WorkerUnknownError(data);
    }
  }

  async send (bundle) {
    let key = generateKey();
    bundle.key = key;
    console.log('JobManager#send:', bundle);
    try {
      this.ensureWorker();
    } catch (err) {
      if (this.worker === false) {
        // `false` means we intentionally refused to create a worker because
        // `nodeBin` was invalid.
        throw new InvalidWorkerError();
      } else {
        throw err;
      }
    }

    return new Promise((resolve, reject) => {
      this.handlersForJobs.set(key, [resolve, reject]);
      let str = JSON.stringify(bundle);
      this.worker.stdin.write(`${str}\n`);
    });
  }
}

export default JobManager;
