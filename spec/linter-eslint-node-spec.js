'use babel';

import * as path from 'path';
import {
  copyFileToDir,
  copyFileToTempDir,
  openAndSetProjectDir
} from './helpers';
import rimraf from 'rimraf';
import linterEslintNode from '../lib/main';

const fixturesDir = path.join(__dirname, 'fixtures');
const projectDir = path.resolve(path.join(__dirname, '..'));

const paths = {
  good: path.join(fixturesDir, 'files', 'with-config', 'good.js'),
  bad: path.join(fixturesDir, 'files', 'with-config', 'bad.js'),
  badInline: path.join(fixturesDir, 'files', 'inline', 'badInline.js'),
  dynamicCwd: path.join(fixturesDir, 'dynamic-cwd', 'logical-or-assignment.js'),
  empty: path.join(fixturesDir, 'files', 'with-config', 'empty.js'),
  fix: path.join(fixturesDir, 'files', 'with-config', 'fix.js'),
  cache: path.join(fixturesDir, 'files', 'with-config', '.eslintcache'),
  config: path.join(fixturesDir, 'configs', '.eslintrc.yml'),
  ignored: path.join(fixturesDir, 'eslintignore', 'ignored.js'),
  endRange: path.join(fixturesDir, 'end-range', 'no-unreachable.js'),
  badCache: path.join(fixturesDir, 'badCache'),
  modifiedIgnore: path.join(fixturesDir, 'modified-ignore-rule', 'foo.js'),
  modifiedIgnoreSpace: path.join(fixturesDir, 'modified-ignore-rule', 'foo-space.js'),
  importing: path.join(fixturesDir, 'import-resolution', 'nested', 'importing.js'),
  badImport: path.join(fixturesDir, 'import-resolution', 'nested', 'badImport.js'),
  fixablePlugin: path.join(fixturesDir, 'plugin-import', 'life.js'),
  eslintignoreDir: path.join(fixturesDir, 'eslintignore'),
  eslintIgnoreKeyDir: path.join(fixturesDir, 'configs', 'eslintignorekey')
};

/**
 * @param {string} expectedMessage
 * @returns {Promise<import("atom").Notification>}
 */
function getNotification(expectedMessage) {
  return new Promise((resolve, reject) => {
    /** @type {import("atom").Disposable | undefined} */
    let notificationSub;
    /**
    * @param {Promise<import("atom").Notification>} notification
    */
    const newNotification = (notification) => {
      if (notification.getMessage() !== expectedMessage) {
        // As the specs execute asynchronously, it's possible a notification
        // from a different spec was grabbed, if the message doesn't match what
        // is expected simply return and keep waiting for the next message.
        return;
      }
      // Dispose of the notification subscription
      if (notificationSub !== undefined) {
        notificationSub.dispose();
        resolve(notification);
      } else {
        reject();
      }
    };
    // Subscribe to Atom's notifications
    notificationSub = atom.notifications.onDidAddNotification(newNotification);
  });
}

/**
 * @param {import("atom").TextEditor} textEditor
 * @returns {Promise<void>}
 */
async function makeFixes(textEditor, expectedFixCount) {
  const buffer = textEditor.getBuffer();
  /** @type {Promise<void>} */
  const editorReloadPromise = new Promise((resolve) => {
    // Subscribe to file reload events
    const editorReloadSubscription = buffer.onDidReload(() => {
      editorReloadSubscription.dispose();
      resolve();
    });
  });

  let expectedMessage;
  if (expectedFixCount === 0) {
    expectedMessage = 'Nothing to fix.';
  } else {
    expectedMessage = `Applied ${expectedFixCount} fix${expectedFixCount > 1 ? 'es' : ''}.`;
  }

  // Subscribe to notification events
  const notificationPromise = getNotification(expectedMessage);

  // Subscriptions now active for Editor Reload and Message Notification
  // Send off a fix request.
  await atom.commands.dispatch(atom.views.getView(textEditor), 'linter-eslint-node:fix-file');

  const notification = await notificationPromise;
  expect(notification.getMessage()).toBe(expectedMessage);
  expect(notification.getType()).toBe('success');

  // After editor reloads, it should be safe for consuming test to resume.
  buffer.reload();
  return editorReloadPromise;
}

