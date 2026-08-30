// Kernel-mode image CAPTION editing end-to-end (kernel/image-caption).
//
// The headless suites prove the COMMAND (test-source-kernel-commands.mjs:
// caption section) and the ROUTE (test-kernel-gateway.mjs I4/I4b/I5/I6b,
// test-kernel-mode-headless.mjs 22d/22d2). What only the real app can prove
// is the GESTURE: Crepe's image-block caption is a plain `<input>` inside the
// node view that dispatches ONE `AttrStep(attr:'caption')` on blur (or a 1s
// input debounce — @milkdown/components image-block/index.js:400,410), so
// this session drives the actual caption input with real clicks and real
// keystrokes and asserts the source bytes, the named refusal toasts, the
// disk bytes and a cold relaunch.
//
// Byte contract under test (commands/image-attrs.js CAPTION ADR, verified
// against components/editor-image-markdown.js):
//   * UNSCALED image: the caption's byte home is the markdown TITLE slot —
//     `![描述](p "旧图注")` + caption edit -> `![描述](p "新图注")`; an image
//     with no title gains one.
//   * SCALED image (`![1.50](p "图注")` — numeric alt + title): both raw
//     slots belong to the ratio scheme; the edit is REFUSED with the named
//     toast (`kernelMode.blocked.image-caption-scaled`) and zero bytes.
//   * CLEARING a caption while the image has alt text: `caption: title||alt`
//     means the alt would shadow straight back — refused with
//     `kernelMode.blocked.empty-image-caption-unrepresentable`, zero bytes.
//   * DRAG-RESIZE: the ratio AttrStep has no kernel byte scheme — refused
//     with `kernelMode.blocked.image-resize-unsupported`, zero bytes.
//
// CRLF variant: `KERNEL_IMG_CAPTION_CRLF=1`. The source textarea normalizes
// to LF, so only the disk bytes at save time pin the CRLF spelling.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const crlf = process.env.KERNEL_IMG_CAPTION_CRLF === '1'
const EOL = crlf ? '\r\n' : '\n'
const root = `/tmp/horsemd-kernel-image-caption-${process.pid}`
const file = join(root, 'caption.md')
const png = join(root, 'pic.png')
const port = Number(process.env.CDP_PORT || 14210)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

// A real 1x1 PNG so the images actually load (the resize handle's ratio math
// needs `img.dataset.origin`, which only onImageLoad sets).
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const LINES = [
  '# 图注验收',
  '',
  '正文甲。',
  '',
  '![描述](./pic.png "旧图注")', // A: unscaled WITH title — replace the caption
  '',
  '![纯说明](./pic.png)', // B: unscaled, alt only — the caption input shows the alt fallback
  '',
  '![1.50](./pic.png "缩放图注")', // C: legacy-scaled — refuse by name
  '',
  // A CodeMirror block so `resolveView` can reach the live EditorView (the
  // CodeMirrorBlock node-view instance is the one spec that stores it; the
  // image-block node view does not — same precondition stage3's fixture has).
  '```js',
  'let x = 1',
  '```',
  '',
  '尾段落。',
  ''
]
const FIXTURE = LINES.join(EOL)
const FIXTURE_LF = LINES.join('\n')

const EXP1 = FIXTURE_LF.replace('![描述](./pic.png "旧图注")', '![描述](./pic.png "新图注")')
const EXP2 = EXP1.replace('![纯说明](./pic.png)', '![纯说明](./pic.png "补写图注")')

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
const mounted = (evaluate) => evaluate(`(${VISIBLE_EDITOR})?.textContent`)
const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
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

async function readSource(evaluate, message) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => visibleSource(evaluate), `source view did not appear (${message})`)
  await toggleSourceMode(evaluate)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `rich view did not return (${message})`)
  await sleep(150)
  return shown
}

async function assertSource(evaluate, expected, message) {
  const actual = await readSource(evaluate, message)
  if (actual !== expected) {
    console.error('  actual  :', JSON.stringify(actual))
    console.error('  expected:', JSON.stringify(expected))
  }
  assert.equal(actual, expected, message)
}

