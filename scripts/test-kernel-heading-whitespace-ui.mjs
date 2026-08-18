// Kernel-mode counterpart of the two LEGACY heading-whitespace regressions
// (scripts/test-heading-leading-tab-source-ui.mjs and
// scripts/test-scratch-heading-leading-whitespace-ui.mjs).
//
// THE REPORT: "为啥标题前面无法使用 tab 或者空格". Measured on the built app in
// kernel mode BEFORE the fix (probe, 2026-08-18):
//   * Tab at a heading's first content position committed a LITERAL '\t' —
//     '## 标题乙' became '## \t标题乙' on disk, the view never changed, no toast
//     and no diagnostic. A silently dead byte.
//   * Space committed a LITERAL ' ' — '# 标题甲' became '#  标题甲', then the
//     kernel's own `projection-mismatch` check repaired the view straight back.
// Both because CommonMark eats the whole spacing run between the ATX marker and
// the content, so a literal byte there is not content at all.
//
// The headless suite (scripts/test-source-kernel-heading-whitespace.mjs) proves
// the COMMAND. It cannot prove the live wiring: that a real Tab keydown reaches
// it before the literal-tab fallback, that a real Space keydown reaches it at
// all (Space is not a structural key and had no kernel handler), and that the
// committed entity survives to the FILE. That is what this script drives — real
// keystrokes through CDP, byte assertions read from the source view and from
// disk after a real save.
//
// Expected bytes are the LEGACY writer's own output for the same shapes, so a
// document edited in either mode reads identically.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-heading-ws-${process.pid}`
const file = join(root, 'heading.md')
const port = Number(process.env.CDP_PORT || 10047)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

// `## ` (marker + its required spacing) rather than the legacy fixture's bare
// `##`: kernel mode pairs an EMPTY ATX heading only when the marker carries
// real spacing (editor-kernel-projection-map.js `emptyAtxHeadingContentStart`),
// because '##x' would be a PARAGRAPH — a bare '##' has no content position to
// write to at all and stays read-only. The committed bytes are identical to
// legacy's ('## &#x9;'); only the starting file differs.
const FIXTURE = ['# 标题甲', '', '段落占位。', '', '## ', '', '末段。', ''].join('\n')

const NBSP = '\u00A0'

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let index = 0; index < tries; index += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

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

async function readSource(evaluate, label) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => visibleSource(evaluate), `source view did not appear (${label})`)
  await toggleSourceMode(evaluate)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `rich view did not return (${label})`)
  await sleep(150)
  return shown
}

