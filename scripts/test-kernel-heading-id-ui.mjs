// Kernel-mode heading-id regression (2026-08-17 veto-divergence report).
//
// THE BUG THIS CLOSES. `@milkdown/preset-commonmark`'s `syncHeadingIdPlugin`
// is a VIEW plugin: on every document change it re-slugs `heading.attrs.id`
// and dispatches one `setNodeMarkup` per stale heading. In kernel mode that
// batch was unclassifiable (`ReplaceAroundStep`s, not `ReplaceStep`s), so it
// fell through to `blocked`/`unsupported-input-type` — vetoed with the
// "源码权威内核实验阶段暂未支持此操作" toast, once per keystroke, on EVERY
// document containing a single non-empty heading. Separately, a raw parse of
// `kernel.doc.text` always returns `id: ''`, so the projection check reported
// a difference at the first AND last heading and the "minimal" diff spanned
// the whole document: one full-document reconcile per keystroke, remounting
// every node view. The user's own edit still landed and still saved (it is a
// different, accepted transaction) — the report's three-way byte check found
// no divergence — but kernel mode was unusable on any real document.
//
// WHY THE EXISTING KERNEL UI SUITES MISSED IT: they assert bytes and
// `attach-unmappable` only. A toast on every keystroke and a whole-document
// reconcile are both invisible to a byte assertion. This script asserts the
// two things they never did:
//   * ZERO `kernelMode.unsupported` toasts across a burst of ordinary typing;
//   * ZERO `projection-mismatch` diagnostics — i.e. the reconcile is gone,
//     re-proven independently by DOM node IDENTITY (a tagged `.cm-editor`
//     survives the typing burst).
// Plus the two user-visible consequences: heading ids stay populated (export
// / TOC anchors) and update when a heading's text is edited.
//
// Fixture shape mirrors the document the bug was reported on: a long-ish
// Chinese technical note with H1/H2/H3, a fenced code block, a table, a
// nested ordered list and inline marks.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-heading-id-${process.pid}`
const file = join(root, 'heading-id.md')
const port = Number(process.env.CDP_PORT || 10023)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const FIXTURE = [
  '# 源码权威内核说明',
  '',
  '首段说明文字，用于普通打字测试。',
  '',
  '## 目标',
  '',
  '这里有 **加粗**、*斜体* 和 `行内代码` 的混排内容。',
  '',
  '```js',
  'function greet(name) {',
  '  return `你好，${name}！`;',
  '}',
  '```',
  '',
  '### 细节',
  '',
  '1. 第一项',
  '   1. 子项甲',
  '   2. 子项乙',
  '2. 第二项',
  '',
  '| 列一 | 列二 |',
  '| --- | --- |',
  '| 甲 | 乙 |',
  '',
  '## 完成标准',
  '',
  '结尾段落。',
  ''
].join('\n')

const TYPED = '东南西北'
const AFTER_TYPING = FIXTURE.replace('首段说明文字，用于普通打字测试。', `首段说明文字，用于普通打字测试。${TYPED}`)
// The heading edit below appends one character to the H2 '目标'.
const HEADING_SUFFIX = '甲'
const SAVED = AFTER_TYPING.replace('## 目标', `## 目标${HEADING_SUFFIX}`)

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

// notifyBlocked/notifyRefusal always append ` (<kernel-code>)` to their
// message, so matching the CODE keeps this assertion locale-independent.
const KERNEL_REFUSAL_RE = /\((unsupported-input-type|unmapped-selection|unsupported-structure|projection-mismatch|stale-revision|invalid-range|not-structural)\)/

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const mounted = (evaluate) => evaluate(`(${VISIBLE_EDITOR})?.textContent ?? null`)

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

async function toggleKernelMode(evaluate) {
  const opened = await evaluate(`(() => {
    const button = document.querySelector('.block-switch-caret-btn')
    button?.click()
    return !!button
  })()`)
  assert.ok(opened, 'no kernel-mode caret button — tab not kernel-eligible?')
  await sleep(200)
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.block-switch-menu .block-menu-item')]
      .find((node) => node.offsetParent)
    item?.click()
    return !!item
  })()`)
  assert.ok(clicked, 'kernel-toggle menu item missing')
}

async function clickTextEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, li') || [])]
      .find((candidate) => candidate.textContent === ${JSON.stringify(text)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 8, y: rect.top + Math.min(12, rect.height / 2) }
  })()`)
  assert.ok(point, `missing editable block: ${text}`)
  await sleep(400)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(200)
  const atEnd = () => evaluate(`(() => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    const node = sel.focusNode
    const value = node?.nodeType === Node.TEXT_NODE ? node.textContent : node?.textContent
    return sel.focusOffset === (value?.length ?? -1)
  })()`)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
    if (await atEnd()) return
  }
  assert.fail(`caret never reached the end of block: ${text}`)
}

