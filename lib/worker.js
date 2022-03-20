// This is a script meant to run in an arbitrary Node environment. It does not
// run within an Atom context and should not `require` anything except (a)
// ESLint itself, (b) built-in Node modules, and (c) pure NPM modules with
// broad cross-Node compatibility.

require('util').inspect.defaultOptions.depth = null;

const Path = require('path');
const { existsSync } = require('fs');
const { createRequire } = require('module');
const compareVersions = require('compare-versions');
const ndjson = require('ndjson');

const MINIMUM_ESLINT_VERSION = '7.0.0';

const PATHS_CACHE = new Map();
const ESLINT_CACHE = new Map();

function descendsFrom (filePath, projectPath) {
  if (typeof filePath !== 'string') { return false; }
  return filePath.startsWith(projectPath.endsWith(Path.sep) ? projectPath : `${projectPath}${Path.sep}`);
}

function findCwd (filePath, projectPath) {
  if (typeof filePath !== 'string') { return projectPath; }
  if (!projectPath || !descendsFrom(filePath, projectPath)) {
    return Path.dirname(filePath);
  }

  // Traverse upwards until we find an `.eslintignore` file...
  let filePathParts = Path.dirname(filePath).split(Path.sep);
  let projectPathParts = projectPath.split(Path.sep);
  while (filePathParts.length > projectPathParts.length) {
    let dir = filePathParts.join(Path.sep);
    let hasEslintIgnore = existsSync(Path.join(dir, '.eslintignore'));
    if (hasEslintIgnore) {
      return dir;
    }
    filePathParts.pop();
  }

  // ...but only until we reach the project root. ESLint itself doesn't even
  // check for `.eslintignore`s in any directory but $PWD, and if we don't stop
  // now we're liable to go all the way to the volume root.
  return projectPath;
}

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
    // eslint-disable-next-line max-len
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

// eslint-disable-next-line no-unused-vars
function obj (o) {
  return JSON.stringify(o, null, 2);
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

let builtInEslintPath;
function resolveBuiltInESLint () {
  if (!builtInEslintPath) {
    builtInEslintPath = createRequire(__dirname).resolve('eslint');
  }
  return builtInEslintPath;
}

function resolveESLint (filePath) {
  try {
    return createRequire(filePath).resolve('eslint');
  } catch (e) {
    return resolveBuiltInESLint();
  }
}

function getESLint (filePath, config, { isDebug, legacyPackagePresent, projectPath }) {
  let { advanced: { useCache } } = config;
  // If two files share a `cwd`, we can reuse any `ESLint` instance that was
  // created for one to lint the other. The `cwd` is almost always the project
  // root by convention.
  //
  // But `ESLint` only cares about `$cwd/.eslintignore`, not any others in
  // various folders. So the presence of `.eslintignore` in a folder is a
  // strong signal that someone intended to run `eslint` commands from that
  // folder.
  //
  // So we do this: starting at the file we're about to lint, we traverse
  // upwards until we hit either (a) an `.eslintignore` file, or (b) the
  // project root. This should handle most cases where project root isn't
  // package root; monorepos are the best example I can think of.
  //
  // (TODO: Monorepos, in fact, are the one thing that might thwart our choice
  // to stop looking when we hit the project root. If people complain about
  // this, consider making it a config flag.)
  //
  // We also have to think about the scenario where the file being linted
  // doesn't descend from the project root. Atom will, for instance, happily
  // open your init-file for editing in whatever project you're in at that
  // moment. For those files, we treat the directory they live in as the `cwd`.
  let resolveDir = findCwd(filePath, projectPath);

  if (!useCache || !PATHS_CACHE.has(resolveDir)) {
    PATHS_CACHE.set(resolveDir, resolveESLint(filePath));
  }
  let eslintPath = PATHS_CACHE.get(resolveDir);

  if (!useCache || !ESLINT_CACHE.has(resolveDir)) {
    log(`Creating new ESLint instance with cwd: ${resolveDir}`);
    const eslintRootPath = eslintPath.replace(/eslint([/\\]).*?$/, 'eslint$1');
    const packageMeta = require(Path.join(eslintRootPath, 'package.json'));
    const { ESLint } = createRequire(eslintPath)('eslint');
    let bundle = {
      cwd: resolveDir,
      isBuiltIn: eslintPath === resolveBuiltInESLint(),
      eslintPath: eslintRootPath,
      eslintVersion: packageMeta.version
    };

    // Older versions of ESLint won't have this API.
    if (ESLint) {
      let commonOptions = buildCommonConstructorOptions(config, resolveDir);

      const eslintLint = new ESLint({ ...commonOptions, fix: false });
      const eslintFix = new ESLint({ ...commonOptions });

      Object.assign(bundle, { ESLint, eslintLint, eslintFix });
    }

    ESLINT_CACHE.set(resolveDir, bundle);
  }

  let cached = ESLINT_CACHE.get(resolveDir);

  if (!isDebug) {
    if (compareVersions(cached.eslintVersion, MINIMUM_ESLINT_VERSION) < 1) {
      // Unsupported version.
      throw new IncompatibleVersionError(cached.eslintVersion);
    } else if ((compareVersions(cached.eslintVersion, '8.0.0') < 1) && legacyPackagePresent) {
      // We're dealing with version 7 of ESLint. The legacy `linter-eslint`
      // package is present and capable of linting with this version, so we
      // should halt instead of trying to lint everything twice.
      throw new VersionOverlapError(cached.eslintVersion);
    }
  }

  return cached;
}

async function lint (eslint, filePath, fileContent) {
  if (typeof fileContent === 'string') {
    return eslint.lintText(fileContent, { filePath });
  } else {
    return eslint.lintFiles([filePath]);
  }
}

async function lintJob (meta, filePath, projectPath, fileContent) {
  const { eslintLint } = meta;
  return lint(eslintLint, filePath, fileContent);
}

async function fixJob (meta, filePath, projectPath, fileContent) {
  const { ESLint, eslintFix } = meta;
  const results = await lint(eslintFix, filePath, fileContent);
  await ESLint.outputFixes(results);
  return results;
}

function countMessages (results) {
  let count = 0;
  for (let { messages } of results) {
    count += messages.length;
  }
  return count;
}

const SEVERITIES = ['info', 'warning', 'error'];

function formatResults (files, rules, config, { isModified, key, isFixJob, lintMessageCount }) {
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
      if (showRuleIdInMessage) {
        idTag = message.fatal ? ` (Fatal)` : ` (${message.ruleId})`;
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
          position
        },
        fix: message.fix,
        excerpt: `${message.message}${idTag}`,
        url: rule ? rule.docs.url : undefined
      });
    }
  }
  let result = { key, rules, results };
  if (isFixJob && lintMessageCount) {
    result.fixCount = lintMessageCount - results.length;
  }
  return result;
}