async function toggleKernelMode(evaluate) {
  const opened = await evaluate(`(() => {
    const button = document.querySelector('.block-switch-caret-btn')
    button?.click()
    return !!button
  })()`)
  assert.ok(opened, 'no kernel-mode caret button — tab not kernel-eligible?')
  await sleep(200)
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.block-switch-menu .block-menu-item')].find((node) => node.offsetParent)
    item?.click()
    return !!item
  })()`)
  assert.ok(clicked, 'kernel-toggle menu item missing')
}

async function charRect(evaluate, blockText, from, to) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])]
      .find((n) => n.textContent === ${JSON.stringify(blockText)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    if (${from} === 0 && ${to} === 0 && !node.firstChild) {
      const rect = node.getBoundingClientRect()
      return rect ? { left: rect.left + 2, right: rect.right, top: rect.top, height: rect.height } : null
    }
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

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

// A raw DOM selection does NOT sync ProseMirror state — every caret placement
// here is a real mouse click, per this repo's CDP convention.
async function clickAt(evaluate, send, blockText, offset) {
  const rect = await waitFor(() => charRect(evaluate, blockText, offset, offset),
    `could not locate caret offset ${offset} in ${JSON.stringify(blockText)}`)
  await click(send, { x: rect.left, y: rect.top + Math.min(12, rect.height / 2) })
  await sleep(200)
}

// Click the EMPTY heading (no text node to range over) by its own box.
async function clickEmptyBlock(evaluate, send, selector) {
  const rect = await waitFor(() => evaluate(`(() => {
    const node = [...((${VISIBLE_EDITOR})?.querySelectorAll(${JSON.stringify(selector)}) || [])]
      .find((n) => n.offsetParent && !n.textContent)
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return { left: rect.left, top: rect.top, height: rect.height }
  })()`), `could not locate an empty ${selector}`)
  await click(send, { x: rect.left + 4, y: rect.top + Math.min(12, rect.height / 2) })
  await sleep(200)
}

// Rendered geometry of the first visible heading of `tag`: how wide its LEADING
// whitespace run actually paints, and where the first non-whitespace glyph sits
// relative to the block's content box. This is the "存下来并且能被看到" half of the
// contract — bytes on disk and a `text` node in the projection are not enough if
// HTML collapses the character away. (ProseMirror ships
// `white-space: break-spaces` on `.ProseMirror`, so a leading tab paints to the
// next `tab-size` stop and an NBSP paints as a space; this measures it rather
// than trusting it.)
async function leadingRunGeometry(evaluate, tag) {
  return evaluate(`(() => {
    const node = [...((${VISIBLE_EDITOR})?.querySelectorAll(${JSON.stringify('$TAG$')}) || [])]
      .find((n) => n.offsetParent)
    if (!node) return null
    const style = getComputedStyle(node)
    const box = node.getBoundingClientRect()
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode()
    if (!text) return null
    let run = 0
    while (run < text.textContent.length && /\\s/.test(text.textContent[run])) run += 1
    const lead = document.createRange()
    lead.setStart(text, 0); lead.setEnd(text, run)
    const rest = document.createRange()
    rest.setStart(text, run); rest.setEnd(text, Math.min(run + 1, text.textContent.length))
    return {
      whiteSpace: style.whiteSpace,
      runLength: run,
      runWidth: lead.getBoundingClientRect().width,
      firstGlyphLeft: rest.getBoundingClientRect().left,
      contentLeft: box.left + parseFloat(style.paddingLeft || '0') + parseFloat(style.borderLeftWidth || '0')
    }
  })()`.replace('$TAG$', tag))
}

// Click at a text-node offset inside the first visible `tag` block — used to put
// the caret BETWEEN the leading entity and the first real character, which is
// the "can the user address it?" half of the contract.
async function clickTextOffset(evaluate, send, tag, offset) {
  const rect = await waitFor(() => evaluate(`(() => {
    const node = [...((${VISIBLE_EDITOR})?.querySelectorAll(${JSON.stringify('$TAG$')}) || [])]
      .find((n) => n.offsetParent)
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode()
    if (!text || text.textContent.length < ${offset}) return null
    const range = document.createRange()
    range.setStart(text, ${offset}); range.setEnd(text, ${offset})
    const box = range.getBoundingClientRect()
    return { left: box.left, top: box.top, height: box.height }
  })()`.replace('$TAG$', tag)), `could not locate text offset ${offset} in ${tag}`)
  await click(send, { x: rect.left, y: rect.top + Math.min(12, rect.height / 2) })
  await sleep(250)
}

const blockTexts = (evaluate) => evaluate(`JSON.stringify(
  [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName + ':' + n.textContent)
)`)

const diagnostics = (evaluate) => evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-6))`)

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})`), 'editor did not mount')
    await sleep(400)
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await sleep(500)
    await evaluate('window.__hmKernelDiagnostics = []')

    // =====================================================================
    // 1) Tab at the first content position of a heading WITH text.
    //    Before the fix: a literal '\t' on disk, nothing visible.
    // =====================================================================
    await clickAt(evaluate, send, '标题甲', 0)
    await pressKey(send, { key: 'Tab', code: 'Tab' })
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 'tab in h1'),
      FIXTURE.replace('# 标题甲', '# &#x9;标题甲'),
      'Tab at a heading content start must commit the legacy `&#x9;` entity'
    )
    assert.ok(
      JSON.parse(await blockTexts(evaluate)).includes('H1:\t标题甲'),
      `the Tab must be VISIBLE in the heading — got ${await blockTexts(evaluate)}`
    )

    // =====================================================================
    // 1b) IT MUST BE VISIBLE. Bytes on disk and a `text` node in the projection
    //     are only two thirds of the contract — the reported defect was a
    //     character nobody could see. Measure the painted width of the heading's
    //     leading whitespace run and where the first real glyph now sits.
    // =====================================================================
    {
      const geometry = await leadingRunGeometry(evaluate, 'h1')
      assert.ok(geometry, 'could not measure the h1 geometry')
      assert.equal(geometry.runLength, 1, 'the heading must start with exactly one whitespace character')
      assert.ok(geometry.runWidth > 1,
        `the leading tab must PAINT, not collapse — measured ${JSON.stringify(geometry)}`)
      assert.ok(geometry.firstGlyphLeft > geometry.contentLeft + 1,
        `the first real glyph must be pushed right by the indent — ${JSON.stringify(geometry)}`)
    }

    // =====================================================================
    // 1c) IT MUST BE ADDRESSABLE AND DELETABLE. Put the caret between the
    //     entity and the first real character with a real click, then Backspace:
    //     the WHOLE entity must go, restoring the original bytes exactly. An
    //     undeletable byte is the same data-integrity problem as an invisible
    //     one.
    // =====================================================================
    await clickTextOffset(evaluate, send, 'h1', 1)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 'backspace over the entity'),
      FIXTURE,
      'Backspace after the leading entity must delete the whole `&#x9;`, restoring the original bytes'
    )
    {
      const geometry = await leadingRunGeometry(evaluate, 'h1')
      assert.equal(geometry.runLength, 0, 'the indent must be gone from the rendering too')
    }

    // 1d) Re-apply the Tab so the following steps start from the same state.
    await clickAt(evaluate, send, '标题甲', 0)
    await pressKey(send, { key: 'Tab', code: 'Tab' })
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 're-applied tab'),
      FIXTURE.replace('# 标题甲', '# &#x9;标题甲'),
      'the Tab must be re-appliable after a delete'
    )

    // =====================================================================
    // 2) Space at the first content position of the same heading, delivered as
    //    a REAL KEYDOWN — the path the user's keyboard takes, and the one the
    //    kernel's new Space keymap owns. The caret is left after the Tab by
    //    step 1, so click back to offset 0.
    // =====================================================================
    await clickAt(evaluate, send, '\t标题甲', 0)
    await pressKey(send, { key: ' ', code: 'Space', text: ' ' })
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 'space keydown in h1'),
      FIXTURE.replace('# 标题甲', '# &nbsp;&#x9;标题甲'),
      'a Space KEYDOWN at a heading content start must commit the legacy `&nbsp;` entity'
    )
    assert.ok(
      JSON.parse(await blockTexts(evaluate)).includes(`H1:${NBSP}\t标题甲`),
      `the Space must be VISIBLE as an NBSP — got ${await blockTexts(evaluate)}`
    )
    {
      const geometry = await leadingRunGeometry(evaluate, 'h1')
      assert.equal(geometry.runLength, 2, 'the heading must now start with NBSP + tab')
      assert.ok(geometry.runWidth > 1,
        `the NBSP + tab run must PAINT — measured ${JSON.stringify(geometry)}`)
    }

    // =====================================================================
    // 2b) The SAME position reached WITHOUT a keydown (Chromium's
    //     `Input.insertText`, i.e. what an autocorrect/accessibility/IME-commit
    //     insertion looks like). The keymap cannot see it, so this proves the
    //     gateway's own defence-in-depth re-spelling — the bytes must be
    //     route-independent.
    // =====================================================================
    await clickAt(evaluate, send, `${NBSP}\t标题甲`, 0)
    await typeTextLikeUser(send, ' ', { delayMs: delay })
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 'space insertText in h1'),
      FIXTURE.replace('# 标题甲', '# &nbsp;&nbsp;&#x9;标题甲'),
      'a Space arriving without a keydown must commit the same entity, not a literal byte'
    )

    // =====================================================================
    // 3) The EMPTY heading (`## `) — the legacy Tab fixture's shape.
    // =====================================================================
    await clickEmptyBlock(evaluate, send, 'h2')
    await pressKey(send, { key: 'Tab', code: 'Tab' })
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 'tab in empty h2'),
      FIXTURE.replace('# 标题甲', '# &nbsp;&nbsp;&#x9;标题甲').replace('\n## \n', '\n## &#x9;\n'),
      'Tab in an EMPTY heading must commit `## &#x9;`, the legacy byte string'
    )

    // =====================================================================
    // 4) Typing continues normally after the entity — the character lands
    //    AFTER it, exactly like the legacy `# &#x9;标题` fixture.
    // =====================================================================
    await typeTextLikeUser(send, '乙', { delayMs: delay })
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 'typing after the entity'),
      FIXTURE.replace('# 标题甲', '# &nbsp;&nbsp;&#x9;标题甲').replace('\n## \n', '\n## &#x9;乙\n'),
      'text typed after a leading entity must land after it, not before'
    )

    // =====================================================================
    // 5) A space that is NOT at a heading's content start must behave exactly
    //    as before — this is the "did the new keymap swallow ordinary spaces?"
    //    control. Typed inside a PARAGRAPH, between two characters.
    // =====================================================================
    await clickAt(evaluate, send, '段落占位。', 2)
    await typeTextLikeUser(send, 'x y', { delayMs: delay })
    await sleep(400)
    const afterParagraph = await readSource(evaluate, 'space inside a paragraph')
    assert.ok(
      afterParagraph.includes('段落x y占位。'),
      `an ordinary space inside a paragraph must still be a literal space — got ${JSON.stringify(afterParagraph)}`
    )

    // =====================================================================
    // 6) Save, and prove the bytes reached the FILE.
    // =====================================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'document never became dirty')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(1000)
    assert.equal(await evaluate(`!!document.querySelector('.hm-save-fab')`), false,
      `save did not settle (diagnostics: ${await diagnostics(evaluate)})`)
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [],
      'heading whitespace must never prompt for recovery')
    assert.equal(
      await readFile(file, 'utf8'),
      afterParagraph,
      'the saved file must be byte-identical to the kernel source view'
    )
    assert.ok(
      (await readFile(file, 'utf8')).includes('# &nbsp;&nbsp;&#x9;标题甲'),
      'the leading entities must survive to disk'
    )

    console.log('PASS kernel-mode heading leading whitespace UI regression: Tab and Space at an ATX heading content start commit the legacy entity bytes and stay visible')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
