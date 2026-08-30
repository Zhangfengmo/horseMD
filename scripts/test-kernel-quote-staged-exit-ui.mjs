// STAGED QUOTE EXIT (2026-08-30 user report). Enter on an empty task item
// nested inside a blockquote used to cascade unpredictably: the vouched
// placeholder's Enter routed to split-list-item (listItemAt claimed the
// quote-only `> ` line's end boundary), failed its proof, toasted
// projection-mismatch and tossed the caret out of the quote while the bytes
// kept the `> ` line — a view/byte split. The staged ladder is the
// Typora/Feishu convention, one level per Enter:
//
//   nested empty item  -> Enter -> TOP-LEVEL empty item   (outdent, in quote)
//   top-level empty    -> Enter -> empty quote line `> `  (in quote)
//   empty quote line   -> Enter -> OUT of the quote       (placeholder AFTER
//                                  the quote — typing starts a clean
//                                  paragraph, never a `> ` re-entry or a
//                                  lazy continuation)
//
// Pinned per stage: caret containment (inside/outside the blockquote), zero
// error toasts, and the byte string after the final typed character.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-quote-staged-exit-${process.pid}`
const file = join(root, 'staged.md')
const port = Number(process.env.CDP_PORT || 12470)

const FIXTURE = [
  '3213',
  '',
  '> 你好',
  '>',
  '> - [ ] 21321312',
  '> - [ ] 31232132',
  '>   - [ ] 1231312',
  '',
  '尾段。',
  ''
].join('\n')

const VISIBLE_EDITOR = `[...document.querySelectorAll('.milkdown .ProseMirror')].find((el) => el.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(250)
  }
  throw new Error(message)
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('尾段')`), 'mount')
    await evaluate(`document.querySelector('.block-switch-caret-btn')?.click()`)
    await sleep(300)
    await evaluate(`[...document.querySelectorAll('.block-switch-menu .block-menu-item')].find((n) => n.offsetParent)?.click()`)
    await sleep(1000)
    assert.ok(await evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not enable')

    // Caret at the end of the NESTED task item's text.
    const pt = await evaluate(`(() => {
      const ed = ${VISIBLE_EDITOR}
      const items = [...ed.querySelectorAll('blockquote li')]
      const last = items[items.length - 1]
      const p = last?.querySelector('p') || last
      const r = p.getBoundingClientRect()
      return { x: r.right - 3, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: pt.x, y: pt.y })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: pt.x, y: pt.y })
    await sleep(400)

    const stage = () => evaluate(`(() => {
      const ed = ${VISIBLE_EDITOR}
      const sel = document.getSelection()
      const bq = ed.querySelector('blockquote')
      const li = sel?.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest?.('li') : null
      return JSON.stringify({
        inQuote: sel?.anchorNode ? !!bq?.contains(sel.anchorNode) : null,
        inItem: !!li,
        toast: document.querySelector('.hm-toast .hm-toast-msg')?.textContent || null,
        items: ed.querySelectorAll('blockquote li').length
      })
    })()`)

    const press = async () => {
      await pressKey(send, { key: 'Enter', code: 'Enter' })
      await sleep(600)
      return JSON.parse(await stage())
    }

    // Enter 1: split — a fresh empty NESTED item (4 items, in quote).
    const s1 = await press()
    assert.equal(s1.inQuote, true, `stage 1 must stay in the quote: ${JSON.stringify(s1)}`)
    assert.equal(s1.inItem, true, 'stage 1 caret sits in the fresh item')
    assert.equal(s1.toast, null, 'stage 1 must not toast')
    assert.equal(s1.items, 4, 'stage 1 has the fresh nested item')

    // Enter 2: the nested empty item OUTDENTS to a top-level item (still 4
    // items, still in the quote) — one level per Enter, never a jump.
    const s2 = await press()
    assert.equal(s2.inQuote, true, `stage 2 must stay in the quote: ${JSON.stringify(s2)}`)
    assert.equal(s2.inItem, true, 'stage 2 caret is still in a list item (outdented, not lifted)')
    assert.equal(s2.toast, null, 'stage 2 must not toast')
    assert.equal(s2.items, 4, 'stage 2 keeps 4 items — the outdent moves, it does not delete')

    // Enter 3: the top-level empty item lifts to an empty quote line — caret
    // still INSIDE the quote (the vouched placeholder), list back to 3 items.
    const s3 = await press()
    assert.equal(s3.inQuote, true, `stage 3 must stay in the quote: ${JSON.stringify(s3)}`)
    assert.equal(s3.inItem, false, 'stage 3 left the list')
    assert.equal(s3.toast, null, 'stage 3 must not toast')
    assert.equal(s3.items, 3, 'stage 3 dropped the empty item')

    // Enter 4: the empty quote line exits the quote — caret OUTSIDE, no
    // error toast, bytes clean.
    const s4 = await press()
    assert.equal(s4.inQuote, false, `stage 4 must leave the quote: ${JSON.stringify(s4)}`)
    assert.equal(s4.toast, null, `stage 4 must not toast: ${JSON.stringify(s4)}`)

    // Typing starts a clean paragraph BETWEEN the quote and the tail — never
    // `> 新` (re-entering) and never a lazy continuation of the last item.
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '新', text: '新', unmodifiedText: '新' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '新' })
    await sleep(700)

    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.status-btn')]
        .find((node) => node.offsetParent && !node.classList.contains('block-switch-caret-btn') &&
          /源码|Source|富文本|Rich/.test(node.title || node.textContent || ''))
      button?.click()
    })()`)
    const bytes = await waitFor(() => evaluate(`[...document.querySelectorAll('textarea')].find((t) => t.offsetParent)?.value || null`), 'source view')
    assert.equal(bytes, [
      '3213',
      '',
      '> 你好',
      '>',
      '> - [ ] 21321312',
      '> - [ ] 31232132',
      '>   - [ ] 1231312',
      '',
      '新',
      '',
      '尾段。',
      ''
    ].join('\n'), 'the typed paragraph lands between the quote and the tail, byte-exact')

    console.log('PASS kernel staged quote exit: Enter walks nested item -> top-level item -> empty quote line -> out of the quote, one level per press, zero error toasts, and the first typed character starts a clean paragraph after the quote')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
