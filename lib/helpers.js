'use babel';
import { Range } from 'atom';
import { generateRange } from 'atom-linter';


export function hasValidScope(editor, scopes) {
  return editor.getCursors()
    .some(
      cursor => (
        cursor.getScopeDescriptor()
          .getScopesArray()
          .some((scope) => scopes.includes(scope))
      )
    );
}

export function generateUserMessage (textEditor, options) {
  const {
    severity = 'error',
    excerpt = '',
    description,
  } = options;
  return [{
    severity,
    excerpt,
    description,
    location: {
      file: textEditor.getPath(),
      position: generateRange(textEditor),
    },
  }];
}

function configThatMayInvalidateWorkerCache (config) {
  let {
    advanced: { disableEslintIgnore } = {},
    autofix: { rulesToDisableWhileFixing } = {}
  } = config;

  return {
    disableEslintIgnore,
    rulesToDisableWhileFixing
  };
}

export function configShouldInvalidateWorkerCache (prev, current) {
  let prevDigest = configThatMayInvalidateWorkerCache(prev);
  let currentDigest = configThatMayInvalidateWorkerCache(current);

  return JSON.stringify(prevDigest) !== JSON.stringify(currentDigest);
}

export function solutionsForFix (fix, textBuffer) {
  let { range, text } = fix;
  let [start, end] = range.map(p => (
    textBuffer.positionForCharacterIndex(p)
  ));

  return [{
    position: new Range(start, end),
    replaceWith: text
  }];
}
