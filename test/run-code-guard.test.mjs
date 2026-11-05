import assert from 'node:assert/strict'
import test from 'node:test'
import { findForbiddenIdentifier, runCodeRefusal, RUN_CODE_TOOL } from '../lib/run-code-guard.js'

const ESCALATION =
  'orchestrator: "run_code" sandbox escalation is not available to the main agent. The main agent only plans; hand every action to a worker with the dispatch tool.'

/** A refusal for one host identifier, in the exact wording the guard produces. */
function refusalFor(name) {
  return (
    'orchestrator: "run_code" cannot reach the Node.js or host runtime ("' +
    name +
    '"). The main agent only plans; hand every action to a worker with the dispatch tool.'
  )
}

/** The arguments object of one run_code call, as the host parses it. */
function call(code) {
  return { code, description: 'a program' }
}

test('the reserved transport name is the one the host reserves', () => {
  assert.equal(RUN_CODE_TOOL, 'run_code')
})

test('the reported bypass is refused: a program that imports a Node module', () => {
  const code =
    'const fs = await import("node:fs/promises");\n' +
    'const cp = await import("node:child_process");\n' +
    'await fs.writeFile("x", "y");'
  assert.equal(findForbiddenIdentifier(code), 'import')
  assert.equal(runCodeRefusal(call(code)), refusalFor('import'))
})

test('every host entry point is refused in a code position', () => {
  const cases = [
    ['require("node:fs")', 'require'],
    ['process.getBuiltinModule("fs")', 'process'],
    ['process.binding("fs")', 'process'],
    ['process.dlopen(module, "x")', 'process'],
    ['process.env.HOME', 'process'],
    ['fetch("https://example.com")', 'fetch'],
    ['new WebSocket("ws://example.com")', 'WebSocket'],
    ['new XMLHttpRequest()', 'XMLHttpRequest'],
    ['globalThis.process', 'globalThis'],
    ['global.process', 'global'],
    ['Buffer.from("x")', 'Buffer'],
    ['eval("1")', 'eval'],
    ['new Function("return process")()', 'Function'],
    ['(()=>{}).constructor("return process")()', 'constructor'],
    ['Reflect.get(globalThis, "process")', 'Reflect'],
    ['({}).__proto__', '__proto__'],
  ]
  for (const [code, name] of cases) {
    assert.equal(findForbiddenIdentifier(code), name, code)
    assert.equal(runCodeRefusal(call(code)), refusalFor(name), code)
  }
})

test('a unicode escape in an identifier is resolved before it is compared', () => {
  // \u0070rocess is the runtime's process; the raw text is not.
  assert.equal(findForbiddenIdentifier('\\u0070rocess.getBuiltinModule("fs")'), 'process')
  assert.equal(findForbiddenIdentifier('im\\u0070ort("node:fs")'), 'import')
  assert.equal(findForbiddenIdentifier('\\u{70}rocess.pid'), 'process')
  assert.equal(findForbiddenIdentifier('f\\u0065tch("x")'), 'fetch')
  assert.equal(runCodeRefusal(call('\\u0070rocess.exit(0)')), refusalFor('process'))
})

test('an escalation field on the call is refused before the program is read', () => {
  for (const permissions of ['workspace-write', 'danger-full-access']) {
    assert.equal(runCodeRefusal({ ...call(''), sandbox_permissions: permissions }), ESCALATION)
  }
  assert.equal(runCodeRefusal({ ...call(''), justification: 'needs to push' }), ESCALATION)
  // Both together, and an escalation with a harmless program, are the same refusal.
  assert.equal(
    runCodeRefusal({ code: 'return 1', sandbox_permissions: 'danger-full-access', justification: 'x' }),
    ESCALATION,
  )
})

test('an expression inside a template literal is code and is scanned', () => {
  const injection = 'await tools.delegate({ prompt: `${await import("node:fs")}` })'
  assert.equal(findForbiddenIdentifier(injection), 'import')
  assert.equal(runCodeRefusal(call(injection)), refusalFor('import'))
})

test('a nested template literal inside an expression is still scanned', () => {
  const nested = 'const x = `a${ `b${ process.pid }c` }d`'
  assert.equal(findForbiddenIdentifier(nested), 'process')
  // A template nested inside a block inside an expression resumes correctly.
  const blocked = 'const y = `${ (() => { return `${ fetch("u") }` })() }`'
  assert.equal(findForbiddenIdentifier(blocked), 'fetch')
})

