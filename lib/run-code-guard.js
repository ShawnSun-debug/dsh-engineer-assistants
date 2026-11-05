/**
 * What the main agent may put inside a `run_code` program.
 *
 * `run_code` is the PTC transport and the ONE tool a main agent may call directly, so it
 * cannot be hidden or restricted: `tools.restrict({ deny: ['run_code'] })` throws, and
 * hiding it would also hide `tools.delegate`. A nested `await tools.write(...)` still
 * reaches `tools.guard` by name, so the gate already refuses it — but the program itself
 * runs in a Node.js >= 22 subprocess, where two escapes stayed open:
 *
 * - `sandbox_permissions` / `justification` on the `run_code` call escalate the whole
 *   program to a wider sandbox mode, which is a way to write files and spawn `git push`
 *   without ever naming a denied tool.
 * - the program may call the host runtime directly (`import('node:fs')`, `process`,
 *   `fetch`, `eval`, `Function`, `Reflect`, `globalThis`, `Buffer`, `require`) instead of
 *   going through `tools.*`, which no tool-level guard ever sees.
 *
 * The check is lexical, not a regex over the raw text: a main agent's `run_code` body is
 * mostly `await tools.delegate({ prompt: \`...\` })`, and those prompts are full of code
 * snippets that legitimately mention `import("node:fs")`, `process.env`, `fetch()` or
 * `constructor`. Matching the raw source would refuse every such delegation. Instead a
 * character-by-character scanner walks the program and only looks at identifiers in CODE
 * positions, skipping comments, string literals, the static chunks of template literals
 * and regex literals, while still scanning the `${...}` expressions inside a template as
 * real code.
 *
 * `constructor` and `__proto__` are refused wherever they appear in code, because a
 * program that never defines a class never needs them, and `(() => {}).constructor('return
 * process')()` is the shortest way back to the host. The same words inside a prompt are
 * skipped like any other text.
 */

/** The reserved PTC transport. It is never registered, so the gate names it directly. */
export const RUN_CODE_TOOL = 'run_code'

/**
 * Identifiers a main-agent program may not name. Each one is a way to the host runtime
 * that does not pass through `tools.*`: the module loaders, the process/global objects,
 * the network and host-I/O globals, the dynamic-evaluation entries, and the two
 * reflection doors a function object carries.
 */
const FORBIDDEN = new Set([
  'import',
  'require',
  'process',
  'globalThis',
  'global',
  'Buffer',
  'fetch',
  'WebSocket',
  'XMLHttpRequest',
  'eval',
  'Function',
  'Reflect',
  'constructor',
  '__proto__',
])

/**
 * Keywords after which an expression — and therefore a regex literal — may start. A
 * regex is otherwise indistinguishable from division without knowing the previous token,
 * and a misread `/` would let a quote inside a regex desynchronise every later string.
 */
const OPERATOR_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'throw',
])

/** `true` for the characters that may open a JavaScript identifier. */
function isIdentifierStart(code) {
  return (
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 36 || // $
    code === 95 || // _
    code > 127
  )
}

/** `true` for the characters that may continue a JavaScript identifier. */
function isIdentifierPart(code) {
  return isIdentifierStart(code) || (code >= 48 && code <= 57)
}

/** `true` for an ASCII digit. */
function isDigit(char) {
  return char !== undefined && char >= '0' && char <= '9'
}

/** `true` for an ASCII hex digit. */
function isHex(char) {
  return char !== undefined && /[0-9a-fA-F]/.test(char)
}

/**
 * Read a JavaScript unicode escape starting at a backslash: `\uXXXX` or `\u{...}`.
 * Resolving it is what makes `\u0070rocess` and `im\u0070ort` read as `process` and
 * `import` instead of as two harmless identifiers.
 * @returns the decoded text and the index after it, or undefined when this is not a valid escape.
 */
