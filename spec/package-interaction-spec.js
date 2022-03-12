'use babel';
import * as Path from 'path';
import * as FS from 'fs';
import {
  copyFileToDir,
  getNotification,
  openAndSetProjectDir,
  // wait
} from './helpers';
import linterEslintNode from '../lib/main';

const root = Path.normalize(process.env.HOME);
const paths = {
  eslint6: Path.join(root, 'with-eslint-6'),
  eslint7: Path.join(root, 'with-eslint-7'),
  eslintLatest: Path.join(root, 'with-eslint-latest')
};

const fixtureRoot = Path.join(__dirname, 'fixtures', 'ci', 'package-interaction');

async function expectNoNotification () {
  try {
    await getNotification();
    fail();
  } catch (_) {
    pass();
  }
}

async function copyFilesIntoProject (projectPath) {
  let files = [
    Path.join(fixtureRoot, '.eslintrc'),
    Path.join(fixtureRoot, 'index.js')
  ];
  if (files.every(f => FS.existsSync(f))) { return; }
  for (let file of files) {
    await copyFileToDir(file, projectPath);
  }
}

if (process.env.CI) {
  describe('Package interaction', () => {
    const linterProvider = linterEslintNode.provideLinter();
    const { lint } = linterProvider;

    beforeEach(async () => {
      atom.config.set('linter-eslint-node.nodeBin', process.env.NODE_DEFAULT);

      atom.packages.triggerDeferredActivationHooks();
      atom.packages.triggerActivationHook('core:loaded-shell-environment');

      await atom.packages.activatePackage('language-javascript');
      await atom.packages.activatePackage('linter-eslint-node');
      await atom.packages.activatePackage('linter-eslint');
    });

    describe('With linter-eslint enabled', () => {
      beforeEach(() => {
        atom.packages.enablePackage('linter-eslint');
      });

      it('should do nothing when opening an ESLint@6 project', async () => {
        await copyFilesIntoProject(paths.eslint6);
        let editor = await openAndSetProjectDir(
          Path.join(paths.eslint6, 'index.js'),
          paths.eslint6
        );

        let results = await lint(editor);
        expect(results).toBe(null);
        await expectNoNotification();
      });

      it('should do nothing when opening an ESLint@7 project', async () => {
        await copyFilesIntoProject(paths.eslint7);
        let editor = await openAndSetProjectDir(
          Path.join(paths.eslint7, 'index.js'),
          paths.eslint7
        );

        let results = await lint(editor);
        expect(results).toBe(null);
        await expectNoNotification();
      });

      it('should lint when opening an ESLint@8 project', async () => {
        await copyFilesIntoProject(paths.eslintLatest);
        let editor = await openAndSetProjectDir(
          Path.join(paths.eslintLatest, 'index.js'),
          paths.eslintLatest
        );

        let results = await lint(editor);
        expect(results.length).toBe(1);
        await expectNoNotification();
      });
    });

    describe('With linter-eslint disabled', () => {
      beforeEach(() => {
        atom.packages.disablePackage('linter-eslint');
      });

      it('should prompt to install linter-eslint when opening an ESLint@6 project', async () => {
        await copyFilesIntoProject(paths.eslint6);
        let editor = await openAndSetProjectDir(
          Path.join(paths.eslint6, 'index.js'),
          paths.eslint6
        );

        let results = await lint(editor);
        expect(results).toBe(null);
        let notification = await getNotification();
        expect(notification.title).toBe('linter-eslint-node: Incompatible ESLint');
      });

      it('should lint when opening an ESLint@7 project', async () => {
        await copyFilesIntoProject(paths.eslint7);
        let editor = await openAndSetProjectDir(
          Path.join(paths.eslint7, 'index.js'),
          paths.eslint7
        );

        let results = await lint(editor);
        expect(results.length).toBe(1);
        await expectNoNotification();
      });

      it('should lint when opening an ESLint@8 project', async () => {
        await copyFilesIntoProject(paths.eslintLatest);
        let editor = await openAndSetProjectDir(
          Path.join(paths.eslintLatest, 'index.js'),
          paths.eslintLatest
        );

        let results = await lint(editor);
        expect(results.length).toBe(1);
        await expectNoNotification();
      });
    });
  });
}
