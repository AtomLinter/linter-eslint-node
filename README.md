# linter-eslint-node package

A “bring-your-own-Node” linter for newer versions of ESLint: v7 and above.

## Installation

```ShellSession
apm install linter-eslint-node
```

The `linter` package will be installed for you if it’s not already present in your Atom installation. If you’re using an alternative `linter-*` consumer, the `linter` package can be disabled.


## Why does this need to exist separate from linter-eslint?

Two reasons:

1. After it was deprecated in v7, the `CLIEngine` class that `linter-eslint` relied upon was removed from ESLint in v8. Its replacement removed a few methods that supported some of `linter-eslint`’s features, making it impossible to abstract away the difference between the two, or to deliver an experience that’s consistent across ESLint versions.

2. As the Node world slowly migrates away from CommonJS and toward [ECMAScript modules][], certain high-profile ESLint plugins now offer native ESM versions. This is not a problem for any recent version of Node, but it is a problem for `linter-eslint`’s practice of linting within a worker script using _Atom’s_ version of Node, which is too old to support ESM and is unlikely to be updated in the near future. The solution to this problem is to switch to a “bring-your-own-Node” model that runs the worker script inside the same version of Node that your project itself uses.

## Should I uninstall linter-eslint?

Depends. The `linter-eslint` package supports **ESLint up through and including v7**. This new package supports **ESLint v7 and greater**. The overlap in v7 is because that’s the one major version where both interfaces, `CLIEngine` and `ESLint`, are available.

If all your projects use ESLint `>=7.0.0`, you can keep this package and uninstall `linter-eslint`. If any of your projects use an older ESLint, you should keep `linter-eslint` installed alongside this package.

Since they can both lint when ESLint 7.x is present, they have to coordinate who does the linting when both packages are installed. **If `linter-eslint` is installed, this package will not perform linting in ESLint 7.x environments** — only 8.x or greater. If only this package is installed, it will lint with any version of ESLint it supports.

## How do I “bring my own Node”?

To run your version of Node, `linter-eslint-node` needs to know _where_ your version of Node is, and that question sometimes has a complex answer.

The command `Linter Eslint Node: Debug` will show a panel with the version of Node that this package will use for a particular project.

### First: just see if it works

If you use exactly one version of Node on your system, there’s a good chance this package will work out of the box without further configuration.

If you manage several versions of Node using a tool like [NVM][], you might still want to do nothing at first and rely on this package’s heuristics to figure out which version of Node to use for a given project. This is highly likely to work if

* you’re on Linux or macOS;
* you only ever open projects from a terminal in which you’ve got NVM installed (and never via your OS’s file browser or **File → Open Recent…**); and
* you are sure to run `nvm use` before running `atom .`, or else have auto-switching set up via `.nvmrc` files.

If you do all these things, the Atom windows you spawn will inherit the environment defined by your shell, including the current value of `$PATH`.

It’s also likely to work if you use a version manager like [Volta][] or [asdf][] in which there’s a single “shim” executable with a consistent location.

### Failing that: set it explicitly

If you use one version of Node on your system, and this package somehow hasn’t inferred it from your `$PATH` variable, then you can use the package settings page to set “Node Binary” manually. On macOS or Linux, `which node` will typically retrieve this path.

If you manage several versions of node with [NVM][] or a similar tool, and sometimes don’t launch a project via the terminal, you might notice this package using your the path to your NVM-default version of Node instead of the correct version for that project.

You can fix this by bypassing our heuristics and setting your Node binary path **on a per-project basis** using one of several methods.

If you’re already using a package like [project-config][] or [atomic-management][], you can specify this setting in a file that resides at `.atom/config.json` (or `config.cson` for atomic-management):

```json
{
  "linter-eslint-node": {
    "nodeBin": "/Users/foo/.nvm/versions/node/v17.4.0/bin/node"
  }
}
```

Otherwise, you can specify your Node binary path (or any other project-specific `linter-eslint-node` settings) with a file called `.linter-eslint` that lives in your project root and contains only configuration settings for this package:

```json
{
  "nodeBin": "/Users/foo/.nvm/versions/node/v17.4.0/bin/node"
}
```

To know which path to use:

* `cd` to your project root in a terminal;
* be sure to run any version-manager-specific commands (like `nvm use`) if necessary; then
* run `which node`.

Keep in mind you’ll have to update this setting whenever you update the version of Node that a given project uses.

## Which ESLint version will this package use?

`linter-eslint-node` will look for a version of `eslint` local to your project, as long as it’s at least v7.0.0. Ideally, this would be installed into a `node_modules` folder in the project root. If it’s in a different location for whatever reason, you can use the `advanced.localNodeModules` setting to specify a path (relative or absolute) in either your `config.cson` or your `.linter-eslint` file.

If it doesn’t find an ESLint in your project, `linter-eslint-node` will fall back to the version it ships with.

## Other configuration

Common JavaScript-derivative languages (TypeScript, Flow, etc.) will also trigger this linter by default. If you’d prefer that they don’t, or if you use a more obscure JS-derivative language that should nonetheless be linted, you can change the list of language scope names in this package’s “List of scopes” setting.


## Using ESLint

Recent versions of ESLint don’t use any rules by default. For all but the most basic of usages, you must create an `.eslintrc` file in your project root:

```ShellSession
npx eslint --init # or without "npx " if installed globally
```

You can also create the `.eslintrc` file manually. It’s a good idea to consult the [ESLint documentation](http://eslint.org/docs/user-guide/configuring), including the [list of rules](http://eslint.org/docs/rules/).

### Plugins

It’s better practice to install ESLint plugins locally in your project, but plugins installed globally will also work just fine. But keep in mind that either way you’ll need to define an `.eslintrc` file in your project that includes those plugins.


[ECMAScript modules]: https://nodejs.org/api/esm.html
[NVM]: https://github.com/nvm-sh/nvm/blob/master/README.md
[Volta]: https://volta.sh/
[asdf]: https://asdf-vm.com/
[project-config]: https://github.com/steelbrain/project-config/
[atomic-management]: https://github.com/harmsk/atomic-management
