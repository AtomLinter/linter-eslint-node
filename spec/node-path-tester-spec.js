'use babel';

import NodePathTester from '../lib/node-path-tester';

describe('Node path tester', () => {

  beforeEach(async () => {
    atom.config.set('linter-eslint-node.nodeBin', 'node');

    atom.packages.triggerDeferredActivationHooks();
    atom.packages.triggerActivationHook('core:loaded-shell-environment');

    await atom.packages.activatePackage('language-javascript');
    await atom.packages.activatePackage('linter-eslint-node');
  });

  describe('testSync', () => {
    it('tests the location of nodeBin synchronously', () => {
      expect(NodePathTester.testSync('node')).not.toBe(false);
      expect(NodePathTester.testSync('fdsfljksdafd')).toBe(false);
    });
  });

  describe('test', () => {
    it('tests the location of nodeBin asynchronously', async () => {
      expect(await NodePathTester.test('node')).not.toBe(false);
      try {
        await NodePathTester.test('fdsfljksdafd');
        fail();
      } catch (err) {
        pass();
      }
    });
  });
});
