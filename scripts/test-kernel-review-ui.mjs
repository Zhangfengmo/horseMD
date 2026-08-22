// Kernel-mode CriticMarkup review end-to-end UI regression (review domain).
//
// The headless suites (scripts/test-source-kernel-review.mjs — the byte
// oracle, LF AND CRLF — and Cases R1-R3 in test-kernel-mode-headless.mjs)
// prove the COMMAND and the CONTROLLER. This script proves the live wiring on
// the surfaces the app actually offers, with a real mouse drag and real
// keystrokes:
//   1. selection toolbar review picker → Deletion wrap commits `{--…--}`;
//   2. → Highlight+comment wrap commits `{==…==}{>><<}` with the caret parked
//      between `>>` and `<<`, and TYPING the comment there commits normally;
//   3. the review card's Done resolves an existing `{==a==}{>>c<<}` to its
//      text, and Edit→Save re-spells another one — both as kernel commits;
//   4. the substitution wrap refuses BY NAME and writes nothing; typing in a
//      paragraph that already contains a substitution marker refuses with the
//      block-read-only message (the per-block degrade this named refusal
//      exists for);
//   5. Accept-All from the command palette resolves every marker (including
//      the substitution — it is a whole-document string rewrite + remount,
//      no PM transaction), the tab REMAINS in kernel mode, and typing still
//      commits afterwards;
//   6. save → disk bytes → cold relaunch parses the same document.
// Line endings live in the headless oracle; this fixture is LF.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-review-${process.pid}`
const file = join(root, 'review.md')
const port = Number(process.env.CDP_PORT || 13100)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const LINES = [
  '# 审阅标题',
  '',
  '甲乙丙丁段落',
  '',
  '注记目标段落',
  '',
  'x {==aim==}{>>note<<} y',
  '',
  '前 {++新增++} 中 {--删去--} 后',
  '',
  '这里有 {~~旧文~>新文~~} 替换',
  '',
  '尾巴段落',
  ''
]
const FIXTURE = LINES.join('\n')

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
const VISIBLE_TOOLBAR = `[...document.querySelectorAll('.milkdown-toolbar')].find((tb) => {
  const r = tb.getBoundingClientRect()
  const s = getComputedStyle(tb)
  return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'
})`
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

// Rect of characters [from, to) inside the block whose textContent matches.
async function charRect(evaluate, matchText, from, to) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])]
      .find((n) => n.textContent === ${JSON.stringify(matchText)})
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

const selectionText = (evaluate) =>
  evaluate(`(() => { const s = window.getSelection(); return s ? s.toString() : '' })()`)

// Real mouse drag over characters [from, to) of the given block — the
// selectBlock idiom from test-kernel-leaf-insert-ui.mjs, generalized to a
// sub-range so the review wrap can target part of a paragraph.
async function selectRange(evaluate, send, blockText, from, to, expectSelected) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rect = await waitFor(() => charRect(evaluate, blockText, from, to),
      `could not locate chars ${from}..${to} of ${JSON.stringify(blockText)}`)
    const y = rect.top + Math.min(12, rect.height / 2)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.left + 1, y, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 4; step += 1) {
      const x = rect.left + ((rect.right - rect.left) * step) / 4
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.max(rect.right - 1, rect.left + 1), y, button: 'left', clickCount: 1 })
    await sleep(250)
    if ((await selectionText(evaluate)) === expectSelected) return
    await sleep(200)
  }
  assert.fail(`drag-select never selected ${JSON.stringify(expectSelected)} in ${JSON.stringify(blockText)}`)
}

// The selection toolbar's review picker: wait for the toolbar, then JS-click
// the kind's action button (the picker's own handlers preventDefault on
// mousedown, so a JS click never disturbs the selection — same idiom the
// marks UI regression uses for toolbar buttons).
async function clickReviewAction(evaluate, kind) {
  await waitFor(() => evaluate(`!!(${VISIBLE_TOOLBAR})`), 'selection toolbar did not appear')
  const clicked = await evaluate(`(() => {
    const tb = ${VISIBLE_TOOLBAR}
    const b = tb?.querySelector('.hm-review-action-${kind}')
    if (!b) return false
    b.click()
    return true
  })()`)
  assert.ok(clicked, `review action button for '${kind}' missing`)
  await sleep(500)
}