const readProbes = async (evaluate) => JSON.parse(await evaluate(`JSON.stringify({
  toasts: window.__hmToasts || [],
  diagnostics: (window.__hmKernelDiagnostics || []).map((entry) => entry.type)
})`))

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('源码权威内核说明') && text.includes('结尾段落。') ? text : null
    }, 'initial document did not mount')

    // Toast recorder. `fireToast` is a window CustomEvent (src/renderer/src/ui.js),
    // so every toast the app raises — kernel refusals included — lands here.
    await evaluate(`(() => {
      window.__hmToasts = []
      window.addEventListener('hm:toast', (event) => {
        const detail = event.detail
        window.__hmToasts.push(typeof detail === 'string' ? detail : detail?.msg)
      })
      return true
    })()`)

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('结尾段落。') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(1200)

    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(
      !attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy for this fixture: ${attachDiagnostics}`
    )

    // Heading ids must be populated at rest — the export/TOC anchor contract.
    const initialIds = JSON.parse(await evaluate(`JSON.stringify(
      [...(${VISIBLE_EDITOR})?.querySelectorAll('h1, h2, h3') || []].map((node) => node.id || '')
    )`))
    assert.equal(initialIds.length, 4, 'fixture has four headings (H1, two H2, one H3)')
    assert.ok(initialIds.every((id) => id.length > 0), `every heading carries an id: ${JSON.stringify(initialIds)}`)

    // Tag the code block's CodeMirror element. A whole-document reconcile
    // rebuilds it, so the tag disappearing IS the reconcile, measured
    // independently of the diagnostics ring buffer.
    const tagged = await evaluate(`(() => {
      const node = (${VISIBLE_EDITOR})?.querySelector('.cm-editor')
      if (!node) return false
      node.__hmIdentityProbe = 'kept'
      return true
    })()`)
    assert.ok(tagged, 'fixture must mount a CodeMirror code block')

    // --- Ordinary typing in a plain paragraph -------------------------------
    await clickTextEnd(evaluate, send, '首段说明文字，用于普通打字测试。')
    await evaluate(`window.__hmToasts = []; window.__hmKernelDiagnostics = []; true`)
    for (const character of [...TYPED]) {
      await typeTextLikeUser(send, character, { delayMs: delay })
      // The refusal toast is rate-limited to one per 1.5 s per code
      // (NOTIFY_COOLDOWN_MS), so a fast burst could hide repeats behind the
      // cooldown. Space the keystrokes past the window: every keystroke that
      // refuses gets its own chance to be seen.
      await sleep(1700)
    }
    await waitFor(async () => (await mounted(evaluate) || '').includes(`打字测试。${TYPED}`),
      'typed text never reached the kernel-mode editor')

    let probes = await readProbes(evaluate)
    assert.deepEqual(
      probes.toasts.filter((message) => KERNEL_REFUSAL_RE.test(String(message || ''))),
      [],
      `ordinary typing must raise no kernel refusal toast: ${JSON.stringify(probes.toasts)}`
    )
    assert.deepEqual(
      probes.diagnostics.filter((type) => type === 'projection-mismatch'),
      [],
      'a heading id must not be read as a content difference (no whole-document reconcile)'
    )
    assert.equal(
      await evaluate(`(${VISIBLE_EDITOR})?.querySelector('.cm-editor')?.__hmIdentityProbe ?? null`),
      'kept',
      'the code block must keep its DOM identity — a reconcile would have remounted it'
    )

    // --- Typing INSIDE a heading (the plugin genuinely must re-slug) --------
    await clickTextEnd(evaluate, send, '目标')
    await evaluate(`window.__hmToasts = []; window.__hmKernelDiagnostics = []; true`)
    await typeTextLikeUser(send, HEADING_SUFFIX, { delayMs: delay })
    await sleep(1800)
    await waitFor(async () => (await mounted(evaluate) || '').includes(`目标${HEADING_SUFFIX}`),
      'the heading edit never landed')

    probes = await readProbes(evaluate)
    assert.deepEqual(
      probes.toasts.filter((message) => KERNEL_REFUSAL_RE.test(String(message || ''))),
      [],
      `editing a heading must raise no kernel refusal toast: ${JSON.stringify(probes.toasts)}`
    )
    const editedId = await evaluate(`(() => {
      const node = [...(${VISIBLE_EDITOR})?.querySelectorAll('h2') || []]
        .find((candidate) => candidate.textContent === ${JSON.stringify(`目标${HEADING_SUFFIX}`)})
      return node ? (node.id || '') : null
    })()`)
    assert.ok(
      editedId && editedId.includes(HEADING_SUFFIX),
      `syncHeadingIdPlugin's refresh must LAND (id followed the text): ${JSON.stringify(editedId)}`
    )

    // --- Three-way byte check ---------------------------------------------
    await toggleSourceMode(evaluate)
    const shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear')
    assert.equal(shown, SAVED, 'kernel bytes must match the typed edits exactly')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return')

    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), SAVED, 'disk bytes must match the kernel state exactly')
    assert.equal(
      app.dialogs.length,
      0,
      `no rebuild prompt may appear: ${JSON.stringify(app.dialogs.map((dialog) => dialog.message))}`
    )

    console.log('PASS kernel heading-id (no refusal toast, no reconcile, ids populate and follow edits, bytes exact)')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
