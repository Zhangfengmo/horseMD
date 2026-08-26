// The source-faithful ordinal must sit exactly where the auto ordinal sat.
//
// `68a0b38` made the editor display the AUTHOR's own list numbers by hiding
// Crepe's `.label.ordered` and repainting it from the source bytes through a
// `::before`. The repaint pinned itself to the label box's top-left corner
// (`position: absolute; top: 0; left: 0`) instead of reproducing the label's own
// layout, so it dropped both of the label's alignments:
//
//   * VERTICAL — the auto ordinal is `align-items: center` in a `1lh + 8px`
//     (38.4px measured) box; the repaint sat at `top: 0`, i.e. flush with the
//     box's top edge. The number therefore rode ABOVE the item's own text, which
//     reads to a user as "the text sits slightly lower than the number".
//     Bullet items were unaffected because nothing repaints them — which is why
//     only ordered lists looked wrong.
//   * HORIZONTAL — the auto ordinal is `justify-content: flex-end` in the 20px
//     gutter, so multi-digit markers line up on their delimiters. The repaint's
//     `left: 0` made them left-aligned, so `1.` and `10.` no longer agreed.
//
// The reference values below are not invented: they were measured from the
// UN-REPAINTED label in legacy mode (kernelDefault off), which is the layout the
// repaint exists to imitate. The test reads that reference from the live label
// at run time rather than hard-coding it, so the two can never drift.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const VISIBLE = "[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)"

async function waitFor(fn, msg, tries = 90) {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn()
    if (v) return v
    await sleep(100)
  }
  throw new Error(`timeout: ${msg}`)
}

// Reads, for every ordered item: the label's OWN layout (the reference) and the
// repainted `::before`'s layout (what the user actually sees).
const PROBE = "(function(){var ed=" + VISIBLE + ";var out=[];var lis=ed.querySelectorAll('li');" +
  "for(var i=0;i<lis.length;i++){var li=lis[i];var label=li.querySelector('.label-wrapper .label.ordered');" +
  "if(!label)continue;var root=li.closest('.milkdown-list-item-block');" +
  "var l=getComputedStyle(label);var b=getComputedStyle(label,'::before');" +
  "var lb=label.getBoundingClientRect();" +
  "out.push({repainted:!!(root&&root.classList.contains('hm-source-ordinal'))," +
  "painted:b.content," +
  "labelDisplay:l.display,labelAlign:l.alignItems,labelJustify:l.justifyContent," +
  "bDisplay:b.display,bAlign:b.alignItems,bJustify:b.justifyContent," +
  "bTop:b.top,bRight:b.right,bBottom:b.bottom,bLeft:b.left," +
  "labelH:+lb.height.toFixed(1)});}" +
  "return JSON.stringify(out);})()"

async function run({ theme, width, port }) {
  const root = `/tmp/horsemd-ordinal-align-${process.pid}-${port}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  // Authored ordinals that are NOT the sequential ones, and of two widths — so
  // the repaint is provably active and the gutter alignment is observable.
  await writeFile(file, ['# T', '', '1. 甲甲甲', '5. 乙乙乙', '10. 丙丙丙', '', '- 项目一', ''].join('\n'))

  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
    const { evaluate } = app
    await waitFor(() => evaluate("(" + VISIBLE + ")?.textContent?.includes('甲')"), 'mount')
    await waitFor(() => evaluate("[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)"), 'kernel attach')
    if (theme) await evaluate(`(document.body.className = ${JSON.stringify(theme)}, 1)`)
    if (width) await evaluate(`(window.resizeTo && window.resizeTo(${width}, 900), 1)`)
    await sleep(900)

    const rows = JSON.parse(await evaluate(PROBE))
    assert.ok(rows.length >= 3, `${theme}/${width}: expected the three ordered items, got ${rows.length}`)

    // Non-vacuity: the repaint must actually be on, or this suite proves nothing.
    assert.ok(rows.every((r) => r.repainted), `${theme}/${width}: the source-ordinal repaint is not active`)
    assert.ok(rows.some((r) => /10\./.test(r.painted)),
      `${theme}/${width}: the AUTHORED 10. must be painted (sequential numbering would say 3.), got ${rows.map((r) => r.painted).join(',')}`)

    for (const row of rows) {
      // The repaint must reproduce the label's OWN layout — read from the same
      // element at run time, so the reference cannot drift.
      assert.equal(row.bDisplay, row.labelDisplay,
        `${theme}/${width}: repaint display must match the label (${row.painted})`)
      assert.equal(row.bAlign, row.labelAlign,
        `${theme}/${width}: repaint vertical alignment must match the label — this is the "number rides above the text" defect (${row.painted})`)
      assert.equal(row.bJustify, row.labelJustify,
        `${theme}/${width}: repaint horizontal alignment must match the label — this is the "1. and 10. do not line up" defect (${row.painted})`)
      // And it must occupy the label's whole box, not a corner of it.
      for (const [side, value] of [['top', row.bTop], ['right', row.bRight], ['bottom', row.bBottom], ['left', row.bLeft]]) {
        assert.equal(value, '0px', `${theme}/${width}: repaint ${side} inset must be 0 so it fills the label box (${row.painted})`)
      }
    }
    console.log(`  PASS ${theme || 'default'} @ ${width || 'default'}px — ${rows.length} ordered items aligned to the label's own box`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

// Visual changes get checked in more than one theme, per the repo's convention.
const CASES = [
  { theme: 'light', width: null },
  { theme: 'dark', width: null },
  { theme: 'light theme-morandi', width: null },
  { theme: 'light', width: 720 }
]
let port = Number(process.env.CDP_PORT || 11601)
for (const testCase of CASES) {
  await run({ ...testCase, port })
  port += 1
}
console.log('PASS kernel source-ordinal alignment: the repainted authored ordinal fills the label box and reproduces its own vertical and horizontal alignment (light / dark / morandi / narrow)')