const toasts = (evaluate) => evaluate(`JSON.stringify(window.__reviewToasts || [])`)
const resetToasts = (evaluate) => evaluate(`(window.__reviewToasts = [], 1)`)

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
      return text && text.includes('甲乙丙丁段落') && text.includes('尾巴段落') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    await evaluate(`(() => {
      window.__reviewToasts = []
      window.addEventListener('hm:toast', (e) => window.__reviewToasts.push(e.detail?.msg ?? String(e.detail)))
      return 1
    })()`)

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('甲乙丙丁段落') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `the fixture must ATTACH (the substitution paragraph only degrades ITS block): ${attachDiagnostics}`)

    // ============================================================
    // 1) Toolbar review picker → Deletion wrap on a real drag selection.
    // ============================================================
    await selectRange(evaluate, send, '甲乙丙丁段落', 1, 3, '乙丙')
    await clickReviewAction(evaluate, 'deletion')
    const afterDeletion = FIXTURE.replace('甲乙丙丁段落', '甲{--乙丙--}丁段落')
    await assertSource(evaluate, afterDeletion,
      `the deletion wrap must commit {--…--} bytes (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 2) Highlight+comment wrap, then TYPE the comment at the parked caret.
    // ============================================================
    await selectRange(evaluate, send, '注记目标段落', 2, 4, '目标')
    await clickReviewAction(evaluate, 'highlight')
    await typeTextLikeUser(send, '妙极', { delayMs: delay })
    await sleep(400)
    const afterHighlight = afterDeletion.replace('注记目标段落', '注记{==目标==}{>>妙极<<}段落')
    await assertSource(evaluate, afterHighlight,
      `the highlight wrap must commit {==…==}{>><<} and the typed comment must land between >> and << (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 3a) Review card Done on the existing {==aim==}{>>note<<}: the markup
    //     goes, the text stays — a kernel byte commit, not a PM insertText.
    // ============================================================
    const openCardIn = async (needle) => {
      const clicked = await evaluate(`(() => {
        const editor = ${VISIBLE_EDITOR}
        const para = [...(editor?.querySelectorAll('p') || [])]
          .find((p) => p.textContent.includes(${JSON.stringify(needle)}))
        const btn = para?.querySelector('.hm-review-note-button')
        if (!btn) return false
        btn.click()
        return true
      })()`)
      assert.ok(clicked, `note button for ${JSON.stringify(needle)} missing`)
      await waitFor(() => evaluate(`document.querySelectorAll('.hm-review-card[role="dialog"]').length`),
        `review card for ${JSON.stringify(needle)} did not open`)
    }
    await openCardIn('aim')
    await evaluate(`(() => {
      const actions = document.querySelectorAll('.hm-review-card-actions .hm-review-card-action')
      if (actions.length < 2) throw new Error('review card actions missing')
      actions[1].click() // Done (check)
      return true
    })()`)
    await sleep(500)
    const afterDone = afterHighlight.replace('x {==aim==}{>>note<<} y', 'x aim y')
    await assertSource(evaluate, afterDone,
      `card Done must remove the markup and keep the text (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 3b) Review card Edit→Save on the note created in step 2: the whole
    //     marker span is re-spelled from the edited fields.
    // ============================================================
    await openCardIn('目标')
    await evaluate(`(() => {
      const actions = document.querySelectorAll('.hm-review-card-actions .hm-review-card-action')
      if (!actions.length) throw new Error('review card actions missing')
      actions[0].click() // Edit (pencil)
      return true
    })()`)
    await sleep(200)
    await evaluate(`(() => {
      const comment = document.querySelector('.hm-review-card-textarea')
      if (!comment) throw new Error('edit-mode comment field missing')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(comment, '改注')
      comment.dispatchEvent(new InputEvent('input', { bubbles: true }))
      return true
    })()`)
    await evaluate(`(() => {
      const save = document.querySelector('.hm-review-card-actions .hm-review-card-primary')
      if (!save) throw new Error('edit-mode save button missing')
      save.click()
      return true
    })()`)
    await sleep(500)
    const afterEdit = afterDone.replace('{>>妙极<<}', '{>>改注<<}')
    await assertSource(evaluate, afterEdit,
      `card Edit→Save must re-spell the marker (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 4a) Substitution wrap: the NAMED refusal — toast, zero bytes.
    // ============================================================
    await selectRange(evaluate, send, '尾巴段落', 0, 2, '尾巴')
    await resetToasts(evaluate)
    await clickReviewAction(evaluate, 'substitution')
    await sleep(200)
    const substitutionToasts = JSON.parse(await toasts(evaluate))
    console.log('  [substitution wrap] ->', JSON.stringify({ toasts: substitutionToasts }))
    assert.ok(substitutionToasts.some((t) => /替换建议标记|substitution marker/i.test(t)),
      `the substitution wrap must raise its named toast, got ${JSON.stringify(substitutionToasts)}`)
    await assertSource(evaluate, afterEdit,
      'a refused substitution wrap must write NOTHING')
    // Collapse the still-active '尾巴' selection so its floating toolbar
    // cannot swallow the next real-mouse click.
    await pressKey(send, { key: 'ArrowRight', code: 'ArrowRight' })
    await sleep(200)

    // ============================================================
    // 4b) The paragraph already CONTAINING a substitution marker is a
    //     read-only pair (editor chain reconstructs the literal marker, the
    //     kernel chain reads GFM strikethrough — the disagreement behind the
    //     named refusal above). Typing there refuses with the block-scoped
    //     message and writes nothing.
    // ============================================================
    const clickIntoParagraph = async (needle) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const point = await waitFor(() => evaluate(`(() => {
          const editor = ${VISIBLE_EDITOR}
          const para = [...(editor?.querySelectorAll('p') || [])]
            .find((p) => p.textContent.includes(${JSON.stringify(needle)}))
          if (!para) return null
          para.scrollIntoView({ block: 'center' })
          const r = para.getBoundingClientRect()
          return { x: r.left + 12, y: r.top + r.height / 2 }
        })()`), `paragraph ${JSON.stringify(needle)} not found in the view`)
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
        await sleep(250)
        const landed = await evaluate(`(() => {
          const sel = getSelection()
          const node = sel?.anchorNode
          if (!node) return false
          const el = node.nodeType === 1 ? node : node.parentElement
          return !!el?.closest('p')?.textContent.includes(${JSON.stringify(needle)})
        })()`)
        if (landed) return
        await sleep(200)
      }
      assert.fail(`the caret never landed in the ${JSON.stringify(needle)} paragraph`)
    }
    await clickIntoParagraph('旧文')
    await resetToasts(evaluate)
    await typeTextLikeUser(send, 'Z', { delayMs: delay })
    await sleep(300)
    const readOnlyToasts = JSON.parse(await toasts(evaluate))
    console.log('  [substitution paragraph typing] ->', JSON.stringify({ toasts: readOnlyToasts }))
    assert.ok(readOnlyToasts.some((t) => /只读|read-only/.test(t)),
      `typing in the substitution paragraph must raise the block-read-only toast, got ${JSON.stringify(readOnlyToasts)}` +
      ` (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)
    await assertSource(evaluate, afterEdit,
      'the refused keystroke must write NOTHING')

    // ============================================================
    // 5) Accept-All from the command palette: every remaining marker
    //    resolves (including the substitution — string rewrite + remount),
    //    the tab STAYS in kernel mode, and typing still commits.
    // ============================================================
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('.topbar .icon-btn')]
        .find((b) => /命令面板|Command Palette/.test(b.title || ''))
      if (!btn) throw new Error('palette button missing')
      btn.click()
      return true
    })()`)
    await waitFor(() => evaluate(`!!document.querySelector('.palette-input input')`), 'palette did not open')
    await evaluate(`(() => {
      const input = document.querySelector('.palette-input input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, '全部接受')
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
      return true
    })()`)
    await sleep(300)
    await evaluate(`(() => {
      const item = [...document.querySelectorAll('.palette-item')]
        .find((n) => /全部接受|Accept All/.test(n.textContent || ''))
      if (!item) throw new Error('accept-all palette item missing')
      item.click()
      return true
    })()`)
    await sleep(800)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`),
      'the tab must re-attach kernel mode after the accept-all remount')
    const afterAccept = afterEdit
      .replace('甲{--乙丙--}丁段落', '甲丁段落')
      .replace('注记{==目标==}{>>改注<<}段落', '注记目标段落')
      .replace('前 {++新增++} 中 {--删去--} 后', '前 新增 中  后')
      .replace('这里有 {~~旧文~>新文~~} 替换', '这里有 新文 替换')
    await assertSource(evaluate, afterAccept,
      'Accept-All must resolve every marker (deletion drops text, highlight keeps it, substitution takes the new text)')

    // Kernel still owns the tab: a keystroke in the (formerly read-only,
    // now marker-free) substitution paragraph commits normally. Click char 0
    // and VERIFY the caret landed at offset 0 so the expected bytes are
    // deterministic.
    for (let attempt = 0; ; attempt += 1) {
      const rect = await waitFor(() => charRect(evaluate, '这里有 新文 替换', 0, 1),
        'resolved substitution paragraph not found')
      const point = { x: rect.left + 1, y: rect.top + Math.min(12, rect.height / 2) }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
      await sleep(250)
      const landed = await evaluate(`(() => {
        const sel = getSelection()
        if (!sel?.anchorNode || sel.anchorOffset !== 0) return false
        const el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement
        return !!el?.closest('p')?.textContent.startsWith('这里有 新文')
      })()`)
      if (landed) break
      assert.ok(attempt < 5, 'the caret never landed at char 0 of the resolved paragraph')
      await sleep(200)
    }
    await typeTextLikeUser(send, 'Q', { delayMs: delay })
    await sleep(400)
    const afterType = afterAccept.replace('这里有 新文 替换', 'Q这里有 新文 替换')
    await assertSource(evaluate, afterType,
      'after Accept-All the re-attached kernel must accept ordinary typing (the block is no longer degraded)')

    // ============================================================
    // 6) Save → disk bytes → cold relaunch.
    // ============================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const disk = await readFile(file, 'utf8')
    if (disk !== afterType) {
      console.error('  disk    :', JSON.stringify(disk))
      console.error('  expected:', JSON.stringify(afterType))
    }
    assert.equal(disk, afterType, 'disk bytes must match the kernel-derived expectation exactly')
    assert.equal(app.dialogs.length, 0,
      `no dialog may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)

    await stopBuiltElectron(app, { removeProfile: false })
    app = null
    app = await launchBuiltElectron({ profileDir: join(root, 'profile-reopen'), port, appArgs: [file] })
    const reopened = app
    await waitFor(async () => {
      const text = await reopened.evaluate(`(${VISIBLE_EDITOR})?.textContent`)
      return text && text.includes('甲丁段落') && text.includes('Q这里有 新文 替换') ? text : null
    }, 'saved document did not remount on cold relaunch')
    const reopenText = await reopened.evaluate(`(${VISIBLE_EDITOR})?.textContent`)
    assert.ok(reopenText.includes('x aim y') && reopenText.includes('注记目标段落'),
      'the resolved review texts must survive the cold relaunch')
    assert.equal(reopened.dialogs.length, 0, 'no dialog on cold relaunch')

    console.log('PASS kernel-mode review markup UI regression: toolbar wraps (deletion + highlight+typed comment), card Done + Edit→Save, the named substitution refusals (wrap + read-only block), palette Accept-All with kernel re-attach, and save + cold relaunch')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
