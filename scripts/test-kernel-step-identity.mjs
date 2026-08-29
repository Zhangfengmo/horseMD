// TDD evidence + regression lock for MINIFICATION-PROOF ProseMirror step
// identification in the source-authoritative kernel (defect D4).
//
// THE DEFECT
// ----------
// editor-kernel-gateway.js identified every ProseMirror Step by
// `step?.constructor?.name === 'ReplaceStep'` (and 'AttrStep',
// 'AddMarkStep', 'RemoveMarkStep', 'ReplaceAroundStep'). A JavaScript class's
// `.name` is a MINIFIER-OWNED identifier, not a stable fact about the object.
// `vite build --config vite.mobile.config.mjs` (npm run build:mobile) uses
// Vite's default `build.minify: 'esbuild'`, which renames `class ReplaceStep`
// to `class ki`. Every one of those checks then fails, every extractor
// returns null, `classifyTransactions` answers `blocked`/INPUT_TYPE, and the
// dispatch veto refuses EVERY keystroke — a silently read-only editor.
// The observed diagnostic in that build was literally:
//   {"code":"unsupported-input-type","shape":"ki[1,1]@heading:d1:off0 open0/0 <text>"}
// The desktop app escapes only because electron-vite happens to emit an
// unminified renderer, i.e. the kernel's correctness depended on a build flag
// nobody guarded.
//
// THE FIX UNDER TEST
// ------------------
// Steps are identified by their prosemirror-transform JSON id.
// `Step.jsonID(id, stepClass)` (node_modules/prosemirror-transform/dist/
// index.js:366-372, v1.12.0) does `stepClass.prototype.jsonID = id` — an OWN
// property of that class's prototype, holding a STRING LITERAL ('replace',
// 'replaceAround', 'attr', 'addMark', 'removeMark', ...). esbuild renames
// bindings, not string literals, and does not mangle property names without
// an explicit `mangleProps` (this repo configures none), so both the property
// and its value survive minification unchanged.
//
// WHAT THIS FILE PROVES
// ---------------------
//   Case R  — rename simulation: real steps, real classification, with every
//             step class's `.name` overwritten exactly the way esbuild does
//             it (`Object.defineProperty(cls, 'name', { value: 'ki' })`).
//   Case M  — the honest one: a REAL esbuild-MINIFIED bundle containing the
//             gateway AND prosemirror-transform/-state/-model together, so
//             the step classes are genuinely renamed by the minifier and the
//             gateway inside the same bundle has to identify them anyway.
//   Case G  — a source guard, so this cannot silently come back: no kernel
//             source file may compare anything against a ProseMirror step
//             class NAME.
//
// Run: node scripts/test-kernel-step-identity.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { toggleMark } from '@milkdown/prose/commands'
import { classifyTransactions } from '../src/renderer/src/components/editor-kernel-gateway.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push(`  ok  ${name}`)
  } catch (err) {
    results.push(`  FAIL ${name}\n       ${err.message.split('\n').join('\n       ')}`)
    process.exitCode = 1
  }
}

// --- fixture schema (mirrors the live Milkdown node/mark names) -------------
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*', attrs: { checked: { default: null } } },
    code_block: { content: 'text*', group: 'block', code: true, attrs: { language: { default: '' } } },
    text: { group: 'inline' }
  },
  marks: {
    strong: {},
    emphasis: {}
  }
})

const doc = (...blocks) => schema.nodes.doc.create(null, blocks)
const para = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null)

