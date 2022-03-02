'use babel';

import { CompositeDisposable } from 'atom';
// eslint-disable-next-line import/no-unresolved
import { shell } from 'electron';
import Path from 'path';

import console from './console';
import Config from './config';
import NodePathTester from './node-path-tester';
import JobManager from './job-manager';
import * as helpers from './helpers';

const BUTTON_SETTINGS = {
  text: 'Settings',
  onDidClick () {
    atom.workspace.open(`atom://config/packages/linter-eslint-node`);
  }
};

const EMBEDDED_SCOPE = 'source.js.embedded.html';

const RECENTLY_SAVED = new Set();
function hasRecentlySaved (path) {
  if (RECENTLY_SAVED.has(path)) { return true; }
  RECENTLY_SAVED.add(path);
  setTimeout(() => RECENTLY_SAVED.delete(path), 100);
}

export default {

  shouldAutoFix (textEditor) {
    if (textEditor.isModified()) { return false; }
    if (!Config.get('autofix.fixOnSave')) { return false; }
    if (!helpers.hasValidScope(textEditor, this.scopes)) { return false; }
    return true;
  },

  isLegacyPackagePresent () {
    return ('linter-eslint' in atom.packages.activePackages);
  },

  async activate () {
    Config.initialize();
    this.workerPath = Path.join(__dirname, 'worker.js');
    NodePathTester.test(Config.get('nodeBin'));
    this.jobManager = new JobManager();

    // Keep track of whether the user has seen certain notifications. Absent
    // any user-initiated changes, they should see each of these no more than
    // once per session.
    this.notified = {
      incompatibleVersion: false,
      invalidNodeBin: false
    };

    this.subscriptions = new CompositeDisposable();

    this.scopes = atom.config.get('linter-eslint-node.scopes');

    if (atom.config.get('linter-eslint-node.lintHtmlFiles')) {
      if (!this.scopes.includes(EMBEDDED_SCOPE)) {
        this.scopes.push(EMBEDDED_SCOPE);
      }
    } else {
      if (this.scopes.includes(EMBEDDED_SCOPE)) {
        this.scopes.splice(
          this.scopes.indexOf(EMBEDDED_SCOPE),
          1
        );
      }
    }

    this.subscriptions.add(
      atom.workspace.observeTextEditors(
        textEditor => {
          textEditor.onDidSave(async () => {
            // Guard against multiple fires from the same save event. This can
            // happen when multiple tabs are open to the same file in different
            // panes.
            if (hasRecentlySaved( textEditor.getPath() )) { return; }
            console.warn('onDidSave', textEditor);
            if (this.shouldAutoFix(textEditor)) {
              await this.fixJob(true);
            }
          });
        }
      ),
      // Scan for new .linter-eslint config files when project paths change.
      atom.project.onDidChangePaths(
        projectPaths => {
          this.projectPaths = projectPaths;
          Config.initialize();
        }
      ),
      // React to changes that happen either in a .linter-eslint file or the
      // base package settings.
      Config.onConfigDidChange(
        (config, prevConfig) => {
          console.log('Config.onConfigDidChange', config, prevConfig);
          if (helpers.configShouldInvalidateWorkerCache(config, prevConfig)) {
            this.clearESLintCache();
          }

          if (config.scopes !== prevConfig.scopes) {
            this.scopes.splice(0, this.scopes.length);
            this.scopes.push(...config.scopes);
            if (config.lintHtmlFiles) {
              this.scopes.push(EMBEDDED_SCOPE);
            }
          }

          if (config.lintHtmlFiles !== prevConfig.lintHtmlFiles) {
            if (config.lintHtmlFiles) {
              if (!this.scopes.includes(EMBEDDED_SCOPE)) {
                this.scopes.push(EMBEDDED_SCOPE);
              }
            } else {
              if (this.scopes.includes(EMBEDDED_SCOPE)) {
                this.scopes.splice(this.scopes.indexOf(EMBEDDED_SCOPE), 1);
              }
            }
          }

          if (config.nodeBin !== prevConfig.nodeBin) {
            this.notified.invalidNodeBin = false;
            console.log('Testing bin:', config.nodeBin, this.notified.invalid);
            NodePathTester
              .schedule(config.nodeBin)
              .then((version) => {
                console.log(`Switched Node to version`, version);
                this.jobManager.createWorker();
              })
              .catch(() => {
                this.notifyAboutInvalidNodeBin();
              });
          }
        }
      ),
      atom.commands.add('atom-text-editor', {
        'linter-eslint-node:fix-file': async () => {
          await this.fixJob();
        },
        'linter-eslint-node:debug': async () => {
          await this.debugJob();
        }
      }),

      // Keep track of `.eslintignore` updates.
      atom.project.onDidChangeFiles(events => {
        for (const event of events) {
          // Any creation, deletion, renaming, or modification of an
          // `.eslintignore` file anywhere in this project will affect which
          // files this linter should ignore, and will confuse old instances of
          // `ESLint` inside the worker script because they seem to cache too
          // aggressively. So in these cases we've got to clear our cache and
          // force new `ESLint` instances to be created.
          if (event.path.endsWith('.eslintignore') || event.oldPath && event.oldPath.endsWith('.eslintignore')) {
            this.clearESLintCache();
          }
        }
      })
    );

    if (!atom.inSpecMode()) {
      await require('atom-package-deps').install('linter-eslint-node');
    }
  },

  async deactivate () {
    this.subscriptions.dispose();
    this.jobManager.dispose();
    Config.dispose();
  },

  notifyAboutInvalidNodeBin () {
    if (this.notified.invalidNodeBin) { return; }
    atom.notifications.addError(
      `linter-eslint-node: Invalid Node path`, {
        description: `Couldn’t use the provided path to your <code>node</code> binary. Are you sure it’s correct?`,
        dismissable: true,
        buttons: [
          BUTTON_SETTINGS
        ]
      }
    );
    this.notified.invalidNodeBin = true;
  },

  // We need to tell the worker to clear its cache when
  // - any .eslintignore file is changed;
  // - certain options are changed that must be declared at `ESLint`
  //   instantiation time.
  //
  clearESLintCache () {
    console.warn('Telling the worker to clear its cache!');
    this.jobManager.send({ type: 'clear-cache' });
  },

  // Show a bunch of stuff to the user that can help them figure out why the
  // package isn't behaving the way they think it ought to, or else give them
  // something to copy and paste into a new issue.
  async debugJob () {
    const textEditor = atom.workspace.getActiveTextEditor();
    let filePath = 'unknown', editorScopes = ['unknown'];
    if (atom.workspace.isTextEditor(textEditor)) {
      filePath = textEditor.getPath();
      editorScopes = textEditor.getLastCursor().getScopeDescriptor().getScopesArray();
    }

    const packagePath = atom.packages.resolvePackagePath('linter-eslint-node');
    let packageMeta;

    if (packagePath === undefined) {
      packageMeta = { version: 'unknown' };
    } else {
      packageMeta = require(
        Path.join(packagePath, 'package.json')
      );
    }

    const projectPath = atom.project.relativizePath(filePath)[0];
    const config = Config.get();
    const hoursSinceRestart = Math.round((process.uptime() / 3600) * 10) / 10;

    let debug;

    try {
      let response;
      try {
        response = await this.jobManager.send({
          type: 'debug',
          config,
          filePath,
          projectPath
        });
      } catch (err) {
        if (err.name === 'InvalidWorkerError') {
          // Worker script can't run. Fill in some dummy values here.
          response = {
            eslintPath: '(unknown)',
            eslintVersion: '(unknown)',
            isIncompatible: false,
            isOverlap: false
          };
        } else {
          throw err;
        }
      }

      let nodeBin = Config.get('nodeBin');
      let nodePath = nodeBin;
      let nodeVersion = await NodePathTester.test(nodeBin);
      if (nodeBin === 'node') {
        nodePath = await NodePathTester.resolve(nodeBin);
      }

      debug = {
        atomVersion: atom.getVersion(),
        packageVersion: packageMeta.version,
        packageConfig: config,
        eslintPath: response.eslintPath,
        eslintVersion: response.eslintVersion,
        isIncompatible: response.isIncompatible,
        isOverlap: response.isOverlap && this.isLegacyPackagePresent(),
        hoursSinceRestart,
        platform: process.platform,
        editorScopes,
        nodePath,
        nodeVersion
      };

      if (response.eslintPath) {
        debug.eslintVersion = require(
          Path.join(response.eslintPath, 'package.json')
        ).version;
      }
    } catch (error) {
      atom.notifications.addError(`${error}`, { dismissable: true });
    }

    let whichPackageWillLint;
    if (debug.isIncompatible) {
      whichPackageWillLint = this.isLegacyPackagePresent() ? 'linter-eslint' : '(nothing)';
    } else if (debug.isOverlap) {
      whichPackageWillLint = this.isLegacyPackagePresent() ? 'linter-eslint' : 'linter-eslint-node';
    } else {
      whichPackageWillLint = 'linter-eslint-node';
    }

    let debugMessage = [
      `Atom version: ${debug.atomVersion}`,
      `linter-eslint-node version: ${debug.packageVersion}`,
      `Node path: ${debug.nodePath}`,
      `Node version: ${debug.nodeVersion}`,
      `ESLint version: ${debug.eslintVersion}`,
      `ESLint location: ${debug.eslintPath}`,
      `Linting in this project performed by: ${whichPackageWillLint}`,
      `Hours since last Atom restart: ${debug.hoursSinceRestart}`,
      `Platform: ${debug.platform}`,
      `Current file's scopes: ${JSON.stringify(debug.editorScopes, null, 2)}`,
      `linter-eslint-node configuration: ${JSON.stringify(debug.packageConfig, null, 2)}`
    ];

    atom.notifications.addInfo(
      'linter-eslint-node debug information',
      {
        detail: debugMessage.join('\n'),
        dismissable: true
      }
    );
  },

  // Here we're operating entirely outside the purview of the `linter` package.
  // This method is called either automatically, via `fixOnSave`; or manually,
  // after the user has saved the file themselves.
  //
  // After linting and finding out if anything can be fixed, the worker script
  // will call `ESLint.outputFixes`, which will apply the fixes and modify the
  // file in place. Atom notices the file has changed and updates the buffer
  // contents.
  async fixJob (isSave = false) {
    const textEditor = atom.workspace.getActiveTextEditor();
    if (!textEditor || !atom.workspace.isTextEditor(textEditor)) {
      return;
    }

    if (textEditor.isModified()) {
      atom.notifications.addError(
        `linter-eslint-node: Please save before fixing.`
      );
    }

    const filePath = textEditor.getPath();
    const projectPath = atom.project.relativizePath(filePath)[0];

    const text = textEditor.getText();
    // Don't try to fix an empty file.
    if (text.length === 0) { return; }

    try {
      const response = await this.jobManager.send({
        type: 'fix',
        config: Config.get(),
        contents: text,
        filePath,
        projectPath,
        isModified: false,
        legacyPackagePresent: this.isLegacyPackagePresent()
      });

      let fixes = response.results.length;
      let noun = fixes === 1 ? 'fix' : 'fixes';

      if (!isSave) {
        // TODO: Check the response format.
        atom.notifications.addSuccess(
          fixes > 0 ?
            `Applied ${fixes} ${noun}.` :
            `Nothing to fix.`
        );
      }
    } catch (err) {
      this.handleError(err);
      return;
    }
  },

  handleError (err) {
    console.debug('handleError:', err);
    if (err.name && err.name === 'InvalidWorkerError') {
      // The worker script never got created. Aside from notifying the user
      // (which will be skipped if they've already gotten such a message in
      // this session), we should do nothing here so that an invalid worker
      // behaves as though no linter is present at all.
      this.notifyAboutInvalidNodeBin();
      return;
    }

    if (err.type && err.type === 'config-not-found') {
      if (Config.get('disabling.disableWhenNoEslintConfig')) {
        return;
      }
      atom.notifications.addError(
        `linter-eslint-node: No .eslintrc found`,
        {
          description: err.error,
          dismissable: false
        }
      );
    }

    if (err.type && err.type === 'no-project') {
      // No project means nowhere to look for an `.eslintrc`.
      return;
    }

    if (err.type && err.type === 'version-overlap') {
      // This is an easy one: we don't need to lint this file because
      // `linter-eslint` is present and can handle it. Do nothing.
      return;
    }

    if (err.type && err.type === 'incompatible-version') {
      // This ESLint is too old. If the user also has `linter-eslint`
      // installed, we don't need to say or do anything; we can just silently
      // fail.
      //
      // We should also silently fail if we've shown this message before since
      // this window has been open; no use spamming it on every lint attempt.
      let linterEslintPresent = this.isLegacyPackagePresent();
      let didNotify = this.notified.incompatibleVersion;
      if (linterEslintPresent || didNotify || !Config.get('warnAboutOldEslint')) {
        return;
      } else {
        // eslint-disable-next-line max-len
        let description = `The ESLint module in this project is of version ${err.version}; linter-eslint-node requires a version of 7.0.0 or greater. You can install the legacy \`linter-eslint\` package if you don’t want to upgrade ESLint.\n\nYou can disable this message in package settings.`;
        atom.notifications.addWarning(
          `linter-eslint-node: Incompatible ESLint`,
          {
            description,
            dismissable: true,
            buttons: [
              BUTTON_SETTINGS,
              {
                text: 'Install linter-eslint',
                onDidClick () {
                  shell.openExternal(`https://atom.io/packages/linter-eslint`);
                }
              }
            ]
          }
        );
        this.notified.incompatibleVersion = true;
      }
    } else {
      atom.notifications.addError(
        `linter-eslint-node Error`,
        {
          description: err.error,
          dismissable: true
        }
      );
    }
  },

  provideLinter () {
    console.log('provideLinter nodeBin:', Config.get('nodeBin'));
    return {
      name: 'ESLint (Node)',
      scope: 'file',
      lintsOnChange: true,
      grammarScopes: this.scopes,
      lint: async (textEditor) => {
        console.warn('linting', textEditor);
        if (!atom.workspace.isTextEditor(textEditor)) {
          return null;
        }
        const filePath = textEditor.getPath();
        if (!filePath) {
          // Can't report messages back to Linter without a path.
          return null;
        }

        if (filePath.includes('://')) {
          // We can't lint remote files.
          return helpers.generateUserMessage(textEditor, {
            severity: 'warning',
            excerpt: `Remote file open; linter-eslint is disabled for this file.`
          });
        }

        const projectPath = atom.project.relativizePath(filePath)[0] || '';

        const text = textEditor.getText();
        const textBuffer = textEditor.getBuffer();

        try {
          const response = await this.jobManager.send({
            type: 'lint',
            contents: text,
            config: Config.get(),
            filePath,
            projectPath,
            isModified: textEditor.isModified(),
            legacyPackagePresent: this.isLegacyPackagePresent()
          });

          if (text !== textEditor.getText()) {
            // The editor contents have changed since we requested this lint job.
            // We can't be certain that the linter results aren't stale, so we'll
            // return `null` to signal to Linter that it shouldn't update the
            // saved results.
            return null;
          }

          if (response === null) {
            // An explicit `null` response from the worker means that it has
            // failed to find ESLint in the load path. This will happen if Node,
            // running from the project root, fails to find any version of
            // `eslint` in the load path, whether local or global.
            //
            // TODO: In these cases, a `null` response will produce the same
            // result as if this linter weren't installed at all. If we wanted
            // some of these scenarios to produce notifications to the user (so
            // they could make corrections), we'd have to distinguish those cases
            // somehow.
            return response;
          }

          const { results } = response;
          if (results instanceof Array === false) {
            return results;
          }
          let filteredResults = [];
          let willAutoFix = this.shouldAutoFix(textEditor);
          for (let result of results) {
            if (result.fix) {
              if (willAutoFix) {
                // Ignore this violation altogether; a separate fix-on-save job
                // is about to fix it. Otherwise the panel might appear for just
                // a fraction of a second before disappearing.
                continue;
              }
              result.solutions = helpers.solutionsForFix(result.fix, textBuffer);
            }
            delete result.fix;
            filteredResults.push(result);
          }

          console.log('RETURNED RESULTS:', filteredResults);
          return filteredResults;
        } catch (err) {
          this.handleError(err);
          return [];
        }
      }
    };
  },
};
