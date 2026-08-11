// User-reported v0.13.x regression: typing into a cell of a NON-rectangular
// (ragged) GFM table fail-closed every save. Root cause: the visible map's
// table-delimiter detection required three dashes, while the canonical
// serializer emits width-fitted runs (`| -- |`) — the canonical delimiter row
// leaked into the visible stream as text and permanently desynced the two
// streams for every table document (mode-visible-map.js isTableSeparator).
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-table-ragged-fill-${process.pid}`
const port = Number(process.env.CDP_PORT || 10018)

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const file = join(root, 'doc.md')
  await writeFile(file, '# 表格\n\n| 项目 | 状态 | 备注 |\n| --- | --- | --- |\n| A | 完成 |\n| B |\n\n尾段。\n')

  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'p'), port, appArgs: [file] })
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`),
      'editor did not open'
    )
    await sleep(1100)

    const rect = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
      const target = [...editor.querySelectorAll('td')].find((t) => t.textContent.includes('完成'))
      if (!target) return null
      const r = target.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    assert.ok(rect, 'could not locate the table cell')
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await sleep(400)
    await typeTextLikeUser(app.send, '进行中')
    await sleep(1100)

    assert.ok(
      await app.evaluate(`[...document.querySelectorAll('.ProseMirror td')].some((t) => t.textContent.includes('进行中'))`),
      'typed text did not land in the cell'
    )
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    assert.equal(app.dialogs.length, 0, 'saving a ragged-table edit must not require recovery')
    const saved = await readFile(file, 'utf8')
    assert.ok(saved.includes('进行中'), `the cell edit must persist on disk (got ${JSON.stringify(saved)})`)
    assert.ok(saved.includes('尾段。'), 'untouched blocks must survive')

    console.log('PASS table ragged fill: editing a non-rectangular table cell maps, saves, and persists without recovery')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