async function toggleKernelMode(evaluate) {
  const opened = await evaluate(`(() => {
    const button = document.querySelector('.block-switch-caret-btn')
    button?.click()
    return !!button
  })()`)
  assert.ok(opened, 'no kernel-mode caret button — tab not kernel-eligible?')
  await sleep(150)
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.block-switch-menu .block-menu-item')]
      .find((node) => node.offsetParent)
    item?.click()
    return !!item
  })()`)
  assert.ok(clicked, 'kernel-toggle menu item missing')
}

// The live EditorView, resolved through any node view spec (same technique as
// test-kernel-stage3-ui.mjs) — used to assert PM-side attrs after refusals.
// Polled: the image-block node views (Vue apps) mount asynchronously after a
// kernel-mode remount.
async function resolveView(evaluate) {
  await waitFor(() => evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    if (!editor) return false
    for (const el of editor.querySelectorAll('*')) {
      const spec = el.pmViewDesc && el.pmViewDesc.spec
      const view = spec && spec.view
      if (view && view.state && view.state.doc && view.state.doc.type && view.dispatch) {
        window.__hmCaptionView = view
        return true
      }
    }
    return false
  })()`), 'could not resolve the live ProseMirror EditorView')
}

// PM attrs of the Nth image-block in document order.
async function imageAttrsAt(evaluate, index) {
  await resolveView(evaluate)
  return JSON.parse(await evaluate(`(() => {
    const v = window.__hmCaptionView
    const found = []
    v.state.doc.descendants((node) => { if (node.type.name === 'image-block') found.push(node.attrs) })
    return JSON.stringify(found[${index}] ?? null)
  })()`))
}

