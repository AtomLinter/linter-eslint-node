'use babel';

import { createRunner } from 'atom-jasmine3-test-runner';

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
  specHelper: true
},
() => {
  beforeEach(() => {
    const { configSchema, name } = require("../package.json");
    setDefaultSettings(name, configSchema);
  });
});