describe('The eslint provider for Linter', () => {
  const linterProvider = linterEslintNode.provideLinter();
  const { lint } = linterProvider;

  beforeEach(async () => {
    atom.config.set('linter-eslint-node.advanced.disableEslintIgnore', true);

    // Activate activation hook
    atom.packages.triggerDeferredActivationHooks();
    atom.packages.triggerActivationHook('core:loaded-shell-environment');

    // Activate the JavaScript language so Atom knows what the files are
    await atom.packages.activatePackage('language-javascript');
    // Activate the provider
    await atom.packages.activatePackage('linter-eslint-node');
  });

  describe('checks bad.js and', () => {
    let editor = null;
    beforeEach(async () => {
      editor = await atom.workspace.open(paths.bad);
      atom.project.setPaths([projectDir]);
    });

    it('verifies the messages', async () => {
      const messages = await lint(editor);
      expect(messages.length).toBe(2);

      const expected0 = "'foo' is not defined. (no-undef)";
      const expected0Url = 'https://eslint.org/docs/rules/no-undef';
      const expected1 = 'Extra semicolon. (semi)';
      const expected1Url = 'https://eslint.org/docs/rules/semi';

      expect(messages[0].severity).toBe('error');
      expect(messages[0].excerpt).toBe(expected0);
      expect(messages[0].url).toBe(expected0Url);
      expect(messages[0].location.file).toBe(paths.bad);
      expect(messages[0].location.position).toEqual([[0, 0], [0, 3]]);
      expect(messages[0].solutions).not.toBeDefined();

      expect(messages[1].severity).toBe('error');
      expect(messages[1].excerpt).toBe(expected1);
      expect(messages[1].url).toBe(expected1Url);
      expect(messages[1].location.file).toBe(paths.bad);
      expect(messages[1].location.position).toEqual([[0, 8], [0, 9]]);
      expect(messages[1].solutions.length).toBe(1);
      expect(messages[1].solutions[0].position).toEqual([[0, 6], [0, 9]]);
      expect(messages[1].solutions[0].replaceWith).toBe('42');
    });
  });

  it('finds nothing wrong with an empty file', async () => {
    const editor = await atom.workspace.open(paths.empty);
    const messages = await lint(editor);

    expect(messages.length).toBe(0);
  });

  it('finds nothing wrong with a valid file', async () => {
    const editor = await atom.workspace.open(paths.good);
    const messages = await lint(editor);

    expect(messages.length).toBe(0);
  });

  it('finds no cwd problems with a valid file (and proper dynamic ecmaVersion)', async () => {
    const cwd = process.cwd();

    const editor = await atom.workspace.open(paths.dynamicCwd);
    const messages = await lint(editor);

    expect(cwd).toEqual(process.cwd());
    process.chdir(cwd);

    expect(messages.length).toBe(0);
  });

  it('reports the fixes for fixable errors', async () => {
    const editor = await atom.workspace.open(paths.fix);
    const messages = await lint(editor);

    expect(messages[0].solutions[0].position).toEqual([[0, 10], [1, 8]]);
    expect(messages[0].solutions[0].replaceWith).toMatch(/^6\s+function$/);

    expect(messages[1].solutions[0].position).toEqual([[2, 0], [2, 1]]);
    expect(messages[1].solutions[0].replaceWith).toBe('  ');
  });

  describe('when resolving import paths using eslint-plugin-import', () => {
    it('correctly resolves imports from parent', async () => {
      const editor = await atom.workspace.open(paths.importing);
      const messages = await lint(editor);

      expect(messages.length).toBe(0);
    });

    it('shows a message for an invalid import', async () => {
      const editor = await atom.workspace.open(paths.badImport);
      const messages = await lint(editor);
      const expected = "Unable to resolve path to module '../nonexistent'. (import/no-unresolved)";
      const expectedUrlRegEx = /https[\S]+eslint-plugin-import[\S]+no-unresolved.md/;

      expect(messages.length).toBe(1);
      expect(messages[0].severity).toBe('error');
      expect(messages[0].excerpt).toBe(expected);
      expect(messages[0].url).toMatch(expectedUrlRegEx);
      expect(messages[0].location.file).toBe(paths.badImport);
      expect(messages[0].location.position).toEqual([[0, 24], [0, 40]]);
      expect(messages[0].solutions).not.toBeDefined();
    });
  });

  describe('when a file is specified in an .eslintignore file', () => {
    let editor;
    beforeEach(async () => {
      atom.config.set('linter-eslint-node.advanced.disableEslintIgnore', false);
      editor = await openAndSetProjectDir(paths.ignored, projectDir);
    });

    it('will not give warnings when linting the file', async () => {
      // By default (for reasons I haven't figured out yet) the `spec/fixtures`
      // folder is the sole project path. Our what’s-our-cwd traversal logic
      // will search upward and use the first directory with an
      // `.eslintignore`… until it hits the project root. If we don't set the
      // project root here, our `.eslintignore` will itself, poignantly, be
      // ignored.
      const messages = await lint(editor);

      expect(messages.length).toBe(0);
    });

    it('will not give warnings when autofixing the file', async () => {
      const expectedMessage = 'Nothing to fix.';
      const notificationPromise = getNotification(expectedMessage);
      await atom.commands.dispatch(
        atom.views.getView(editor),
        'linter-eslint-node:fix-file'
      );
      const notification = await notificationPromise;

      expect(notification.getMessage()).toBe(expectedMessage);
    });
  });

  describe('when a file is not specified in .eslintignore file', () => {
    it('will give warnings when linting the file', async () => {
      const tempPath = await copyFileToTempDir(
        path.join(paths.eslintignoreDir, 'ignored.js')
      );
      const tempDir = path.dirname(tempPath);
      const editor = await atom.workspace.open(tempPath);
      atom.config.set('linter-eslint-node.advanced.disableEslintIgnore', false);
      await copyFileToDir(path.join(paths.eslintignoreDir, '.eslintrc.yaml'), tempDir);

      const messages = await lint(editor);
      expect(messages.length).toBe(1);
      rimraf.sync(tempDir);
    });
  });

  // These tests fail when the worker runs `lintText`, but pass when it runs
  // `lintFiles`. This makes no sense. They're skipped until I can figure out
  // why.
  xdescribe('when a file is specified in an eslintIgnore key in package.json', () => {
    it('will still lint the file if an .eslintignore file is present', async () => {
      atom.config.set('linter-eslint-node.advanced.disableEslintIgnore', false);
      let filePath = path.join(paths.eslintIgnoreKeyDir, 'ignored.js');
      const editor = await openAndSetProjectDir(filePath, projectDir);
      // const editor = await atom.workspace.open(filePath);
      const messages = await lint(editor);

      expect(messages.length).toBe(1);
    });

    it('will not give warnings when linting the file', async () => {
      const tempPath = await copyFileToTempDir(path.join(paths.eslintIgnoreKeyDir, 'ignored.js'));
      const tempDir = path.dirname(tempPath);

      const editor = await atom.workspace.open(tempPath);
      atom.config.set('linter-eslint-node.advanced.disableEslintIgnore', false);
      await copyFileToDir(path.join(paths.eslintIgnoreKeyDir, 'package.json'), tempDir);

      const messages = await lint(editor);
      expect(messages.length).toBe(0);
      rimraf.sync(tempDir);
    });
  });

  describe('fixes errors', () => {
    let editor;
    let tempDir;

    beforeEach(async () => {
      atom.config.set('linter-eslint-node.advanced.useCache', false);
      // Copy the file to a temporary folder
      const tempFixturePath = await copyFileToTempDir(paths.fix);
      editor = await atom.workspace.open(tempFixturePath);
      tempDir = path.dirname(tempFixturePath);
      // Copy the config to the same temporary directory
      await copyFileToDir(paths.config, tempDir);
    });

    afterEach(() => {
      // Remove the temporary directory
      rimraf.sync(tempDir);
    });

    /**
     * @param {import("atom").TextEditor} textEditor
     * @returns {Promise<void>}
     */
    async function firstLint(textEditor) {
      const messages = await lint(textEditor);
      // The original file has two errors
      expect(messages.length).toBe(2);
    }

    it('should fix linting errors', async () => {
      await firstLint(editor);
      await makeFixes(editor, 2);
      const messagesAfterFixing = await lint(editor);
      expect(messagesAfterFixing.length).toBe(0);
    });

    it('should not fix linting errors for rules that are disabled with rulesToDisableWhileFixing', async () => {
      atom.config.set('linter-eslint-node.autofix.rulesToDisableWhileFixing', ['semi']);

      await firstLint(editor);
      await makeFixes(editor, 1);
      const messagesAfterFixing = await lint(editor);
      const expected = 'Extra semicolon. (semi)';
      const expectedUrl = 'https://eslint.org/docs/rules/semi';

      expect(messagesAfterFixing.length).toBe(1);
      expect(messagesAfterFixing[0].excerpt).toBe(expected);
      expect(messagesAfterFixing[0].url).toBe(expectedUrl);
    });
  });

  describe('Ignores specified rules when editing', () => {
    let expectedPath;

    const checkNoConsole = (message) => {
      const text = 'Unexpected console statement. (no-console)';
      const url = 'https://eslint.org/docs/rules/no-console';
      expect(message.severity).toBe('error');
      expect(message.excerpt).toBe(text);
      expect(message.url).toBe(url);
      expect(message.location.file).toBe(expectedPath);
      expect(message.location.position).toEqual([[0, 0], [0, 11]]);
    };

    const checkNoTrailingSpace = (message) => {
      const text = 'Trailing spaces not allowed. (no-trailing-spaces)';
      const url = 'https://eslint.org/docs/rules/no-trailing-spaces';

      expect(message.severity).toBe('error');
      expect(message.excerpt).toBe(text);
      expect(message.url).toBe(url);
      expect(message.location.file).toBe(expectedPath);
      expect(message.location.position).toEqual([[1, 9], [1, 10]]);
    };

    const checkBefore = (messages) => {
      expect(messages.length).toBe(1);
      checkNoConsole(messages[0]);
    };

    const checkNew = (messages) => {
      expect(messages.length).toBe(2);
      checkNoConsole(messages[0]);
      checkNoTrailingSpace(messages[1]);
    };

    const checkAfter = (messages) => {
      expect(messages.length).toBe(1);
      checkNoConsole(messages[0]);
    };

    it('does nothing on saved files', async () => {
      atom.config.set('linter-eslint-node.disabling.rulesToSilenceWhileTyping', ['no-trailing-spaces']);
      atom.config.set('linter-eslint-node.autofix.ignoreFixableRulesWhileTyping', true);
      expectedPath = paths.modifiedIgnoreSpace;
      const editor = await atom.workspace.open(expectedPath);
      // Run once to populate the fixable rules list
      await lint(editor);
      // Run again for the testable results
      const messages = await lint(editor);
      checkNew(messages);
    });

    it('allows ignoring a specific list of rules when modified', async () => {
      expectedPath = paths.modifiedIgnore;
      const editor = await atom.workspace.open(expectedPath);

      // Verify expected error before
      const firstMessages = await lint(editor);
      checkBefore(firstMessages);

      // Insert a space into the editor
      editor.getBuffer().insert([1, 9], ' ');

      // Verify the space is showing an error
      const messages = await lint(editor);
      checkNew(messages);

      // Enable the option under test
      atom.config.set('linter-eslint-node.disabling.rulesToSilenceWhileTyping', ['no-trailing-spaces']);

      // Check the lint results
      const newMessages = await lint(editor);
      checkAfter(newMessages);
    });

    it('allows ignoring all fixable rules while typing', async () => {
      expectedPath = paths.modifiedIgnore;
      const editor = await atom.workspace.open(expectedPath);

      // Verify no error before
      const firstMessages = await lint(editor);
      checkBefore(firstMessages);

      // Insert a space into the editor
      editor.getBuffer().insert([1, 9], ' ');

      // Verify the space is showing an error
      const messages = await lint(editor);
      checkNew(messages);

      // Enable the option under test
      // NOTE: Depends on no-trailing-spaces being marked as fixable by ESLint
      atom.config.set('linter-eslint-node.autofix.ignoreFixableRulesWhileTyping', true);

      // Check the lint results
      const newMessages = await lint(editor);
      checkAfter(newMessages);
    });

    it('allows ignoring fixible rules from plugins while typing', async () => {
      expectedPath = paths.fixablePlugin;
      const editor = await atom.workspace.open(expectedPath);

      // Verify no error before the editor is modified
      const firstMessages = await lint(editor);
      expect(firstMessages.length).toBe(0);

      // Remove the newline between the import and console log
      editor.getBuffer().deleteRow(1);

      // Verify there is an error for the fixable import/newline-after-import rule
      const messages = await lint(editor);
      expect(messages.length).toBe(1);
      expect(messages[0].severity).toBe('error');
      expect(messages[0].excerpt).toBe('Expected 1 empty line after import '
        + 'statement not followed by another import. (import/newline-after-import)');

      // Enable the option under test
      // NOTE: Depends on import/newline-after-import rule being marked as fixable
      atom.config.set('linter-eslint-node.autofix.ignoreFixableRulesWhileTyping', true);

      // Check the lint results
      const newMessages = await lint(editor);
      expect(newMessages.length).toBe(0);
    });
  });

  describe('prints debugging information with the `debug` command', () => {
    let editor;
    const expectedMessage = 'linter-eslint-node debug information';
    beforeEach(async () => {
      editor = await atom.workspace.open(paths.good);
    });

    it('shows an info notification', async () => {
      const notificationPromise = getNotification(expectedMessage);
      await atom.commands.dispatch(atom.views.getView(editor), 'linter-eslint-node:debug');
      const notification = await notificationPromise;

      expect(notification.getMessage()).toBe(expectedMessage);
      expect(notification.getType()).toEqual('info');
    });

    it('includes debugging information in the details', async () => {
      const notificationPromise = getNotification(expectedMessage);
      await atom.commands.dispatch(atom.views.getView(editor), 'linter-eslint-node:debug');
      const notification = await notificationPromise;
      const detail = notification.getDetail();

      expect(detail.includes(`Atom version: ${atom.getVersion()}`)).toBe(true);
      expect(detail.includes('linter-eslint-node version:')).toBe(true);
      expect(detail.includes(`Platform: ${process.platform}`)).toBe(true);
      expect(detail.includes('linter-eslint-node configuration:')).toBe(true);
    });
  });

  it('handles ranges in messages', async () => {
    const editor = await atom.workspace.open(paths.endRange);
    const messages = await lint(editor);
    const expected = 'Unreachable code. (no-unreachable)';
    const expectedUrl = 'https://eslint.org/docs/rules/no-unreachable';

    expect(messages[0].severity).toBe('error');
    expect(messages[0].excerpt).toBe(expected);
    expect(messages[0].url).toBe(expectedUrl);
    expect(messages[0].location.file).toBe(paths.endRange);
    expect(messages[0].location.position).toEqual([[5, 2], [6, 15]]);
  });

  describe('when setting `disableWhenNoEslintConfig` is false', () => {
    let editor;
    let tempFilePath;
    let tempFixtureDir;

    beforeEach(async () => {
      atom.config.set('linter-eslint-node.disabling.disableWhenNoEslintConfig', false);

      tempFilePath = await copyFileToTempDir(paths.badInline);
      editor = await atom.workspace.open(tempFilePath);
      tempFixtureDir = path.dirname(tempFilePath);
    });

    afterEach(() => {
      rimraf.sync(tempFixtureDir);
    });

    it('errors when no config file is found', async () => {
      const messages = await lint(editor);
      const expected = 'Error while running ESLint: No ESLint configuration found.';
      expect(messages.length).toBe(1);
      expect(messages[0].severity).toBe('error');
      expect(messages[0].excerpt).toBe(expected);
      // expect(messages[0].description.startsWith(description)).toBe(true);
      expect(messages[0].url).not.toBeDefined();
      expect(messages[0].location.file).toBe(tempFilePath);
      expect(messages[0].location.position).toEqual([[0, 0], [0, 28]]);
    });
  });

  describe('when `disableWhenNoEslintConfig` is true', () => {
    let editor;
    let tempFixtureDir;

    beforeEach(async () => {
      atom.config.set('linter-eslint-node.disabling.disableWhenNoEslintConfig', true);

      const tempFilePath = await copyFileToTempDir(paths.badInline);
      editor = await atom.workspace.open(tempFilePath);
      tempFixtureDir = path.dirname(tempFilePath);
    });

    afterEach(() => {
      rimraf.sync(tempFixtureDir);
    });

    it('does not report errors when no config file is found', async () => {
      const messages = await lint(editor);
      expect(messages.length).toBe(0);
    });
  });

  describe('handles the Show Rule ID in Messages option', () => {
    const expectedUrlRegEx = /https[\S]+eslint-plugin-import[\S]+no-unresolved.md/;

    it('shows the rule ID when enabled', async () => {
      atom.config.set('linter-eslint-node.advanced.showRuleIdInMessage', true);
      const editor = await atom.workspace.open(paths.badImport);
      const messages = await lint(editor);
      const expected = "Unable to resolve path to module '../nonexistent'. (import/no-unresolved)";

      expect(messages.length).toBe(1);
      expect(messages[0].severity).toBe('error');
      expect(messages[0].excerpt).toBe(expected);
      expect(messages[0].url).toMatch(expectedUrlRegEx);
      expect(messages[0].location.file).toBe(paths.badImport);
      expect(messages[0].location.position).toEqual([[0, 24], [0, 40]]);
      expect(messages[0].solutions).not.toBeDefined();
    });

    it("doesn't show the rule ID when disabled", async () => {
      atom.config.set('linter-eslint-node.advanced.showRuleIdInMessage', false);
      const editor = await atom.workspace.open(paths.badImport);
      const messages = await lint(editor);
      const expected = "Unable to resolve path to module '../nonexistent'.";

      expect(messages.length).toBe(1);
      expect(messages[0].severity).toBe('error');
      expect(messages[0].excerpt).toBe(expected);
      expect(messages[0].url).toMatch(expectedUrlRegEx);
      expect(messages[0].location.file).toBe(paths.badImport);
      expect(messages[0].location.position).toEqual([[0, 24], [0, 40]]);
      expect(messages[0].solutions).not.toBeDefined();
    });
  });

  it("registers an 'ESLint Fix' right click menu command", () => {
    // NOTE: Reaches into the private data of the ContextMenuManager, there is
    // no public method to check this though so...
    expect(
      atom.contextMenu.itemSets.some((itemSet) => (
        // Matching selector...
        itemSet.selector === 'atom-text-editor:not(.mini), .overlayer'
        && itemSet.items.some((item) => (
          // Matching command...
          item.command === 'linter-eslint-node:fix-file'
          // Matching label
          && item.label === 'ESLint Fix'
          // And has a function controlling display
          && typeof item.shouldDisplay === 'function'
        ))
      ))
    ).toBe(true);
  });
});
