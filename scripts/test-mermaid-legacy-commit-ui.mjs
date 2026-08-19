// LEGACY-MODE regression for `ed60fe2` — "a broken mermaid language parser
// silently ate the user's diagram".
//
// THE DEFECT. `mermaidLanguage`'s CodeMirror StreamLanguage was defined from a
// FACTORY (`StreamLanguage.define(() => ({ token: () => null }))`) instead of a
// StreamParser object, so `streamParser.token` was undefined and every parse
// threw inside `readToken`. The throw escapes through `cm.dispatch()`, and the
// vendored CodeMirrorBlock's `setSelection()` is
// `cm.focus(); this.updating = true; cm.dispatch(...); this.updating = false`,
// so the throw left `updating` STUCK TRUE — and `forwardUpdate` opens with
// `if (this.updating || !this.cm.hasFocus) return`. From that moment the node
// view accepted every keystroke into CodeMirror LOCALLY and mirrored none of
// them into ProseMirror: the user watched their diagram appear on screen while
// the document, and the file on disk, never received a byte of it. No veto, no
// toast, no diagnostic — because no transaction was ever dispatched to have one.
//
// WHY THIS SCRIPT EXISTS. The fix shipped with no test of its own. It is caught
// INCIDENTALLY by scripts/test-kernel-blockinsert-ui.mjs's `/mermaid` step, but
// that guard is kernel-mode-only and incidental, while the wedge is in the
// vendored node view and (as the commit message says) "applies to legacy just
// as much". This script drives the DEFAULT, non-kernel path.
//
// WHAT MAKES IT NON-VACUOUS — and why the flow is `/mermaid` rather than
// "open a file that already has a diagram".
//  1. The block is created FRESH through the slash menu, and the insert itself
//     drops the caret into the new fence's CodeMirror. That is the frame the
//     throw wedges: the language descriptor loads for a just-mounted node view
//     while `setSelection()` (`cm.focus(); updating = true; cm.dispatch(...);
//     updating = false`) is running. MEASURED: on a build with `ed60fe2`
//     reverted, clicking into the CodeMirror of a mermaid fence that was
//     already in the file does NOT reproduce it (that language load has long
//     since settled outside any `setSelection`) — an earlier draft of this
//     script did exactly that and passed on the broken build. The insert flow
//     is the defect's real shape, and it is the one the commit describes.
//  2. It asserts the bytes in the DOCUMENT and on DISK, not just in CodeMirror.
//     "CodeMirror shows the text" is the SYMPTOM of the bug, not its absence:
//     on the broken build step 5 below still passes and step 6 fails with the
//     fence still empty.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-mermaid-legacy-commit-${process.pid}`
const file = join(root, 'mermaid-legacy.md')
const port = Number(process.env.CDP_PORT || 10052)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const PLACEHOLDER = '甲乙丙丁'
const TYPED = 'graph TD; A-->B;'
const FIXTURE = [
  '# 图表编辑回归',
  '',
  '说明段落。',
  '',
  PLACEHOLDER,
  '',
  '尾段落。',
  ''
].join('\n')
// What legacy mode's own serializer writes for a mermaid code block holding
// TYPED — asserted, not guessed: the run below prints both strings on a
// mismatch.
const EXPECTED = FIXTURE.replace(PLACEHOLDER, ['```mermaid', TYPED, '```'].join('\n'))

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
const MERMAID_BLOCK = (editorExpr) =>
  `[...(${editorExpr})?.querySelectorAll('.milkdown-code-block') || []]
    .find((block) => block.querySelector('.language-button')?.textContent?.trim().toLowerCase() === 'mermaid')`

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const mermaidCmText = (evaluate) =>
  evaluate(`(${MERMAID_BLOCK(VISIBLE_EDITOR)})?.querySelector('.cm-content')?.textContent ?? null`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)`)

async function toggleSourceMode(evaluate) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && !node.classList.contains('block-switch-caret-btn') &&
        /源码|Source|富文本|Rich|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
    return !!button
  })()`)
  assert.ok(clicked, 'no source-toggle trigger button')
}

async function selectionNonEmpty(evaluate) {
  return evaluate(`(() => { const s = window.getSelection(); return !!s && s.toString().length > 0 })()`)
}

