'use babel';

import { createRunner } from 'atom-jasmine3-test-runner';
import childProcess from 'child_process';

if (process.env.PATH === '/usr/bin:/bin:/usr/sbin:/sbin') {
  // If the PATH value is the default, we're probably in a GUI spec-runner
  // window that has failed to inherit its PATH variable from the window that
  // spawned it. This happened sporadically in Atom but is happening
  // consistently in Pulsar. This is a quick fix.
  let shellOutput = childProcess.execFileSync(
    process.env.SHELL,
    ['-i', '-c', 'echo $PATH']
  ).toString().trim().split('\n');
  process.env.PATH = shellOutput[shellOutput.length - 1];
}

function setDefaultSettings(namespace, settings) {
  for (const name in settings) {
    const setting = settings[name];
    if (setting.type === "object") {
      setDefaultSettings(`${namespace}.${name}`, setting.properties);
    } else {
      atom.config.set(`${namespace}.${name}`, setting.default);
    }
  }
}

module.exports = createRunner({
  testPackages: ['linter', 'linter-ui-default'],
  timeReporter: true,
  specHelper: {
    atom: true,
    attachToDom: true,
    ci: true,
    customMatchers: true,
    jasmineFocused: true,
    jasmineJson: true,
    jasminePass: true,
    jasmineTagged: true,
    mockClock: false,
    mockLocalStorage: true,
    profile: true,
    set: true,
    unspy: true
  }
},
() => {
  beforeEach(() => {
    const { configSchema, name } = require("../package.json");
    setDefaultSettings(name, configSchema);
  });
});
