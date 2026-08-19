// LEGACY LOCK — not a regression for any source-kernel change.
//
// What it pins: in LEGACY (non-kernel) mode, source generated from the
// empty-file H1 scaffold must preserve a first whitespace character (Tab or
// Space, alone or followed by text) already present in the heading when saving.
// It asserts the ENTITY spelling (`&#x9;` / `&nbsp;`) and DISK BYTES ONLY —
// nothing here checks that the character is visible, addressable or deletable
// in the editor, so on its own it cannot tell "portable source" apart from a
// dead byte the user can never see or remove.
//
// It is deliberately kept only because legacy mode still ships and must not
// BREAK while it does. It passes unmodified against builds from before the
// source-kernel work, so it is evidence for nothing that work changed. The
// kernel-mode contract is a different (and stronger) one: real whitespace
// characters (U+00A0), asserted VISIBLE, addressable and deletable, in
// scripts/test-kernel-heading-whitespace-ui.mjs. When legacy mode is removed,
// delete this file with it — do not "upgrade" its expectation, and never cite
// it as proof that kernel-mode whitespace works.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-scratch-heading-leading-whitespace-${process.pid}`
const file = join(root, 'scratch.md')
const port = Number(process.env.CDP_PORT || 10018)

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function saveSingleLeadingCharacter({ character, expected, suffix, text = '' }) {
  await writeFile(file, '')
  let app
  try {
    const installedExecutable = process.env.HORSEMD_EXECUTABLE || ''
    app = await launchBuiltElectron({
      profileDir: join(root, `profile-${suffix}`),
      port: port + (character === '\t' ? 0 : 1),
      appArgs: [file],
      executable: installedExecutable || undefined,
      entrypoint: installedExecutable ? null : undefined
    })
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror h1')].find((node) => node.offsetParent)`),
      `${suffix}: initial heading did not mount`
    )
    await evaluate('window.__hmGateLog = []')
    assert.equal(await evaluate(`(() => {
      const heading = [...document.querySelectorAll('.ProseMirror h1')]
        .find((node) => node.offsetParent)
      if (!heading) return false
      heading.focus()
      const range = document.createRange()
      range.selectNodeContents(heading)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`), true, `${suffix}: could not focus the initial heading`)

    // The behavior under test starts after the whitespace is already editor
    // content. The platform keyboard/input-method path that committed it is
    // outside this save-boundary regression.
    await send('Input.insertText', { text: character })
    await typeTextLikeUser(send, text, { delayMs: 50 })
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), `${suffix}: edit did not become dirty`)
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(1000)
    const result = await evaluate(`({
      pending: !!document.querySelector('.hm-save-fab'),
      gate: window.__hmGateLog || []
    })`)
    assert.equal(result.pending, false, `${suffix}: save did not settle: ${JSON.stringify(result)}`)
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [], `${suffix}: save prompted for recovery`)
    assert.equal(await readFile(file, 'utf8'), expected, `${suffix}: saved source did not preserve the leading character`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  try {
    await saveSingleLeadingCharacter({
      character: '\t',
      expected: '# &#x9;\n',
      suffix: 'tab'
    })
    await saveSingleLeadingCharacter({
      character: ' ',
      expected: '# &nbsp;\n',
      suffix: 'space'
    })
    await saveSingleLeadingCharacter({
      character: '\t',
      expected: '# &#x9;标题\n',
      suffix: 'tab-with-text',
      text: '标题'
    })
    await saveSingleLeadingCharacter({
      character: ' ',
      expected: '# &nbsp;标题\n',
      suffix: 'space-with-text',
      text: '标题'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('PASS legacy lock — scratch heading leading whitespace: Tab and Space save as portable source in LEGACY mode (entity spelling, disk bytes only; the kernel contract lives in test-kernel-heading-whitespace-ui.mjs)')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