// Each fixture returns { transactions, oldState, expectKind }. They are built
// through the REAL Transform API (tr.insertText / tr.setNodeAttribute /
// toggleMark), so the step objects are genuine prosemirror-transform
// instances, never hand-rolled shapes.
const fixtures = {
  // ReplaceStep — the plain-typing path, the one whose failure makes the
  // whole editor read-only.
  'plain typing (ReplaceStep)': () => {
    const state = EditorState.create({ doc: doc(para('hello')) })
    const tr = state.tr.insertText('x', 6, 6)
    return { transactions: [tr], oldState: state, expectKind: 'plain-text' }
  },
  // AttrStep (attr === 'checked') — the task-checkbox toggle.
  'task toggle (AttrStep)': () => {
    const item = schema.nodes.list_item.create({ checked: false }, para('todo'))
    const list = schema.nodes.bullet_list.create(null, item)
    const state = EditorState.create({ doc: doc(list) })
    const tr = state.tr.setNodeAttribute(1, 'checked', true)
    return { transactions: [tr], oldState: state, expectKind: 'task-toggle' }
  },
  // AttrStep (attr === 'language') — the code-block language switch.
  'code language (AttrStep)': () => {
    const block = schema.nodes.code_block.create({ language: '' }, schema.text('x'))
    const state = EditorState.create({ doc: doc(block) })
    const tr = state.tr.setNodeAttribute(0, 'language', 'js')
    return { transactions: [tr], oldState: state, expectKind: 'code-language' }
  },
  // AddMarkStep — the bold/italic toolbar + Mod-b keymap path.
  'mark toggle (AddMarkStep)': () => {
    const state = EditorState.create({
      doc: doc(para('hello')),
      selection: undefined
    })
    const withSel = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1, 6))
    )
    let captured = null
    toggleMark(schema.marks.strong)(withSel, (tr) => { captured = tr })
    assert.ok(captured, 'toggleMark did not dispatch')
    return { transactions: [captured], oldState: withSel, expectKind: 'mark-toggle' }
  }
}

// Every distinct step constructor a fixture produces (so the rename covers
// exactly the classes the gateway has to identify).
const stepClassesOf = (transactions) => {
  const set = new Set()
  for (const tr of transactions) for (const step of tr.steps) set.add(step.constructor)
  return set
}

// =========================================================================
// Case R — esbuild's rename, simulated in-process
// =========================================================================
// Sanity first: unrenamed, these classify as expected. If THIS fails the
// fixtures are wrong, not the fix.
for (const [name, build] of Object.entries(fixtures)) {
  check(`R0 baseline (unminified) — ${name}`, () => {
    const { transactions, oldState, expectKind } = build()
    const out = classifyTransactions(transactions, oldState)
    assert.equal(out.kind, expectKind, `got ${out.kind} (${out.blockedShape || ''})`)
  })
}

// Now the actual defect: rename the classes the way esbuild does and re-run.
for (const [name, build] of Object.entries(fixtures)) {
  check(`R1 esbuild-renamed constructors — ${name}`, () => {
    const { transactions, oldState, expectKind } = build()
    const classes = stepClassesOf(transactions)
    const restore = []
    for (const cls of classes) {
      restore.push([cls, Object.getOwnPropertyDescriptor(cls, 'name')])
      // Exactly what esbuild emits: `class ki extends xt { … }`.
      Object.defineProperty(cls, 'name', { value: 'ki', configurable: true })
    }
    try {
      assert.ok([...classes].every((c) => c.name === 'ki'), 'rename did not take')
      const out = classifyTransactions(transactions, oldState)
      assert.equal(
        out.kind,
        expectKind,
        `minified build classified as ${out.kind}` +
        (out.blockedShape ? ` — shape "${out.blockedShape}"` : '')
      )
    } finally {
      for (const [cls, desc] of restore) Object.defineProperty(cls, 'name', desc)
    }
  })
}

