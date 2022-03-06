'use babel';
import { existsSync } from 'fs';
import { exec, execSync } from 'child_process';
import which from 'which';

const NodePathTester = {
  _knownGoodValues: new Map(),

  // Tries to discern the absolute path to the user's `node` binary.
  // TODO: Handle relative paths, not just the bare value `node`.
  resolve (bin) {
    if (bin.startsWith('/') && existsSync(bin) ) {
      return Promise.resolve(bin);
    }
    return which(bin);
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
    if (this._knownGoodValues.has(bin)) {
      return Promise.resolve(this._knownGoodValues.get(bin));
    }
    // Assume it's valid until we know otherwise.
    this.valid = true;
    return new Promise((resolve, reject) => {
      exec(`${bin} --version`, (err, stdout) => {
        if (err) {
          console.log('error!');
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
