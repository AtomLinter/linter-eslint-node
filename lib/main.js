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

const CONFIG_NOT_FOUND_MESSAGE = {
  severity: 'error',
  excerpt: `Error while running ESLint: No ESLint configuration found.`
};

const RECENTLY_SAVED = new Set();
function hasRecentlySaved (path) {
  if (RECENTLY_SAVED.has(path)) { return true; }
  RECENTLY_SAVED.add(path);
  setTimeout(() => RECENTLY_SAVED.delete(path), 100);
}

function eventInvolvesFile (event, fileName) {
  return event.path.endsWith(fileName) || (event.oldPath && event.oldPath.endsWith(fileName));
}

// Catch file-change events that involve any of `.eslintrc`, `.eslintrc.js`, or
// `.eslintrc.yml`.
function eventInvolvesEslintrc (event) {
  return [event.path, event.oldPath].some((p) => {
    return p && (
      p.includes(`${Path.sep}.eslintrc`) || p.startsWith(`.eslintrc`)
    );
  });
}

export default {

  shouldAutoFix (textEditor) {
    if (this.inactive) { return false; }
    if (textEditor.isModified()) { return false; }
    if (!Config.get('autofix.fixOnSave')) { return false; }
    if (!helpers.hasValidScope(textEditor, this.scopes)) { return false; }
    return true;
  },

  isLegacyPackagePresent () {
    return atom.packages.isPackageActive('linter-eslint');
  },

  async activate () {
    Config.initialize();
    this.workerPath = Path.join(__dirname, 'worker.js');
    this.jobManager = new JobManager();

    // “Inactive” is the mode we enter when we think a project won’t be doing
    // much, or any, linting. Examples include (a) no ESLint in this project,
    // (b) too-old ESLint in this project, (c) v7 ESLint when we’re deferring
    // to the legacy package. Option A will be the most common, as it would
    // also apply to all non-JavaScript projects, for which it’s silly and
    // wasteful to keep a worker process around.
    //
    // If we see evidence of any of these situations, we should put ourselves
    // to sleep via `this.sleep`. This kills our worker process, and it also
    // means that we’ll return empty results for linting requests without an
    // unnecessary round-trip to the worker.
    //
    // This isn’t a problem because we can wake whenever we want, and the job
    // manager will create a new worker the next time we send it a job. So we
    // should wake whenever anything changes about the project that might
    // invalidate our assumptions. We’ll also wake when the user explicitly
    // triggers the “Fix File” or “Debug” commands.
    this.inactive = false;

    // Keep track of whether the user has seen certain notifications. Absent
    // any user-initiated changes, they should see each of these no more than
    // once per session.
    this.notified = {
      incompatibleVersion: false,
      invalidNodeBin: false
    };

    this.subscriptions = new CompositeDisposable();

    this.scopes = atom.config.get('linter-eslint-node.scopes');

    this.subscriptions.add(
      atom.workspace.observeTextEditors(
        textEditor => {
          textEditor.onDidSave(async () => {
            // Guard against multiple fires from the same save event. This can
            // happen when multiple tabs are open to the same file in different
            // panes.
            if (hasRecentlySaved(textEditor.getPath())) { return; }
            if (this.shouldAutoFix(textEditor)) {
              await this.fixJob(true);
            }
          });
        }
      ),

      // Scan for new .linter-eslint config files when project paths change.
      atom.project.onDidChangePaths(() => {
        this.wake();
        Config.rescan();
      }),

      // React to changes that happen either in a .linter-eslint file or the
      // base package settings.
      Config.onConfigDidChange(
        (config, prevConfig) => {
          this.wake();
          console.debug('Config changed:', config, prevConfig);
          if (helpers.configShouldInvalidateWorkerCache(config, prevConfig)) {
            this.clearESLintCache();
          }

          if (config.scopes !== prevConfig.scopes) {
            this.scopes.splice(0, this.scopes.length);
            this.scopes.push(...config.scopes);
          }

          if (config.nodeBin !== prevConfig.nodeBin) {
            this.notified.invalidNodeBin = false;
            this.jobManager.suspend();
            NodePathTester
              .test(config.nodeBin)
              .then((version) => {
                console.info(`Switched Node to version:`, version);
              })
              .catch(() => {
                this.sleep();
                this.notifyAboutInvalidNodeBin();
              });
          }
        }
      ),

      atom.commands.add('atom-text-editor', {
        'linter-eslint-node:fix-file': async () => {
          let wasInactive = this.inactive;
          this.wake();
          await this.fixJob();
          if (wasInactive) { this.sleep(); }
        },
        'linter-eslint-node:debug': async () => {
          let wasInactive = this.inactive;
          this.wake();
          await this.debugJob();
          if (wasInactive) { this.sleep(); }
        }
      }),

      // Keep track of `.eslintignore` and `.eslintrc` updates.
      atom.project.onDidChangeFiles(events => {
        for (const event of events) {
          // Without this, `npm install` inside an already-open project
          // triggers a _bunch_ of cache clearances.
          if (event.path.includes('node_modules')) { return false; }

          if (eventInvolvesFile(event, '.linter-eslint')) {
            this.wake();
            Config.rescan();
          }
          // Instances of `ESLint` cache whatever configuration details were
          // present at instantiation time. If any config changes, we can't
          // re-use old instances.
          if (eventInvolvesFile(event, '.eslintignore') || eventInvolvesEslintrc(event)) {
            this.wake();
            this.clearESLintCache();
          }
        }
      }),

      // Add item to editor context menu.
      atom.contextMenu.add({
        'atom-text-editor:not(.mini), .overlayer': [{
          label: 'ESLint Fix',
          command: 'linter-eslint-node:fix-file',
          shouldDisplay: (evt) => {
            const activeEditor = atom.workspace.getActiveTextEditor();
            if (!activeEditor) {
              return false;
            }
            // Black magic!
            // Compares the private component property of the active TextEditor
            //   against the components of the elements
            const evtIsActiveEditor = evt.path.some((elem) => (
              // Atom v1.19.0+
              elem.component && activeEditor.component
                && elem.component === activeEditor.component));
            // Only show if it was the active editor and it is a valid scope
            return evtIsActiveEditor && helpers.hasValidScope(activeEditor, Config.get('scopes'));
          }
        }]
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

  sleep () {
    this.inactive = true;
    this.jobManager.suspend();
  },

  wake () {
    // No need to start the worker; it will restart next time we lint.
    this.inactive = false;
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

  clearESLintCache () {
    console.debug('Telling the worker to clear its cache');
    this.jobManager.send({ type: 'clear-cache' });
  },

  // Show a bunch of stuff to the user that can help them figure out why the
  // package isn't behaving the way they think it ought to, or else give them
  // something to copy and paste into a new issue.
  async debugJob (editor = null) {
    const textEditor = editor || atom.workspace.getActiveTextEditor();
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
            isOverlap: false,
            workerPid: null
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
        workerPid: response.workerPid,
        nodeVersion: nodeVersion.toString('utf-8').replace(/\n/, '')
      };

      if (response.eslintPath) {
        debug.eslintVersion = require(
          Path.join(response.eslintPath, 'package.json')
        ).version;
      }
    } catch (error) {
      atom.notifications.addError(`${error}`, { dismissable: true });
      return {};
    }

    let whichPackageWillLint;
    if (debug.isIncompatible) {
      whichPackageWillLint = this.isLegacyPackagePresent() ? 'linter-eslint' : '(nothing)';
    } else if (debug.isOverlap) {
      whichPackageWillLint = this.isLegacyPackagePresent() ? 'linter-eslint' : 'linter-eslint-node';
    } else {
      whichPackageWillLint = 'linter-eslint-node';
    }
    debug.whichPackageWillLint = whichPackageWillLint;

    let debugMessage = [
      `Atom version: ${debug.atomVersion}`,
      `linter-eslint-node version: ${debug.packageVersion}`,
      `Worker using Node at path: ${debug.nodePath}`,
      `Worker Node version: ${debug.nodeVersion}`,
      `Worker PID: ${debug.workerPid}`,
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
        dismissable: true,
        buttons: [
          {
            text: 'Copy',
            onDidClick () {
              atom.clipboard.write(debugMessage.join('\n'));
            }
          }
        ]
      }
    );

    return debug;
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

    // If we're in inactive mode and we get this far, it's because the user
    // explicitly ran the `Fix Job` command, so we should wake up.
    this.wake();

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

      let fixes = response.fixCount;
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
      this.handleError(err, 'fix');
      return;
    }
  },

  handleError (err, type, editor = null) {
    if (err.name && err.name === 'InvalidWorkerError') {
      // The worker script never got created. Aside from notifying the user
      // (which will be skipped if they've already gotten such a message in
      // this session), we should do nothing here so that an invalid worker
      // behaves as though no linter is present at all.
      this.notifyAboutInvalidNodeBin();
      this.sleep();
      return null;
    }

    if (err.type && err.type === 'config-not-found') {
      if (Config.get('disabling.disableWhenNoEslintConfig')) {
        this.sleep();
        return [];
      }
      if (type === 'fix') {
        atom.notifications.addError(
          `linter-eslint-node: No .eslintrc found`,
          {
            description: err.error,
            dismissable: false
          }
        );
      } else {
        // If you're working on a file outside of a project, you're probably
        // aware that there's no .eslintrc, so we should notify you in a less
        // obtrusive way than a full-on notification. We'll show it as a linter
        // error so that you can just hide the linter pane (or toggle the
        // config option) if you don't want further reminders.
        let position = [[0, 0], [0, 0]];
        if (editor.getLineCount() > 0) {
          let firstLine = editor.getTextInBufferRange([[0, 0], [0, Number.POSITIVE_INFINITY]]);
          position = [[0, 0], [0, firstLine.length]];
        }
        return [
          {
            ...CONFIG_NOT_FOUND_MESSAGE,
            location: {
              file: editor.getPath(),
              position
            }
          }
        ];
      }
    }

    if (err.type && err.type === 'no-project') {
      // No project means nowhere to look for an `.eslintrc`.
      this.sleep();
      return null;
    }

    if (err.type && err.type === 'version-overlap') {
      // This is an easy one: we don't need to lint this file because
      // `linter-eslint` is present and can handle it. Do nothing.
      this.sleep();
      return null;
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
      this.sleep();
      if (linterEslintPresent || didNotify || !Config.get('warnAboutOldEslint')) {
        return null;
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
        return null;
      }
    }

    // Unknown/unhandled error from the worker.
    atom.notifications.addError(
      `linter-eslint-node Error`,
      {
        description: err.error,
        dismissable: true
      }
    );
    return null;
  },

  provideLinter () {
    return {
      name: 'ESLint (Node)',
      scope: 'file',
      lintsOnChange: true,
      grammarScopes: this.scopes,
      lint: async (textEditor) => {
        console.warn('Linting', textEditor);
        if (!atom.workspace.isTextEditor(textEditor)) {
          return null;
        }
        if (this.inactive) {
          console.debug('Inactive; skipping lint');
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
            // The editor contents have changed since we requested this lint
            // job. We can't be certain that the linter results aren't stale,
            // so we'll return `null` to signal to Linter that it shouldn't
            // update the saved results.
            return null;
          }

          if (response === null) {
            // An explicit `null` response from the worker means that it has
            // failed to find ESLint in the load path. This will happen if
            // Node, running from the project root, fails to find any version
            // of `eslint` in the load path, whether local or global.
            //
            // TODO: In these cases, a `null` response will produce the same
            // result as if this linter weren't installed at all. If we wanted
            // some of these scenarios to produce notifications to the user (so
            // they could make corrections), we'd have to distinguish those
            // cases somehow.
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
                // is about to fix it. Otherwise the panel might appear for
                // just a fraction of a second before disappearing.
                continue;
              }
              result.solutions = helpers.solutionsForFix(result.fix, textBuffer);
            }
            delete result.fix;
            filteredResults.push(result);
          }

          console.debug('Linting results:', filteredResults);
          return filteredResults;
        } catch (err) {
          return this.handleError(err, 'lint', textEditor);
        }
      }
    };
  },
};