test('a static template chunk, a string and a comment are text, not code', () => {
  assert.equal(findForbiddenIdentifier('const s = `import("node:fs") process.env`'), undefined)
  assert.equal(findForbiddenIdentifier("const s = 'eval(process.env)'"), undefined)
  assert.equal(findForbiddenIdentifier("const s = \"require('node:fs')\""), undefined)
  assert.equal(findForbiddenIdentifier('// import("node:fs") and process.env'), undefined)
  assert.equal(findForbiddenIdentifier('/* fetch("x") globalThis */ const a = 1'), undefined)
  // A comment inside a template expression is a comment there too.
  assert.equal(findForbiddenIdentifier('const t = `${ 1 /* process */ }`'), undefined)
})

test('a regex literal never desynchronises the scan, and division is not a regex', () => {
  // A quote and a slash inside a character class must not open a string.
  assert.equal(findForbiddenIdentifier('const r = /[/"]/g; const q = 1'), undefined)
  assert.equal(findForbiddenIdentifier('const r = /a\\/b/; const q = 2'), undefined)
  // After a value a slash is division, so the code after it is code again.
  assert.equal(findForbiddenIdentifier('const a = b / c; const d = /x/.test(s)'), undefined)
  assert.equal(findForbiddenIdentifier('const r = /[/"]/; process.exit(0)'), 'process')
  // A regex that spells a forbidden word is still only a regex.
  assert.equal(findForbiddenIdentifier('const r = /process|import|fetch/'), undefined)
})

test('an ordinary delegation program passes untouched', () => {
  const program = [
    'const results = await Promise.all([',
    '  tools.delegate({ description: "read a file", prompt: "read it" }),',
    '  tools.orchestrate({ items: [1, 2], stages: [{ name: "s", prompt: "do it" }] }),',
    '])',
    'await tools.send_message({ agent_id: "child-1", message: "go on" })',
    'const x: Record<string, unknown> = { a: JSON.stringify(results) }',
    'try { await tools.delegate({ description: "b", prompt: "c" }) } catch (error) { if (error instanceof ToolCallError) console.log(error.message) }',
    'return x',
  ].join('\n')
  assert.equal(findForbiddenIdentifier(program), undefined)
  assert.equal(runCodeRefusal(call(program)), undefined)
})

test('a prompt full of host code is a prompt, not a program', () => {
  // The shape a main agent really sends: one huge template literal, full of code it
  // wants a WORKER to write, including the very identifiers the gate refuses.
  const fence = String.fromCharCode(96, 96, 96)
  const prompt = [
    'Write lib/probe.mjs exactly like this:',
    '',
    fence + 'js',
    'const fs = await import("node:fs/promises")',
    'const cp = await import("node:child_process")',
    'const raw = process.getBuiltinModule("child_process")',
    'const home = process.env.HOME',
    'const res = await fetch("https://example.com")',
    'const all = globalThis',
    'eval("1")',
    'new Function("return process")()',
    'class Probe { constructor() { this.kind = "probe" } }',
    'const re = /[/"]\\/([a-z]+)/g',
    '// a comment about import("node:fs") and constructor',
    'const quoted = "an escaped \\" quote"',
    'const x: Record<string, unknown> = { a: 1 }',
    fence,
    '',
    'Also pass sandbox_permissions: "workspace-write" if the tool asks.',
  ].join('\n')
  // A prompt that carries its own fence escapes it, exactly as the model must.
  const escaped = prompt.split(fence).join('\\' + fence)
  const program = 'await tools.delegate({ description: "write probe", prompt: `' + escaped + '` })'
  assert.equal(findForbiddenIdentifier(program), undefined)
  assert.equal(runCodeRefusal(call(program)), undefined)

  // The same text as a quoted string, and as an orchestrate stage prompt.
  const quoted = 'await tools.orchestrate({ items: ["a"], stages: [{ name: "s", prompt: ' + JSON.stringify(prompt) + ' }] })'
  assert.equal(runCodeRefusal(call(quoted)), undefined)
})

test('an empty or non-string program is never refused', () => {
  assert.equal(runCodeRefusal(call('')), undefined)
  assert.equal(runCodeRefusal({}), undefined)
  assert.equal(runCodeRefusal({ code: 42 }), undefined)
  assert.equal(runCodeRefusal(undefined), undefined)
  assert.equal(runCodeRefusal(null), undefined)
  assert.equal(runCodeRefusal('run_code'), undefined)
})

test('an inactive gate lets everything through', () => {
  const escalated = { ...call('await import("node:fs")'), sandbox_permissions: 'danger-full-access' }
  assert.equal(runCodeRefusal(escalated, false), undefined)
  assert.equal(runCodeRefusal(call('process.exit(0)'), false), undefined)
  // The default is active: an omitted flag still refuses a host import.
  assert.equal(runCodeRefusal(call('await import("node:fs")')), refusalFor('import'))
})
