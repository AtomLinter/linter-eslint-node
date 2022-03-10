'use babel';
import { CompositeDisposable, Disposable } from 'atom';
import get from 'lodash.get';

import console from './console';

function configChanged (config, prevConfig) {
  return JSON.stringify(config) !== JSON.stringify(prevConfig);
}

// Returns config values, but prioritizes anything defined in `.linter-eslint`
// as a per-project override for this linter's settings.
const Config = {
  subscriptions: null,
  initialized: false,
  handlers: [],
  overrides: {},

  initialize () {
    if (this.initialized) { return; }
    this._currentConfig = null;
    this.rescan();
    this.initialized = true;
  },

  // Search again for the presence of a .linter-eslint in the project root.
  rescan () {
    if (this.subscriptions) {
      this.subscriptions.dispose();
    }
    this.subscriptions = new CompositeDisposable();
    this.overrides = {};
    this.configFile = null;

    for (let dir of atom.project.getDirectories()) {
      let candidate = dir.getFile('.linter-eslint');
      if (candidate.existsSync()) {
        this.configFile = candidate;
        break;
      }
    }

    if (this.configFile) {
      // Changes to config file contents are caught by this subscription. File
      // deletion, file creation, or file renaming that involves
      // `.linter-eslint` is caught by the main module. We might decide to make
      // Config in charge of both in the future.
      this.subscriptions.add(
        this.configFile.onDidChange(this.update.bind(this))
      );
      this.update();
    }
    this.subscriptions.add(
      atom.config.observe(
        'linter-eslint-node',
        this.triggerConfigChange.bind(this)
      )
    );
  },

  // Re-read from .linter-eslint when it updates.
  update () {
    if (!this.configFile) {
      this.overrides = {};
      return;
    }
    try {
      this.overrides = JSON.parse(this.configFile.readSync());
    } catch (err) {
      console.error('Error parsing .linter-eslint file', err);
      this.overrides = {};
    }
    this.triggerConfigChange();
  },

  get (keyName = null) {
    // TODO: Once we're certain that no config changes will go unnoticed by us,
    // we could just reuse this._currentConfig instead of building a new object
    // every time.
    let config = Object.assign(
      {},
      atom.config.get('linter-eslint-node'),
      this.overrides
    );
    if (!keyName) { return config; }
    return get(config, keyName);
  },

  triggerConfigChange () {
    let newConfig = this.get();
    if (!configChanged(newConfig, this._currentConfig)) { return; }
    if (this._currentConfig) {
      for (let handler of this.handlers) {
        handler(newConfig, this._currentConfig);
      }
    }
    this._currentConfig = newConfig;
  },

  onConfigDidChange (handler) {
    this.handlers.push(handler);
    return new Disposable(() => {
      let indexToRemove = this.handlers.indexOf(handler);
      this.handlers.splice(indexToRemove, 1);
    });
  },

  dispose () {
    this.subscriptions.dispose();
    this.initialized = false;
  }
};

export default Config;