// The Nth image-block's caption input, scrolled into view; returns its rect
// center and current value. Every block in this fixture HAS a visible caption
// input (title present, or the alt fallback makes `caption` non-empty).
async function captionInput(evaluate, index) {
  return evaluate(`(() => {
    const blocks = [...((${VISIBLE_EDITOR})?.querySelectorAll('.milkdown-image-block') || [])]
    const input = blocks[${index}]?.querySelector('.caption-input')
    if (!input) return null
    input.scrollIntoView({ block: 'center' })
    const r = input.getBoundingClientRect()
    if (!r.width) return null
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, value: input.value }
  })()`)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

// Focus the Nth caption input with a REAL click, prove focus, select its
// whole value (input.select() — the selection is set directly; every byte
// that follows is real keystrokes), and type `text` over it.
async function retypeCaption(evaluate, send, index, text, expectedValue) {
  const point = await waitFor(() => captionInput(evaluate, index),
    `caption input ${index} did not appear`)
  assert.equal(point.value, expectedValue,
    `caption input ${index} must show ${JSON.stringify(expectedValue)} before editing (anti-vacuity)`)
  await click(send, point)
  await sleep(200)
  assert.ok(await evaluate(`document.activeElement?.classList.contains('caption-input')`),
    `caption input ${index} must be focused after the click`)
  await evaluate(`document.activeElement.select()`)
  if (text) {
    await typeTextLikeUser(send, text, { delayMs: delay })
    assert.equal(await evaluate(`document.activeElement?.value`), text,
      'the typed caption really reached the input (anti-vacuity)')
  } else {
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    assert.equal(await evaluate(`document.activeElement?.value`), '',
      'the caption input really was emptied (anti-vacuity)')
  }
}

// Blur the caption input by clicking the tail paragraph — the blur handler
// dispatches the caption AttrStep immediately (no debounce wait needed).
async function blurIntoTail(evaluate, send) {
  const rect = await waitFor(() => evaluate(`(() => {
    const node = [...((${VISIBLE_EDITOR})?.querySelectorAll('p') || [])]
      .find((n) => n.textContent === '尾段落。')
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const r = node.getBoundingClientRect()
    return r.width ? { x: r.left + 8, y: r.top + r.height / 2 } : null
  })()`), 'tail paragraph not found for blur')
  await click(send, rect)
  await sleep(400)
}

const toasts = (evaluate) => evaluate(`JSON.stringify(window.__captionToasts || [])`)
const resetToasts = (evaluate) => evaluate(`(window.__captionToasts = [], 1)`)

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  await writeFile(png, PNG_BYTES)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('图注验收') && text.includes('尾段落。') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    await evaluate(`(() => {
      window.__captionToasts = []
      window.addEventListener('hm:toast', (e) => window.__captionToasts.push(e.detail?.msg ?? String(e.detail)))
      return 1
    })()`)

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('图注验收') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this fixture: ${attachDiagnostics}`)

    // Anti-vacuity for the SCALED fixture: the legacy-scaled byte form really
    // parsed into the resized state (ratio from the alt slot, caption from
    // the title slot) — a fixture that silently lost the scaled reading would
    // make the refusal below pass for the wrong reason.
    const scaledAttrs = await imageAttrsAt(evaluate, 2)
    assert.ok(scaledAttrs && Math.abs(Number(scaledAttrs.ratio) - 1.5) < 0.001,
      `the third image must parse as ratio 1.5, got ${JSON.stringify(scaledAttrs)}`)
    assert.equal(scaledAttrs.caption, '缩放图注', 'the scaled caption lives in the title slot')

    // ============================================================
    // 1) UNSCALED image WITH a title: retyping the caption commits into the
    //    TITLE slot on blur — byte-exact, nothing else moves.
    // ============================================================
    await retypeCaption(evaluate, send, 0, '新图注', '旧图注')
    await blurIntoTail(evaluate, send)
    await assertSource(evaluate, EXP1,
      `the caption edit must rewrite ONLY the title bytes (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)
    assert.equal((await imageAttrsAt(evaluate, 0))?.caption, '新图注',
      'the live node carries the committed caption (the AttrStep passed through)')

    // ============================================================
    // 2) UNSCALED image with NO title (the caption input shows the alt
    //    fallback): typing a caption INSERTS a title.
    // ============================================================
    await retypeCaption(evaluate, send, 1, '补写图注', '纯说明')
    await blurIntoTail(evaluate, send)
    await assertSource(evaluate, EXP2, 'a title-less image must GAIN a title carrying the caption')

    // ============================================================
    // 3) NAMED refusal: clearing the caption while the image has alt text.
    //    `caption: title || alt` — the alt would shadow straight back, so
    //    the state has no byte spelling. Zero bytes, named toast.
    // ============================================================
    await retypeCaption(evaluate, send, 1, '', '补写图注')
    await resetToasts(evaluate)
    await blurIntoTail(evaluate, send)
    const clearToasts = JSON.parse(await toasts(evaluate))
    console.log('  [clear refusal] ->', JSON.stringify(clearToasts))
    assert.ok(clearToasts.some((t) => /无法清空图注|cannot be emptied/.test(t)),
      `the shadowed clear must raise its NAMED toast, got ${JSON.stringify(clearToasts)}`)
    await assertSource(evaluate, EXP2, 'a refused clear must write NOTHING')
    assert.equal((await imageAttrsAt(evaluate, 1))?.caption, '补写图注',
      'the veto discards the AttrStep: the live node keeps its caption')

    // ============================================================
    // 4) NAMED refusal: the SCALED image's caption. Both raw slots belong to
    //    the ratio scheme — zero bytes, named toast, ratio intact.
    // ============================================================
    await retypeCaption(evaluate, send, 2, '想改图注', '缩放图注')
    await resetToasts(evaluate)
    await blurIntoTail(evaluate, send)
    const scaledToasts = JSON.parse(await toasts(evaluate))
    console.log('  [scaled refusal] ->', JSON.stringify(scaledToasts))
    assert.ok(scaledToasts.some((t) => /缩放比例方案占用|claimed by the resize scheme/.test(t)),
      `the scaled caption edit must raise its NAMED toast, got ${JSON.stringify(scaledToasts)}`)
    await assertSource(evaluate, EXP2, 'a refused scaled-caption edit must write NOTHING')
    const scaledAfter = await imageAttrsAt(evaluate, 2)
    assert.ok(Math.abs(Number(scaledAfter.ratio) - 1.5) < 0.001, 'the persisted resize survives')
    assert.equal(scaledAfter.caption, '缩放图注', 'the scaled caption survives the veto')

    // ============================================================
    // 5) DRAG-RESIZE COMMITS (FLIPPED 2026-08-30, recorded-refusals batch).
    //    The pointerup dispatches `setAttr('ratio', …)` and the kernel now
    //    writes the legacy spelling: numeric alt + the caption migrated
    //    into the title slot. The exact ratio depends on the drag geometry,
    //    so the pin is the SPELLING (numeric alt, caption preserved) plus
    //    alt/ratio agreement with the live node.
    // ============================================================
    await waitFor(() => evaluate(`(() => {
      const img = [...((${VISIBLE_EDITOR})?.querySelectorAll('.milkdown-image-block img') || [])][0]
      return img && img.dataset.origin ? 1 : 0
    })()`), 'the first image never loaded (dataset.origin missing) — the ratio math needs it')
    const handle = await waitFor(() => evaluate(`(() => {
      const blocks = [...((${VISIBLE_EDITOR})?.querySelectorAll('.milkdown-image-block') || [])]
      const h = blocks[0]?.querySelector('.image-resize-handle')
      if (!h) return null
      h.scrollIntoView({ block: 'center' })
      const r = h.getBoundingClientRect()
      return r.width || r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })()`), 'the first image has no resize handle')
    await resetToasts(evaluate)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: handle.x, y: handle.y })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y + 60 })
    await sleep(100)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: handle.x, y: handle.y + 60 })
    await sleep(600)
    const resizeToasts = JSON.parse(await toasts(evaluate))
    console.log('  [resize commit] toasts ->', JSON.stringify(resizeToasts))
    assert.ok(!resizeToasts.some((t) => /无效操作|未做任何修改|not supported|nothing was changed/i.test(t)),
      `the resize must not refuse, got ${JSON.stringify(resizeToasts)}`)
    const resizedSource = await readSource(evaluate, 'post-resize source')
    const resizedLine = resizedSource.split('\n').find((l) => l.includes('"新图注"'))
    console.log('  [resize commit] line ->', JSON.stringify(resizedLine))
    const ratioMatch = resizedLine && resizedLine.match(/^!\[(\d+(?:\.\d+)?)\]\(\.\/pic\.png "新图注"\)$/)
    assert.ok(ratioMatch,
      `the resized image must spell numeric-alt + caption-in-title, got ${JSON.stringify(resizedLine)}`)
    const persistedRatio = Number(ratioMatch[1])
    assert.ok(persistedRatio > 0 && Math.abs(persistedRatio - 1) > 0.001,
      `the persisted ratio must be a real resize, got ${ratioMatch[1]}`)
    const EXP3 = EXP2.replace('![描述](./pic.png "新图注")', `![${ratioMatch[1]}](./pic.png "新图注")`)
    assert.equal(resizedSource, EXP3, 'only the resized image line may change')
    const resizedAfter = await imageAttrsAt(evaluate, 0)
    assert.ok(Math.abs(Number(resizedAfter.ratio) - persistedRatio) < 0.011,
      `the live ratio must agree with the persisted bytes, got ${JSON.stringify(resizedAfter)} vs ${ratioMatch[1]}`)

    // ============================================================
    // 6) Disk bytes (the only place CRLF is provable), then a COLD RELAUNCH.
    // ============================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const disk = await readFile(file, 'utf8')
    const expectedDisk = EXP3.split('\n').join(EOL)
    if (disk !== expectedDisk) {
      console.error('  disk    :', JSON.stringify(disk))
      console.error('  expected:', JSON.stringify(expectedDisk))
    }
    assert.equal(disk, expectedDisk, 'disk bytes must match the kernel-derived expectation exactly')
    if (crlf) {
      assert.equal(/(?<!\r)\n/.test(disk), false, 'a CRLF document must not gain a lone LF anywhere')
    }
    assert.equal(app.dialogs.length, 0,
      `no dialog may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)

    await stopBuiltElectron(app, { removeProfile: false })
    app = null
    app = await launchBuiltElectron({ profileDir: join(root, 'profile-reopen'), port, appArgs: [file] })
    const reopened = app
    await waitFor(async () => {
      const text = await reopened.evaluate(`(${VISIBLE_EDITOR})?.textContent`)
      return text && text.includes('图注验收') ? text : null
    }, 'saved document did not remount on cold relaunch')
    const reopenCaptions = await waitFor(() => reopened.evaluate(`(() => {
      const inputs = [...((${VISIBLE_EDITOR})?.querySelectorAll('.milkdown-image-block .caption-input') || [])]
      if (inputs.length !== 3) return null
      return JSON.stringify(inputs.map((i) => i.value))
    })()`), 'the three caption inputs did not remount on cold relaunch')
    assert.deepEqual(JSON.parse(reopenCaptions), ['新图注', '补写图注', '缩放图注'],
      'the committed captions round-trip through the title slot on a cold reopen')
    assert.equal(reopened.dialogs.length, 0, 'no dialog on cold relaunch')

    console.log(`PASS kernel-mode image caption UI regression (${crlf ? 'CRLF' : 'LF'}): retyping a caption rewrites the TITLE slot byte-exactly, a title-less image gains one, the shadowed clear and the scaled image refuse with their NAMED toasts and zero bytes, drag-resize COMMITS the numeric-alt spelling with the caption in the title slot, and the bytes survive save + cold relaunch`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
