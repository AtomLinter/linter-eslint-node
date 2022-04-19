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

// A class that handles creating, maintaining, and communicating with the
// worker that we spawn to perform linting.
class JobManager {
  constructor () {
    this.handlersForJobs = new Map();
    this.worker = null;
    this.workerPath = Path.join(__dirname, 'worker.js');
  }

  dispose () {
    this.killWorker();
    this.worker = null;
    this._workerPromise = null;
    this.handlersForJobs = null;
  }

  // Resolves when the worker is spawned and ready to process messages. Rejects
  // if the worker errors during startup.
  createWorker () {
    // When reloading an existing project with X tabs open, this method will be
    // called X times in a very short span of time. They all need to wait for
    // the _same_ worker to spawn instead of each trying to spawn their own.
    if (this._workerPromise) {
      // The worker is already in the process of being created.
      return this._workerPromise;
    }

    let nodeBin = Config.get('nodeBin');
    console.debug('JobManager creating worker at:', nodeBin);

    // TODO: Figure out if this can even happen anymore.
    if (this.worker) {
      this.killWorker(this.worker);
    }

    // We choose to do a sync test here because this method is much easier to
    // reason about without an `await` keyword introducing side effects.
    //
    // In practice, this will result in only one brief call to `execSync` when
    // a project window is created/reloaded; subsequent calls with the same
    // `nodeBin` argument will reuse the earlier value.
    //
    // When `nodeBin` is changed in the middle of a session, we validate the
    // new value asynchronously _before_ we reach this method, and `testSync`
    // merely looks up the async validation's result.
    let isValid = NodePathTester.testSync(nodeBin);
    if (!isValid) {
      this.worker = false;
      throw new InvalidWorkerError();
    }

    let promise = new Promise((resolve, reject) => {
      this.worker = spawn(nodeBin, [this.workerPath]);

      // Reject this promise if the worker fails to spawn.
      this.worker.on('error', reject);

      this.worker.stdout
        .pipe(ndjson.parse({ strict: false }))
        .on('data', (obj) => {
          // We could listen for the `spawn` event to know when the worker is
          // ready, but that event wasn't added until Node v14.17. Instead,
          // we'll just have the worker emit a `ready` message.
          if (obj.type === 'ready') {
            resolve();
          } else {
            this.receiveMessage(obj);
          }
        });

      // Even unanticipated runtime errors will get sent as newline-delimited
      // JSON.
      this.worker.stderr
        .pipe(ndjson.parse({ strict: false }))
        .on('data', this.receiveError.bind(this));
    });

    let nullWorkerPromise = () => this._workerPromise = null;

    this._workerPromise = promise;
    this._workerPromise
      .then(nullWorkerPromise)
      .catch(nullWorkerPromise);

    return promise;
  }

  async suspend () {
    console.debug('Suspending worker');
    // To prevent async chaos, we should refrain from killing a worker that
    // we're in the process of creating.
    let promise = this._workerPromise || Promise.resolve();
    this._killingWorkerPromise = promise.then(() => {
      let worker = this.worker;
      this.worker = null;
      this.killWorker(worker);
      this._killingWorkerPromise = null;
    });
    return this._killingWorkerPromise;
  }

  killWorker (worker) {
    if (!worker || worker.exitCode) { return; }
    worker.removeAllListeners();
    worker.kill();
  }

  ensureWorker () {
    if (!this.worker || this.worker.exitCode !== null) {
      throw new Error(`linter-eslint-node: Worker is dead`);
    }
  }

  receiveMessage (data) {
    if (data.log) {
      console.debug('WORKER LOG:', data.log);
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
    if (this._killingWorkerPromise) {
      console.debug('Waiting for worker to be killed');
      await this._killingWorkerPromise;
    }
    if (!this.worker) {
      console.debug('Creating worker');
      await this.createWorker();
    }

    let key = generateKey();
    bundle.key = key;
    console.debug('JobManager#send:', bundle);

    return new Promise((resolve, reject) => {
      this.handlersForJobs.set(key, [resolve, reject]);
      let str = JSON.stringify(bundle);
      this.worker.stdin.write(`${str}\n`);
    });
  }
}

export default JobManager;
