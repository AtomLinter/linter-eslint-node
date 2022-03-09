'use babel';

import * as path from 'path';
import * as fs from 'fs';
import rimraf from 'rimraf';
import {
  copyFileToTempDir,
  openAndSetProjectDir,
  wait
} from './helpers';

import Config from '../lib/config';
import makeSpy from './make-spy';

const fixturesDir = path.join(__dirname, 'fixtures', 'config');

const paths = {
  empty: path.join(fixturesDir, 'empty'),
  withOverrides: path.join(fixturesDir, 'with-overrides')
};


describe('Config module', () => {

  beforeEach(async () => {
    atom.config.set('linter-eslint-node.foo', '');
    // Activate activation hook
    atom.packages.triggerDeferredActivationHooks();
    atom.packages.triggerActivationHook('core:loaded-shell-environment');

    // Activate the JavaScript language so Atom knows what the files are
    await atom.packages.activatePackage('language-javascript');
    // Activate the provider
    await atom.packages.activatePackage('linter-eslint-node');
  });

  describe('onConfigDidChange', () => {

    it('removes the correct handler when disposed', () => {
      let empty = () => {};
      let disposable = Config.onConfigDidChange(empty);
      expect(Config.handlers).toContain(empty);
      disposable.dispose();
      expect(Config.handlers).not.toContain(empty);
    });

  });

  describe('when no .linter-eslint file is present', () => {

    beforeEach(async () => {
      await atom.workspace.open(path.join(paths.empty, 'index.js'));
      expect(Config.initialized).toBe(true);
    });

    it('retrieves a package setting with atom.config.get', () => {
      let scopes = Config.get('foo');
      expect(scopes).toEqual('');
    });

    it('activates a change handler when package settings change', () => {
      let handler = makeSpy();
      let disposable = Config.onConfigDidChange(handler.call);
      atom.config.set('linter-eslint-node.foo', 'bar');
      expect(handler.called()).toBe(true);
      let [config, prevConfig] = handler.calledWith[0];
      expect(prevConfig.foo).toBe('');
      expect(config.foo).toBe('bar');
      disposable.dispose();
    });

  });

  describe('when .linter-eslint is present', () => {

    let tempPath, tempDir, editor;
    beforeEach(async () => {
      tempPath = await copyFileToTempDir(
        path.join(paths.withOverrides, '_linter-eslint'),
        '.linter-eslint'
      );
      tempDir = path.dirname(tempPath);
      editor = await openAndSetProjectDir(tempPath, tempDir);
    });

    afterEach(() => {
      // Remove the temporary directory
      rimraf.sync(tempDir);
    });

    it('allows a value defined in .linter-eslint to override a package setting', () => {
      let foo = Config.get('foo');
      expect(foo).toBe('thud');
      expect(atom.config.get('linter-eslint-node.foo')).not.toBe(foo);
    });

    it('does not trigger a change listener if we call atom.config.set on a shadowed setting', () => {
      let handler = makeSpy();
      let disposable = Config.onConfigDidChange(handler.call);
      atom.config.set('linter-eslint-node.foo', 'bar');
      expect(Config.get('foo')).toBe('thud');
      expect(handler.called()).toBe(false);
      disposable.dispose();
    });

    it('triggers a change listener if we call atom.config.set on a non-shadowed setting', () => {
      let handler = makeSpy();
      let disposable = Config.onConfigDidChange(handler.call);
      atom.config.set('linter-eslint-node.bar', 'something');
      expect(Config.get('bar')).toBe('something');
      expect(handler.called()).toBe(true);
      let [config, prevConfig] = handler.calledWith[0];
      expect(config.bar).toBe('something');
      expect(prevConfig.bar).toBe(undefined);
      disposable.dispose();
    });

    it('reacts to changes made to .linter-eslint', async () => {
      editor.setText(JSON.stringify({ foo: 'zort' }));
      await editor.save();
      await wait(1000);

      expect(Config.get('foo')).toBe('zort');
    });

    it('triggers a change listener if we modify .linter-eslint', async () => {
      let handler = makeSpy();
      let disposable = Config.onConfigDidChange(handler.call);
      editor.setText(JSON.stringify({ foo: 'wat' }));
      await editor.save();
      await wait(1000);

      expect(handler.called()).toBe(true);
      let [config, prevConfig] = handler.calledWith[0] || [];
      expect(config.foo).toBe('wat');
      expect(prevConfig.foo).toBe('thud');
      disposable.dispose();
    });

    it('stops treating .linter-eslint as an overrides file if we rename it', async () => {
      expect(Config.get('foo')).toBe('thud');
      fs.renameSync(tempPath, `${tempDir}${path.sep}_linter-eslint`);
      await wait(1000);

      expect(Config.get('foo')).toBe('');
    });

  });

});