// The diagnostic string must stay readable too — "ki[1,1]@…" told the
// 2026-08 investigator nothing. A genuinely unsupported step under renamed
// classes must still name itself with a stable id.
check('R2 blocked-shape diagnostics survive the rename', () => {
  const state = EditorState.create({ doc: doc(para('a'), para('b')) })
  // A TWO-step chain (cross-block delete + insert): still refused by design.
  // (A LONE cross-block delete routes to the paste kind since 2026-08-30, so
  // it no longer serves as this test's blocked example — the test's subject
  // is the DIAGNOSTIC string, not the deletion.)
  const tr = state.tr.delete(2, 4).insertText('Z', 1)
  const classes = stepClassesOf([tr])
  const restore = []
  for (const cls of classes) {
    restore.push([cls, Object.getOwnPropertyDescriptor(cls, 'name')])
    Object.defineProperty(cls, 'name', { value: 'ki', configurable: true })
  }
  try {
    const out = classifyTransactions([tr], state)
    assert.equal(out.kind, 'blocked')
    assert.ok(
      /^replace\[/.test(out.blockedShape || ''),
      `blockedShape should start with the stable step id, got "${out.blockedShape}"`
    )
  } finally {
    for (const [cls, desc] of restore) Object.defineProperty(cls, 'name', desc)
  }
})

// =========================================================================
// Case E — the fix must be EXACTLY-THIS-TYPE, not a subclass test
// =========================================================================
// `jsonID` is inherited, so a naive `step.jsonID === 'replace'` would accept
// an UNREGISTERED subclass of ReplaceStep that the old `.name` comparison
// refused — a widening, and this architecture never widens to make something
// pass. The implementation therefore requires the id to be an OWN property of
// the instance's immediate prototype, which is where `Step.jsonID` writes it
// and which a subclass's own prototype does not have.
check('E1 an unregistered ReplaceStep SUBCLASS is still refused', () => {
  const state = EditorState.create({ doc: doc(para('hello')) })
  const tr = state.tr.insertText('x', 6, 6)
  const real = tr.steps[0]
  assert.equal(Object.getPrototypeOf(real).jsonID, 'replace', 'fixture precondition')

  class SneakyStep extends real.constructor {}
  // Same fields, same inherited jsonID ('replace'), different concrete class.
  Object.setPrototypeOf(real, SneakyStep.prototype)
  assert.equal(real.jsonID, 'replace', 'subclass still INHERITS the id')
  assert.equal(
    Object.prototype.hasOwnProperty.call(SneakyStep.prototype, 'jsonID'),
    false,
    'a subclass prototype must not own the id'
  )

  const out = classifyTransactions([tr], state)
  assert.equal(out.kind, 'blocked', `subclass was accepted as ${out.kind}`)
})

check('E2 a step with no registered id is refused (fail-closed)', () => {
  const state = EditorState.create({ doc: doc(para('hello')) })
  const tr = state.tr.insertText('x', 6, 6)
  // A JSON round-trip / plain object: prototype carries no id at all.
  Object.setPrototypeOf(tr.steps[0], Object.prototype)
  const out = classifyTransactions([tr], state)
  assert.equal(out.kind, 'blocked', `unregistered step accepted as ${out.kind}`)
  // The diagnostic must not INVENT a stable id it could not read; it falls
  // back to the (minifier-owned, but last-resort) class name instead.
  assert.ok(!/^replace\[/.test(out.blockedShape || ''),
    `refused step must not be labelled with a registered id, got "${out.blockedShape}"`)
})

// =========================================================================
// Case M — a REAL esbuild-minified bundle
// =========================================================================
// The gateway, prosemirror-transform, prosemirror-state and prosemirror-model
// are bundled TOGETHER and minified, so the step classes are renamed by the
// actual minifier (not by a test helper) and the gateway must still identify
// them. This is the production shape of `npm run build:mobile`.
const runMinifiedBundleCase = async () => {
  const { build } = await import('esbuild')
  const dir = mkdtempSync(join(tmpdir(), 'hm-step-identity-'))
  try {
    const entry = join(dir, 'entry.mjs')
    writeFileSync(entry, `
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { toggleMark } from '@milkdown/prose/commands'
import { classifyTransactions } from ${JSON.stringify(resolve(repoRoot, 'src/renderer/src/components/editor-kernel-gateway.js'))}

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*', attrs: { checked: { default: null } } },
    code_block: { content: 'text*', group: 'block', code: true, attrs: { language: { default: '' } } },
    text: { group: 'inline' }
  },
  marks: { strong: {}, emphasis: {} }
})
const doc = (...b) => schema.nodes.doc.create(null, b)
const para = (t) => schema.nodes.paragraph.create(null, t ? schema.text(t) : null)

export function run() {
  const out = {}

  {
    const state = EditorState.create({ doc: doc(para('hello')) })
    const tr = state.tr.insertText('x', 6, 6)
    out.stepClassName = tr.steps[0].constructor.name
    out.plain = classifyTransactions([tr], state)
  }
  {
    const item = schema.nodes.list_item.create({ checked: false }, para('todo'))
    const state = EditorState.create({ doc: doc(schema.nodes.bullet_list.create(null, item)) })
    out.task = classifyTransactions([state.tr.setNodeAttribute(1, 'checked', true)], state)
  }
  {
    const block = schema.nodes.code_block.create({ language: '' }, schema.text('x'))
    const state = EditorState.create({ doc: doc(block) })
    out.language = classifyTransactions([state.tr.setNodeAttribute(0, 'language', 'js')], state)
  }
  {
    const base = EditorState.create({ doc: doc(para('hello')) })
    const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1, 6)))
    let captured = null
    toggleMark(schema.marks.strong)(state, (tr) => { captured = tr })
    out.mark = classifyTransactions([captured], state)
  }
  return out
}
`)
    const outfile = join(dir, 'bundle.mjs')
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      minify: true,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      absWorkingDir: repoRoot,
      // The entry lives in /tmp, so bare specifiers have no node_modules to
      // walk up to; point esbuild at the repo's.
      nodePaths: [resolve(repoRoot, 'node_modules')],
      logLevel: 'silent'
    })
    const mod = await import(pathToFileURL(outfile).href)
    const out = mod.run()

    check('M0 the bundle really is minified (step class name mangled)', () => {
      assert.notEqual(
        out.stepClassName,
        'ReplaceStep',
        'esbuild did not rename the step class — this case would prove nothing'
      )
    })
    check('M1 minified bundle — plain typing (ReplaceStep)', () => {
      assert.equal(out.plain.kind, 'plain-text',
        `got ${out.plain.kind}; class was renamed to "${out.stepClassName}"` +
        (out.plain.blockedShape ? ` — shape "${out.plain.blockedShape}"` : ''))
    })
    check('M2 minified bundle — task toggle (AttrStep)', () => {
      assert.equal(out.task.kind, 'task-toggle', `got ${out.task.kind}`)
    })
    check('M3 minified bundle — code language (AttrStep)', () => {
      assert.equal(out.language.kind, 'code-language', `got ${out.language.kind}`)
    })
    check('M4 minified bundle — mark toggle (AddMarkStep)', () => {
      assert.equal(out.mark.kind, 'mark-toggle', `got ${out.mark.kind}`)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// =========================================================================
// Case G — source guard
// =========================================================================
// The kernel must never again decide anything from a ProseMirror class NAME.
// Scanned files: every editor-kernel-*.js plus the whole source-kernel lib.
// (src/renderer/src/lib/source-transaction-sync.js is deliberately OUT of
// scope — it is the LEGACY rich→source path, not the kernel; it carries the
// same hazard and is reported separately.)
const PM_CLASS_NAMES = [
  'ReplaceStep', 'ReplaceAroundStep', 'AttrStep', 'DocAttrStep',
  'AddMarkStep', 'RemoveMarkStep', 'AddNodeMarkStep', 'RemoveNodeMarkStep'
]
// Matches both `x.constructor.name !== 'ReplaceStep'` and the indirect
// `const name = step?.constructor?.name; if (name !== 'AddMarkStep')`.
const COMPARISON_RE = new RegExp(
  `(?:[!=]==?\\s*['"](?:${PM_CLASS_NAMES.join('|')})['"])` +
  `|(?:['"](?:${PM_CLASS_NAMES.join('|')})['"]\\s*[!=]==?)`
)

const kernelSourceFiles = () => {
  const files = []
  const componentsDir = resolve(repoRoot, 'src/renderer/src/components')
  for (const name of readdirSync(componentsDir)) {
    if (/^editor-kernel-.*\.js$/.test(name)) files.push(join(componentsDir, name))
  }
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.js')) files.push(full)
    }
  }
  walk(resolve(repoRoot, 'src/renderer/src/lib/source-kernel'))
  return files
}

check('G1 no kernel source compares against a ProseMirror step class name', () => {
  const offenders = []
  for (const file of kernelSourceFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // Prose/comments legitimately mention the class names; only CODE
      // comparisons are the hazard.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (COMPARISON_RE.test(line)) {
        offenders.push(`${file.slice(repoRoot.length + 1)}:${i + 1}: ${line.trim()}`)
      }
    })
  }
  assert.deepEqual(
    offenders,
    [],
    'ProseMirror class names are minifier-owned; identify steps by `jsonID`.\n' +
    offenders.join('\n')
  )
})

await runMinifiedBundleCase()

console.log('kernel step identity (D4 — minification-proof step classification)')
console.log(results.join('\n'))
if (process.exitCode) {
  console.log('\nFAILED')
} else {
  console.log('\nAll kernel step-identity cases passed.')
}
