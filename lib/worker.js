// This is a script meant to run in an arbitrary Node environment. It does not
// run within an Atom context and should not `require` anything except (a)
// ESLint itself, (b) built-in Node modules, and (c) pure NPM modules with
// broad cross-Node compatibility.

require('util').inspect.defaultOptions.depth = null;

const { join, dirname } = require('path');
const { createRequire } = require('module');
const compareVersions = require('compare-versions');
const ndjson = require('ndjson');

const MINIMUM_ESLINT_VERSION = '7.0.0';

const PATHS_CACHE = new Map();
const ESLINT_CACHE = new Map();


class IncompatibleVersionError extends Error {
  constructor (version) {
    // eslint-disable-next-line max-len
    let message = `This project uses ESLint version ${version}; linter-eslint-node requires a minimum of ${MINIMUM_ESLINT_VERSION}.`;
    super(message);
    this.name = 'IncompatibleVersionError';
    this.version = version;
  }
}

class VersionOverlapError extends Error {
  constructor (version) {
    let message = `This version of ESLint is compatible with linter-eslint, which is present in this installation of Atom.`;
    super(message);
    this.name = 'VersionOverlapError';
    this.version = version;
  }
}

function isConfigNotFoundError (error) {
  return error.messageTemplate === 'no-config-found';
}

function emit (obj) {
  if (typeof obj !== 'string') {
    obj = JSON.stringify(obj);
  }
  process.stdout.write(`${obj}\n`);
}

function emitError (obj) {
  if (typeof obj !== 'string') {
    obj = JSON.stringify(obj);
  }
  process.stderr.write(`${obj}\n`);
}

function log (message) {
  emit({ log: message });
}

function buildCommonConstructorOptions (config, cwd) {
  let {
    advanced: { disableEslintIgnore },
    autofix: { rulesToDisableWhileFixing }
  } = config;

  return {
    cwd,
    ignore: !disableEslintIgnore,
    // `fix` can be a function, so we'll use it to ignore any rules that the
    // user has told us to ignore. This isn't a "common" option, but it's easy
    // to overwrite with `fix: false` for the lint-only instance.
    fix: ({ ruleId }) => !rulesToDisableWhileFixing.includes(ruleId)
  };
}

function clearESLintCache () {
  for (let key of PATHS_CACHE) {
    PATHS_CACHE.delete(key);
  }
  for (let key of ESLINT_CACHE) {
    ESLINT_CACHE.delete(key);
  }
}

function resolveESLint (filePath) {
  try {
    return createRequire(filePath).resolve('eslint');
  } catch (e) {
    return createRequire(__dirname).resolve('eslint');
  }
}

let builtInEslintPath;
function resolveBuiltInESLint () {
  if (!builtInEslintPath) {
    builtInEslintPath = createRequire(__dirname).resolve('eslint');
  }
  return builtInEslintPath;
}

function getESLint (filePath, config, { legacyPackagePresent }) {
  let resolveDir = dirname(filePath);
  if (!PATHS_CACHE.has(resolveDir)) {
    PATHS_CACHE.set(resolveDir, resolveESLint(filePath));
  }

  let eslintPath = PATHS_CACHE.get(resolveDir);

  // We need to manage an arbitrary number of different ESLint versions without
  // having them clash. On top of that, a declaration of `ESLint` accepts a
  // `cwd` option on instantiation and infers its configuration based on the
  // `.eslintrc`s and `.eslintignore`s that it sees from that particular
  // directory.
  //
  // Thus an `ESLint` instance is good for the directory it was created in and
  // nothing more. If two files are siblings in a project's file tree, linting
  // the first one will create an instance that can be reused when we lint the
  // second, but can't be reused with any file in the parent directory or in
  // any child directories.
  //
  // TODO: Add an option to disable this method of caching. Could be useful as
  // a diagnostic tool and as a workaround when users report bugs.
  if (!ESLINT_CACHE.has(resolveDir)) {
    const eslintRootPath = eslintPath.replace(/eslint([/\\]).*?$/, 'eslint$1');
    const packageMeta = require(join(eslintRootPath, 'package.json'));

    const { ESLint } = createRequire(eslintPath)('eslint');
    let commonOptions = buildCommonConstructorOptions(config, resolveDir);

    const eslintLint = new ESLint({ ...commonOptions, fix: false });
    const eslintFix = new ESLint({ ...commonOptions });

    ESLINT_CACHE.set(resolveDir, {
      ESLint,
      eslintLint,
      eslintFix,
      eslintPath: eslintRootPath,
      eslintVersion: packageMeta.version,
      isBuiltIn: eslintPath === resolveBuiltInESLint()
    });
  }

  let cached = ESLINT_CACHE.get(resolveDir);

  if (compareVersions(cached.eslintVersion, MINIMUM_ESLINT_VERSION) < 1) {
    // Unsupported version.
    throw new IncompatibleVersionError(cached.eslintVersion);
  } else if ((compareVersions(cached.eslintVersion, '8.0.0') < 1) && legacyPackagePresent) {
    // We're dealing with version 7 of ESLint. The legacy `linter-eslint`
    // package is present and capable of linting with this version, so we
    // should halt instead of trying to lint everything twice.
    throw new VersionOverlapError(cached.eslintVersion);
  }

  return cached;
}

