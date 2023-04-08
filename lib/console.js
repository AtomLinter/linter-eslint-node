'use babel';

const CONSOLE = {};

function getEnabled () {
  if (process.env.SILENCE_LOG) { return false; }
  return atom.config.get('linter-eslint-node.advanced.enableLogging');
}

let isEnabled = getEnabled();

atom.config.observe('linter-eslint-node.advanced.enableLogging', () => {
  isEnabled = getEnabled();
});

function makeConsoleMethod (name) {
  return (...args) => {
    if (!isEnabled) { return; }
    return window.console[name](
      '[linter-eslint-node]',
      ...args
    );
  };
}

['log', 'warn', 'error', 'info', 'debug', 'group'].forEach(name => {
  CONSOLE[name] = makeConsoleMethod(name);
});

export default CONSOLE;