async function charRect(evaluate, blockText, from, to) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])].find((n) => n.textContent === ${JSON.stringify(blockText)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let count = 0
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0
    let n
    while ((n = walker.nextNode())) {
      const len = n.textContent.length
      if (startNode === null && count + len >= ${from}) { startNode = n; startOffset = ${from} - count }
      if (endNode === null && count + len >= ${to}) { endNode = n; endOffset = ${to} - count }
      count += len
      if (startNode && endNode) break
    }
    if (!startNode || !endNode) return null
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    const rect = range.getBoundingClientRect()
    return rect ? { left: rect.left, right: rect.right, top: rect.top, height: rect.height } : null
  })()`)
}

// A real mouse DRAG across the block's text (never a triple click, which
// ProseMirror turns into a whole-node selection).
async function selectBlock(evaluate, send, blockText) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rect = await waitFor(() => charRect(evaluate, blockText, 0, blockText.length),
      `could not locate ${JSON.stringify(blockText)} to select`)
    const y = rect.top + Math.min(12, rect.height / 2)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.left + 1, y, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 4; step += 1) {
      const x = rect.left + ((rect.right - rect.left) * step) / 4
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.max(rect.right - 1, rect.left + 1), y, button: 'left', clickCount: 1 })
    await sleep(250)
    if (await selectionNonEmpty(evaluate)) return
    await sleep(200)
  }
  assert.fail(`drag-select never produced a non-empty selection for ${JSON.stringify(blockText)}`)
}

// Type "/<query>", wait for the menu, assert the item is present and ranked
// first, then activate it with Enter.
async function runSlashItem(evaluate, send, query, id) {
  await typeTextLikeUser(send, '/' + query, { delayMs: delay })
  await waitFor(() => evaluate(`document.querySelectorAll('.milkdown-slash-menu[data-show="true"] .hm-slash-item').length > 0`),
    `slash menu did not open for the /${query} query`, 25)
  const state = await waitFor(() => evaluate(`(() => {
    const li = document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item[data-id=${JSON.stringify(id)}]')
    if (!li) return null
    return { disabled: li.classList.contains('disabled'), first: document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item')?.dataset.id }
  })()`), `the '${id}' item never appeared for the /${query} query`)
  assert.equal(state.disabled, false, `the '${id}' slash item must be enabled in legacy mode`)
  assert.equal(state.first, id, `the /${query} query must rank '${id}' first so Enter activates it (got ${state.first})`)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(800)
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app

    // ---- 1) default (LEGACY) mode ------------------------------------
    await waitFor(async () => (await evaluate(`(${VISIBLE_EDITOR})?.textContent`) || '').includes(PLACEHOLDER),
      'document did not mount')
    assert.equal(await evaluate(`!!document.querySelector('.hm-kernel-mode')`), false,
      'this regression must run in the DEFAULT (non-kernel) editor — kernel mode was active')

    // ---- 2) select the placeholder paragraph and run /mermaid ---------
    // A real DRAG, never a triple click (which ProseMirror turns into a
    // whole-node selection); the typed query then REPLACES the block's text,
    // the one shape the slash menu's shouldShow fires on. Same convention as
    // scripts/test-kernel-blockinsert-ui.mjs.
    await selectBlock(evaluate, send, PLACEHOLDER)
    await runSlashItem(evaluate, send, 'mermaid', 'code:mermaid')

    // ---- 3) the insert must leave the caret in the NEW, empty fence ----
    // Read off ONE block so a caret parked in some other code block cannot
    // satisfy this vacuously — and so "nothing was typed" can never be
    // confused with "the typing was not committed" in step 6.
    assert.deepEqual(await evaluate(`(() => {
      const block = document.activeElement?.closest?.('.milkdown-code-block')
      if (!block) return null
      return {
        empty: (block.querySelector('.cm-content')?.textContent || '') === '',
        language: block.querySelector('.language-button')?.textContent?.trim()?.toLowerCase() || null,
        visible: !block.querySelector('.codemirror-host')?.classList.contains('hidden')
      }
    })()`), { empty: true, language: 'mermaid', visible: true },
      'the /mermaid insert must leave the caret in the NEW, empty mermaid fence with a VISIBLE CodeMirror')

    // ---- 4) type the diagram, without switching views first ------------
    // This is the real user flow (insert, then type). A source round trip in
    // between would drop CM focus and re-mount the node view, which is exactly
    // what would hide the wedge.
    await typeTextLikeUser(send, TYPED, { delayMs: delay })
    await sleep(500)

    // ---- 5) the SYMPTOM level: CodeMirror shows it --------------------
    // True on the BROKEN build as well — this assertion exists to prove the
    // keystrokes were delivered at all, so that step 6 failing means "the
    // document never received them" rather than "nothing was typed".
    await waitFor(async () => (await mermaidCmText(evaluate)) === TYPED,
      'the typed statement never reached the mermaid CodeMirror editor at all')

    // ---- 6) the CONTRACT: the bytes reached the DOCUMENT --------------
    // This is what `ed60fe2` fixed. On the pre-fix build `updating` stays
    // stuck true, `forwardUpdate` returns early, no transaction is ever
    // dispatched, and the source view still shows the untouched fence.
    await toggleSourceMode(evaluate)
    const source = await waitFor(() => visibleSource(evaluate), 'source view did not appear')
    if (source !== EXPECTED) {
      console.error('  actual  :', JSON.stringify(source))
      console.error('  expected:', JSON.stringify(EXPECTED))
    }
    assert.equal(source, EXPECTED,
      'the diagram edit never reached the document — CodeMirror showed it while the source kept the original fence (ed60fe2)')
    await toggleSourceMode(evaluate)
    await waitFor(async () => (await evaluate(`(${VISIBLE_EDITOR})?.textContent`) || '').includes('说明段落'),
      'did not return to rich mode')

    // ---- 7) …and the FILE ---------------------------------------------
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'the diagram edit never marked the document dirty')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), EXPECTED, 'the saved file did not receive the diagram edit')
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [], 'the diagram edit must not prompt for recovery')

    console.log('PASS legacy mermaid commit: text typed into a previewed mermaid fence reaches the document and the file (ed60fe2 — the wedged StreamParser regression), in DEFAULT non-kernel mode')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
