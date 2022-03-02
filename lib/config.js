'use babel';
import { CompositeDisposable, Disposable } from 'atom';
import get from 'lodash.get';

import console from './console';

// Returns config values, but prioritizes anything defined in `.linter-eslint`
// as a per-project override for this linter's settings.
const Config = {
  subscriptions: null,
  initialized: false,
  handlers: [],
  overrides: {},

  initialize () {
    if (this.initialized) { return; }
    this.rescan();
    this.initialized = true;
    console.log('Config initialized. nodeBin:', this.get('nodeBin'));
  },

  rescan () {
    if (this.subscriptions) {
      this.subscriptions.dispose();
    }
    this.subscriptions = new CompositeDisposable();
    this.overrides = {};
    this._currentConfig = null;

    for (let dir of atom.project.getDirectories()) {
      let candidate = dir.getFile('.linter-eslint');
      if (candidate.existsSync()) {
        this.configFile = candidate;
        break;
      }
    }

    if (this.configFile) {
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

  update () {
    if (!this.configFile) {
      this.overrides = {};
      return;
    }
    try {
      this.overrides = JSON.parse(this.configFile.readSync());
    } catch (err) {
      console.error('Linter ESLint v8: Error parsing .linter-eslint file', err);
      this.overrides = {};
    }
    this.triggerConfigChange();
  },

  get (keyName = null) {
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
    for (let handler of this.handlers) {
      handler(newConfig, this._currentConfig || {});
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
  }
};

export default Config;