async function processMessage (bundle) {
  let {
    config,
    contents,
    filePath,
    isModified,
    key,
    legacyPackagePresent,
    projectPath = null,
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
    eslint = getESLint(filePath, config, {
      isDebug: type === 'debug',
      legacyPackagePresent,
      projectPath
    });
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
        stack: err.stack,
        type: 'unknown'
      });
    }
    return;
  }

  const oldCwd = process.cwd();
  process.chdir(eslint.cwd);

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
      isBuiltIn,
      workerPid: process.pid
    });
    process.chdir(oldCwd);
    return;
  }

  try {
    let results, rules, lintMessageCount;
    if (type === 'fix') {
      let lintResults = await lintJob(eslint, filePath, projectPath, contents, config);
      lintMessageCount = countMessages(lintResults);
      results = await fixJob(eslint, filePath, projectPath, contents, config);
      rules = eslint.eslintFix.getRulesMetaForResults(results);
    } else if (type === 'lint') {
      results = await lintJob(eslint, filePath, projectPath, contents, config);
      rules = eslint.eslintLint.getRulesMetaForResults(results);
    }

    emit(
      formatResults(results, rules, config, {
        isModified,
        key,
        isFixJob: type === 'fix',
        lintMessageCount
      })
    );

  } catch (error) {
    if (isConfigNotFoundError(error)) {
      emit({
        key,
        error: error.message,
        type: 'config-not-found'
      });
      return;
    }
    error.key = key;
    error.error = error.message || 'Unknown error';
    emitError(
      JSON.stringify(error, Object.getOwnPropertyNames(error))
    );
  } finally {
    process.chdir(oldCwd);
  }
}

if (require.main === module) {
  process.stdin.pipe(ndjson.parse({ strict: false })).on('data', processMessage);
  process.stdin.resume();
  process.on('uncaughtException', (error) => {
    error.uncaught = true;
    error.error = 'Unknown error';
    emitError(
      JSON.stringify(error, Object.getOwnPropertyNames(error))
    );
  });
  process.title = `node (linter-eslint-node worker ${process.pid})`;
  emit({ type: 'ready' });
}
