'use babel';
import { existsSync } from 'fs';
import { exec, execSync } from 'child_process';
import which from 'which';

const NodePathTester = {
  _timeout: null,
  _bin: null,
  _knownGoodValues: new Map(),

  schedule (bin) {
    // Assume it's valid until we know otherwise.
    this.valid = true;
    if (this._timeout !== null) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }

    // When an Atom window loads, we get the main config first; then any config
    // overrides from project-config or atomic-management a couple seconds
    // later; then any further overrides from `.linter-eslint` files a couple
    // seconds after that.
    //
    // So we wait a few seconds before we try this version of Node, lest we
    // complain about a version that isn't even the correct setting for this
    // project.
    return new Promise((resolve, reject) => {
      this._timeout = setTimeout(() => {
        this.test(bin).then(resolve).catch(reject);
      }, 3000);
    });
  },

  // Tries to discern the absolute path to the user's `node` binary. TODO:
  // Handle relative paths, not just the bare value `node`.
  resolve (bin) {
    if (bin.startsWith('/') && existsSync(bin) ) { return Promise.resolve(bin); }
    return new Promise((resolve, reject) => {
      which(bin, (err, resolvedPath) => {
        if (err) {
          reject(err);
        } else {
          resolve(resolvedPath);
        }
      });
    });
  },

  testSync (bin) {
    if (this._knownGoodValues.has(bin)) {
      return this._knownGoodValues.get(bin);
    }
    try {
      let stdout = execSync(`${bin} --version`);
      return stdout;
    } catch (err) {
      return false;
    }
  },

  test (bin) {
    console.log(`actually testing ${bin}`);
    if (this._knownGoodValues.has(bin)) {
      return Promise.resolve(
        this._knownGoodValues.get(bin)
      );
    }
    return new Promise((resolve, reject) => {
      exec(`${bin} --version`, (err, stdout) => {
        if (err) {
          console.log(`nope`);
          this.valid = false;
          reject(err);
        } else {

          this._knownGoodValues.set(bin, stdout);
          resolve(stdout);
        }
      });
    });
  }
};

export default NodePathTester;