function readUnicodeEscape(source, at) {
  if (source[at] !== '\\' || source[at + 1] !== 'u') return undefined
  if (source[at + 2] === '{') {
    let end = at + 3
    while (end < source.length && source[end] !== '}') {
      if (!isHex(source[end])) return undefined
      end += 1
    }
    if (source[end] !== '}') return undefined
    const digits = source.slice(at + 3, end)
    if (digits.length === 0 || digits.length > 6) return undefined
    const point = Number.parseInt(digits, 16)
    if (!Number.isFinite(point) || point > 0x10ffff) return undefined
    return { text: String.fromCodePoint(point), next: end + 1 }
  }
  const digits = source.slice(at + 2, at + 6)
  if (digits.length !== 4 || ![...digits].every(isHex)) return undefined
  return { text: String.fromCodePoint(Number.parseInt(digits, 16)), next: at + 6 }
}

/**
 * Read one identifier, resolving unicode escapes so the caller compares the name the
 * runtime would see. Stops at the first character that cannot continue the name.
 * @returns the decoded name and the index after it; `next === at` means nothing was read.
 */
function readIdentifier(source, at) {
  let index = at
  let name = ''
  let first = true
  while (index < source.length) {
    if (source[index] === '\\' && source[index + 1] === 'u') {
      const escape = readUnicodeEscape(source, index)
      if (escape === undefined) break
      name += escape.text
      index = escape.next
      first = false
      continue
    }
    const code = source.charCodeAt(index)
    if (first ? !isIdentifierStart(code) : !isIdentifierPart(code)) break
    name += source[index]
    index += 1
    first = false
  }
  return { name, next: index }
}

/**
 * Skip a quoted string, honouring backslash escapes so `'it\\'s'` ends where it should.
 * @returns the index after the closing quote, or the end of the source.
 */
function skipString(source, at) {
  let index = at
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    index += 1
    if (char === "'" || char === '"') return index
    if (char === '\n') return index
  }
  return source.length
}

/**
 * Skip a regex literal starting after its opening slash: backslash escapes and `[...]`
 * character classes are consumed verbatim, so a quote or a slash inside a class can never
 * start a string or end the literal early. A newline before the closing slash means this
 * was division after all, and the caller keeps scanning from the slash.
 * @returns the index after the flags, or undefined when this is not a regex literal.
 */
function skipRegex(source, at) {
  let index = at
  let inClass = false
  while (index < source.length) {
    const char = source[index]
    if (char === '\n') return undefined
    if (char === '\\') {
      index += 2
      continue
    }
    if (inClass) {
      if (char === ']') inClass = false
      index += 1
      continue
    }
    if (char === '[') {
      inClass = true
      index += 1
      continue
    }
    if (char === '/') {
      index += 1
      while (index < source.length && isIdentifierPart(source.charCodeAt(index))) index += 1
      return index
    }
    index += 1
  }
  return undefined
}

/**
 * Skip the static chunk of a template literal, resuming after the opening backtick or
 * after a `}` that closed a `${...}` expression.
 * @returns the index after the chunk and whether it stopped at a `${` (a code position).
 */
function readTemplateChunk(source, at) {
  let index = at
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '`') return { next: index + 1, opensExpression: false }
    if (char === '$' && source[index + 1] === '{') return { next: index + 2, opensExpression: true }
    index += 1
  }
  return { next: source.length, opensExpression: false }
}

/**
 * The first forbidden identifier in a code position, or undefined.
 *
 * The scan is a small lexer: it tracks whether the previous significant token was a value
 * or an operator (to tell a regex from division), and keeps a stack of open constructs so
 * a `}` knows whether it closes a `{` block or returns to the template literal that
 * opened a `${...}`. Comments, strings, template static text and regex literals are
 * consumed without being examined.
 * @param source - the program text of a `run_code` call.
 * @returns the forbidden name as the runtime would resolve it, or undefined.
 */
