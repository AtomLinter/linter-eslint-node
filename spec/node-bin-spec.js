'use babel';
import { homedir } from 'os';
import * as Path from 'path';
import * as FS from 'fs';
import {
  copyFileToDir,
  openAndSetProjectDir,
  wait
} from './helpers';
import rimraf from 'rimraf';
import linterEslintNode from '../lib/main';

const root = Path.normalize(homedir());
const paths = {
  eslint6: Path.join(root, 'with-eslint-6'),
  eslint7: Path.join(root, 'with-eslint-7'),
  eslintLatest: Path.join(root, 'with-eslint-latest')
};

const fixtureRoot = Path.join(__dirname, 'fixtures', 'ci', 'package-interaction');

async function writeProjectConfig (projectPath, config) {
  let overrideFile = Path.join(projectPath, '.linter-eslint');
  let text = JSON.stringify(config, null, 2);
  FS.writeFileSync(overrideFile, text);
  await wait(1000);
}

async function copyFilesIntoProject (projectPath) {
  let files = [
    Path.join(fixtureRoot, '.eslintrc'),
    Path.join(fixtureRoot, 'index.js')
  ];
  for (let file of files) {
    await copyFileToDir(file, projectPath);
  }
}

async function deleteFilesFromProject (projectPath) {
  let files = [
    Path.join(projectPath, '.eslintrc'),
    Path.join(projectPath, 'index.js'),
    Path.join(projectPath, '.linter-eslint')
  ];
  for (let file of files) {
    await rimraf.sync(file);
  }
}

function expectVersionMatch (expected, actual) {
  expected = expected.replace(/\s/g, '');
  actual = actual.replace(/\s/g, '');
  expect(expected).toBe(actual);
}

if (process.env.CI) {
  describe('Node binary config', () => {
    const linterProvider = linterEslintNode.provideLinter();
    const debugJob = linterEslintNode.debugJob.bind(linterEslintNode);
    const { lint } = linterProvider;

    beforeEach(async () => {
      atom.config.set('linter-eslint-node.nodeBin', process.env.NODE_DEFAULT);

      atom.packages.triggerDeferredActivationHooks();
      atom.packages.triggerActivationHook('core:loaded-shell-environment');

      await atom.packages.activatePackage('language-javascript');
      await atom.packages.activatePackage('linter-eslint-node');
    });

    describe('with default nodeBin', () => {
      let editor;
      beforeEach(async () => {
        await copyFilesIntoProject(paths.eslintLatest);
        editor = await openAndSetProjectDir(
          Path.join(paths.eslintLatest, 'index.js'),
          paths.eslintLatest
        );
      });

      afterEach(async () => {
        await deleteFilesFromProject(paths.eslintLatest);
      });

      it('lints correctly', async () => {
        let results = await lint(editor);
        expect(results.length).toBe(1);
      });

      it('reports the correct version of Node', async () => {
        let debug = await debugJob(editor);
        expectVersionMatch(
          debug.nodeVersion,
          process.env.NODE_DEFAULT_VERSION
        );
      });
    });

    describe('with project override', () => {
      let editor;

      beforeEach(async () => {
        await copyFilesIntoProject(paths.eslintLatest);
        editor = await openAndSetProjectDir(
          Path.join(paths.eslintLatest, 'index.js'),
          paths.eslintLatest
        );
        await writeProjectConfig(paths.eslintLatest, {
          nodeBin: process.env.NODE_LATEST
        });
      });

      afterEach(async () => {
        await deleteFilesFromProject(paths.eslintLatest);
      });

      it('lints correctly and using the right version of Node', async () => {
        let results = await lint(editor);
        expect(results.length).toBe(1);

        let debug = await debugJob(editor);
        expectVersionMatch(
          debug.nodeVersion,
          process.env.NODE_LATEST_VERSION
        );
      });
    });

    describe('with config change after activation', () => {
      let editor;

      beforeEach(async () => {
        await copyFilesIntoProject(paths.eslintLatest);
        editor = await openAndSetProjectDir(
          Path.join(paths.eslintLatest, 'index.js'),
          paths.eslintLatest
        );
      });

      afterEach(async () => {
        await deleteFilesFromProject(paths.eslintLatest);
      });

      it('lints correctly both before and after the version change', async () => {
        let debug = await debugJob(editor);
        expectVersionMatch(
          debug.nodeVersion,
          process.env.NODE_DEFAULT_VERSION
        );

        let results = await lint(editor);
        expect(results.length).toBe(1);

        atom.config.set('linter-eslint-node.nodeBin', process.env.NODE_LATEST);
        wait(1000);

        debug = await debugJob(editor);
        expectVersionMatch(
          debug.nodeVersion,
          process.env.NODE_LATEST_VERSION
        );

        results = await lint(editor);
        expect(results.length).toBe(1);
      });

    });
  });
}
