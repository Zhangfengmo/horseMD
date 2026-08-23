// Kernel-mode join/split/exit UI regression (2026-08-23 user reports, three
// gestures in one sweep, LF + CRLF):
//   (A) Backspace at the START of a content paragraph directly below an ATX
//       heading JOINS the paragraph into the heading (was refused
//       `unsupported-structure`);
//   (B) Enter at the end of a list item ENDING IN INLINE CODE splits AFTER
//       the closing backtick (the old split landed inside the delimiter and
//       silently un-closed the code — measured '- `npm run test:source-map\n- `');
//       the new empty item then Backspace-exits and typing lands a SEPARATED
//       paragraph;
//   (C) exiting the document-end list (Enter, Enter) and typing body text
//       yields separated paragraphs — never lazy continuation lines absorbed
//       into the last item (measured '- 11312312\n2313').
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function runScenario({ ending, port }) {
  const label = ending === '\n' ? 'LF' : 'CRLF'
  const root = `/tmp/horsemd-join-split-exit-${label}-${process.pid}`
  const file = join(root, 'doc.md')
  const LINES = [
    '###### 3412321',
    '',
    '121312',
    '',
    '- `npm run build`',
    '',
    '- `npm run test:source-map`',
    '',
    '- 你是十二',
    '- 11312312',
    ''
  ]
  const FIXTURE = LINES.join(ending)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)

  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('11312312')`), `${label} mount`)
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), `${label} kernel`)
    await sleep(600)

    const clickAt = async (text, edge) => {
      const rect = await waitFor(() => evaluate(`(() => {
        const t = [...((${VISIBLE_EDITOR})?.querySelectorAll('p') || [])].find((n) => n.textContent === ${JSON.stringify(text)})
        if (!t) return null
        t.scrollIntoView({ block: 'center' })
        const r = t.getBoundingClientRect()
        return { x: ${edge === 'start' ? 'r.left + 2' : 'r.right - 2'}, y: r.top + r.height / 2 }
      })()`), `${label}: block ${text} missing`)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
      await sleep(250)
      await pressKey(send, { key: edge === 'start' ? 'Home' : 'End', code: edge === 'start' ? 'Home' : 'End' })
      await sleep(150)
    }
    const noToast = async (step) => {
      const toasts = await evaluate(`JSON.stringify([...document.querySelectorAll('.hm-toast, .toast')].filter((t) => t.offsetParent).map((t) => t.textContent))`)
      assert.equal(toasts, '[]', `${label} ${step} must not refuse: ${toasts}`)
    }
    const press = async (key, step) => {
      await pressKey(send, { key, code: key })
      await sleep(450)
      await noToast(step)
    }

    // (A) join into the heading.
    await clickAt('121312', 'start')
    await press('Backspace', 'A join')
    await waitFor(() => evaluate(`!![...((${VISIBLE_EDITOR})?.querySelectorAll('h6') || [])].find((n) => n.textContent === '3412321121312')`),
      `${label}: the paragraph must join into the H6`)

    // (B) split after the closing backtick, exit, type.
    const codeRect = await waitFor(() => evaluate(`(() => {
      const codes = [...((${VISIBLE_EDITOR})?.querySelectorAll('code') || [])]
      const t = codes.find((n) => n.textContent.includes('source-map'))
      if (!t) return null
      t.scrollIntoView({ block: 'center' })
      const r = t.getBoundingClientRect()
      return { x: r.right - 2, y: r.top + r.height / 2 }
    })()`), `${label}: code item missing`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...codeRect })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...codeRect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...codeRect })
    await sleep(250)
    await pressKey(send, { key: 'End', code: 'End' })
    await sleep(150)
    await press('Enter', 'B split')
    // the old item's inline code must still render as ONE code element
    const codeIntact = await evaluate(`[...((${VISIBLE_EDITOR})?.querySelectorAll('code') || [])].some((n) => n.textContent === 'npm run test:source-map')`)
    assert.ok(codeIntact, `${label}: the closing backtick must stay with its item — the code span survives the split`)
    await press('Backspace', 'B exit')
    await typeTextLikeUser(send, '正文A', { delayMs: 40 })
    await sleep(500)
    await noToast('B typed')

    // (C) document-end list exit, then body text with a second paragraph.
    await clickAt('11312312', 'end')
    await press('Enter', 'C enter1')
    await press('Enter', 'C exit')
    await typeTextLikeUser(send, '2313', { delayMs: 40 })
    await sleep(450)
    await press('Enter', 'C enter3')
    await typeTextLikeUser(send, '打', { delayMs: 40 })
    await sleep(500)
    await noToast('C typed')

    // Save; compare bytes end-to-end.
    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), `${label} save fab missing`)
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), `${label} save did not settle`)
    const saved = await readFile(file, 'utf8')
    const expected = [
      '###### 3412321121312',
      '',
      '- `npm run build`',
      '',
      '- `npm run test:source-map`',
      '',
      '正文A',
      '',
      '- 你是十二',
      '- 11312312',
      '',
      '2313',
      '',
      '打',
      ''
    ].join(ending)
    if (saved !== expected) {
      console.error('  actual  :', JSON.stringify(saved))
      console.error('  expected:', JSON.stringify(expected))
    }
    assert.equal(saved, expected, `${label}: the joined/split/exited document lands byte-exactly`)

    const diag = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).map((d) => d.type))`)
    for (const bad of ['unclassified-transaction', 'attach-unmappable', 'split-placeholder-unprovable']) {
      assert.ok(!diag.includes(bad), `${label}: ${bad} must never appear: ${diag}`)
    }
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
  console.log(`PASS kernel join-split-exit ${label}`)
}

await runScenario({ ending: '\n', port: Number(process.env.CDP_PORT || 10236) })
await runScenario({ ending: '\r\n', port: Number(process.env.CDP_PORT || 10236) + 1 })
console.log('PASS kernel join-split-exit: paragraph-into-heading join, mark-tail split integrity, and list-exit body separation all land byte-exactly (LF + CRLF)')
