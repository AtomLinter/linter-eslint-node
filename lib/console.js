'use babel';

const CONSOLE = {};

const isEnabled = atom.inDevMode() && !process.env.SILENCE_LOG;

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