export function findForbiddenIdentifier(source) {
  if (typeof source !== 'string') return undefined
  const length = source.length
  /** 'value' after something that can end an expression, 'operator' after one that cannot. */
  let previous = 'operator'
  /** Open `{` blocks and `${...}` expressions, innermost last. */
  const stack = []
  let index = 0

  while (index < length) {
    const char = source[index]
    const code = source.charCodeAt(index)

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v' || char === '\ufeff' || char === '\u00a0') {
      index += 1
      continue
    }

    if (char === '/' && source[index + 1] === '/') {
      index += 2
      while (index < length && source[index] !== '\n') index += 1
      continue
    }

    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? length : end + 2
      continue
    }

    if (char === "'" || char === '"') {
      index = skipString(source, index + 1)
      previous = 'value'
      continue
    }

    if (char === '`') {
      const chunk = readTemplateChunk(source, index + 1)
      index = chunk.next
      if (chunk.opensExpression) {
        stack.push('template')
        previous = 'operator'
      } else {
        previous = 'value'
      }
      continue
    }

    if (char === '/') {
      const regex = previous === 'value' ? undefined : skipRegex(source, index + 1)
      if (regex === undefined) {
        index += 1
        previous = 'operator'
        continue
      }
      index = regex
      previous = 'value'
      continue
    }

    if (isIdentifierStart(code) || (char === '\\' && source[index + 1] === 'u')) {
      const read = readIdentifier(source, index)
      if (read.next === index) {
        index += 1
        previous = 'operator'
        continue
      }
      index = read.next
      if (FORBIDDEN.has(read.name)) return read.name
      previous = OPERATOR_KEYWORDS.has(read.name) ? 'operator' : 'value'
      continue
    }

    if (isDigit(char) || (char === '.' && isDigit(source[index + 1]))) {
      index += 1
      while (index < length) {
        const next = source[index]
        if (isIdentifierPart(source.charCodeAt(index)) || next === '.') {
          index += 1
          continue
        }
        if ((next === '+' || next === '-') && (source[index - 1] === 'e' || source[index - 1] === 'E')) {
          index += 1
          continue
        }
        break
      }
      previous = 'value'
      continue
    }

    if (char === '{') {
      stack.push('brace')
      index += 1
      previous = 'operator'
      continue
    }

    if (char === '}') {
      const open = stack.pop()
      index += 1
      if (open === 'template') {
        const chunk = readTemplateChunk(source, index)
        index = chunk.next
        if (chunk.opensExpression) {
          stack.push('template')
          previous = 'operator'
        } else {
          previous = 'value'
        }
        continue
      }
      previous = 'value'
      continue
    }

    if (char === ')' || char === ']') {
      index += 1
      previous = 'value'
      continue
    }

    index += 1
    previous = 'operator'
  }

  return undefined
}

/** The escalation half of the refusal: a wider sandbox mode or a justification on the call. */
const ESCALATION =
  'orchestrator: "run_code" sandbox escalation is not available to the main agent. ' +
  'The main agent only plans; hand every action to a worker with the dispatch tool.'

/**
 * Decide whether one `run_code` call may run.
 *
 * Both checks are refused before the program is executed, so a refused program has no
 * effect: the guard runs in the host's `prepareExecution`, ahead of the body.
 * @param args - the parsed `run_code` arguments (`code`, `description`, and the optional
 *   escalation fields).
 * @param active - whether the gate currently denies anything at all; an empty deny list
 *   means the profile turned the gate off, so nothing is refused here either.
 * @returns the refusal text, or undefined when the call may proceed.
 */
export function runCodeRefusal(args, active = true) {
  if (active !== true) return undefined
  if (args === null || typeof args !== 'object') return undefined
  if (args.sandbox_permissions !== undefined || args.justification !== undefined) return ESCALATION
  const name = findForbiddenIdentifier(args.code)
  if (name === undefined) return undefined
  return (
    'orchestrator: "run_code" cannot reach the Node.js or host runtime ("' +
    name +
    '"). The main agent only plans; hand every action to a worker with the dispatch tool.'
  )
}
