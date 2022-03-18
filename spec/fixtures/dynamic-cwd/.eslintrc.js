const { join } = require('path');

const getEcmaVersionForNodeVersion = (nodeVersion) => {
  if (nodeVersion === '16.0.0') {
    return 'es2021';
  }

  // Would really need to do more detection
  return 'es2015';
};

const detectNodeVersion = (packagePath) => {
  const { engines: { node } } = require(packagePath);

  // Would really want to use semver.minVersion, wrap in try-catch, etc.
  return node;
};

const nodeVersion = detectNodeVersion(join(process.cwd(), 'package.json'));
const ecmaVersion = getEcmaVersionForNodeVersion(nodeVersion);

module.exports = {
  "root": true,
  "env": {
    [ecmaVersion]: true
  }
};