async function lint (eslint, workingDir, filePath, fileContent) {
  if (typeof fileContent === 'string') {
    return eslint.lintText(fileContent, { filePath });
  } else {
    return eslint.lintFiles([filePath]);
  }
}

async function lintJob (meta, filePath, fileContent) {
  const { eslintLint, workingDir } = meta;
  return lint(eslintLint, workingDir, filePath, fileContent);
}

async function fixJob (meta, filePath, fileContent) {
  const { ESLint, eslintFix, workingDir } = meta;
  const results = await lint(eslintFix, workingDir, filePath, fileContent);
  await ESLint.outputFixes(results);
  return results;
}

const SEVERITIES = ['info', 'warning', 'error'];

function formatResults (files, rules, config, { isModified, key }) {
  let {
    advanced: { showRuleIdInMessage = true },
    autofix: { ignoreFixableRulesWhileTyping },
    disabling: { rulesToSilenceWhileTyping = [] }
  } = config;
  const results = [];

  for (let { filePath, messages } of files) {
    for (let message of messages) {
      // Filter out any violations that the user has asked to ignore.
      if (isModified && ignoreFixableRulesWhileTyping && message.fix) {
        continue;
      }
      if (isModified && rulesToSilenceWhileTyping.includes(message.ruleId)) {
        continue;
      }

      let idTag = '';
      if (showRuleIdInMessage && message.ruleId) {
        idTag = ` (${message.ruleId})`;
      }

      let rule = rules[message.ruleId];

      let position;
      if (message.fatal) {
        // Parsing errors don't define a range — only a single position. By
        // default, Linter will assume the other point in the range is [0, 0],
        // and report that the parsing error starts at Line 1, Column 1. That's
        // not helpful.
        //
        // Instead, we'll construct our own range that starts at the beginning
        // of the offending line, so that clicking on the message will take us
        // very close to the problem.
        position = [
          [message.line - 1, 0],
          [message.line - 1, message.column - 1]
        ];
      } else {
        position = [
          [message.line - 1, message.column - 1],
          [message.endLine - 1, message.endColumn - 1]
        ];
      }
      results.push({
        severity: SEVERITIES[message.severity] || 'error',
        location: {
          file: filePath,
          position,
        },
        fix: message.fix,
        excerpt: `${message.message}${idTag}`,
        url: rule ? rule.docs.url : undefined
      });
    }
  }
  return { key, rules, results };
}

async function processMessage (bundle) {
  let {
    config,
    contents,
    filePath,
    isModified,
    key,
    legacyPackagePresent,
    type
  } = bundle;

  if (!key) {
    emitError({ error: 'No job key' });
    return;
  }

  if (!type) {
    emit({ key, error: 'No job type' });
  }

  if (type === 'clear-cache') {
    clearESLintCache();
    emit({
      key,
      type: 'clear-cache',
      result: true
    });
    return;
  }

  let eslint;
  try {
    eslint = getESLint(filePath, config, { legacyPackagePresent });
  } catch (err) {
    if (err instanceof IncompatibleVersionError) {
      emit({
        key,
        error: err.message,
        version: err.version,
        type: 'incompatible-version'
      });
    } else if (err instanceof VersionOverlapError) {
      emit({
        key,
        error: err.message,
        version: err.version,
        type: 'version-overlap'
      });
    } else {
      log(`Error: ${err.message}`);
      emit({
        key,
        error: `Can't find an ESLint for file: ${filePath}`,
        type: 'unknown'
      });
    }
    return;
  }

  if (type === 'debug') {
    let { eslintPath, eslintVersion, isBuiltIn } = eslint;
    let isIncompatible = compareVersions(eslintVersion, MINIMUM_ESLINT_VERSION) < 1;
    let isOverlap = (compareVersions(eslintVersion, '8.0.0') < 1) && !isIncompatible;
    emit({
      key,
      type: 'debug',
      eslintPath,
      eslintVersion,
      isIncompatible,
      isOverlap,
      isBuiltIn
    });
    return;
  }

  try {
    let results, rules;
    if (type === 'fix') {
      results = await fixJob(eslint, filePath, contents, config);
      rules = eslint.eslintFix.getRulesMetaForResults(results);
    } else if (type === 'lint') {
      results = await lintJob(eslint, filePath, contents, config);
      rules = eslint.eslintLint.getRulesMetaForResults(results);
    }

    emit(
      formatResults(results, rules, config, { isModified, key })
    );

  } catch (error) {
    if (isConfigNotFoundError(error)) {
      emit({
        key,
        error: error.message,
        type: 'config-not-found'
      });
    }
    error.key = key;
    error.error = 'Unknown error';
    emitError(
      JSON.stringify(error, Object.getOwnPropertyNames(error))
    );
  }
}

if (require.main === module) {
  process.stdin.pipe(ndjson.parse()).on('data', processMessage);
  process.stdin.resume();
  process.on('uncaughtException', (error) => {
    error.uncaught = true;
    error.error = 'Unknown error';
    emitError(
      JSON.stringify(error, Object.getOwnPropertyNames(error))
    );
  });
}
