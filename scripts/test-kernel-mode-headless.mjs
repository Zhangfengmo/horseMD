// TDD evidence + regression lock for editor-kernel-mode.js
// (source-kernel integration Plan 2, Task 5).
//
// Drives createKernelMode() directly with a hand-built @milkdown/prose Schema,
// a real EditorState behind a stub view (dispatch applies the tr, updateState
// swaps the state — the same two-phase protocol editor-source-transactions.js
// uses), and a STUB parse that maps kernel markdown bytes to hand-built PM
// docs. Every raw offset / PM position below is derived by hand, same
// convention as scripts/test-kernel-gateway.mjs.
//
// The Editor.jsx wiring itself (props, crepe options, markdownUpdated gate) is
// covered by the Task 9 UI regression; this file locks the DECISIONS:
// pass-through vs veto, kernel byte advancement, structural/history keymap
// handling, caret restore, and full degradation on an unmappable document.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Schema } from '@milkdown/prose/model'
import { EditorState, PluginKey, TextSelection } from '@milkdown/prose/state'
import { toggleMark } from '@milkdown/prose/commands'
import { createKernelMode } from '../src/renderer/src/components/editor-kernel-mode.js'
import { readOnlyPairAt } from '../src/renderer/src/lib/kernel-status.js'
import { isTypableTextblock } from '../src/renderer/src/components/editor-kernel-gateway.js'
import {
  buildSyntaxIndex,
  getKernelParseStats,
  setKernelMemoTestFreeze
} from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { getCharacterMapStats } from '../src/renderer/src/lib/source-kernel/character-map.js'

// Memo-contract enforcement (integration review Condition 1): this suite
// drives the full command surface, so it runs with every memo entry frozen —
// a consumer that mutates a served tree/index THROWS here instead of
// poisoning later hits. Costs nothing on these tiny documents.
setKernelMemoTestFreeze(true)
import { routeStructuralKey } from '../src/renderer/src/lib/source-kernel/router.js'
import { applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { splitMarkdown, CHUNK_SIZE, CHUNK_THRESHOLD } from '../src/renderer/src/components/editor-chunked-parse.js'

// `bullet_list`/`list_item` (with a `checked` attr, `list_item` content
// `'paragraph block*'`) mirror @milkdown/preset-commonmark + preset-gfm's
// real shape — needed for Case 11's task-checkbox dispatch path.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    // Block-type conversion domain — mirrors @milkdown/preset-commonmark's
    // real `heading` ($nodeSchema("heading"), content 'inline*', attrs.level)
    // and `ordered_list` shapes. Adding them does NOT affect Case 18's
    // paragraph-vs-mdast-heading rejection: that one turns on
    // `PM_TO_MD.paragraph` (in editor-kernel-projection-map.js), not on
    // whether this schema declares a heading node at all.
    // `attrs.id` mirrors preset-commonmark's real heading spec. It is what
    // `syncHeadingIdPlugin` (a VIEW plugin) writes into the LIVE document and
    // what a raw parse can never produce — the blindness that let the
    // 2026-08-17 veto-divergence bug ship: without this attr declared, the
    // stub parse and the stub view could never disagree on a heading id, so
    // no headless case could have caught the whole-document reconcile.
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 }, id: { default: '' } } },
    bullet_list: { content: 'list_item+', group: 'block' },
    ordered_list: { content: 'list_item+', group: 'block' },
    list_item: {
      content: 'paragraph block*',
      attrs: { checked: { default: null } }
    },
    // Plan 3 Task 4 — needed for Case 12's code-block text-commit +
    // language-switch end-to-end path.
    code_block: { content: 'text*', group: 'block', code: true, attrs: { language: { default: '' } } },
    // Plan 4 Task 4 — needed for the quote-toggle end-to-end cases (mirrors
    // preset-commonmark's real `blockquote` shape: one-or-more block content).
    blockquote: { content: 'block+', group: 'block' },
    // Plan 5 Task 1 — Crepe's latex feature: inline math is an ATOM carrying
    // its TeX source in `attrs.value`; BLOCK math is a `code_block` whose
    // `attrs.language` is 'LaTeX' (crepe's remarkMathBlock rewrites the mdast
    // `math` node to `{type:'code', lang:'LaTeX'}` before the PM parse).
    math_inline: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
    // Plan 5 Task 2 — preset-commonmark's `html` node (src/node/html.ts) is an
    // INLINE atom; the editor chain's `remarkMergeInlineHtml` collapses a
    // balanced `<span>x</span>` run into exactly one of them.
    html: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
    // Plan 5 Task 4 — @milkdown/preset-gfm's real table nodes
    // (lib/index.js:88-280): four container levels (table / row / cell /
    // paragraph) against mdast's three. `alignment` is the cell attr
    // preset-gfm declares; nothing in this phase writes it.
    //
    // `tableRole` + the colspan/rowspan/colwidth attrs come from
    // prosemirror-tables' own `tableNodes()` (which preset-gfm spreads) and
    // are NOT decoration here: `isInTable`/`selectionCell`/`TableMap` — the
    // machinery behind the Tab/Shift-Tab cell navigation this file exercises
    // — read exactly those.
    table: { content: 'table_header_row table_row+', group: 'block', tableRole: 'table' },
    table_header_row: { content: '(table_header)*', tableRole: 'row' },
    table_row: { content: '(table_cell)*', tableRole: 'row' },
    table_header: {
      content: 'paragraph+',
      tableRole: 'header_cell',
      attrs: {
        alignment: { default: 'left' },
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null }
      }
    },
    table_cell: {
      content: 'paragraph+',
      tableRole: 'cell',
      attrs: {
        alignment: { default: 'left' },
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null }
      }
    },
    // Plan 5 Task 5 — the TWO image nodes, with the attrs the live schemas
    // declare: @milkdown/preset-commonmark's inline `image` ({src, alt,
    // title}) and @milkdown/components' block `image-block` ({src, caption,
    // ratio}) PLUS this repo's own `alt` extension
    // (src/renderer/src/components/editor-image-markdown.js:20-65).
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { src: { default: '' }, alt: { default: '' }, title: { default: '' } }
    },
    // P6 status-indicator rewrite (2026-08-18): the two other structurally
    // opaque LEAVES the projection map pairs and never gives a charMap —
    // `hr` (mdast thematicBreak) and `frontmatter` (mdast yaml,
    // src/renderer/src/components/editor-frontmatter.js). Both are atoms with
    // no text surface; they are what the read-only COUNT must not count.
    hr: { group: 'block', atom: true },
    frontmatter: { group: 'block', atom: true, attrs: { value: { default: '' } } },
    // preset-commonmark's hardbreak — typable since 2026-08-18, and the shape
    // the status indicator's false-negative half was written for.
    hardbreak: { group: 'inline', inline: true, atom: true },
    'image-block': {
      group: 'block',
      atom: true,
      attrs: {
        src: { default: '' },
        alt: { default: '' },
        caption: { default: '' },
        ratio: { default: 1 }
      }
    }
  },
  // Plan 4 Task 3 — mark names mirror the LIVE schema exactly (probed):
  // preset-commonmark "strong"/"emphasis"/"inlineCode"/"link", preset-gfm
  // "strike_through", editor-highlight.js 'highlight' (color default yellow).
  marks: {
    strong: {},
    emphasis: {},
    strike_through: {},
    inlineCode: {},
    highlight: { attrs: { color: { default: 'yellow' } } },
    link: { attrs: { href: { default: '' } } }
  }
})
const p = (...c) => schema.node('paragraph', null, c)
const doc = (...c) => schema.node('doc', null, c)
const text = (s) => schema.text(s)
const li = (checked, ...c) => schema.node('list_item', { checked }, c)
const bl = (...c) => schema.node('bullet_list', null, c)
const ol = (...c) => schema.node('ordered_list', null, c)
const hd = (level, ...c) => schema.node('heading', { level }, c)
const cb = (language, s) => schema.node('code_block', { language }, s ? text(s) : [])
const bq = (...c) => schema.node('blockquote', null, c)
const mif = (value) => schema.node('math_inline', { value })
const ih = (value) => schema.node('html', { value })
// Plan 5 Task 4 — rows: array of rows, each an array of [cellText, alignment].
const tbl = (rows) => schema.node('table', null, rows.map((cells, rowIndex) =>
  schema.node(rowIndex === 0 ? 'table_header_row' : 'table_row', null,
    cells.map(([s, alignment]) => schema.node(
      rowIndex === 0 ? 'table_header' : 'table_cell',
      { alignment },
      [s ? p(text(s)) : p()]
    )))))
// Plan 5 Task 5 — image helpers.
const ib = (attrs) => schema.node('image-block', attrs)
const img = (attrs) => schema.node('image', attrs)
// Case I6 — the thematic break leaf.
const hr = () => schema.node('hr')

// The `/task` seed byte (U+00A0), spelled as an escape so no fixture can be
// edited by accident into an ordinary space — the same convention as
// commands/trailing-whitespace.js's NO_BREAK_SPACE. (Older fixtures embed the
// literal character; new ones use this constant.)
const SEED_NBSP = '\u00A0'

// Stub parse: kernel markdown bytes -> a freshly built PM doc. Unknown bytes
// throw, exactly like a parser failure would.
const FIXTURE_DOCS = {
  '甲乙\n': () => doc(p(text('甲乙'))),
  '甲丙乙\n': () => doc(p(text('甲丙乙'))),
  '甲\n\n乙\n': () => doc(p(text('甲')), p(text('乙'))),
  '甲\t乙\n': () => doc(p(text('甲\t乙'))),
  '- [x] 乙\n': () => doc(bl(li(true, p(text('乙'))))),
  '- [ ] 乙\n': () => doc(bl(li(false, p(text('乙'))))),
  // Task 11.5 fixtures: trailing-placeholder typing + split placeholder.
  '- 甲\n': () => doc(bl(li(null, p(text('甲'))))),
  // Case CRLF-SB fixtures (soft-break widening, 2026-08-21): a CRLF list item
  // wrapping onto a continuation line, before and after each typed byte. PM
  // holds ONE '\n' character for the soft break regardless of the source
  // spelling — which is exactly why the map must count it as one unit.
  '- 甲\r\n  乙\r\n': () => doc(bl(li(null, p(text('甲\n乙'))))),
  '- 甲\r\n  乙X\r\n': () => doc(bl(li(null, p(text('甲\n乙X'))))),
  '- 甲\r\n  Y乙X\r\n': () => doc(bl(li(null, p(text('甲\nY乙X'))))),
  '- 甲乙\r\n': () => doc(bl(li(null, p(text('甲乙'))))),
  '- 甲\n\nX': () => doc(bl(li(null, p(text('甲')))), p(text('X'))),
  '- 甲\n\nab': () => doc(bl(li(null, p(text('甲')))), p(text('ab'))),
  '甲乙\n\n\n': () => doc(p(text('甲乙'))),
  // Case PERF-3 fixtures: a pending debounced verify + a split-placeholder
  // session on the SAME document (blank-line runs collapse in the reparse).
  '甲丙乙\n\n\n': () => doc(p(text('甲丙乙'))),
  '甲丙乙\n\n丁\n': () => doc(p(text('甲丙乙')), p(text('丁'))),
  '甲乙\n\n丙\n': () => doc(p(text('甲乙')), p(text('丙'))),
  'X甲乙\n\n\n': () => doc(p(text('X甲乙'))),
  // Task 2 (plan 3) fixtures: repeated Enter inside the trailing placeholder
  // chain — mdast always collapses the blank run to nothing regardless of
  // its length, so every one of these still parses to the single paragraph.
  '甲乙\n\n\n\n': () => doc(p(text('甲乙'))),
  '甲乙\n\n\n\n\n': () => doc(p(text('甲乙'))),
  '甲乙\n\n\n\n丙\n': () => doc(p(text('甲乙')), p(text('丙'))),
  // Plan 3 Task 4 fixtures: a code_block text commit (multi-line CM-style
  // insert) followed by a language switch, both on the same block.
  '```js\nab\n```\n': () => doc(cb('js', 'ab')),
  '```js\naX\nYb\n```\n': () => doc(cb('js', 'aX\nYb')),
  '```python\naX\nYb\n```\n': () => doc(cb('python', 'aX\nYb')),
  // CRLF fixtures (un-narrowing, 2026-08-17): a CRLF code block is editable
  // end to end — Case 13 commits a '\r\n'-spelled multi-line insert into it,
  // then proves the bare-'\n' shape still fails closed and that neither
  // outcome locks the rest of the document out.
  '```js\r\nab\r\ncd\r\n```\r\n甲乙\r\n': () => doc(cb('js', 'ab\r\ncd'), p(text('甲乙'))),
  '```js\r\nabX\r\nY\r\ncd\r\n```\r\n甲乙\r\n': () => doc(cb('js', 'abX\r\nY\r\ncd'), p(text('甲乙'))),
  '```js\r\nabX\r\nY\r\ncd\r\n```\r\n甲丙乙\r\n': () => doc(cb('js', 'abX\r\nY\r\ncd'), p(text('甲丙乙'))),
  // Plan 3 Task 5 fixtures: Mod-Enter code-block exit (doc-end + mid-doc)
  // — CommonMark collapses the exit's blank lines, so the post-exit texts
  // parse back to the same block sequences.
  '```js\nab\n```\n\n\n': () => doc(cb('js', 'ab')),
  '```js\nab\n```\n甲\n': () => doc(cb('js', 'ab'), p(text('甲'))),
  '```js\nab\n```\n\n\n甲\n': () => doc(cb('js', 'ab'), p(text('甲'))),
  '```js\nab\n```\nX\n\n甲\n': () => doc(cb('js', 'ab'), p(text('X')), p(text('甲'))),
  // Final-review fixtures (2026-08-16): the from-readonly language-switch
  // refusal was lifted — a mermaid block can switch straight to a real
  // language and immediately accept a plain-text commit afterward.
  '```mermaid\ngraph TD\n```\n': () => doc(cb('mermaid', 'graph TD')),
  '```js\ngraph TD\n```\n': () => doc(cb('js', 'graph TD')),
  '```js\nXgraph TD\n```\n': () => doc(cb('js', 'Xgraph TD')),
  // Plan 4 Task 3 fixtures: inline mark toggles. The live parse chain
  // (Crepe's, WITH the highlight remark plugin) turns committed marker
  // bytes into real marks — mirrored here exactly.
  '甲乙丙\n': () => doc(p(text('甲乙丙'))),
  // P5-3 review follow-up (Case M4c): the ONE mark shape that still trips
  // `requireMap`'s anchor half. The wrap is byte-legal but the RESULT block
  // cannot character-map, so the toggle must refuse before writing anything.
  // (`safeParse` runs on the result text BEFORE the refusal, hence a fixture.)
  'see www.a.com ok\n': () => doc(p(
    text('see '),
    schema.text('www.a.com', [schema.mark('link', { href: 'http://www.a.com' })]),
    text(' ok'))),
  'see ==www.a.com== ok\n': () => doc(p(
    text('see =='),
    schema.text('www.a.com', [schema.mark('link', { href: 'http://www.a.com' })]),
    text('== ok'))),
  '甲**乙**丙\n': () => doc(p(text('甲'), schema.text('乙', [schema.mark('strong')]), text('丙'))),
  '甲==乙==丙\n': () => doc(p(text('甲'), schema.text('乙', [schema.mark('highlight')]), text('丙'))),
  // P5-2.5 review item 6: the `/quote` slash query and the bytes
  // `runQuoteToggleFromQuery` would commit for it (a bare owned-blank-line
  // marker). ProseMirror's blockquote is `block+` and cannot hold zero
  // children, so the parse fills an empty paragraph in — which is exactly
  // why that document can never pair (mdast blockquote has NO children).
  '/quote\n': () => doc(p(text('/quote'))),
  '>\n': () => doc(bq(p())),
  // Block-type conversion domain (Cases B1-B5). The slash query blocks and
  // every document `runBlockTypeFromQuery` can produce from them, mirroring
  // the live Crepe parse + `withTrailingParagraph`'s own append (a document
  // whose last top-level child is a LIST gains a trailing paragraph; one
  // ending in a HEADING does not — heading is an accepted final block).
  '/h2\n': () => doc(p(text('/h2'))),
  '/ul\n': () => doc(p(text('/ul'))),
  '/ol\n': () => doc(p(text('/ol'))),
  '/task\n': () => doc(p(text('/task'))),
  '## \n': () => doc(hd(2)),
  '## T\n': () => doc(hd(2, text('T'))),
  '- \n': () => doc(bl(li(null, p())), p()),
  '- x\n': () => doc(bl(li(null, p(text('x')))), p()),
  '1. \n': () => doc(ol(li(null, p())), p()),
  '# /h2\n': () => doc(hd(1, text('/h2'))),
  // Case B6/B7 (2026-08-22): block-type conversion INSIDE a blockquote — the
  // quote survives, the converted block lives inside it, and the empty
  // heading/item is typable there exactly like at top level.
  '> /h2\n': () => doc(bq(p(text('/h2')))),
  '> ## \n': () => doc(bq(hd(2))),
  '> ## T\n': () => doc(bq(hd(2, text('T')))),
  '> /ul\n': () => doc(bq(p(text('/ul')))),
  '> - \n': () => doc(bq(bl(li(null, p())))),
  '> - x\n': () => doc(bq(bl(li(null, p(text('x')))))),
  // Case IQ1-IQ3 (2026-08-22): block INSERTS inside a blockquote — every
  // continuation line carries the `> ` prefix byte-for-byte (code-map's own
  // per-line requirement), and the created block is typable in place.
  '> /table\n': () => doc(bq(p(text('/table')))),
  '> |  |  |  |\n> | --- | --- | --- |\n> |  |  |  |\n': () =>
    doc(bq(tbl([[[''], [''], ['']], [[''], [''], ['']]]))),
  '> | x |  |  |\n> | --- | --- | --- |\n> |  |  |  |\n': () =>
    doc(bq(tbl([[['x'], [''], ['']], [[''], [''], ['']]]))),
  '> /js\n': () => doc(bq(p(text('/js')))),
  '> ```javascript\n> \n> ```\n': () => doc(bq(cb('javascript'))),
  '> ```javascript\n> x\n> ```\n': () => doc(bq(cb('javascript', 'x'))),
  '> /task\n': () => doc(bq(p(text('/task')))),
  ['> - [ ] ' + SEED_NBSP + '\n']: () => doc(bq(bl(li(false, p(text(SEED_NBSP)))))),
  ['> - [ ] ' + SEED_NBSP + '买\n']: () => doc(bq(bl(li(false, p(text(SEED_NBSP + '买')))))),
  ['> - [ ] 买\n']: () => doc(bq(bl(li(false, p(text('买')))))),
  // Block-INSERT domain (Cases I1-I4): the slash query blocks and every
  // document `runInsertBlockFromQuery` can produce from them. Same
  // `withTrailingParagraph` convention as above — a document ending in a TABLE
  // or a CODE BLOCK gains the trailing paragraph, which is also why the table
  // fixtures carry an explicit `p()` (safeParse's own append is idempotent).
  '/table\n': () => doc(p(text('/table'))),
  '/js\n': () => doc(p(text('/js'))),
  '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n': () =>
    doc(tbl([[[''], [''], ['']], [[''], [''], ['']]]), p()),
  '| x |  |  |\n| --- | --- | --- |\n|  |  |  |\n': () =>
    doc(tbl([[['x'], [''], ['']], [[''], [''], ['']]]), p()),
  '```javascript\n\n```\n': () => doc(cb('javascript'), p()),
  '```javascript\nx\n```\n': () => doc(cb('javascript', 'x'), p()),
  // Case I5 (2026-08-20): the `/task` seed spelling — `- [ ] ` + U+00A0, the
  // only representable "empty" task (checked FALSE, one addressable char) —
  // and the document its first-content DISSOLVE commits (seed deleted, label
  // exactly the typed text). Same trailing-`p()` convention as the fixtures
  // above.
  '- [ ]  \n': () => doc(bl(li(false, p(text(' ')))), p()),
  '- [ ] x\n': () => doc(bl(li(false, p(text('x')))), p()),
  // Case I5c-I5f (2026-08-20 adversarial panel): the IME route to the task-
  // seed dissolve. Every byte string commitReplace can produce on these
  // shapes is registered — INCLUDING the un-dissolved pre-fix spellings
  // (seed + committed label, the same tripwire convention as Case 21c:
  // without them stubParse would THROW on the pre-fix bytes and the kernel
  // would roll back, masking the byte assertion behind a parse failure).
  ['/task\r\n']: () => doc(p(text('/task'))),
  ['- [ ] ' + SEED_NBSP + '\r\n']: () => doc(bl(li(false, p(text(SEED_NBSP)))), p()),
  ['- [ ] 买菜\n']: () => doc(bl(li(false, p(text('买菜')))), p()),
  ['- [ ] 买菜\r\n']: () => doc(bl(li(false, p(text('买菜')))), p()),
  ['- [ ] ' + SEED_NBSP + '买菜\n']: () => doc(bl(li(false, p(text(SEED_NBSP + '买菜')))), p()),
  ['- [ ] ' + SEED_NBSP + '买菜\r\n']: () => doc(bl(li(false, p(text(SEED_NBSP + '买菜')))), p()),
  ['- [ ] x买\n']: () => doc(bl(li(false, p(text('x买')))), p()),
  ['- [ ] ' + SEED_NBSP + '买\n']: () => doc(bl(li(false, p(text(SEED_NBSP + '买')))), p()),
  // Case I5g/I5h (2026-08-21 task-Enter matrix): Enter continuation writes a
  // SEEDED second item; the pre-fix demoted spelling (bare `- [ ] ` → a
  // checked:null item holding literal "[ ]" text) is registered too, per the
  // Case 21c tripwire convention, so the pre-fix commit lands and fails on
  // BYTES instead of a masked stub-parse throw. Enter on the fresh seed
  // EXITS the list, leaving no blocks at all ('\n' → just the trailing
  // placeholder).
  ['- [ ] x\n- [ ] ' + SEED_NBSP + '\n']: () =>
    doc(bl(li(false, p(text('x'))), li(false, p(text(SEED_NBSP)))), p()),
  ['- [ ] x\n- [ ] \n']: () => doc(bl(li(false, p(text('x'))), li(null, p(text('[ ]')))), p()),
  ['- [ ] x\n- [ ] y\n']: () => doc(bl(li(false, p(text('x'))), li(false, p(text('y')))), p()),
  ['\n']: () => doc(p()),
  // Case I6 (2026-08-20): `/divider` — the first caret-AFTER insert. An
  // hr-ending document always carries the trailing placeholder (same
  // `withTrailingParagraph` convention as every fixture above); the typed
  // follow-up rides the virtual pair ('---\n' + '\n' separator + 'X').
  '/hr\n': () => doc(p(text('/hr'))),
  '---\n': () => doc(hr(), p()),
  '---\n\nX': () => doc(hr(), p(text('X'))),
  '/hr\n\n乙\n': () => doc(p(text('/hr')), p(text('乙'))),
  '---\n\n乙\n': () => doc(hr(), p(text('乙'))),
  '---\n\nX乙\n': () => doc(hr(), p(text('X乙'))),
  '/hr\n\n- 甲\n': () => doc(p(text('/hr')), bl(li(null, p(text('甲')))), p()),
  // Case I7 (2026-08-20): `/image` — the second caret-AFTER insert. `![]()`
  // is the paragraph>image shape Crepe's remarkImageBlock renders as the
  // block-level image-block ATOM; an image-ending document carries the
  // trailing placeholder like every other atom ending.
  '/image\n': () => doc(p(text('/image'))),
  '![]()\n': () => doc(ib({ src: '', alt: '', caption: '' }), p()),
  '![]()\n\nX': () => doc(ib({ src: '', alt: '', caption: '' }), p(text('X'))),
  '/image\n\n乙\n': () => doc(p(text('/image')), p(text('乙'))),
  '![]()\n\n乙\n': () => doc(ib({ src: '', alt: '', caption: '' }), p(text('乙'))),
  '![]()\n\nX乙\n': () => doc(ib({ src: '', alt: '', caption: '' }), p(text('X乙'))),
  // Case I8 (2026-08-20): `/text` — revert-to-paragraph. The post-strip
  // documents parse WITHOUT the emptied paragraph (a trailing blank line is
  // no block); the controller then gives the caret its home (a vouched
  // placeholder after a paragraph ending, the trailing pair after a list).
  '甲\n\n/text\n': () => doc(p(text('甲')), p(text('/text'))),
  '甲\n\n': () => doc(p(text('甲'))),
  '甲\n\nX': () => doc(p(text('甲')), p(text('X'))),
  '- 甲\n\n/text\n': () => doc(bl(li(null, p(text('甲')))), p(text('/text'))),
  '- 甲\n\n': () => doc(bl(li(null, p(text('甲')))), p()),
  '/text\n\n乙\n': () => doc(p(text('/text')), p(text('乙'))),
  // Case I8b (2026-08-21): `/text` MID-DOCUMENT. The deletion leaves a
  // blank-line RUN that CommonMark collapses, so the post-strip parses hold
  // no node for it at all — the placeholder is view-only until the follow-up
  // keystroke makes it real.
  '甲\n\n/text\n\n乙\n': () => doc(p(text('甲')), p(text('/text')), p(text('乙'))),
  '甲\n\n\n\n乙\n': () => doc(p(text('甲')), p(text('乙'))),
  '甲\n\nX\n\n乙\n': () => doc(p(text('甲')), p(text('X')), p(text('乙'))),
  '\n\n乙\n': () => doc(p(text('乙'))),
  'X\n\n乙\n': () => doc(p(text('X')), p(text('乙'))),
  'X甲\n\n\n\n乙\n': () => doc(p(text('X甲')), p(text('乙'))),
  '- a\n\n/text\n\n- b\n': () =>
    doc(bl(li(null, p(text('a')))), p(text('/text')), bl(li(null, p(text('b')))), p()),
  // P5-2.5 fixtures (Case 17): a document with ONE unprovable block. It used
  // to be `==高亮==` — P5-3 taught the kernel that shape (it is editable now,
  // see Case M4), so the pin moved to the RED highlight, which is exactly the
  // shape P5-3 deliberately did NOT teach: `<mark class="hm-hl-red">` is
  // inline HTML, ONE atom to the kernel's shared run rule but a 2-character
  // marked text run in ProseMirror (the editor's `coalesceMarkHtml` turns the
  // merged fragment into a highlight node). The same pure size disagreement,
  // in the shape that still has it.
  '甲乙\n\n<mark class="hm-hl-red">高亮</mark>\n': () =>
    doc(p(text('甲乙')), p(schema.text('高亮', [schema.mark('highlight', { color: 'red' })]))),
  '甲丙乙\n\n<mark class="hm-hl-red">高亮</mark>\n': () =>
    doc(p(text('甲丙乙')), p(schema.text('高亮', [schema.mark('highlight', { color: 'red' })]))),
  '甲丁丙乙\n\n<mark class="hm-hl-red">高亮</mark>\n': () =>
    doc(p(text('甲丁丙乙')), p(schema.text('高亮', [schema.mark('highlight', { color: 'red' })]))),
  '甲`乙`丙\n': () => doc(p(text('甲'), schema.text('乙', [schema.mark('inlineCode')]), text('丙'))),
  '甲`乙丙`\n': () => doc(p(text('甲'), schema.text('乙丙', [schema.mark('inlineCode')]))),
  // P4-3.5 Fix B fixtures: plain typing inside the already-marked paragraph.
  '甲**乙**丙X\n': () => doc(p(text('甲'), schema.text('乙', [schema.mark('strong')]), text('丙X'))),
  '甲**乙**X丙\n': () => doc(p(text('甲'), schema.text('乙', [schema.mark('strong')]), text('X丙'))),
  // Plan 4 Task 4 fixture: quote-toggle wrap/unwrap round trip. Reused for
  // both directions ('甲乙\n' -> wrap -> this, and this -> unwrap -> '甲乙\n',
  // which already has its own fixture above). Trailing `p()` mirrors
  // `withTrailingParagraph`'s own append (see e.g. the mermaid fixtures
  // above): a doc whose last top-level child is not paragraph/heading always
  // gains one, so the fixture bakes it in directly rather than relying on
  // the (here bypassed for a hand-built parse) append to add it again.
  '> 甲乙\n': () => doc(bq(p(text('甲乙'))), p()),
  // Plan 5 Task 1 fixtures: a document carrying BOTH inline and block math.
  // Before the kernel chain gained remark-math this whole document degraded
  // to legacy at attach (projection map null), so NOTHING in it was
  // kernel-editable — including its ordinary paragraphs. These fixtures
  // mirror the live Crepe parse exactly: `$x$` -> math_inline atom,
  // `$$..$$` -> code_block(language 'LaTeX').
  'a $x$ b\n\n$$\nE=mc^2\n$$\n\n甲乙\n': () => doc(
    p(text('a '), mif('x'), text(' b')), cb('LaTeX', 'E=mc^2'), p(text('甲乙'))),
  'a $x$ b\n\n$$\nE=mc^2\n$$\n\n甲X乙\n': () => doc(
    p(text('a '), mif('x'), text(' b')), cb('LaTeX', 'E=mc^2'), p(text('甲X乙'))),
  // Plan 5 Task 2 — inline HTML: the editor chain's merged `<span>x</span>`
  // is ONE inline `html` atom in the parsed doc.
  'a <span>x</span> b\n\n甲乙\n': () => doc(
    p(text('a '), ih('<span>x</span>'), text(' b')), p(text('甲乙'))),
  'a <span>x</span> b\n\n甲丙乙\n': () => doc(
    p(text('a '), ih('<span>x</span>'), text(' b')), p(text('甲丙乙'))),
  // blockAt-inline-html fixtures: a paragraph that STARTS with a fragment,
  // and the result of joining it backward into the previous paragraph (the
  // soft break survives as a literal '\n' inside the merged paragraph's
  // leading text node — the same lazy-continuation shape every other
  // join-block-backward commit produces).
  'a\n\n<span>x</span> b\n': () => doc(
    p(text('a')), p(ih('<span>x</span>'), text(' b'))),
  'a\n<span>x</span> b\n': () => doc(
    p(text('a\n'), ih('<span>x</span>'), text(' b'))),
  // Plan 5 Task 4 fixtures: a GFM table with per-column alignment, plus a
  // paragraph after it. Crepe's parse puts each column's alignment on every
  // cell of that column (preset-gfm's parseMarkdown runners read
  // `table.align`), which is exactly what must survive a cell TEXT edit.
  '| a | b |\n| :-- | --: |\n| c | d |\n\n甲乙\n': () => doc(
    tbl([[['a', 'left'], ['b', 'right']], [['c', 'left'], ['d', 'right']]]),
    p(text('甲乙'))),
  '| aX | b |\n| :-- | --: |\n| c | d |\n\n甲乙\n': () => doc(
    tbl([[['aX', 'left'], ['b', 'right']], [['c', 'left'], ['d', 'right']]]),
    p(text('甲乙'))),
  '| aX | b |\n| :-- | --: |\n| c | dY |\n\n甲乙\n': () => doc(
    tbl([[['aX', 'left'], ['b', 'right']], [['c', 'left'], ['dY', 'right']]]),
    p(text('甲乙'))),
  '| aX | b |\n| :-- | --: |\n| c | dY |\n\n甲丙乙\n': () => doc(
    tbl([[['aX', 'left'], ['b', 'right']], [['c', 'left'], ['dY', 'right']]]),
    p(text('甲丙乙'))),
  // Case 21c: the REGRESSION shape itself — a literal tab committed into a
  // cell. GFM reads it as cell padding, so the document still parses to the
  // very same ProseMirror doc (the tab is invisible in the view while living
  // in the file). Registered deliberately even though the fixed build never
  // reaches it: without the fixture `stubParse` would THROW on the pre-fix
  // bytes and the kernel would roll back, masking the byte assertion in Case
  // 21c and turning it into a tripwire that can never fire.
  '| a\t | b |\n| :-- | --: |\n| c | d |\n\n甲乙\n': () => doc(
    tbl([[['a', 'left'], ['b', 'right']], [['c', 'left'], ['d', 'right']]]),
    p(text('甲乙'))),
  // Case 21c (e): the positive control — a Tab in the ORDINARY paragraph
  // after the table still writes source-first. Since 2026-08-18 that is TWO
  // no-break spaces, not a literal '\t': a tab at a block's END is stripped by
  // CommonMark, so the literal byte was a dead byte (written to disk, invisible
  // in the view, forever). See lib/source-kernel/commands/trailing-whitespace.js.
  '| a | b |\n| :-- | --: |\n| c | d |\n\n甲乙  \n': () => doc(
    tbl([[['a', 'left'], ['b', 'right']], [['c', 'left'], ['d', 'right']]]),
    p(text('甲乙  '))),
  // Case 21d: a RAGGED table (body row short of a cell) — the whole table
  // degrades to one opaque pair, but cell navigation must still work.
  '| a | b |\n| :-- | --: |\n| c |\n\n甲乙\n': () => doc(
    tbl([[['a', 'left'], ['b', 'right']], [['c', 'left']]]),
    p(text('甲乙'))),
  // Plan 5 Task 5 fixtures: a standalone image (Crepe's block-level
  // `image-block` atom over the kernel's `paragraph > image` wrapper) plus a
  // following paragraph, before and after each attribute rewrite.
  // Case HID (2026-08-17 veto-divergence): a heading document, parsed with
  // the EMPTY heading id a real parse always produces. The live view's
  // heading carries the slug `syncHeadingIdPlugin` wrote there — the exact
  // disagreement that used to reconcile the whole document per keystroke.
  '# 标题\n\n甲乙\n': () => doc(hd(1, text('标题')), p(text('甲乙'))),
  '# 标题\n\n甲丙乙\n': () => doc(hd(1, text('标题')), p(text('甲丙乙'))),
  '![a](x.png)\n\n甲乙\n': () => doc(ib({ src: 'x.png', alt: 'a', caption: 'a' }), p(text('甲乙'))),
  '![a](y/pic.png)\n\n甲乙\n': () => doc(ib({ src: 'y/pic.png', alt: 'a', caption: 'a' }), p(text('甲乙'))),
  '![a](y/pic.png)\n\n甲丙乙\n': () => doc(ib({ src: 'y/pic.png', alt: 'a', caption: 'a' }), p(text('甲丙乙'))),
  // kernel/image-caption: the committed caption's projection (`caption:
  // title || alt`), and the SCALED byte form (numeric alt + title -> the
  // legacy reading: alt '', caption = title, ratio = the number).
  '![a](x.png "新图注")\n\n甲乙\n': () => doc(ib({ src: 'x.png', alt: 'a', caption: '新图注' }), p(text('甲乙'))),
  '![1.50](x.png "说明")\n\n甲乙\n': () =>
    doc(ib({ src: 'x.png', alt: '', caption: '说明', ratio: 1.5 }), p(text('甲乙'))),
  '![说明文字](x.png)\n\n甲乙\n': () =>
    doc(ib({ src: 'x.png', alt: '说明文字', caption: '说明文字' }), p(text('甲乙'))),
  // Inline image: one width-1 atom inside its paragraph.
  '前![a](x.png)后\n\n甲乙\n': () =>
    doc(p(text('前'), img({ src: 'x.png', alt: 'a' }), text('后')), p(text('甲乙'))),
  '前![a](x.png "标题")后\n\n甲乙\n': () =>
    doc(p(text('前'), img({ src: 'x.png', alt: 'a', title: '标题' }), text('后')), p(text('甲乙'))),
  // An image whose raw span carries a LINE ENDING (CommonMark allows one in
  // the whitespace before the title). It maps perfectly well — it is one
  // atom on both sides — but `setImageAttrs` refuses to rewrite it, which is
  // what makes it the per-pair degradation fixture.
  '前![a](x.png\n"t")后\n\n甲乙\n': () =>
    doc(p(text('前'), img({ src: 'x.png', alt: 'a', title: 't' }), text('后')), p(text('甲乙'))),
  '前![a](x.png\n"t")后\n\n甲丙乙\n': () =>
    doc(p(text('前'), img({ src: 'x.png', alt: 'a', title: 't' }), text('后')), p(text('甲丙乙'))),
  // Plan 5 Task 6 (link domain). A `link` is a MARK on both sides, so the PM
  // fixture is just a marked text run — the `[`/`](url)` bytes are gaps in
  // the character map, exactly like `**`/`==`.
  '甲[乙](https://x.example)丙\n': () =>
    doc(p(text('甲'), schema.text('乙', [schema.mark('link', { href: 'https://x.example' })]), text('丙'))),
  '甲[乙](https://y.example)丙\n': () =>
    doc(p(text('甲'), schema.text('乙', [schema.mark('link', { href: 'https://y.example' })]), text('丙'))),
  '甲[https://q.example](https://q.example)乙\n': () =>
    doc(p(
      text('甲'),
      schema.text('https://q.example', [schema.mark('link', { href: 'https://q.example' })]),
      text('乙')
    )),
  // (A GFM autolink literal — the same `link` MARK in ProseMirror over a
  // `link` mdast node with NO syntax bytes — already has its fixture above,
  // registered for Case M4c; Case M5 below reuses it.)
  // Integration-review Condition 2/3 fixtures (2026-08-21): the mid-block
  // split shape for the structural-subsumption pin, and the PERF-4 guard's
  // own document states (unique strings — the parse memo is keyed by exact
  // string, so fresh spellings make the parse-count deltas deterministic
  // regardless of what earlier cases left in the LRU).
  '守丙\n\n亥\n': () => doc(p(text('守丙')), p(text('亥'))),
  '守甲\n\n守乙\n': () => doc(p(text('守甲')), p(text('守乙'))),
  '守甲丙\n\n守乙\n': () => doc(p(text('守甲丙')), p(text('守乙'))),
  '守甲丙丁\n\n守乙\n': () => doc(p(text('守甲丙丁')), p(text('守乙'))),
  '守甲丙丁戊\n\n守乙\n': () => doc(p(text('守甲丙丁戊')), p(text('守乙')))
}
const stubParse = (markdown) => {
  const build = FIXTURE_DOCS[markdown]
  if (!build) throw new Error('stub parse has no fixture for: ' + JSON.stringify(markdown))
  return build()
}

// Stub view implementing the dispatch protocol handleTransactions relies on:
// a real EditorState, dispatch applies the tr in place (so reconcileProjection
// and caret-restore work), updateState swaps in a pre-applied state.
const makeView = (initialDoc) => {
  let state = EditorState.create({ schema, doc: initialDoc })
  return {
    get state() { return state },
    dispatch(tr) { state = state.apply(tr) },
    updateState(next) { state = next },
    composing: false,
    focus() {}
  }
}

const makeHarness = (initialContent, initialDoc, extra = {}) => {
  const notifications = []
  const changes = []
  const view = makeView(initialDoc)
  const controller = createKernelMode({
    initialContent,
    getView: () => view,
    parse: stubParse,
    notify: (message) => notifications.push(message),
    getT: (key) => key,
    onChange: (markdown, flag) => changes.push([markdown, flag]),
    ...extra
  })
  return { view, controller, notifications, changes }
}

// Emulate createSourceTransactionDispatch: classify first, updateState only
// when not vetoed.
const dispatchThrough = (harness, tr) => {
  const oldState = harness.view.state
  const applied = oldState.apply(tr)
  const verdict = harness.controller.handleTransactions([tr], oldState, {
    ...applied,
    doc: applied.doc,
    tr: applied.tr
  })
  if (!verdict?.veto) harness.view.updateState(applied)
  return verdict
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

console.log('--- kernel mode headless ---')

// Shared harness for cases 1 / 2 / 5 (they form one editing session).
const session = makeHarness('甲乙\n', doc(p(text('甲乙'))))
assert.equal(session.controller.attachAfterCreate(), true, 'initial map must build')
assert.ok(session.controller.kernel.map, 'kernel.map set after attach')

// Case 1: plain-text insert flows through commitPlainText — pass-through
// (undefined), kernel bytes advance, onChange publishes the kernel text.
{
  const oldState = session.view.state
  const tr = oldState.tr.insertText('丙', 2) // between 甲 and 乙 -> raw offset 1
  const verdict = dispatchThrough(session, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'plain-text is allowed (no veto)')
  assert.equal(session.controller.kernel.doc.text, '甲丙乙\n')
  assert.equal(session.controller.kernel.doc.revision, 1)
  assert.deepEqual(session.changes.at(-1), ['甲丙乙\n', false])
  assert.equal(session.view.state.doc.textContent, '甲丙乙')
  // Map was rebound to the new revision/doc: raw 1 (after 甲) -> PM pos 2.
  assert.equal(session.controller.kernel.map.pmPosToRaw(2), 1)
}

// Case 2: a drop transaction is blocked -> {veto:true}, kernel unchanged,
// notify fired; the view keeps its pre-drop state (dispatch protocol skips
// updateState on veto).
{
  const before = session.notifications.length
  const oldState = session.view.state
  const tr = oldState.tr.insertText('X', 1)
  tr.setMeta('uiEvent', 'drop')
  const verdict = dispatchThrough(session, tr)
  assert.deepEqual(verdict, { veto: true })
  assert.equal(session.controller.kernel.doc.text, '甲丙乙\n', 'kernel bytes untouched')
  assert.equal(session.view.state.doc.textContent, '甲丙乙', 'view untouched after veto')
  assert.ok(session.notifications.length > before, 'blocked edit notifies the user')

  // Toast cooldown: an immediately repeated blocked edit (key-repeat veto
  // storm) still vetoes but must NOT stack another toast within the window.
  const notifCount = session.notifications.length
  const repeat = session.view.state.tr.insertText('X', 1)
  repeat.setMeta('uiEvent', 'drop')
  assert.deepEqual(dispatchThrough(session, repeat), { veto: true })
  assert.equal(session.notifications.length, notifCount, 'repeat toast suppressed by cooldown')
}

// Case 3: structural Enter mid-paragraph. Fresh session '甲乙\n', caret at PM
// pos 2 (raw offset 1). splitTextBlock inserts '\n\n' at raw 1 ->
// '甲\n\n乙\n'; the view is reconciled to the parsed two-paragraph doc and the
// caret lands in the second paragraph (raw 3 -> PM pos 4).
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))
  const handled = h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view)
  assert.equal(handled, true)
  assert.equal(h.controller.kernel.doc.text, '甲\n\n乙\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲')), p(text('乙')))), 'view reconciled to parse output')
  assert.equal(h.view.state.selection.head, 4, 'caret restored into the new block')
  assert.deepEqual(h.changes.at(-1), ['甲\n\n乙\n', false])
}

// Case 4: Tab in a paragraph is not-structural -> replaceVisibleText inserts
// a literal '\t' through the kernel (source-first), swallowing the key.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))
  const handled = h.controller.structuralHandlers.Tab(h.view.state, h.view.dispatch, h.view)
  assert.equal(handled, true)
  assert.equal(h.controller.kernel.doc.text, '甲\t乙\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲\t乙')))))
  assert.equal(h.view.state.selection.head, 3, 'caret sits right after the inserted tab')
}

// Case 5: history — undo restores the pre-Case-1 bytes exactly; redo
// reapplies them. Both reconcile the view and both suppress PM history
// (handler returns true even when there is nothing to undo).
{
  const undone = session.controller.historyHandlers.undo(
    session.view.state, session.view.dispatch, session.view
  )
  assert.equal(undone, true)
  assert.equal(session.controller.kernel.doc.text, '甲乙\n', 'undo restores bytes exactly')
  assert.ok(session.view.state.doc.eq(doc(p(text('甲')))) === false)
  assert.ok(session.view.state.doc.eq(doc(p(text('甲乙')))))
  assert.equal(session.view.state.selection.head, 2, 'undo caret at the removed span')

  const redone = session.controller.historyHandlers.redo(
    session.view.state, session.view.dispatch, session.view
  )
  assert.equal(redone, true)
  assert.equal(session.controller.kernel.doc.text, '甲丙乙\n', 'redo reapplies bytes exactly')
  assert.ok(session.view.state.doc.eq(doc(p(text('甲丙乙')))))
  assert.equal(session.view.state.selection.head, 3)

  // Empty redo stack: still true (suppresses PM history), no state change.
  const emptyRedo = session.controller.historyHandlers.redo(
    session.view.state, session.view.dispatch, session.view
  )
  assert.equal(emptyRedo, true)
  assert.equal(session.controller.kernel.doc.text, '甲丙乙\n')
}

// Case 6: degraded mode. The initial map cannot be proven (kernel text has
// ONE paragraph, the PM doc has TWO) -> attachAfterCreate degrades with a
// notification; from then on handleTransactions passes EVERYTHING through
// (legacy behavior — even a drop) and every keymap handler returns false.
{
  const fallbacks = []
  const h = makeHarness('甲乙\n', doc(p(text('甲')), p(text('乙'))), {
    onLegacyFallback: (info) => fallbacks.push(info)
  })
  assert.equal(h.controller.attachAfterCreate(), false)
  assert.ok(h.notifications.length >= 1, 'degradation is announced, never silent')
  assert.equal(h.controller.kernel.map, null)
  // Perf plan §9 item 1: kernel mode does not register Milkdown's
  // `markdownUpdated` listener (the serializer behind it is pure waste for a
  // live kernel tab), so the DEGRADED tab — whose only publisher IS that
  // handler — depends on this callback firing exactly once at the degradation
  // edge. A missing/duplicated call is silent data loss or a double publish.
  assert.equal(fallbacks.length, 1, 'legacy fallback announced exactly once')
  assert.equal(fallbacks[0].chunked, false)
  assert.equal(fallbacks[0].reason, 'unmappable')

  const oldState = h.view.state
  const drop = oldState.tr.insertText('X', 1)
  drop.setMeta('uiEvent', 'drop')
  assert.equal(h.controller.handleTransactions([drop], oldState, oldState.apply(drop)), undefined)

  const plain = h.view.state.tr.insertText('Y', 1)
  assert.equal(
    h.controller.handleTransactions([plain], h.view.state, h.view.state.apply(plain)),
    undefined
  )
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'degraded kernel never advances')
  assert.equal(h.changes.length, 0, 'degraded mode publishes nothing')

  for (const key of ['Enter', 'Tab', 'Shift-Tab', 'Backspace', 'Delete']) {
    assert.equal(
      h.controller.structuralHandlers[key](h.view.state, h.view.dispatch, h.view),
      false,
      key + ' falls back to legacy keymaps in degraded mode'
    )
  }
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), false)
  assert.equal(h.controller.historyHandlers.redo(h.view.state, h.view.dispatch, h.view), false)
  assert.equal(h.controller.isDegraded(), true)

  // Degraded-aware API delegation: every override must reach the captured
  // legacy implementation at call time — the frozen kernel.doc.text is a
  // data-loss trap here (save would silently write the initial content).
  const legacyCalls = []
  h.controller.attachLegacyApi({
    flushMarkdown: () => h.view.state.doc.textContent + '\n',
    flushMarkdownSettled: async () => h.view.state.doc.textContent + '\n',
    replaceMarkdown: (md) => { legacyCalls.push(['replaceMarkdown', md]); return true },
    getVerifiedSyncStatus: () => ({ status: 'committed' }),
    getRecoveryMarkdown: () => 'LEGACY-RECOVERY',
    markdownOffsetFromSelection: () => 42,
    restoreMarkdownOffset: (raw) => { legacyCalls.push(['restore', raw]); return true },
    applyTextFormat: () => true,
    toggleHighlight: () => undefined,
    applyReviewMarkup: () => true
  })
  const api = h.controller.apiOverrides

  // A real text edit passes through to the view (legacy ownership) and the
  // delegated flush then returns the EDITED content, not the frozen bytes.
  const edit = h.view.state.tr.insertText('新', 1)
  const applied = h.view.state.apply(edit)
  assert.equal(h.controller.handleTransactions([edit], h.view.state, applied), undefined)
  h.view.updateState(applied)
  assert.equal(h.view.state.doc.textContent, '新甲乙')
  assert.equal(api.flushMarkdown(), '新甲乙\n', 'flush reflects the edit via legacy delegation')
  assert.notEqual(api.flushMarkdown(), h.controller.kernel.doc.text, 'never the frozen kernel bytes')
  assert.equal(await api.flushMarkdownSettled(), '新甲乙\n')
  assert.notEqual(api.getVerifiedSyncStatus().status, 'kernel-authoritative',
    'degraded tab must not claim kernel authority')
  assert.equal(api.getRecoveryMarkdown(), 'LEGACY-RECOVERY')
  assert.equal(api.markdownOffsetFromSelection(), 42)
  assert.equal(api.restoreMarkdownOffset(7), true)
  assert.equal(api.replaceMarkdown('X\n'), true)
  assert.deepEqual(legacyCalls, [['restore', 7], ['replaceMarkdown', 'X\n']])
  const notifBefore = h.notifications.length
  assert.equal(api.applyTextFormat('bold'), true, 'legacy owns formatting again when degraded')
  assert.equal(api.toggleHighlight(), undefined,
    'a void legacy result propagates (no ?? fallback to the refusal path)')
  assert.equal(api.applyReviewMarkup('insert'), true)
  assert.equal(h.notifications.length, notifBefore, 'no unsupported-API toast in degraded mode')
}

// Case 6b: the SAME callback must NOT fire for a tab that attaches. The whole
// `markdownUpdated`-skipping optimization rests on this asymmetry — a spurious
// call would re-register Milkdown's serializer on a healthy kernel tab (giving
// the cost back), and a missing one on a degraded tab is data loss (Case 6).
// The chunked flavour is asserted too, because that is the fallback the
// >CHUNK_THRESHOLD band takes and its reason string is user-visible.
{
  const attachedFallbacks = []
  const ok = makeHarness('甲乙\n', doc(p(text('甲乙'))), {
    onLegacyFallback: (info) => attachedFallbacks.push(info)
  })
  assert.equal(ok.controller.attachAfterCreate(), true)
  assert.deepEqual(attachedFallbacks, [], 'an attached tab never announces a legacy fallback')

  const chunkedFallbacks = []
  const chunked = makeHarness('甲乙\n', doc(p(text('甲')), p(text('乙'))), {
    chunkedLoad: true,
    onLegacyFallback: (info) => chunkedFallbacks.push(info)
  })
  assert.equal(chunked.controller.attachAfterCreate(), false)
  assert.deepEqual(chunkedFallbacks, [{ chunked: true, reason: 'chunked' }])
}

// Case 7 (wiring guard): before attachAfterCreate has run (Crepe still
// creating / chunks still appending), everything passes through and no key is
// intercepted — otherwise the kernel would veto the editor's own init
// transactions.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  const oldState = h.view.state
  const tr = oldState.tr.insertText('Z', 1)
  assert.equal(h.controller.handleTransactions([tr], oldState, oldState.apply(tr)), undefined)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n')
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), false)
}

// Case 8: apiOverrides surface. flushMarkdown returns the kernel bytes
// directly; sync status reports kernel authority; offset APIs run on the
// projection map (never the ordinal editor-source-map path); unsupported
// rich formatting APIs refuse with a notification.
{
  globalThis.__hmKernelDiagnostics = []
  const prepareCalls = []
  const structureCalls = []
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))), {
    prepareMarkdown: (source) => { prepareCalls.push(source); return source },
    onStructureChange: () => structureCalls.push(1)
  })
  assert.equal(h.controller.attachAfterCreate(), true)
  const api = h.controller.apiOverrides
  assert.equal(api.flushMarkdown(), '甲乙\n')
  assert.equal(await api.flushMarkdownSettled(), '甲乙\n')
  assert.deepEqual(api.getVerifiedSyncStatus(), { status: 'kernel-authoritative' })
  assert.equal(api.getRecoveryMarkdown(), '甲乙\n')
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))
  assert.equal(api.markdownOffsetFromSelection(), 1)
  assert.equal(api.restoreMarkdownOffset(2), true)
  assert.equal(h.view.state.selection.head, 3)
  const before = h.notifications.length
  assert.equal(api.applyTextFormat('bold'), false)
  assert.equal(api.toggleHighlight(), false)
  assert.equal(api.applyReviewMarkup('insert'), false)
  assert.equal(h.notifications.length, before + 1,
    'unsupported APIs notify (cooldown collapses the burst to one toast)')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'unsupported-api').length,
    3,
    'every refusal is individually diagnosed'
  )

  // replaceMarkdown resets the kernel + history, reconciles the view, runs
  // the legacy prepare normalization before parsing, and reports the
  // structure change (outline refresh parity with the legacy path).
  assert.equal(api.replaceMarkdown('甲\n\n乙\n'), true)
  assert.deepEqual(prepareCalls, ['甲\n\n乙\n'], 'prepareMarkdown ran before parse')
  assert.equal(structureCalls.length, 1, 'onStructureChange fired once')
  assert.equal(h.controller.kernel.doc.text, '甲\n\n乙\n')
  assert.equal(h.controller.kernel.doc.revision, 0, 'replace resets the revision line')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲')), p(text('乙')))))
  assert.equal(
    h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view),
    true, 'undo after replace is suppressed (history cleared)'
  )
  assert.equal(h.controller.kernel.doc.text, '甲\n\n乙\n')
}

// Case 9: history-frozen diagnostic. A null undo caused by revision desync
// (the stack still has entries but the doc's revision no longer matches the
// history's rolling pointer) is diagnosed, not silently identical to an
// empty stack.
{
  globalThis.__hmKernelDiagnostics = []
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const oldState = h.view.state
  const tr = oldState.tr.insertText('丙', 2)
  dispatchThrough(h, tr) // records one undo group
  await flushMicrotasks()
  // External desync: same bytes, foreign revision — breaks the linear chain
  // createSourceHistory tracks via its rolling lastKnownRevision pointer.
  h.controller.kernel.doc = { text: h.controller.kernel.doc.text, revision: 99 }
  const handled = h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view)
  assert.equal(handled, true, 'frozen history still swallows the key')
  assert.equal(h.controller.kernel.doc.text, '甲丙乙\n', 'nothing replayed')
  assert.ok(
    globalThis.__hmKernelDiagnostics.some(
      (entry) => entry.type === 'history-frozen' && entry.direction === 'undo'
    ),
    'history-frozen diagnostic recorded'
  )
}

// Case 10 (Task 6 integration): apiOverrides.flushMarkdownSettled awaits an
// active IME composition session instead of resolving immediately.
// composition.onStart/onEnd bypass handleTransactions entirely (composition
// transactions are the caller's pass-through concern, not the kernel's — see
// case 'composition' in handleTransactions), so this drives the controller's
// `composition` surface directly and mutates the stub view the same way a
// real compositionupdate would (view.updateState with the composed doc)
// before calling onEnd. Same '甲乙\n' -> insert '丙' at raw 1 -> '甲丙乙\n'
// fixture as case 1, so the committed text is provable by inspection.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))

  h.controller.composition.onStart()
  assert.equal(h.controller.composition.isActive(), true)

  let settled = false
  const flushPromise = h.controller.apiOverrides.flushMarkdownSettled()
    .then((text) => { settled = true; return text })
  await flushMicrotasks()
  assert.equal(settled, false, 'flushMarkdownSettled must wait for the open composition')
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'kernel untouched while composing')

  // The composed edit lands in the view (composition transactions never
  // reach the kernel mid-flight — only compositionend's diff does).
  h.view.updateState(h.view.state.apply(h.view.state.tr.insertText('丙', 2)))
  h.controller.composition.onEnd()
  await flushMicrotasks()

  const settledText = await flushPromise
  assert.equal(settled, true)
  assert.equal(settledText, '甲丙乙\n', 'flush resolves to the settled (committed) kernel text')
  assert.equal(h.controller.kernel.doc.text, '甲丙乙\n')
  assert.equal(h.controller.composition.isActive(), false)
}

// Case 11 (Task 9 root-cause fix): the task-checkbox click. Crepe's
// list-item-block node view toggles a task item with a bare
// `tr.setNodeAttribute(pos, 'checked', v)` (an AttrStep, never a keymap and
// never a ReplaceStep) — before the gateway/kernel-mode `task-toggle`
// classification existed, this fell through to `blocked`/`INPUT_TYPE` and
// the dispatch-veto protocol silently discarded every checkbox click in
// kernel mode (found by the Task 9 UI smoke run). Same dispatchThrough
// protocol a real click goes through: pass-through (undefined verdict),
// kernel bytes flip the marker, the view's own attr-flip is what lands
// (no reconcile needed), and the toggle is its own undo group.
{
  const h = makeHarness('- [x] 乙\n', doc(bl(li(true, p(text('乙'))))))
  assert.equal(h.controller.attachAfterCreate(), true, 'task-list map must build')
  const oldState = h.view.state
  const pos = 1
  assert.equal(oldState.doc.nodeAt(pos)?.type.name, 'list_item', 'fixture position sanity check')
  const tr = oldState.tr.setNodeAttribute(pos, 'checked', false)
  assert.equal(tr.steps[0].constructor.name, 'AttrStep')
  const verdict = dispatchThrough(h, tr)
  assert.equal(verdict, undefined, 'task toggle is allowed through (no veto)')
  assert.equal(h.controller.kernel.doc.text, '- [ ] 乙\n')
  assert.equal(h.controller.kernel.doc.revision, 1)
  assert.deepEqual(h.changes.at(-1), ['- [ ] 乙\n', false])
  assert.equal(h.view.state.doc.firstChild.firstChild.attrs.checked, false, 'view reflects the flip')

  // Undo restores '- [x] 乙\n' as ONE group — its own history entry (intent
  // 'toggle-task'), never coalesced with an unrelated insert-text group —
  // and reconciles via the stub parse fixture above.
  const undone = h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view)
  assert.equal(undone, true)
  assert.equal(h.controller.kernel.doc.text, '- [x] 乙\n', 'undo restores the checked marker exactly')
}

// Case 12 (Task 11.5, trailing placeholder): a document ENDING IN A LIST
// attaches live (this is the exact shape @milkdown/plugin-trailing appends
// its empty paragraph after — pre-fix, the map rejected the whole doc and
// kernel mode silently degraded to legacy). Typing into the trailing
// paragraph commits at the raw document end WITH the blank-line separator,
// so the source gains a new paragraph — never a lazy continuation line of
// the last item. Raw '- 甲\n' length 4; trailing p@7, content start 8.
{
  const h = makeHarness('- 甲\n', doc(bl(li(null, p(text('甲')))), p()))
  assert.equal(h.controller.attachAfterCreate(), true,
    'a list-ending doc (with its trailing placeholder) must attach live, not degrade')
  assert.equal(h.controller.isDegraded(), false)
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(8), { raw: 4, prefix: '\n' })

  const oldState = h.view.state
  const tr = oldState.tr.insertText('X', 8)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing in the trailing paragraph is allowed')
  assert.equal(h.controller.kernel.doc.text, '- 甲\n\nX',
    'the insert carries the blank-line separator: a new paragraph, NOT "- 甲\\nX" (lazy continuation)')
  assert.deepEqual(h.changes.at(-1), ['- 甲\n\nX', false])
  assert.ok(h.view.state.doc.eq(doc(bl(li(null, p(text('甲')))), p(text('X')))))
  assert.ok(h.controller.kernel.map, 'map realigns once the paragraph is real')
}

// Case 13 (Task 11.5, splitTextBlock degenerate split): Enter at the END of
// a paragraph writes '\n\n' whose reparse shows no new block (CommonMark
// collapses blank-line runs). The controller must materialize an editable
// placeholder paragraph, park the caret in it, and route the NEXT keystroke
// to the blank-line raw offset — this is the exact caret-misplacement bug
// that made continuation text land in the wrong block (Task 11 Bug 3).
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 3))) // end of 甲乙
  const handled = h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view)
  assert.equal(handled, true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n', 'split bytes written at the block end')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p())),
    'the view shows the new empty paragraph even though the reparse collapses it')
  assert.equal(h.view.state.selection.head, 5, 'caret parked inside the placeholder')
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(5), { raw: 4, prefix: '' })

  // The continuation keystroke lands at the blank-line offset — the bytes
  // the pure-kernel oracle derives for "Enter then type".
  const tr = h.view.state.tr.insertText('丙', 5)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n丙\n',
    'typed text becomes the new paragraph — never merged into a neighboring block')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p(text('丙')))))
  assert.equal(h.controller.kernel.map.pmPosToRaw(6), 5, 'map realigned to the now-real paragraph')

  // Undo granularity: the typed char and the split are separate groups.
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')))),
    'undo of the fill removes the paragraph from the view (the bytes cannot represent it)')
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'undo of the split restores the original bytes')
}

// Case 14 (Task 11.5): typing ELSEWHERE while a split placeholder is
// pending ends the placeholder session — the orphaned empty paragraph (the
// parse never contains it) is removed by the verify repair and the map
// recovers, instead of staying null.
{
  globalThis.__hmKernelDiagnostics = []
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 3)))
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true)
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p())), 'placeholder present')

  const tr = h.view.state.tr.insertText('X', 1) // start of 甲乙 — NOT the placeholder
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, 'X甲乙\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('X甲乙')))),
    'the orphaned placeholder was reconciled away')
  assert.ok(h.controller.kernel.map, 'map recovered after the orphan cleanup')
  assert.equal(h.controller.kernel.map.pmPosToRaw(1), 0)
}

// Case 15 (Task 11.5): @milkdown/plugin-trailing's own append transaction —
// an empty paragraph inserted at the very end of a list-ending doc — is
// passed through (never vetoed) with no kernel byte change, and the map is
// rebound so the new node pairs as the trailing placeholder.
{
  const h = makeHarness('- [x] 乙\n', doc(bl(li(true, p(text('乙'))))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const oldState = h.view.state
  const end = oldState.doc.content.size
  const tr = oldState.tr.insert(end, schema.nodes.paragraph.createAndFill())
  const verdict = dispatchThrough(h, tr)
  assert.equal(verdict, undefined, 'the trailing append must not be vetoed')
  assert.equal(h.controller.kernel.doc.text, '- [x] 乙\n', 'no kernel bytes for a view-only node')
  assert.equal(h.changes.length, 0, 'nothing published for the trailing append')
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(end + 1), { raw: 8, prefix: '\n' })
}

// Case 16 (Task 11.5 review fix, prefix latching end-to-end): ONE
// transaction carrying TWO insert steps into the trailing paragraph must
// commit as ONE new source paragraph ('- 甲\n\nab') with the cheap-path
// verify passing — no projection-mismatch, no repair reconcile
// restructuring the user's typing (the unlatched bug produced
// '- 甲\n\na\nb': two source paragraphs for PM's one).
{
  globalThis.__hmKernelDiagnostics = []
  const h = makeHarness('- 甲\n', doc(bl(li(null, p(text('甲')))), p()))
  assert.equal(h.controller.attachAfterCreate(), true)
  const oldState = h.view.state
  const tr = oldState.tr.insertText('a', 8).insertText('b', 9)
  assert.equal(tr.steps.length, 2)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '- 甲\n\nab',
    'two-step batch commits one paragraph, prefix latched to the first step')
  assert.ok(h.view.state.doc.eq(doc(bl(li(null, p(text('甲')))), p(text('ab')))),
    'the view keeps the user typing as ONE paragraph — no repair restructuring')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'projection-mismatch').length,
    0,
    'cheap-path verify passes: no repair churn'
  )
}

// Case 17 (Task 2, plan 3: 块尾连续 Enter): repeated Enter INSIDE the
// split-placeholder chain must extend it — a SECOND (and THIRD) Enter at the
// placeholder's own raw anchor used to be refused (`resolveBlock` finds no
// block on a blank-line-run offset). Byte states below are the pure-kernel
// oracle's own output (routeStructuralKey chained three times from '甲乙\n'
// at raw offset 2, the block end — see the task's derivation transcript):
// '甲乙\n\n\n' -> '甲乙\n\n\n\n' -> '甲乙\n\n\n\n\n', then typing '丙' into the
// LAST placeholder yields '甲乙\n\n\n\n丙\n' (4 separator newlines: the K
// Enters pressed = the separator's `K+1` newline-byte count once real
// content replaces the last placeholder — same K=1 shape Case 13 already
// locks with its own '甲乙\n\n丙\n' single-Enter continuation).
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 3))) // end of 甲乙

  // Enter #1: unchanged existing degenerate-split behavior (same as Case 13).
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p())))
  assert.equal(h.view.state.selection.head, 5)
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(5), { raw: 4, prefix: '' })

  // Enter #2: NEW — extends the chain instead of being refused. A second
  // empty placeholder appears, the kernel byte gains exactly one more
  // `ending`, and the caret follows into the new (now last) placeholder.
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n\n', 'one more ending extends the run')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p(), p())),
    'a SECOND empty placeholder is materialized, the first one is NOT discarded')
  assert.equal(h.view.state.selection.head, 7, 'caret follows into the new (last) placeholder')
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(7), { raw: 5, prefix: '' })
  // The FIRST placeholder is still vouched too — the whole chain, not just
  // the newest link.
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(5), { raw: 4, prefix: '' })

  // Enter #3: the chain keeps extending — proves this isn't a one-shot
  // special case hardcoded for exactly two placeholders.
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p(), p(), p())))
  assert.equal(h.view.state.selection.head, 9)
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(9), { raw: 6, prefix: '' })

  // Typing into the LAST placeholder collapses the WHOLE chain into one real
  // paragraph — every placeholder before it was purely a PM-view convenience
  // (mdast can never distinguish "3 blank lines" from "5 blank lines", only
  // the raw bytes carry that), so the reconcile correctly discards them all
  // once real content exists.
  const tr = h.view.state.tr.insertText('丙', 9)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n\n丙\n',
    'typed text becomes a new paragraph, all three Enters preserved as separator bytes')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p(text('丙')))),
    'every placeholder in the chain collapses once real content lands')
  assert.equal(h.controller.kernel.map.pmPosToRaw(5), 6, 'map realigned to the now-real paragraph (before 丙)')
  assert.equal(h.controller.kernel.map.pmPosToRaw(6), 7, 'map realigned to the now-real paragraph (after 丙)')

  // Undo granularity: each Enter (create + 2 extends) and the typed char are
  // FOUR separate undo groups, unwound one at a time.
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n\n\n')
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n\n')
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n')
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'four undos fully unwind back to the original bytes')
}

// Case 18 (review fix): extendTrailingPlaceholder's atomic rollback. Forces
// bindMap's buildProjectionMap call to fail AFTER kernel.doc has already
// advanced and the new placeholder node has already been inserted into the
// view, and proves BOTH sides roll back together — never just one.
//
// The failure is forced the same way Case 9 forces a history desync: by
// directly corrupting `kernel.doc` on the live controller (an accepted
// technique in this file for exercising a defensive path with no other
// entry point). After the first Enter (`kernel.doc.text === '甲乙\n\n\n'`,
// view `doc(p(甲乙), p())`), `kernel.doc` is replaced with a text whose real
// block is a HEADING ('# 丁\n\n\n') while the VIEW keeps showing a
// PARAGRAPH. This is invisible to the pure-kernel Enter derivation
// (routeStructuralKey only cares about the trailing-gap OFFSET, which is
// structurally identical either way) and invisible to the CONTROLLER's own
// map (unchanged, still built against the real '甲乙'), so the second Enter
// is accepted and proceeds exactly like Case 17's — right up until the
// extended chain's bindMap call, which DOES notice: `PM_TO_MD.paragraph` has
// no 'heading' entry, so buildProjectionMap rejects the WHOLE map.
//
// P5-2.5 changed the FORCING MECHANISM (not this case's subject, which is
// extendTrailingPlaceholder's atomic rollback). It used to corrupt with a
// same-shape paragraph of a different WIDTH ('丁\n\n\n' — 1 char where the
// view shows 2), relying on `content.size !== visibleLength` to null the
// whole map. That condition is now a per-BLOCK degradation (the offending
// pair simply becomes non-editable and the map still builds), so it can no
// longer force a map failure. A type-pair mismatch is the nearest remaining
// STRUCTURAL failure and expresses the same "the two trees disagree about
// the document" premise — see the P5-2.5 section of
// scripts/test-kernel-projection-map.mjs for the full boundary.
{
  globalThis.__hmKernelDiagnostics = []
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 3))) // end of 甲乙

  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p())))
  assert.equal(h.view.state.selection.head, 5)

  // Corrupt: same trailing-blank structure (so the pure Enter derivation and
  // the EXISTING map's pmPosToRaw both still resolve identically), but the
  // real block is now a HEADING where the view shows a PARAGRAPH — a
  // structural (type-pair) disagreement, the class that still rejects the
  // whole map after P5-2.5.
  const beforeCorruption = h.controller.kernel.doc
  h.controller.kernel.doc = { text: '# 丁\n\n\n', revision: beforeCorruption.revision }
  const notifBefore = h.notifications.length

  const handled = h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view)
  assert.equal(handled, true, 'the key is swallowed either way, success or refusal')

  // kernel.doc must be back to EXACTLY the corrupted pre-attempt value —
  // never the extended '# 丁\n\n\n\n' the failed attempt computed internally.
  assert.equal(h.controller.kernel.doc.text, '# 丁\n\n\n',
    'kernel.doc must roll back to its pre-extend value on a failed chain extension')
  // The view must be back to exactly ONE placeholder — the second (failed)
  // insert removed, not left orphaned.
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p())),
    'the view must roll back to the pre-extend shape (one placeholder), not two')

  assert.ok(
    globalThis.__hmKernelDiagnostics.some((entry) => entry.type === 'split-placeholder-unprovable'),
    'the failed extension must be diagnosed'
  )
  assert.ok(h.notifications.length > notifBefore, 'the failed extension must notify the user')
  assert.ok(
    h.notifications.at(-1).includes('projection-mismatch'),
    `notification must carry the actual KERNEL_CODES.PROJECTION code, got: ${h.notifications.at(-1)}`
  )
}

// Case 12 (Plan 3 Task 4): code-block end-to-end — a CM-style multi-line
// text commit, then a language switch, both landing in `handleTransactions`
// as pass-through (undefined), never a veto, kernel bytes advancing exactly
// like a real CodeMirror forwardUpdate + language-picker session would drive
// them.
// The live view doc carries an explicit trailing EMPTY paragraph after the
// code_block — mirroring what `@milkdown/plugin-trailing` really appends
// after any non-paragraph/heading final block in the live editor (this
// stub harness has no such plugin, so the test builds it by hand, same
// convention every other bullet_list/code_block-ending fixture in this file
// uses). Without it, `safeParse`'s `withTrailingParagraph` (which the
// verify-diff path always runs) would synthesize one on the PARSED side
// only, a onesided mismatch that has nothing to do with this task's own
// logic.
{
  globalThis.__hmKernelDiagnostics = []
  const h = makeHarness('```js\nab\n```\n', doc(cb('js', 'ab'), p()))
  assert.equal(h.controller.attachAfterCreate(), true, 'code_block-only doc must map')

  // (a) multi-line insert 'X\nY' between 'a' and 'b' (content offset 1 ->
  // PM pos 2, code_block is the doc's sole child: open@0, content start@1).
  const tr1 = h.view.state.tr.insertText('X\nY', 2)
  const verdict1 = dispatchThrough(h, tr1)
  await flushMicrotasks()
  assert.equal(verdict1, undefined, 'code_block newline-bearing insert is allowed (no veto)')
  assert.equal(h.controller.kernel.doc.text, '```js\naX\nYb\n```\n')
  assert.equal(h.controller.kernel.doc.revision, 1)
  assert.deepEqual(h.changes.at(-1), ['```js\naX\nYb\n```\n', false])
  assert.equal(h.view.state.doc.textContent, 'aX\nYb', 'view content unchanged by the pass-through')

  // (b) language switch 'js' -> 'python' on the same (still sole-child, pos
  // 0) code_block.
  const tr2 = h.view.state.tr.setNodeAttribute(0, 'language', 'python')
  const verdict2 = dispatchThrough(h, tr2)
  await flushMicrotasks()
  assert.equal(verdict2, undefined, 'code-language commit is allowed (no veto)')
  assert.equal(h.controller.kernel.doc.text, '```python\naX\nYb\n```\n')
  assert.equal(h.controller.kernel.doc.revision, 2)
  assert.deepEqual(h.changes.at(-1), ['```python\naX\nYb\n```\n', false])
  assert.equal(h.view.state.doc.firstChild.attrs.language, 'python')

  // No diagnostics from either commit (the verify-diff cheap path found no
  // mismatch against either fixture, and the map rebound cleanly both times).
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) =>
      entry.type === 'projection-mismatch' || entry.type === 'map-refresh-failed').length,
    0,
    'neither commit should have needed a projection repair'
  )
}

// Case 13 (CRLF un-narrowing, 2026-08-17): a CRLF-lineEnding code block is
// EDITABLE end to end. Supersedes the 2026-08-16 fix-review ADR, which
// vetoed every such edit because the vendored CodeMirrorBlock bridge dropped
// '\r' from its own position model; `editor-codeblock-crlf.js` fixes that
// bridge at the source, so the slice arriving here already spells its break
// '\r\n' (the block's dominant ending) and the gateway commits it verbatim.
// This case proves (i) the commit is byte-exact CRLF-preserving, (ii) ZERO
// projection-mismatch diagnostics — no repair churn, which was THE P3-4
// symptom, (iii) the residual bare-'\n' shape still fails closed, and (iv)
// neither outcome locks the rest of the document out.
{
  globalThis.__hmKernelDiagnostics = []
  const initialMd = '```js\r\nab\r\ncd\r\n```\r\n甲乙\r\n'
  const h = makeHarness(initialMd, doc(cb('js', 'ab\r\ncd'), p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true, 'CRLF-code + paragraph doc must map')

  // (i) code_block open@0, content 'ab\r\ncd' [1,7) (a@1 b@2 \r@3 \n@4 c@5
  // d@6). PM 3 (after 'b', before the break) -> raw 9. The patched bridge
  // hands the break already spelled '\r\n'.
  const tr1 = h.view.state.tr.insertText('X\r\nY', 3)
  const verdict1 = dispatchThrough(h, tr1)
  await flushMicrotasks()
  assert.equal(verdict1, undefined, 'a CRLF code_block edit must commit, not veto')
  assert.equal(
    h.controller.kernel.doc.text,
    '```js\r\nabX\r\nY\r\ncd\r\n```\r\n甲乙\r\n',
    'kernel bytes must be byte-exact CRLF-preserving'
  )
  assert.equal(/\r(?!\n)/.test(h.controller.kernel.doc.text), false, 'no lone \\r may be injected')
  assert.equal(h.view.state.doc.textContent, 'abX\r\nY\r\ncd甲乙', 'the view carries the same bytes')
  // (ii) THE regression this un-narrowing had to earn: the cheap-path
  // verify must pass, so no repair reconcile is ever scheduled.
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'projection-mismatch').length,
    0,
    'a CRLF code commit must pass cheap-path verify — zero repair churn'
  )

  // (iii) fail-closed residual: a bare '\n' break in a CRLF block (what the
  // bridge emits only when the block's own text holds no '\r' — see
  // commitPlainText's ADR) is refused, kernel bytes untouched, and the
  // defensive veto-after-CM-applied resync still runs for a code_block
  // target (pushing its own diagnostic even when the reconcile is a no-op).
  const tr2 = h.view.state.tr.insertText('Z\nW', 3)
  const verdict2 = dispatchThrough(h, tr2)
  await flushMicrotasks()
  assert.deepEqual(verdict2, { veto: true }, 'a bare-\\n break in a CRLF block must be vetoed')
  assert.equal(h.controller.kernel.doc.text, '```js\r\nabX\r\nY\r\ncd\r\n```\r\n甲乙\r\n',
    'kernel bytes untouched by the refused edit')
  assert.equal(h.view.state.doc.textContent, 'abX\r\nY\r\ncd甲乙',
    'view untouched after veto (dispatch protocol skips updateState)')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'cm-veto-resync').length,
    1,
    'a code_block-targeting veto must schedule the defensive nodeview resync'
  )
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) =>
      entry.type === 'cm-veto-resync-failed' || entry.type === 'cm-veto-resync-parse-failure').length,
    0,
    'the resync reconcile must be a clean no-op when the view already agrees with the kernel'
  )

  // (iv) no lockout: an ordinary edit into the paragraph ('甲乙') still
  // commits normally. The code_block's content is now 10 chars
  // ('abX\r\nY\r\ncd'), nodeSize 12, so the paragraph opens at 12 and its
  // content start is 13: 甲@13, 乙@14.
  const tr3 = h.view.state.tr.insertText('丙', 14)
  const verdict3 = dispatchThrough(h, tr3)
  await flushMicrotasks()
  assert.equal(verdict3, undefined, 'an unrelated edit after a refused code-block edit must not be vetoed')
  assert.equal(h.controller.kernel.doc.text, '```js\r\nabX\r\nY\r\ncd\r\n```\r\n甲丙乙\r\n')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'projection-mismatch').length,
    0,
    'the follow-up commit must also pass cheap-path verify cleanly'
  )
}

// ---- Plan 3 Task 5: per-block CM editability gate + Mod-Enter exit ----
import { classifyBlockedCmKeydown } from '../src/renderer/src/components/editor-kernel-cm-bridge.js'

// Case T5a: the pure keydown allowlist for a BLOCKED code block. Mutating
// keys (printables, Enter/Backspace/Delete/Tab, paste/cut combos, the
// defaultKeymap's editing chords) block; navigation/selection/copy/IME/the
// kernel-owned combos pass.
{
  const block = (event) => assert.equal(classifyBlockedCmKeydown(event), 'block', JSON.stringify(event))
  const pass = (event) => assert.equal(classifyBlockedCmKeydown(event), 'pass', JSON.stringify(event))
  block({ key: 'a' })
  block({ key: 'A', shiftKey: true })
  block({ key: 'Enter' })
  block({ key: 'Backspace' })
  block({ key: 'Delete' })
  block({ key: 'Tab' })
  block({ key: 'v', metaKey: true }) // paste
  block({ key: 'x', ctrlKey: true }) // cut
  block({ key: '/', ctrlKey: true }) // toggleComment
  block({ key: '[', metaKey: true }) // indentLess
  block({ key: 'k', metaKey: true, shiftKey: true }) // deleteLine
  // Alt-Arrow vertical chords are doc-mutating in the defaultKeymap
  // (moveLineUp/Down; +Shift copyLineUp/Down) — reviewer-proved leak: left
  // passing they reorder/duplicate a blocked block's CM lines while the
  // kernel vetoes the bytes.
  block({ key: 'ArrowUp', altKey: true }) // moveLineUp
  block({ key: 'ArrowDown', altKey: true }) // moveLineDown
  block({ key: 'ArrowUp', altKey: true, shiftKey: true }) // copyLineUp
  block({ key: 'ArrowDown', altKey: true, shiftKey: true }) // copyLineDown
  pass({ key: 'ArrowUp', altKey: true, metaKey: true }) // addCursor — selection-only
  pass({ key: 'ArrowLeft', altKey: true }) // cursorSyntaxLeft — pure navigation
  pass({ key: 'ArrowLeft' })
  pass({ key: 'ArrowDown', shiftKey: true }) // selection extension
  pass({ key: 'Home' })
  pass({ key: 'End' })
  pass({ key: 'PageDown' })
  pass({ key: 'Escape' })
  pass({ key: 'Shift' }) // bare modifier — must never be eaten
  pass({ key: 'Meta' })
  pass({ key: 'F5' })
  pass({ key: 'c', metaKey: true }) // copy
  pass({ key: 'a', ctrlKey: true }) // select-all
  pass({ key: 'z', metaKey: true }) // kernel undo (bridge keymap owns it)
  pass({ key: 'z', metaKey: true, shiftKey: true }) // kernel redo
  pass({ key: 'y', ctrlKey: true }) // kernel redo (win)
  pass({ key: 'Enter', metaKey: true }) // kernel exit-code (bridge keymap owns it)
  pass({ key: 'Process', keyCode: 229 }) // IME — inputHandler backstops
  pass({ key: 'a', isComposing: true })
  block(null) // no event info -> fail closed
}

// Case T5b: isCmBlockEditable — the per-instance identity is the CM
// editor's DOM resolved through view.posAtDOM into the CURRENT map's
// blockPairs. An LF js block (charMap proven) reports editable, a CRLF block
// now reports editable too (un-narrowing, 2026-08-17), and a failed DOM
// resolution reports non-editable (fail-closed). Since 2026-08-18 a
// `mermaid` block reports EDITABLE too — the preview is a sibling of the
// always-mounted CodeMirror, not a substitute for it (see the ADR that
// replaced `READONLY_CODE_LANGUAGES`). The remaining always-blocked code
// shape is a `$$` math block, whose mdast type is `math`, not `code`.
{
  const h = makeHarness('```js\nab\n```\n甲\n', doc(cb('js', 'ab'), p(text('甲'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const cmDom = {}
  h.view.posAtDOM = (dom) => {
    assert.equal(dom, cmDom, 'identity resolution must use the CM instance dom')
    return 1 // interior of the code_block node [0,4)
  }
  assert.equal(h.controller.isCmBlockEditable({ dom: cmDom }), true, 'LF js block must be editable')
  // A position outside every code_block pair (the paragraph) fails closed.
  h.view.posAtDOM = () => 6
  assert.equal(h.controller.isCmBlockEditable({ dom: cmDom }), false)
  // posAtDOM throwing (detached DOM) fails closed.
  h.view.posAtDOM = () => { throw new Error('not inside the editor') }
  assert.equal(h.controller.isCmBlockEditable({ dom: cmDom }), false)

  const crlf = makeHarness('```js\r\nab\r\ncd\r\n```\r\n甲乙\r\n', doc(cb('js', 'ab\r\ncd'), p(text('甲乙'))))
  assert.equal(crlf.controller.attachAfterCreate(), true)
  crlf.view.posAtDOM = () => 1
  assert.equal(crlf.controller.isCmBlockEditable({ dom: {} }), true, 'CRLF block must now be editable')

  // A preview-rendered language is now an ordinary fence to the map: its CM
  // instance is ungated exactly like a ```js block's.
  const mermaid = makeHarness('```mermaid\ngraph TD\n```\n', doc(cb('mermaid', 'graph TD')))
  assert.equal(mermaid.controller.attachAfterCreate(), true)
  mermaid.view.posAtDOM = () => 1
  assert.equal(mermaid.controller.isCmBlockEditable({ dom: {} }), true, 'mermaid block must now be editable')

  // Block math (`$$..$$`, mdast `math`) is editable too since 2026-08-18 —
  // same always-mounted CodeMirror, and buildCodeMap proves its bytes. Typed
  // here end to end so this is a byte assertion, not just a gate flag: the
  // insert must land INSIDE the delimiters.
  const mathBlock = makeHarness('$$\nE=mc^2\n$$\n', doc(cb('LaTeX', 'E=mc^2')))
  assert.equal(mathBlock.controller.attachAfterCreate(), true)
  mathBlock.view.posAtDOM = () => 1
  assert.equal(mathBlock.controller.isCmBlockEditable({ dom: {} }), true, '$$ math must now be editable')
  assert.equal(dispatchThrough(mathBlock, mathBlock.view.state.tr.insertText('X', 1)), undefined)
  await flushMicrotasks()
  assert.equal(mathBlock.controller.kernel.doc.text, '$$\nXE=mc^2\n$$\n',
    'the insert must land inside the $$ delimiters, never on one')

  // …and the still-blocked code shape is the one buildCodeMap cannot prove:
  // a quoted math block whose blank content line is a bare '>' rather than
  // '> ', so its per-line prefix contract fails. Fail-closed per block.
  const raggedMath = makeHarness('> $$\n> a\n>\n> b\n> $$\n', doc(
    schema.node('blockquote', null, [cb('LaTeX', 'a\n\nb')])
  ))
  assert.equal(raggedMath.controller.attachAfterCreate(), true)
  raggedMath.view.posAtDOM = () => 2
  assert.equal(raggedMath.controller.isCmBlockEditable({ dom: {} }), false,
    'an unprovable math block stays non-editable')
}

// Case T5c: runExitCode at document end — exit bytes are written
// source-first, the view gains the trailing paragraph, and the caret lands
// in it via the trailing-virtual pair (no voucher needed).
{
  const h = makeHarness('```js\nab\n```\n', doc(cb('js', 'ab')))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.posAtDOM = () => 1
  const handled = h.controller.runExitCode({ dom: {} })
  assert.equal(handled, true)
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(cb('js', 'ab'), p())), 'view gains the trailing empty paragraph')
  assert.equal(h.view.state.selection.head, 5, 'caret parked inside the new trailing paragraph')
  assert.deepEqual(h.changes.at(-1), ['```js\nab\n```\n\n\n', false])
  // The next keystroke lands in the paragraph, not the code block: typing
  // at the caret commits with the trailing-virtual separator semantics.
  const tr = h.view.state.tr.insertText('X', 5)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n\n\nX')
}

// Case T5d: runExitCode mid-document — the caret anchor sits on a blank
// line the reparse cannot show, so the controller materializes a vouched
// placeholder right after the code block; the first typed character fills
// it and becomes its own paragraph between the code block and the
// following content.
{
  const h = makeHarness('```js\nab\n```\n甲\n', doc(cb('js', 'ab'), p(text('甲'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.posAtDOM = () => 1
  const handled = h.controller.runExitCode({ dom: {} })
  assert.equal(handled, true)
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n\n\n甲\n')
  assert.ok(
    h.view.state.doc.eq(doc(cb('js', 'ab'), p(), p(text('甲')))),
    'placeholder paragraph materialized between the code block and the following paragraph'
  )
  assert.equal(h.view.state.selection.head, 5, 'caret parked inside the placeholder')
  // Typing into the placeholder commits at the vouched raw anchor and the
  // typed text parses as its OWN paragraph (blank line before `甲` kept).
  const tr = h.view.state.tr.insertText('X', 5)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\nX\n\n甲\n')
  assert.ok(h.view.state.doc.eq(doc(cb('js', 'ab'), p(text('X')), p(text('甲')))))
  // Undo grouping (reviewer ride-along): the exit is ONE kernel history
  // group and the placeholder tr rode addToHistory:false — so undo #1 pops
  // only the typed char (back to the post-exit bytes) and undo #2 pops the
  // WHOLE exit in one step (back to the exact pre-exit bytes), never
  // replaying the placeholder as its own undo unit.
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n\n\n甲\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n甲\n')
  assert.ok(
    h.view.state.doc.eq(doc(cb('js', 'ab'), p(text('甲')))),
    'undoing the exit reconciles the placeholder away (parse never contains it)'
  )
}

// Case T5e: runExitCode refusals — an unmapped CM instance notifies and
// swallows; kernel state never moves.
{
  const h = makeHarness('```js\nab\n```\n', doc(cb('js', 'ab')))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.posAtDOM = () => { throw new Error('detached') }
  const before = h.notifications.length
  assert.equal(h.controller.runExitCode({ dom: {} }), true, 'refusal still swallows the key')
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n')
  assert.ok(h.notifications.length > before, 'refusal notifies')
}

// Case T5f (final-review finding, 2026-08-16; extended 2026-08-18): a
// language switch OUT of a preview-rendered language must commit (not veto),
// and the map's UNCONDITIONAL rebind after a code-language commit (see the
// `code-language` case's own comment) must leave the block genuinely
// editable on the very next transaction: switch then type, end to end.
//
// Since 2026-08-18 the mermaid block is editable BEFORE the switch too, so
// step (a0) below pins that directly — the bytes land inside the fence body,
// never on a ``` delimiter.
{
  globalThis.__hmKernelDiagnostics = []
  const h = makeHarness('```mermaid\ngraph TD\n```\n', doc(cb('mermaid', 'graph TD'), p()))
  assert.equal(h.controller.attachAfterCreate(), true, 'mermaid-only doc must map')
  assert.ok(h.controller.kernel.map.blockPairs[0].charMap, 'sanity: mermaid pair is editable')

  // (a0) typing into the mermaid fence itself, before any language switch.
  const tr0 = h.view.state.tr.insertText('Z', 1)
  assert.equal(dispatchThrough(h, tr0), undefined, 'typing into a mermaid fence must commit')
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '```mermaid\nZgraph TD\n```\n')
  // Undo it so the rest of the case runs on the original bytes.
  h.controller.runHistory('undo')
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '```mermaid\ngraph TD\n```\n')

  // (a) mermaid -> js language switch.
  const tr1 = h.view.state.tr.setNodeAttribute(0, 'language', 'js')
  const verdict1 = dispatchThrough(h, tr1)
  await flushMicrotasks()
  assert.equal(verdict1, undefined, 'mermaid -> js switch is allowed through (no veto)')
  assert.equal(h.controller.kernel.doc.text, '```js\ngraph TD\n```\n')
  assert.equal(h.view.state.doc.firstChild.attrs.language, 'js')
  assert.ok(h.controller.kernel.map.blockPairs[0].charMap,
    'the rebound map must carry a real charMap for the block immediately after the switch')

  // (b) typing right after the switch: a plain-text insert at the block's
  // content start (PM pos 1, doc's sole non-placeholder child) must commit,
  // proving the block is genuinely editable now, not just reclassified.
  const tr2 = h.view.state.tr.insertText('X', 1)
  const verdict2 = dispatchThrough(h, tr2)
  await flushMicrotasks()
  assert.equal(verdict2, undefined, 'typing into the newly-js block must commit, not veto')
  assert.equal(h.controller.kernel.doc.text, '```js\nXgraph TD\n```\n')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'projection-mismatch').length,
    0,
    'both the switch and the follow-up type must pass cheap-path verify cleanly'
  )
}

// ---- Plan 4 Task 3: inline mark toggles, end-to-end through the dispatch
// protocol. Every toggle transaction is built by the REAL prosemirror
// `toggleMark` (the function Crepe's toolbar commands / applyTextFormat /
// the preset keymaps bottom out in) against the live view state — the exact
// toolbar-shaped dispatch the gateway classifies.
const toggleVia = (h, markType, from, to) => {
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, from, to)))
  let captured = null
  toggleMark(markType)(h.view.state, (tr) => { captured = tr })
  return captured
}

// Case M1: strong wrap → source gains '**', the veto'd PM transaction is
// replaced by the kernel's own reconcile whose doc carries a REAL strong
// mark, and the content stays SELECTED (range restore — the toolbar must
// stay up for an immediate second toggle).
{
  const h = makeHarness('甲乙丙\n', doc(p(text('甲乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const before = h.notifications.length
  const tr = toggleVia(h, schema.marks.strong, 2, 3) // select 乙
  assert.ok(tr, 'toggleMark must dispatch')
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.deepEqual(verdict, { veto: true }, 'the original PM mark transaction is always vetoed')
  assert.equal(h.controller.kernel.doc.text, '甲**乙**丙\n', 'source gains the ** markers, byte-exact')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲'), schema.text('乙', [schema.mark('strong')]), text('丙')))),
    'the reconciled PM doc carries a real strong mark (reparse authority)')
  assert.equal(h.view.state.selection.from, 2, 'content stays selected: from')
  assert.equal(h.view.state.selection.to, 3, 'content stays selected: to')
  assert.equal(h.view.state.selection.empty, false)
  assert.deepEqual(h.changes.at(-1), ['甲**乙**丙\n', false], 'onChange publishes the kernel text')
  assert.equal(h.notifications.length, before, 'a successful toggle never toasts')

  // Case M2 (same session): toggling the SAME range again unwraps — the
  // toolbar-shaped RemoveMarkStep routes to the kernel's exact-cover unwrap.
  const tr2 = toggleVia(h, schema.marks.strong, 2, 3)
  assert.equal(tr2.steps[0].constructor.name, 'RemoveMarkStep')
  const verdict2 = dispatchThrough(h, tr2)
  await flushMicrotasks()
  assert.deepEqual(verdict2, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', 'unwrap removes both marker runs, byte-exact')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))))
  assert.equal(h.view.state.selection.from, 2)
  assert.equal(h.view.state.selection.to, 3)

  // Case M3 (same session): kernel history owns the toggles — each is its
  // own undo group. Undo #1 restores the wrapped bytes; undo #2 the plain
  // original; redo re-wraps.
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲**乙**丙\n', 'undo #1 restores the wrap')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲'), schema.text('乙', [schema.mark('strong')]), text('丙')))))
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', 'undo #2 restores the original')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))))
  assert.equal(h.controller.historyHandlers.redo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲**乙**丙\n', 'redo re-wraps')
}

// Case M4 (FLIPPED by P5-3 — the highlight toggle works): this used to be
// the ADR pin for the pre-commit map guard (`requireMap`), because the
// committed `==` bytes were literal text to the kernel chain and invisible to
// the Crepe parse, so the toggled paragraph came back unmappable and the
// guard refused the whole transaction. The kernel now injects real positioned
// `highlight` nodes (highlight-syntax.js), the toggled block pairs, the
// transaction's anchor resolves, and the toggle COMMITS byte-exactly.
//
// `requireMap` itself is unchanged and still guards this route; it simply has
// no reachable mark shape left that trips it (the remaining live pin for the
// guard is the `/quote` empty-blockquote refusal in
// scripts/test-kernel-marks-ui.mjs). The two refusals below are the new
// fail-closed edges, and they refuse EARLIER, in the toggle command itself.
{
  const h = makeHarness('甲乙丙\n', doc(p(text('甲乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const before = h.notifications.length

  // Wrap: select 乙, hit highlight -> `甲==乙==丙`, reconciled to a real
  // highlight MARK, selection kept on the content (2..3 shifted by the two
  // inserted marker bytes -> 2..3 again in PM coordinates, since the markers
  // are gaps).
  const tr = toggleVia(h, schema.marks.highlight, 2, 3)
  assert.equal(tr.steps[0].constructor.name, 'AddMarkStep')
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.deepEqual(verdict, { veto: true }, 'the PM mark transaction is always vetoed; the kernel reconciles')
  assert.equal(h.controller.kernel.doc.text, '甲==乙==丙\n', 'highlight wrap commits byte-exactly')
  assert.ok(
    h.view.state.doc.eq(doc(p(text('甲'), schema.text('乙', [schema.mark('highlight')]), text('丙')))),
    'the reconciled doc carries a real highlight mark'
  )
  assert.ok(h.controller.kernel.map, 'the map rebinds — no post-toggle lock-up (the old M4 failure mode)')
  assert.ok(h.controller.kernel.map.blockPairs[0].charMap,
    'and the toggled paragraph is still EDITABLE, which is what used to be impossible')
  assert.equal(h.notifications.length, before, 'a successful toggle notifies nothing')
  assert.equal(h.view.state.selection.from, 2)
  assert.equal(h.view.state.selection.to, 3)

  // Unwrap: the same range resolves to the highlight node's exact content
  // range (mark-map.js derives it from the real node now) and both markers go.
  const tr2 = toggleVia(h, schema.marks.highlight, 2, 3)
  assert.equal(tr2.steps[0].constructor.name, 'RemoveMarkStep')
  const verdict2 = dispatchThrough(h, tr2)
  await flushMicrotasks()
  assert.deepEqual(verdict2, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', 'highlight unwrap removes both marker runs')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))))

  // Undo: each toggle is its own kernel history group.
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲==乙==丙\n', 'undo #1 restores the highlight wrap')
  assert.ok(
    h.view.state.doc.eq(doc(p(text('甲'), schema.text('乙', [schema.mark('highlight')]), text('丙'))))
  )
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', 'undo #2 restores the original')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))))
}

// Case M4a (P5-3 fail-closed edge): `==` markers are NOT unconditionally
// effective. Wrapping a selection whose neighbours or content would make the
// shared rule read plain text instead of a highlight refuses in the toggle
// command (`unsupported-structure`), before any byte is written — otherwise
// the user would get four inert `=` characters and no highlight.
//  - '甲=乙丙' selecting 乙 would commit '甲===乙==丙' (a `===` run: no highlight
//    in EITHER chain).
{
  const h = makeHarness('甲=乙丙\n', doc(p(text('甲=乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const before = h.notifications.length
  const verdict = dispatchThrough(h, toggleVia(h, schema.marks.highlight, 3, 4))
  await flushMicrotasks()
  assert.deepEqual(verdict, { veto: true }, 'the inert-marker wrap must veto')
  assert.equal(h.controller.kernel.doc.text, '甲=乙丙\n', 'kernel bytes untouched')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲=乙丙')))), 'view untouched')
  assert.ok(h.notifications.at(-1).includes('unsupported-structure'),
    `the toggle command itself refuses, got: ${h.notifications.at(-1)}`)
}

// Case M4c (P5-3 review follow-up — `requireMap`'s ANCHOR half is REACHABLE
// from the mark route, contrary to what M4's first draft claimed): highlight
// a bare URL. The wrap itself is legal (`toggleInlineMark` returns ok and the
// bytes would be `see ==www.a.com== ok`), but that result cannot be
// character-mapped: remark's gfm autolink-literal falls back to a
// POSITIONLESS `link` node, and — because the fallback rebuilds the whole
// paragraph's phrasing — the surrounding `text` nodes lose their positions
// too, so `buildCharacterMap` fails closed for the entire block. The block
// would therefore come back degraded (permanently read-only for that
// revision), and `rawToPmPos(anchor)` returns null, so the guard refuses
// BEFORE any byte is written.
//
// UX consequence, recorded deliberately: "select a URL, click highlight,
// nothing happens (toast)". That is the fail-closed outcome; the alternative
// — committing bytes into a paragraph the user can no longer type in — is
// strictly worse. Not a highlight defect: the same paragraph is already
// unmappable in the kernel today with or without the markers.
{
  globalThis.__hmKernelDiagnostics = []
  const linkDoc = () => doc(p(
    text('see '),
    schema.text('www.a.com', [schema.mark('link', { href: 'http://www.a.com' })]),
    text(' ok')))
  const h = makeHarness('see www.a.com ok\n', linkDoc())
  assert.equal(h.controller.attachAfterCreate(), true)
  const before = h.notifications.length
  // PM: content starts at 1, 'see ' is 4 chars -> the URL spans 5..14.
  const verdict = dispatchThrough(h, toggleVia(h, schema.marks.highlight, 5, 14))
  await flushMicrotasks()
  assert.deepEqual(verdict, { veto: true }, 'the unmappable-result toggle must veto')
  assert.equal(h.controller.kernel.doc.text, 'see www.a.com ok\n', 'kernel bytes untouched')
  assert.ok(h.view.state.doc.eq(linkDoc()), 'view untouched')
  assert.ok(h.notifications.length > before, 'the refusal is surfaced, never silent')
  assert.ok(
    globalThis.__hmKernelDiagnostics.some((entry) => entry.type === 'projection-unmappable-refused'),
    'the pre-commit map guard is the refusing party (not the toggle command)'
  )
}

// Case M4b: inline-code wrap/unwrap commits end-to-end — single-char AND,
// since P4-3.5's per-char inlineCode units, multi-char too (the old atom
// unit made `requireMap` refuse any N>1 wrap; the flipped pin lives here).
{
  const h = makeHarness('甲乙丙\n', doc(p(text('甲乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const tr = toggleVia(h, schema.marks.inlineCode, 2, 3)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.deepEqual(verdict, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲`乙`丙\n', 'single-char code wrap commits, byte-exact')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲'), schema.text('乙', [schema.mark('inlineCode')]), text('丙')))),
    'the reconciled doc carries a real inlineCode mark')
  assert.ok(h.controller.kernel.map, 'the map rebinds — no post-toggle lock-up')
  // Unwrap it again: the marked run's content range resolves through the
  // normal inlineMarkAt exact-cover path (the atom fallback is gone).
  const tr2 = toggleVia(h, schema.marks.inlineCode, 2, 3)
  const verdict2 = dispatchThrough(h, tr2)
  await flushMicrotasks()
  assert.deepEqual(verdict2, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', 'single-char code unwrap restores the original')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))))

  // Multi-char wrap (P4-3.5 flipped pin): select 乙丙, toggle code →
  // requireMap passes because the reparse now maps (per-char units), the
  // source gains the backticks byte-exactly, selection stays on the content.
  const before = h.notifications.length
  const tr3 = toggleVia(h, schema.marks.inlineCode, 2, 4)
  const verdict3 = dispatchThrough(h, tr3)
  await flushMicrotasks()
  assert.deepEqual(verdict3, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲`乙丙`\n', 'multi-char code wrap commits, byte-exact')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲'), schema.text('乙丙', [schema.mark('inlineCode')])))),
    'the reconciled doc carries a real multi-char inlineCode run')
  assert.ok(h.controller.kernel.map, 'the rebound map is live (no lock-up)')
  assert.equal(h.view.state.selection.from, 2, 'content stays selected: from')
  assert.equal(h.view.state.selection.to, 4, 'content stays selected: to')
  assert.equal(h.notifications.length, before, 'a successful multi-char wrap never toasts')

  // …and unwrap straight back.
  const tr4 = toggleVia(h, schema.marks.inlineCode, 2, 4)
  const verdict4 = dispatchThrough(h, tr4)
  await flushMicrotasks()
  assert.deepEqual(verdict4, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', 'multi-char code unwrap restores the original')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))))
}

// Case M7 (P4-3.5 Fix B — flips the old blanket "any mark in the textblock
// refuses all typing" behavior): after a real strong wrap, PLAIN typing in
// the same paragraph commits through the normal plain-text path; a plain
// char at the run's trailing edge lands OUTSIDE the closing markers
// (rawNeutralInsert); typing with an INHERITED mark stays refused.
{
  const h = makeHarness('甲乙丙\n', doc(p(text('甲乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const tr = toggleVia(h, schema.marks.strong, 2, 3) // bold 乙
  dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '甲**乙**丙\n')

  // (a) plain X at the end of the paragraph (inside the plain 丙 run).
  const before = h.notifications.length
  const trType = h.view.state.tr.replaceWith(4, 4, text('X'))
  const verdict = dispatchThrough(h, trType)
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'plain typing in a marked paragraph must commit (no veto)')
  assert.equal(h.controller.kernel.doc.text, '甲**乙**丙X\n', 'bytes commit at the right raw offset')
  assert.equal(h.notifications.length, before, 'no toast for legitimate typing')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((e) => e.type === 'projection-mismatch').length, 0,
    'cheap-path verify passes — PM view and committed bytes agree'
  )

  // undo the typing, then (b) plain X right AFTER the bold run: the neutral
  // resolver writes it after the closing '**', never inside.
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲**乙**丙\n')
  const trEdge = h.view.state.tr.replaceWith(3, 3, text('X'))
  const verdictEdge = dispatchThrough(h, trEdge)
  await flushMicrotasks()
  assert.equal(verdictEdge, undefined)
  assert.equal(h.controller.kernel.doc.text, '甲**乙**X丙\n',
    'plain char at the run edge lands OUTSIDE the markers')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((e) => e.type === 'projection-mismatch').length, 0,
    'edge insert also verifies cleanly'
  )

  // (c) typing WITH the inherited strong mark (real keystroke inside the
  // run) → marked slice → veto + toast: the inheritance trap stays closed.
  const notifBefore = h.notifications.length
  const trMarked = h.view.state.tr.replaceWith(3, 3, schema.text('Y', [schema.mark('strong')]))
  const verdictMarked = dispatchThrough(h, trMarked)
  assert.deepEqual(verdictMarked, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲**乙**X丙\n', 'kernel bytes untouched')
  assert.ok(h.notifications.length > notifBefore, 'marked-slice refusal notifies')
}

// Case M5 (FLIPPED by P5-6 — the link flow works): this used to pin "link has
// no kernel mark kind, so a link toggle is blocked". It still has no kind
// (`toggleInlineMark` wraps MARKERS, and `[text](url)` has no marker pair),
// but Plan 5 Task 6 gave it its own gateway classification + command. What
// remains pinned here is the ONE link shape the kernel still refuses on
// principle: a GFM autolink literal, whose `link` node has no `[`…`](…)`
// bytes to rewrite. The end-to-end wrap/edit/unwrap flow is Case L1 below.
{
  const md = 'see www.a.com ok\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true)
  const before = h.notifications.length
  // The tooltip's remove shape, targeting the autolink literal's mark run.
  const tr = h.view.state.tr.removeMark(5, 14, schema.marks.link)
  const verdict = dispatchThrough(h, tr)
  assert.deepEqual(verdict, { veto: true })
  assert.equal(h.controller.kernel.doc.text, md, 'an autolink literal is never rewritten')
  assert.ok(h.view.state.doc.eq(stubParse(md)))
  assert.ok(h.notifications.length > before, 'the refusal notifies')
}

// Case L1 (Plan 5 Task 6): the LinkTooltip flow end-to-end through the
// dispatch protocol — wrap, then change the URL, then remove — each step
// byte-exact and each its OWN undo group. Every transaction below is built
// the way @milkdown/components' `#confirmEdit` / `removeLink` build theirs
// (link-tooltip/edit/edit-view.ts:102-129, :188-196).
{
  const h = makeHarness('甲乙丙\n', doc(p(text('甲乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const linked = (href) => doc(p(text('甲'), schema.text('乙', [schema.mark('link', { href })]), text('丙')))

  // (1) WRAP — `addLink(2,3)` then confirm: one AddMarkStep.
  const wrap = h.view.state.tr.addMark(2, 3, schema.mark('link', { href: 'https://x.example' }))
  assert.deepEqual(wrap.steps.map((s) => s.constructor.name), ['AddMarkStep'])
  assert.deepEqual(dispatchThrough(h, wrap), { veto: true },
    'the tooltip transaction is always vetoed; the kernel reconciles from the reparsed bytes')
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '甲[乙](https://x.example)丙\n')
  assert.ok(h.view.state.doc.eq(linked('https://x.example')), 'the view shows the REPARSED link mark')
  assert.equal(h.view.state.selection.from, 2, 'the label stays selected')
  assert.equal(h.view.state.selection.to, 3)

  // (2) EDIT — `editLink(mark,2,3)` then confirm: removeMark + addMark in ONE
  // transaction (the mixed shape `extractMarkToggle` refuses by design).
  const edit = h.view.state.tr
  edit.removeMark(2, 3, schema.mark('link', { href: 'https://x.example' }))
  edit.addMark(2, 3, schema.mark('link', { href: 'https://y.example' }))
  assert.deepEqual(edit.steps.map((s) => s.constructor.name), ['RemoveMarkStep', 'AddMarkStep'])
  assert.deepEqual(dispatchThrough(h, edit), { veto: true })
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '甲[乙](https://y.example)丙\n',
    'only the destination segment moved')
  assert.ok(h.view.state.doc.eq(linked('https://y.example')))

  // (3) UNWRAP — `removeLink(2,3)`: a lone RemoveMarkStep.
  const remove = h.view.state.tr.removeMark(2, 3, schema.marks.link)
  assert.deepEqual(remove.steps.map((s) => s.constructor.name), ['RemoveMarkStep'])
  assert.deepEqual(dispatchThrough(h, remove), { veto: true })
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', 'both syntax runs are deleted, label bytes kept')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))))

  // Three commits -> THREE undo groups, unwound one at a time.
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲[乙](https://y.example)丙\n', 'undo #1 restores the link')
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲[乙](https://x.example)丙\n', 'undo #2 restores the old URL')
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', 'undo #3 restores the plain original')
  assert.equal(h.controller.historyHandlers.redo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲[乙](https://x.example)丙\n', 'redo re-wraps')
}

// Case L2: an EMPTY selection is the tooltip's "type the URL and mark it"
// shape (ReplaceStep + AddMarkStep) — `[url](url)`.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const href = 'https://q.example'
  const tr = h.view.state.tr
  tr.insertText(href, 2)
  tr.addMark(2, 2 + href.length, schema.mark('link', { href }))
  assert.deepEqual(tr.steps.map((s) => s.constructor.name), ['ReplaceStep', 'AddMarkStep'])
  assert.deepEqual(dispatchThrough(h, tr), { veto: true })
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '甲[https://q.example](https://q.example)乙\n')
  assert.ok(h.view.state.doc.eq(
    doc(p(text('甲'), schema.text(href, [schema.mark('link', { href })]), text('乙')))
  ))
}

// Case M6 (stored-marks ADR): the empty-selection mark-shortcut guard.
// Empty selection → swallowed (true) + "select text first" toast, so the
// preset toggleMark never runs and no stored mark ever arms (the typing
// trap: an armed stored mark makes every next keystroke a marked-slice
// veto). Non-empty selection → pass-through (false) to the preset, whose
// transaction the gateway owns (Case M1). Inactive controller → false.
{
  const h = makeHarness('甲乙丙\n', doc(p(text('甲乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2, 2)))
  const before = h.notifications.length
  assert.equal(h.controller.markShortcutGuard(h.view.state), true, 'empty selection: swallowed')
  assert.ok(h.notifications.length > before, 'empty selection: toasts "select text first"')
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2, 3)))
  assert.equal(h.controller.markShortcutGuard(h.view.state), false, 'real selection: falls through to the preset')
  assert.equal(typeof h.controller.marksKeymap, 'function', 'marksKeymap is exposed for registration')
  assert.ok(h.controller.marksKeymap(), 'marksKeymap builds a plugin')
}

// ---- Plan 4 Task 4: quote toggle. `runQuoteToggle` is NOT reached via
// dispatchThrough (no PM `wrapInBlockTypeCommand`/AddMarkStep transaction is
// ever built) — the slash menu's 'quote' item calls straight into
// `controller.runQuoteToggle(view)` (see editor-slash-menu.js's `quoteRun` /
// editor-crepe-setup.js's `quoteToggle` option), so these cases call it
// directly, mirroring runExitCode's own direct-call pattern (Case T5c-T5f)
// rather than toggleVia's PM-dispatch shape (Case M1 and friends).

// Case Q1: wrap a plain paragraph. Caret at PM pos 2 (raw offset 1, between
// 甲 and 乙) in '甲乙\n' — the kernel gains a blockquote wrapping the SAME
// paragraph, the view reconciles to it, and the caret is restored at the
// equivalent raw position (still between 甲 and 乙, shifted by the 2 inserted
// bytes) — same "stay on the same character" contract every other structural
// command here locks (splitTextBlock's own 段首 Enter cases, indentListItem).
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))
  const handled = h.controller.runQuoteToggle(h.view)
  assert.equal(handled, true)
  assert.equal(h.controller.kernel.doc.text, '> 甲乙\n')
  // withTrailingParagraph appends an empty trailing paragraph: the doc's
  // only top-level child is now `blockquote`, not paragraph/heading — same
  // append @milkdown/plugin-trailing performs live (see the mermaid/code
  // fixtures above for the same convention).
  assert.ok(h.view.state.doc.eq(doc(bq(p(text('甲乙'))), p())), 'view reconciled to the quoted paragraph')
  assert.equal(h.view.state.selection.head, 3, 'caret restored between 甲 and 乙, inside the new blockquote')
  assert.deepEqual(h.changes.at(-1), ['> 甲乙\n', false])

  // Case Q2: toggling AGAIN at the same (now-quoted) content unwraps it back
  // to the exact original bytes and PM shape — the round-trip this command's
  // whole ADR rests on (see quote-toggle.js's header comment).
  const handled2 = h.controller.runQuoteToggle(h.view)
  assert.equal(handled2, true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')))), 'view reconciled back to the plain paragraph')
  assert.equal(h.view.state.selection.head, 2, 'caret restored to the original PM position')
  assert.deepEqual(h.changes.at(-1), ['甲乙\n', false])

  // Case Q3: undo grouping — each toggle is its own history group (default
  // `record: true` via applyKernelTransaction), so one undo exactly reverses
  // the unwrap (back to quoted) and a second undo exactly reverses the wrap
  // (back to the original plain paragraph), never merging the two.
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '> 甲乙\n', 'first undo restores the quoted form')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'second undo restores the original plain paragraph')
}

// Case Q4: refusal — no projection map (pre-attach) swallows the call with a
// notification and leaves the kernel doc untouched, same fail-closed shape
// every other kernel entry point uses when `kernel.map` isn't proven yet.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  // Deliberately no attachAfterCreate(): kernel.map stays null.
  const before = h.notifications.length
  const handled = h.controller.runQuoteToggle(h.view)
  assert.equal(handled, false, 'inactive controller (never attached) does not intercept the call')
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'kernel bytes untouched')
  assert.equal(h.notifications.length, before, 'inactive controller does not notify either')
}

// Case Q5: a top-level node type this command does not own (a code block —
// its own domain, plan 3) refuses end-to-end: `toggleBlockquote` returns
// `unsupported-structure`, `runQuoteToggle` notifies and swallows (true), and
// neither the kernel bytes nor the view move at all.
{
  const h = makeHarness('```js\nab\n```\n', doc(cb('js', 'ab')))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))
  const before = h.notifications.length
  const handled = h.controller.runQuoteToggle(h.view)
  assert.equal(handled, true, 'refusal still swallows the call')
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n', 'kernel bytes untouched')
  assert.ok(h.view.state.doc.eq(doc(cb('js', 'ab'))), 'view untouched')
  assert.ok(h.notifications.length > before, 'refusal notifies')
}

// ---- Plan 5 Task 1: math domain, degradation healed at the controller
// level. The proof is end-to-end and byte-level: attach succeeds on a
// math-bearing document (it used to return false -> full legacy degradation),
// and a keystroke in an ORDINARY paragraph of that document commits the exact
// expected bytes with the math left untouched.
{
  const md = 'a $x$ b\n\n$$\nE=mc^2\n$$\n\n甲乙\n'
  const h = makeHarness(md, doc(
    p(text('a '), mif('x'), text(' b')), cb('LaTeX', 'E=mc^2'), p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true,
    'a document containing inline AND block math attaches (no degradation)')

  // Block math is paired AND (since 2026-08-18) editable, addressing the
  // TeX's own bytes; the rest of the document stays mapped either way.
  const pairs = h.controller.kernel.map.blockPairs
  assert.equal(pairs.length, 3)
  assert.equal(pairs[1].mdBlock.type, 'math')
  assert.ok(pairs[1].charMap, 'block math is editable')
  assert.equal(pairs[1].charMap.visibleLength, 'E=mc^2'.length)
  assert.equal(pairs[1].charMap.visibleToRaw(0), md.indexOf('E=mc^2'))

  // Type 'X' between 甲 and 乙. PM: paragraph1 nodeSize 7, code_block
  // nodeSize 8 -> paragraph3 at pos 15, content start 16, caret 17.
  const tr = h.view.state.tr.insertText('X', 17)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing in a plain paragraph of a math document is allowed')
  assert.equal(h.controller.kernel.doc.text, 'a $x$ b\n\n$$\nE=mc^2\n$$\n\n甲X乙\n',
    'commit is byte-exact and leaves both math shapes untouched')
  assert.deepEqual(h.changes.at(-1), ['a $x$ b\n\n$$\nE=mc^2\n$$\n\n甲X乙\n', false])
  // Map rebound on the new revision: the inline-math atom still resolves to
  // its own `$...$` byte span, unmoved.
  assert.equal(h.controller.kernel.map.pmPosToRaw(3), 2)
  assert.equal(h.controller.kernel.map.pmPosToRaw(4), 5)
}

// Case 15 (Plan 5 Task 2): a document containing INLINE HTML attaches, and a
// plain paragraph elsewhere in it commits byte-exactly. Before the inline-HTML
// coalescing, `flattenPm`/`flattenMd` counted the fragment differently on each
// side (PM: one merged `html` atom; kernel mdast: `<span>` and `</span>` as two
// separate positioned nodes) and `buildProjectionMap` rejected the WHOLE map —
// so ANY document with an inline `<span>`/`<u>`/`<mark>` degraded to legacy.
//
// Raw offsets of 'a <span>x</span> b\n\n甲乙\n':
//   'a <span>x</span> b' = 0..17 (the fragment is [2,16)), '\n'=18 '\n'=19,
//   甲=20 乙=21 '\n'=22.
// PM: paragraph1 content = text('a ') + html atom + text(' b') = size 5 ->
// nodeSize 7; paragraph2 at pos 7, content start 8, caret between 甲 and 乙 = 9.
{
  const md = 'a <span>x</span> b\n\n甲乙\n'
  const h = makeHarness(md, doc(p(text('a '), ih('<span>x</span>'), text(' b')), p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true,
    'a document containing inline HTML attaches (no degradation)')

  const pairs = h.controller.kernel.map.blockPairs
  assert.equal(pairs.length, 2)
  assert.ok(pairs[0].charMap, 'the inline-HTML paragraph is itself mappable')
  assert.equal(pairs[0].charMap.visibleLength, 5, 'the whole fragment counts as ONE visible unit')

  const tr = h.view.state.tr.insertText('丙', 9)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing in a plain paragraph of an inline-HTML document is allowed')
  assert.equal(h.controller.kernel.doc.text, 'a <span>x</span> b\n\n甲丙乙\n',
    'commit is byte-exact and leaves the HTML fragment untouched')
  assert.deepEqual(h.changes.at(-1), ['a <span>x</span> b\n\n甲丙乙\n', false])
  // Map rebound on the new revision: the fragment still resolves to its own
  // byte span [2,16), unmoved.
  assert.equal(h.controller.kernel.map.pmPosToRaw(3), 2)
  assert.equal(h.controller.kernel.map.pmPosToRaw(4), 16)
}

// Case 16: the fragment atom, end to end through the live dispatch path.
// P6-1 relaxed `textblockProfile` (editor-kernel-gateway.js) to admit inline
// ATOMS, so typing AROUND the fragment commits; P6-1b then admitted a step
// that swallows the atom WHOLE (its resolved raw range is exactly the
// fragment's own bytes). What stays refused is a step that only PARTIALLY
// covers an atom — unrepresentable for a nodeSize-1 leaf, pinned directly on
// the guard in scripts/test-kernel-gateway.mjs — and any step whose shape the
// gateway does not classify at all, which is what the generic-message positive
// control below rides on. PM layout: content start 1, 'a ' 1..3, the html atom
// 3..4, ' b' 4..6; the second paragraph's content starts at 8.
{
  const md = 'a <span>x</span> b\n\n甲乙\n'
  const h = makeHarness(md, doc(p(text('a '), ih('<span>x</span>'), text(' b')), p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  assert.equal(dispatchThrough(h, h.view.state.tr.insertText('Z', 1)), undefined,
    'typing OUTSIDE the fragment, in the same paragraph, is now allowed')
  assert.equal(h.controller.kernel.doc.text, 'Za <span>x</span> b\n\n甲乙\n',
    'and commits byte-exactly, leaving the fragment untouched')

  const w = makeHarness(md, doc(p(text('a '), ih('<span>x</span>'), text(' b')), p(text('甲乙'))))
  assert.equal(w.controller.attachAfterCreate(), true)
  assert.equal(dispatchThrough(w, w.view.state.tr.delete(3, 4)), undefined,
    'deleting the fragment WHOLE is admitted since P6-1b')
  assert.equal(w.controller.kernel.doc.text, 'a  b\n\n甲乙\n',
    'and removes exactly the fragment bytes — no half tag left behind')

  const g = makeHarness(md, doc(p(text('a '), ih('<span>x</span>'), text(' b')), p(text('甲乙'))))
  assert.equal(g.controller.attachAfterCreate(), true)
  const before = g.notifications.length
  // A range spanning TWO paragraphs: not a single-textblock edit, so the
  // gateway refuses it outright (`sameParent`). Chosen deliberately as the
  // carrier for the message control below — the paragraph it starts in is
  // fully mapped, so a "read-only" message here would be over-reporting.
  const verdict = dispatchThrough(g, g.view.state.tr.delete(5, 9))
  assert.deepEqual(verdict, { veto: true }, 'a cross-block range step is refused')
  assert.equal(g.controller.kernel.doc.text, md, 'kernel bytes untouched')
  assert.ok(g.notifications.length > before, 'the refusal is surfaced, never silent')
  // Positive control for the P5-2.5 block-scoped message: this paragraph is
  // NOT degraded (it pairs and carries a charMap), it is merely an unsupported
  // TYPING target, so the user must keep getting the GENERIC message. If this
  // ever flips to "read-only", `degradedPairAt` has started over-reporting.
  assert.ok(g.controller.kernel.map.blockPairs[0].charMap,
    'the fragment-bearing paragraph is mapped, not degraded')
  assert.ok(g.notifications.at(-1).includes('unsupported-input-type'),
    `a non-degraded refusal keeps the generic message, got: ${g.notifications.at(-1)}`)
  assert.ok(!g.notifications.at(-1).includes('read-only'),
    'a non-degraded refusal must not claim the block is read-only')
}

// ===========================================================================
// Case 16c (2026-08-20) — THE DOCUMENT'S TRAILING EMPTY PARAGRAPH
// ===========================================================================
// User report: the caret sits in the empty paragraph at the very END of the
// document, right after an ordered list, and Backspace raises
// 「暂未支持此操作 (unsupported-input-type)」.
//
// That paragraph is `@milkdown/plugin-trailing`'s synthetic node — it owns no
// markdown bytes, and a trailing blank line cannot produce a real one because
// CommonMark discards trailing blank lines entirely. So Backspace there has
// NOTHING to delete: the correct answer is a view-only caret move to the end of
// the previous block, and forward Delete at that previous block's end is a
// no-op. Both used to reach ProseMirror's own commands, whose node-bearing
// transaction the gateway then refused.
//
// PM positions for doc(bullet_list(list_item(paragraph('甲'))), paragraph()):
// bullet_list 0 (size 7), list_item 1 (size 5), paragraph 2 (size 3, content 3,
// '甲' ends 4), trailing paragraph 7 (size 2, content 8).
{
  const md = '- \u7532\n'
  const h = makeHarness(md, doc(bl(li(null, p(text('\u7532')))), p()))
  assert.equal(h.controller.attachAfterCreate(), true, 'the fixture must attach')
  const pairs = h.controller.kernel.map.blockPairs
  const last = pairs[pairs.length - 1]
  assert.equal(last.pmNode.type.name, 'paragraph')
  assert.equal(last.virtual, true, 'sanity: the trailing paragraph pairs VIRTUAL — it owns no bytes')

  // (a) BACKSPACE inside it: swallowed, zero bytes, zero toasts, and the caret
  //     lands at the end of the previous block's content.
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 8)))
  const notifBefore = h.notifications.length
  const revisionBefore = h.controller.kernel.doc.revision
  assert.equal(h.controller.structuralHandlers.Backspace(h.view.state, h.view.dispatch, h.view), true,
    'Backspace in the trailing placeholder is handled, never delegated to PM')
  assert.equal(h.controller.kernel.doc.text, md, 'a caret move must write no bytes')
  assert.equal(h.controller.kernel.doc.revision, revisionBefore, 'and advance no revision')
  assert.equal(h.notifications.length, notifBefore,
    `a zero-byte caret move must raise no toast \u2014 got ${h.notifications.slice(notifBefore).join(' | ')}`)
  assert.equal(h.view.state.selection.head, 4,
    'the caret lands at the END of the last list item\u2019s content')

  // (b) FORWARD DELETE at that same position: nothing follows but the
  //     placeholder, so the key is consumed silently.
  const notifBeforeDelete = h.notifications.length
  assert.equal(h.controller.structuralHandlers.Delete(h.view.state, h.view.dispatch, h.view), true,
    'Delete at the end of the document is handled')
  assert.equal(h.controller.kernel.doc.text, md, 'and writes no bytes')
  assert.equal(h.notifications.length, notifBeforeDelete,
    `nor raises a toast \u2014 got ${h.notifications.slice(notifBeforeDelete).join(' | ')}`)

  // (c) THE NEGATIVE CONTROL: Backspace somewhere that is NOT the trailing
  //     placeholder keeps its previous behaviour exactly. Inside the list
  //     item's own text it is an ordinary character delete, which this family
  //     must not claim \u2014 `structuralHandlers` answers false so ProseMirror
  //     produces the deletion and the gateway owns its bytes.
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  assert.equal(h.controller.structuralHandlers.Backspace(h.view.state, h.view.dispatch, h.view), false,
    'Backspace inside real content is still the text path, not this family')
}

// ===========================================================================
// Case 16b (2026-08-20) — A REFUSAL INSIDE A CONTAINER IS NOT A READ-ONLY BLOCK
// ===========================================================================
// The user's report: 「Tab 和无序列表的搭配使用等还有问题,会报错「只读」」. Measured in
// the built app: with the caret anywhere inside a bullet list, a refused
// structural key raised 「此段落在内核模式下暂为只读（源码无法证明对应关系）」 while
// the status line said, at the same instant, that every block was editable. The
// recorded hits for that position were `bullet_list` and `list_item` — the
// paragraph the caret was in had a perfectly good charMap.
//
// Cause: `degradedPairAt` (the toast's predicate) kept the pre-2026-08-18 rule
// `!pair.charMap && !pair.virtual` and returned the FIRST match. `blockPairs`
// carries one entry per structural node on both sides, containers included, and
// a container is never a textblock — so it can never claim a charMap, always
// answers yes, and (being pre-order) always comes first. The status COUNT had
// been fixed for exactly this on 2026-08-18; the toast's copy had not.
//
// Case 16 above is the same control for a bare paragraph — which is why the bug
// survived it: with no container in the document there was nothing to blame.
{
  // '- 甲' item1: bullet_list 0, list_item 1, paragraph 2 (content 3, '甲' at 3,
  // ends 5), item ends 6. item2: list_item 6, paragraph 7 (content 8), ends 11.
  // bullet_list ends 12; trailing paragraph '丙' at 12 (content 13).
  const md = '- 甲\n- 乙\n\n丙\n'
  const build = () => doc(
    bl(li(null, p(text('甲'))), li(null, p(text('乙')))),
    p(text('丙'))
  )
  const h = makeHarness(md, build())
  assert.equal(h.controller.attachAfterCreate(), true, 'the list document must attach')
  const pairs = h.controller.kernel.map.blockPairs
  const byType = pairs.map((pair) => pair.pmNode.type.name)
  assert.deepEqual(byType,
    ['bullet_list', 'list_item', 'paragraph', 'list_item', 'paragraph', 'paragraph'],
    'sanity: containers really do occupy pairs of their own')
  for (const name of ['bullet_list', 'list_item']) {
    assert.equal(pairs.find((pair) => pair.pmNode.type.name === name).charMap, null,
      `sanity: a ${name} pair can never carry a charMap — that is why it must not be blamed`)
  }
  assert.equal(h.controller.getKernelStatus().readOnlyBlocks, 0,
    'every block of this document is editable — the premise of the whole case')

  // THE GESTURE: a selection anchored inside the FIRST list item's text and
  // extended into the second item's — a cross-textblock range, which the
  // gateway refuses outright. Its `batchTargetPos` is 4: strictly inside the
  // bullet_list (0..12), the list_item (1..6) AND the paragraph (2..5).
  const before = h.notifications.length
  assert.deepEqual(dispatchThrough(h, h.view.state.tr.delete(4, 9)), { veto: true },
    'a cross-block range step inside a list is refused')
  assert.equal(h.controller.kernel.doc.text, md, 'kernel bytes untouched')
  assert.ok(h.notifications.length > before, 'the refusal is surfaced, never silent')
  assert.ok(!h.notifications.at(-1).includes('read-only'),
    `a refusal inside a PROVEN list item must not claim it is read-only, got: ${h.notifications.at(-1)}`)
  assert.ok(h.notifications.at(-1).includes('unsupported-input-type'),
    `it keeps the generic message, got: ${h.notifications.at(-1)}`)

  // The predicate itself, over the SAME real map: no position inside this
  // document is read-only to the user — including every position strictly
  // inside the containers, which is where the old rule answered yes.
  for (let pmPos = 1; pmPos < h.view.state.doc.content.size; pmPos += 1) {
    assert.equal(readOnlyPairAt(pairs, pmPos, isTypableTextblock), null,
      `pm position ${pmPos} of a fully provable list document must not resolve to a read-only block`)
  }
}
{
  // Same shape one container over — a blockquote — because the defect is about
  // CONTAINERS, not about lists, and a list-only regression would let the next
  // container reintroduce it. Measured in the built app on the blockquote
  // fixture too (a quote..paragraph selection + Tab said 只读).
  // blockquote 0, paragraph 1 (content 2, '甲' at 2, ends 4), quote ends 5;
  // paragraph '乙' at 5 (content 6).
  const md = '> 甲\n\n乙\n'
  const h = makeHarness(md, doc(bq(p(text('甲'))), p(text('乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  assert.equal(h.controller.getKernelStatus().readOnlyBlocks, 0)
  const before = h.notifications.length
  assert.deepEqual(dispatchThrough(h, h.view.state.tr.delete(3, 7)), { veto: true })
  assert.ok(h.notifications.length > before)
  assert.ok(!h.notifications.at(-1).includes('read-only'),
    `a refusal inside a PROVEN blockquote must not claim it is read-only, got: ${h.notifications.at(-1)}`)
}
{
  // THE OTHER DIRECTION, so the fix cannot be "never say read-only": a
  // genuinely unprovable block INSIDE a list still reports itself, and the
  // innermost pair — the paragraph, not the enclosing list — is the one named
  // in the diagnostic. The unprovable block is the RED highlight paragraph
  // Case 17 uses (kernel: one coalesced inline-html atom; PM: a 2-char marked
  // run), here carried by a list item.
  globalThis.__hmKernelDiagnostics = []
  const RED = '<mark class="hm-hl-red">高亮</mark>'
  const md = '- 甲\n- ' + RED + '\n'
  const redP = () => p(schema.text('高亮', [schema.mark('highlight', { color: 'red' })]))
  const h = makeHarness(md, doc(bl(li(null, p(text('甲'))), li(null, redP())), p()))
  assert.equal(h.controller.attachAfterCreate(), true)
  const pairs = h.controller.kernel.map.blockPairs
  const degraded = pairs.filter((pair) => pair.pmNode.isTextblock && !pair.charMap)
  assert.equal(degraded.length, 1, 'exactly the highlight item degrades')
  assert.equal(h.controller.getKernelStatus().readOnlyBlocks, 1,
    'and it is counted — the fix must not silence a real degradation')
  // pmPos inside the degraded paragraph resolves to IT, not to the list around it.
  const inside = degraded[0].pmPos + 1
  assert.equal(readOnlyPairAt(pairs, inside, isTypableTextblock)?.pmNode.type.name, 'paragraph',
    'the innermost read-only pair is reported, never the enclosing container')
  const before = h.notifications.length
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, inside)))
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true,
    'Enter in the unprovable item is swallowed')
  assert.ok(h.notifications.length > before, 'and surfaced')
  assert.ok(h.notifications.at(-1).includes('read-only'),
    `a genuinely unprovable list item must still say read-only, got: ${h.notifications.at(-1)}`)
  const diag = globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'block-read-only')
  assert.ok(diag.length >= 1, 'the refusal is diagnosable')
  assert.equal(diag.at(-1).block, 'paragraph',
    'the diagnostic names the block it is ABOUT — the missing evidence that let the mis-attribution hide')
}

// Case 17 (P5-2.5): a document containing ONE unprovable block attaches and
// stays fully usable — the unprovable block degrades to read-only, every
// other block edits source-first. Before P5-2.5 the whole map came back null
// here, `attachAfterCreate` set `degraded = true`, and the ENTIRE tab fell
// back to legacy (that is the pattern this task cures).
//
// The unprovable block is a RED highlight paragraph: `<mark class="hm-hl-red">`
// is inline HTML, which the shared run rule (inline-html.js) coalesces into
// ONE atom on the kernel side, while the editor's `coalesceMarkHtml` turns
// the same fragment into a highlight node so ProseMirror holds a 2-character
// marked text run. A pure content-size disagreement (1 vs 2).
// (It used to be `==高亮==`; P5-3 made that shape editable — see Case M4 —
// so the pin moved to the red/blue form P5-3 deliberately left alone.)
// PM: paragraph1 pos 0 (content start 1), paragraph2 pos 4 (content start 5,
// size 2 — the mark does not change size).
{
  globalThis.__hmKernelDiagnostics = []
  const RED = '<mark class="hm-hl-red">高亮</mark>'
  const md = '甲乙\n\n' + RED + '\n'
  const redP = () => p(schema.text('高亮', [schema.mark('highlight', { color: 'red' })]))
  const h = makeHarness(md, doc(p(text('甲乙')), redP()))
  assert.equal(h.controller.attachAfterCreate(), true,
    'a document with one unprovable block must still attach (no whole-tab degradation)')
  assert.equal(h.controller.isDegraded(), false, 'kernel mode stays active')

  const pairs = h.controller.kernel.map.blockPairs
  assert.equal(pairs.length, 2)
  assert.ok(pairs[0].charMap, 'the good paragraph is editable')
  assert.equal(pairs[1].charMap, null, 'the unprovable paragraph degrades to a non-editable leaf')

  // (a) typing in the GOOD paragraph commits byte-correct.
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('丙', 2))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing in the good paragraph is allowed')
  assert.equal(h.controller.kernel.doc.text, '甲丙乙\n\n' + RED + '\n',
    'the commit is byte-exact and leaves the degraded block untouched')
  assert.deepEqual(h.changes.at(-1), ['甲丙乙\n\n' + RED + '\n', false])
  // ...and the cheap-path verify still passes: reparsing the kernel bytes
  // reproduces the live doc exactly (the kernel/PM disagreement is between
  // the KERNEL's remark chain and the EDITOR's parse, never between two
  // editor parses), so a degraded block causes no repair churn.
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) =>
      entry.type === 'projection-mismatch' || entry.type === 'projection-parse-failure').length,
    0,
    'no projection mismatch/parse failure from the degraded block'
  )

  // (b) typing INSIDE the degraded block is refused, fail-closed, with a
  //     toast and ZERO byte change. (paragraph2 shifted by one char: pos 5,
  //     content start 6.)
  const bytesBefore = h.controller.kernel.doc.text
  const revisionBefore = h.controller.kernel.doc.revision
  const notifBefore = h.notifications.length
  const refused = dispatchThrough(h, h.view.state.tr.insertText('Z', 7))
  assert.deepEqual(refused, { veto: true }, 'typing in the degraded block is vetoed')
  assert.equal(h.controller.kernel.doc.text, bytesBefore, 'kernel bytes untouched')
  assert.equal(h.controller.kernel.doc.revision, revisionBefore, 'no revision advance')
  assert.ok(h.notifications.length > notifBefore, 'the refusal is surfaced, never silent')
  //     Typing is how a user actually meets a degraded block, so this path
  //     gets the BLOCK-SCOPED message too (P5-2.5 review item 3), even though
  //     the refusal itself comes one layer EARLIER than the map (the inserted
  //     char would carry the red highlight mark, which `plainSliceText`
  //     rejects as `unsupported-input-type`). Both layers are fail-closed;
  //     (c) below exercises the MAP's own refusal.
  assert.ok(h.notifications.at(-1).includes('read-only'),
    `typing in a degraded block must say it is read-only, got: ${h.notifications.at(-1)}`)

  // (c) a STRUCTURAL key inside the degraded block is refused by the MAP —
  //     the caret's raw offset is unprovable (`pmPosToRaw` skips
  //     charMap-less pairs), so it never reaches PM's own commands (which
  //     would produce an unowned structural transaction).
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 7)))
  const notifBeforeEnter = h.notifications.length
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true,
    'Enter is swallowed (refused), never delegated to PM')
  assert.equal(h.controller.kernel.doc.text, bytesBefore, 'Enter changed no bytes')
  // No new toast is asserted here: `notifyBlockReadOnly` rate-limits the
  // TOAST (one per cooldown window, so a held key does not strobe) while
  // pushing its diagnostic every time — (b) just raised the same message.
  // The block-scoped message itself is asserted on (b) above and pinned by
  // the diagnostic below.
  // ...it is the BLOCK-SCOPED message (P5-2.5 review item 3), not the
  // generic "not supported yet" one: this paragraph is permanently read-only
  // for this revision, which is a different (and actionable) statement. The
  // harness's `getT` echoes the key back, so `tOr` serves the English
  // fallback — the key itself is asserted via the diagnostic below.
  assert.ok(h.notifications.at(-1).includes('read-only'),
    `a degraded block must say so, got: ${h.notifications.at(-1)}`)
  assert.ok(!h.notifications.at(-1).includes('unmapped-selection'),
    'the block-scoped message must not carry the generic code')
  assert.ok(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'block-read-only').length >= 2,
    'both the typing and the Enter refusal are diagnosable as block-read-only'
  )
  assert.ok(
    h.view.state.doc.eq(doc(p(text('甲丙乙')), redP())),
    'the view is untouched by the refused Enter')

  // (d) the good paragraph is STILL editable after all those refusals — the
  //     degraded block never poisons the map.
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))
  const verdict2 = dispatchThrough(h, h.view.state.tr.insertText('丁', 2))
  await flushMicrotasks()
  assert.equal(verdict2, undefined)
  assert.equal(h.controller.kernel.doc.text, '甲丁丙乙\n\n' + RED + '\n')
}

// Case 18 (blockAt inline html): the review's exact UX regression, cured
// end-to-end. `a\n\n<span>x</span> b\n` — the SECOND paragraph starts with an
// inline HTML fragment, so `index.blockAt(3)` used to answer the html node
// instead of the paragraph; the Backspace branch of `router.js` handed that to
// `joinParagraphBackward`, which refused on its own type re-check. Result: an
// ordinary "merge this paragraph into the one above" was rejected with a toast
// in kernel mode, where legacy merged it. Now the paragraph is resolved and the
// join commits byte-exactly.
//
// Raw offsets: 'a'=0 '\n'=1 '\n'=2, paragraph2 = [3,19), fragment = [3,17).
// PM: paragraph1 nodeSize 3 -> paragraph2 at pos 3, content start 4; the html
// atom occupies 4..5, text ' b' 5..7.
{
  const md = 'a\n\n<span>x</span> b\n'
  const h = makeHarness(md, doc(p(text('a')), p(ih('<span>x</span>'), text(' b'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  assert.equal(h.controller.kernel.map.pmPosToRaw(4), 3,
    'the fragment paragraph\'s content start maps to its own raw start')

  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  const notifBefore = h.notifications.length
  const handled = h.controller.structuralHandlers.Backspace(
    h.view.state, h.view.dispatch, h.view
  )
  await flushMicrotasks()
  assert.equal(handled, true, 'the join is owned by the kernel, not delegated to PM')
  assert.equal(h.controller.kernel.doc.text, 'a\n<span>x</span> b\n',
    'the two paragraphs merged, byte-exactly, with the fragment untouched')
  assert.equal(h.notifications.length, notifBefore, 'no refusal toast — it simply worked')
  assert.ok(
    h.view.state.doc.eq(doc(p(text('a\n'), ih('<span>x</span>'), text(' b')))),
    'view reconciled to the parse of the merged bytes'
  )
  assert.deepEqual(h.changes.at(-1), ['a\n<span>x</span> b\n', false])
}

// Case 19: the bisect guard. Now that structural commands REACH the paragraph,
// a split strictly inside the fragment would commit `a <span>x` + `</span> b` —
// two unbalanced fragments the editor renders as escaped text, i.e. bytes that
// reparse into a different document than the one on screen. Refused, zero byte
// change, same fail-closed shape as the gateway's `bisectsLineEnding` CRLF-pair
// guard.
//
// Also proven here: today's ProseMirror model cannot even PRODUCE such a caret
// (the whole fragment is one atom, so no PM position maps strictly inside its
// raw span). The guard is a byte-contract defence owned by the command layer
// rather than inherited from the schema — exactly the reasoning
// `bisectsLineEnding` states for its own unreachable-through-the-UI shapes.
{
  const md = 'a <span>x</span> b\n\n甲乙\n'
  const h = makeHarness(md, doc(p(text('a '), ih('<span>x</span>'), text(' b')), p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)

  // (a) no PM position inside the fragment paragraph maps strictly into the
  //     fragment's raw span [2,16).
  const index = buildSyntaxIndex(h.controller.kernel.doc.text)
  assert.deepEqual(index.inlineHtmlSpans, [{ start: 2, end: 16 }])
  for (let pos = 1; pos <= 6; pos += 1) {
    const raw = h.controller.kernel.map.pmPosToRaw(pos)
    if (raw === null) continue
    assert.equal(index.bisectsInlineHtml(raw), false,
      `PM pos ${pos} -> raw ${raw} must not land inside the fragment`)
  }

  // (b) the command layer refuses an interior offset outright, and nothing in
  //     the live kernel moves.
  const bytesBefore = h.controller.kernel.doc.text
  const revisionBefore = h.controller.kernel.doc.revision
  for (const offset of [3, 8, 15]) {
    assert.deepEqual(
      routeStructuralKey('Enter', { doc: h.controller.kernel.doc, index, offset }),
      { ok: false, code: 'unsupported-structure' },
      `Enter at raw ${offset} must refuse`
    )
  }
  assert.equal(h.controller.kernel.doc.text, bytesBefore, 'kernel bytes untouched')
  assert.equal(h.controller.kernel.doc.revision, revisionBefore, 'no revision advance')

  // (c) positive control on the SAME live document: the fragment's own edges
  //     are legal split points and produce balanced bytes on both sides.
  for (const [offset, expected] of [
    [2, 'a \n\n<span>x</span> b\n\n甲乙\n'],
    [16, 'a <span>x</span>\n\n b\n\n甲乙\n']
  ]) {
    const routed = routeStructuralKey('Enter', { doc: h.controller.kernel.doc, index, offset })
    assert.equal(routed.ok, true, routed.code)
    assert.equal(
      applySourceTransaction(h.controller.kernel.doc, routed.transaction).doc.text,
      expected
    )
  }
  assert.equal(h.controller.kernel.doc.text, bytesBefore, 'the controls committed nothing either')
}

// Case 20 (2026-08-19): `/quote` COMMITS. This case used to pin the opposite —
// the command had never once succeeded since it was written, because the bytes
// it commits ('>' alone on its line) reparse to a blockquote with ZERO mdast
// children while ProseMirror's `block+` blockquote always holds at least an
// empty paragraph: pmBlocks 2 vs mdBlocks 1, a COUNT mismatch, so the whole map
// was null and `requireMap` refused. The menu therefore offered an item that
// could only ever fail.
//
// The mismatch is now synthesized exactly like an empty list item's
// (editor-kernel-projection-map.js `syntheticEmptyQuoteParagraph`), so the
// result document maps, the caret has a provable home, and the follow-up
// keystroke commits — which is the whole point: a block the kernel creates but
// cannot map would be read-only, i.e. worse than a refused menu item.
{
  const h = makeHarness('/quote\n', doc(p(text('/quote'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  // Caret at the end of the query text, which is what `shouldShow` guarantees.
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 7)))
  assert.equal(h.controller.runQuoteToggleFromQuery(h.view), true,
    'the slash item always swallows the invocation')
  assert.equal(h.controller.kernel.doc.text, '>\n',
    'the query bytes became a real, empty blockquote in ONE commit')
  // The trailing empty paragraph is `withTrailingParagraph`'s own append after a
  // non-paragraph final block, the same convention every list/code fixture in
  // this file uses.
  assert.ok(h.view.state.doc.eq(doc(bq(p()), p())),
    'view reconciled to an empty blockquote')
  assert.ok(h.controller.kernel.map, 'the result document maps')
  assert.equal(h.view.state.selection.head, 2, 'caret sits inside the quote')

  // The follow-up keystroke: an ordinary plain-text commit through the empty
  // quote's derived single-point anchor.
  const oldState = h.view.state
  assert.equal(dispatchThrough(h, oldState.tr.insertText('x', 2)), undefined,
    'typing into the new blockquote is NOT vetoed')
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '>x\n', 'the text lands after the marker')

  // Undo reverses the whole conversion in one step.
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '>\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '/quote\n', 'the original query bytes come back')
}

// Case 21 (Plan 5 Task 4): typing inside a GFM table CELL commits byte-exact
// source, and the delimiter row + alignment are never touched. Before this
// task the whole table was ONE opaque non-editable pair, so every keystroke
// in a cell was vetoed with a "read-only block" toast.
//
// Raw '| a | b |\n| :-- | --: |\n| c | d |\n\n甲乙\n':
//   header row [0,9)   cells [0,4) [4,9)   texts 'a'@2 'b'@6
//   delimiter  [10,23) '| :-- | --: |'     — NO mdast node
//   body row   [24,33) cells [24,28) [28,33) texts 'c'@26 'd'@30
//   blank \n@34, '甲乙' [35,37)
// PM: table@0 (nodeSize 26; header row [1,13), body row [13,25)), cell
// paragraphs at 3 / 8 / 15 / 20 -> content positions 4 / 9 / 16 / 21; the
// trailing paragraph at 26 -> content position 27.
{
  const md = '| a | b |\n| :-- | --: |\n| c | d |\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true, 'a table document must map')
  const cellPairs = h.controller.kernel.map.blockPairs.filter((pair) => pair.tableCell)
  assert.equal(cellPairs.length, 4, 'one editable pair per cell')
  assert.deepEqual(cellPairs.map((pair) => pair.pmPos), [3, 8, 15, 20])
  assert.ok(cellPairs.every((pair) => pair.charMap), 'every cell carries a charMap')

  // (a) type 'X' after 'a' (PM 5 -> raw 3).
  {
    const verdict = dispatchThrough(h, h.view.state.tr.insertText('X', 5))
    await flushMicrotasks()
    assert.equal(verdict, undefined, 'an in-cell insert is allowed')
    assert.equal(h.controller.kernel.doc.text,
      '| aX | b |\n| :-- | --: |\n| c | d |\n\n甲乙\n')
    assert.deepEqual(h.changes.at(-1),
      ['| aX | b |\n| :-- | --: |\n| c | d |\n\n甲乙\n', false])
  }
  // (b) …and again in a BODY cell. After (a) the header row is one PM char
  //     wider ([1,14)), so the body row is [14,26) and the LAST cell's
  //     paragraph is at 21 -> content [22,23]; PM 23 is right after 'd'.
  {
    const verdict = dispatchThrough(h, h.view.state.tr.insertText('Y', 23))
    await flushMicrotasks()
    assert.equal(verdict, undefined, 'a body-cell insert is allowed')
    assert.equal(h.controller.kernel.doc.text,
      '| aX | b |\n| :-- | --: |\n| c | dY |\n\n甲乙\n')
  }
  // The delimiter row is byte-identical and every cell's alignment attr
  // survived — nothing in this phase writes either.
  assert.ok(h.controller.kernel.doc.text.includes('\n| :-- | --: |\n'),
    'the delimiter row is untouched, byte for byte')
  {
    const alignments = []
    h.view.state.doc.descendants((node) => {
      if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
        alignments.push(node.attrs.alignment)
      }
      return true
    })
    assert.deepEqual(alignments, ['left', 'right', 'left', 'right'])
  }
  // The rest of the document is still editable too.
  {
    const before = h.controller.kernel.doc.text
    const paragraphPos = h.view.state.doc.content.size - 2 // between 甲 and 乙
    const verdict = dispatchThrough(h, h.view.state.tr.insertText('丙', paragraphPos))
    await flushMicrotasks()
    assert.equal(verdict, undefined, 'the paragraph after the table still types')
    assert.equal(h.controller.kernel.doc.text, before.replace('甲乙', '甲丙乙'))
  }
}

// Case 21b (Plan 5 Task 4): the two structural writes this phase refuses —
// a literal `|` (it would split the column) and a cross-cell range — are
// vetoed, notify, and leave the kernel bytes untouched.
{
  const md = '| a | b |\n| :-- | --: |\n| c | d |\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true)
  const before = h.controller.kernel.doc.text
  const revision = h.controller.kernel.doc.revision

  const pipe = dispatchThrough(h, h.view.state.tr.insertText('|', 5))
  await flushMicrotasks()
  assert.equal(pipe?.veto, true, 'a literal `|` in a cell must be vetoed')
  assert.equal(h.controller.kernel.doc.text, before, 'kernel bytes untouched')
  assert.equal(h.controller.kernel.doc.revision, revision)

  const cross = dispatchThrough(h, h.view.state.tr.delete(4, 10))
  await flushMicrotasks()
  assert.equal(cross?.veto, true, 'a cross-cell range must be vetoed')
  assert.equal(h.controller.kernel.doc.text, before, 'kernel bytes untouched')
  assert.equal(h.controller.kernel.doc.revision, revision)
  assert.ok(h.notifications.length >= 2, 'both refusals notify')
}

// ---- Case 22 (Plan 5 Task 5): image attribute edits end to end ----
//
// The image UI's `setAttr` is a bare `tr.setNodeAttribute` — the same AttrStep
// route as the task checkbox and the language picker — so the attribute has
// ALREADY flipped on the live PM doc by the time the kernel classifies it.
// A proven rewrite therefore passes the transaction through (`undefined`),
// commits the minimal segment bytes, and rebinds the map so the blocks AFTER
// the image (whose raw offsets just moved) keep typing.

// 22a: block-image `src` — the one image path the real UI can reach today
// (@milkdown/components image-block/index.js:545, the empty-image
// ImageInput's confirm button).
{
  const md = '![a](x.png)\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true, 'a document with a standalone image maps')
  assert.equal(h.controller.kernel.map.blockPairs[0].charMap, null,
    'the image-block pair is NOT editable — attribute edits do not need a charMap')

  const verdict = dispatchThrough(h, h.view.state.tr.setNodeAttribute(0, 'src', 'y/pic.png'))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'a proven image attribute edit passes through')
  assert.equal(h.controller.kernel.doc.text, '![a](y/pic.png)\n\n甲乙\n')
  assert.deepEqual(h.changes[h.changes.length - 1], ['![a](y/pic.png)\n\n甲乙\n', false])

  // The map was rebound against the LONGER source: the paragraph after the
  // image still commits at its new raw offsets.
  const typed = dispatchThrough(h, h.view.state.tr.insertText('丙', 3))
  await flushMicrotasks()
  assert.equal(typed, undefined, 'the paragraph after the image still types')
  assert.equal(h.controller.kernel.doc.text, '![a](y/pic.png)\n\n甲丙乙\n')
}

// 22b: block-image `alt` — this repo's own schema extension. No UI dispatches
// it today (see the gateway's probe notes); the route is proven so a future
// one does not have to reopen the kernel.
{
  const md = '![a](x.png)\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true)
  const verdict = dispatchThrough(h, h.view.state.tr.setNodeAttribute(0, 'alt', '说明文字'))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '![说明文字](x.png)\n\n甲乙\n')
}

// 22c: INLINE image `title` — resolved through the ordinary charMap atom unit
// rather than a blockPairs lookup, and inserted (the source had no title) with
// the destination bytes untouched.
{
  const md = '前![a](x.png)后\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true)
  assert.equal(h.view.state.doc.nodeAt(2)?.type.name, 'image')
  const verdict = dispatchThrough(h, h.view.state.tr.setNodeAttribute(2, 'title', '标题'))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '前![a](x.png "标题")后\n\n甲乙\n')
}

// 22d: display attrs after kernel/image-caption. An UNSCALED image-block's
// `caption` is a REAL byte edit now: the AttrStep passes through and the
// caption commits into the markdown TITLE slot (the legacy scheme's own byte
// home — editor-image-markdown.js parses `caption: title || alt`). `ratio`
// (the resize handle) still never reaches the source; its refusal now
// carries the NAMED code `image-resize-unsupported`.
{
  const md = '![a](x.png)\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true)

  const committed = dispatchThrough(h, h.view.state.tr.setNodeAttribute(0, 'caption', '新图注'))
  await flushMicrotasks()
  assert.equal(committed, undefined, 'an unscaled caption edit passes through like src/alt/title')
  assert.equal(h.controller.kernel.doc.text, '![a](x.png "新图注")\n\n甲乙\n',
    'the caption commits into the TITLE slot, alt untouched')

  const revision = h.controller.kernel.doc.revision
  const ratio = dispatchThrough(h, h.view.state.tr.setNodeAttribute(0, 'ratio', 0.5))
  await flushMicrotasks()
  assert.equal(ratio?.veto, true, 'ratio must be vetoed')
  assert.equal(h.controller.kernel.doc.text, '![a](x.png "新图注")\n\n甲乙\n', 'kernel bytes untouched')
  assert.equal(h.controller.kernel.doc.revision, revision)
  assert.ok(h.notifications.some((n) => n.includes('image-resize-unsupported')),
    `the ratio refusal must carry its NAMED code, got ${JSON.stringify(h.notifications)}`)
}

// 22d2: the two NAMED caption refusals end to end. A SCALED image's caption
// is refused at classification (`image-caption-scaled` — both raw slots
// belong to the ratio scheme); clearing a caption the projection cannot
// represent (`title || alt` would shadow the alt straight back) is refused
// by the COMMAND (`empty-image-caption-unrepresentable`). Zero bytes either
// way.
{
  const md = '![1.50](x.png "说明")\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true, 'a scaled image still maps')
  const revision = h.controller.kernel.doc.revision
  const scaled = dispatchThrough(h, h.view.state.tr.setNodeAttribute(0, 'caption', '想改'))
  await flushMicrotasks()
  assert.equal(scaled?.veto, true, 'a scaled caption edit must be vetoed')
  assert.equal(h.controller.kernel.doc.text, md, 'kernel bytes untouched')
  assert.equal(h.controller.kernel.doc.revision, revision)
  assert.ok(h.notifications.some((n) => n.includes('image-caption-scaled')),
    `the scaled refusal must carry its NAMED code, got ${JSON.stringify(h.notifications)}`)
}
{
  const md = '![a](x.png)\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true)
  const revision = h.controller.kernel.doc.revision
  const cleared = dispatchThrough(h, h.view.state.tr.setNodeAttribute(0, 'caption', ''))
  await flushMicrotasks()
  assert.equal(cleared?.veto, true, 'the unrepresentable clear must be vetoed')
  assert.equal(h.controller.kernel.doc.text, md, 'kernel bytes untouched')
  assert.equal(h.controller.kernel.doc.revision, revision)
  assert.ok(h.notifications.some((n) => n.includes('empty-image-caption-unrepresentable')),
    `the shadowed clear must carry its NAMED code, got ${JSON.stringify(h.notifications)}`)
}

// 22e: PER-PAIR DEGRADATION. An image whose raw span carries a line ending
// maps fine (it is one atom on both sides) but cannot be rewritten
// byte-provably, so ITS attribute edit is vetoed — while the rest of the
// document, including the very paragraph that holds it, keeps editing.
{
  const md = '前![a](x.png\n"t")后\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true,
    'the document still maps — the unprovable image degrades nothing structurally')
  const revision = h.controller.kernel.doc.revision

  const refused = dispatchThrough(h, h.view.state.tr.setNodeAttribute(2, 'src', 'y.png'))
  await flushMicrotasks()
  assert.equal(refused?.veto, true, 'the unprovable image refuses its own attribute edit')
  assert.equal(h.controller.kernel.doc.text, md, 'kernel bytes untouched')
  assert.equal(h.controller.kernel.doc.revision, revision)
  assert.ok(h.notifications.length >= 1)

  // …and only its own pair: the paragraph AFTER it still commits.
  // p(前,image,后) is nodeSize 5 (positions 0-4); the next paragraph's content
  // starts at 6, so 7 is between 甲 and 乙.
  const typed = dispatchThrough(h, h.view.state.tr.insertText('丙', 7))
  await flushMicrotasks()
  assert.equal(typed, undefined, 'the rest of the document is unaffected')
  assert.equal(h.controller.kernel.doc.text, '前![a](x.png\n"t")后\n\n甲丙乙\n')
}

// Case 21c (review finding, 2026-08-17): Tab / Shift-Tab inside a table cell
// NAVIGATE between cells and write NOTHING.
//
// The regression Task 4 introduced: before it, a caret in a cell had no raw
// offset, so `structuralHandler`'s `Number.isFinite(offset)` guard refused
// the key. Once cells became mappable, `routeStructuralKey('Tab')` answered
// `not-structural` and the fallback inserted a LITERAL TAB into the cell's
// source ('| a | b |' + Tab -> '| a\t | b |'). GFM reads that byte as cell
// padding, so the reparse still mapped and ProseMirror still showed 'a' — an
// INVISIBLE byte persisted to the file, dirtying the document and
// accumulating on every press. Separately, this keymap is registered ahead of
// Crepe's plugins, so it also preempted preset-gfm's own NextCell/PrevCell
// (tableKeymap, priority 100) and Tab stopped moving between cells at all.
//
// PM geometry for '| a | b |\n| :-- | --: |\n| c | d |\n\n甲乙\n' (Case 21):
// cell paragraphs at 3 / 8 / 15 / 20, content positions 4 / 9 / 16 / 21.
{
  const md = '| a | b |\n| :-- | --: |\n| c | d |\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true)
  const revision = h.controller.kernel.doc.revision
  const notifications = h.notifications.length

  const caretAt = (pos) => {
    h.view.updateState(h.view.state.apply(
      h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, pos))
    ))
  }

  // (a) Tab from the first header cell -> the SECOND cell's content.
  caretAt(5) // after 'a'
  assert.equal(h.controller.structuralHandlers.Tab(h.view.state, h.view.dispatch, h.view), true,
    'Tab in a cell is handled (never falls through to another keymap)')
  // The byte contract FIRST — this is the assertion that fails on the
  // pre-fix build with '| a\t | b |…'.
  assert.equal(h.controller.kernel.doc.text, md, 'Tab wrote NO bytes')
  assert.equal(/\t/.test(h.controller.kernel.doc.text), false, 'no tab byte reached the source')
  assert.equal(h.controller.kernel.doc.revision, revision, 'Tab took no history slot')
  assert.equal(h.view.state.selection.$head.parent.textContent, 'b',
    'Tab moved the caret into the next cell')

  // (b) Shift-Tab goes back.
  assert.equal(h.controller.structuralHandlers['Shift-Tab'](h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.view.state.selection.$head.parent.textContent, 'a',
    'Shift-Tab moved the caret back to the previous cell')
  assert.equal(h.controller.kernel.doc.text, md)

  // (c) Tab wraps from the header row into the body row.
  caretAt(10) // in cell 'b'
  h.controller.structuralHandlers.Tab(h.view.state, h.view.dispatch, h.view)
  assert.equal(h.view.state.selection.$head.parent.textContent, 'c',
    'Tab crosses the row boundary, like preset-gfm does')

  // (d) Tab at the LAST cell has nowhere to go: swallowed, still no bytes.
  caretAt(22) // in cell 'd'
  assert.equal(h.controller.structuralHandlers.Tab(h.view.state, h.view.dispatch, h.view), true,
    'Tab at the last cell is still swallowed (no other keymap may run)')
  assert.equal(h.view.state.selection.$head.parent.textContent, 'd')
  assert.equal(h.controller.kernel.doc.text, md, 'the last-cell Tab wrote no bytes either')
  assert.equal(h.controller.kernel.doc.revision, revision)
  assert.equal(/\t/.test(h.controller.kernel.doc.text), false,
    'NO tab byte may ever reach the source through a table cell')
  assert.equal(h.notifications.length, notifications, 'cell navigation never toasts')

  // (e) POSITIVE CONTROL on the same live document: Tab in the ORDINARY
  //     paragraph after the table still writes source-first — as of 2026-08-18
  //     as TWO no-break spaces, because a literal tab at a block's END is
  //     stripped by CommonMark and would be another invisible dead byte.
  caretAt(h.view.state.doc.content.size - 1) // end of 甲乙
  assert.equal(h.controller.structuralHandlers.Tab(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text,
    '| a | b |\n| :-- | --: |\n| c | d |\n\n甲乙  \n',
    'a paragraph Tab is unchanged by the table branch, and writes REAL whitespace')
  assert.equal(/\t/.test(h.controller.kernel.doc.text), false,
    'a tab at a block end is stripped by CommonMark, so the literal byte must never be written')
}

// Case 21d: a DEGRADED (ragged) table still navigates — moving the caret is
// always safe, and it must not fall through to another keymap either. The
// check is made from the LIVE PM state (`isInTable`), not the projection map,
// exactly so this shape keeps working.
{
  const md = '| a | b |\n| :-- | --: |\n| c |\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true)
  const tablePairs = h.controller.kernel.map.blockPairs.filter((pair) => pair.tableCell)
  assert.equal(tablePairs.length, 0, 'sanity: the ragged table degraded to one opaque pair')
  h.view.updateState(h.view.state.apply(
    h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 5))
  ))
  assert.equal(h.controller.structuralHandlers.Tab(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.view.state.selection.$head.parent.textContent, 'b',
    'navigation works even in a table whose cells are read-only')
  assert.equal(h.controller.kernel.doc.text, md, 'and it writes nothing')
}

// ===========================================================================
// P6 Task 5 — THE ABOVE-CHUNK_THRESHOLD FALLBACK IS NAMED, NOT SILENT
// ===========================================================================
// A document over CHUNK_THRESHOLD is loaded by `appendChunks`, which parses
// each ~40 KB chunk SEPARATELY; the kernel parses the whole text once. The two
// disagree structurally on real content, so the projection map refuses and the
// tab degrades to legacy — which is the mode the byte-fidelity bug family
// lives in, and until now the user was told nothing that distinguished it from
// any other unmappable document. The attach is still ATTEMPTED (a large
// document whose two parses agree keeps working); what changed is that a
// chunk-loaded failure reports its own cause.
{
  // Unmappable on purpose: the PM doc has a block the source does not.
  const md = '\u7532\u4e59\n'
  // `getT` returns a marked key so the assertions read the i18n LOOKUP, not
  // the English fallback string (tOr treats `t(key) === key` as "no
  // translation" and falls back, which would hide a missing key).
  const tr = { getT: (key) => `t:${key}` }
  const chunked = makeHarness(md, doc(p(text('\u7532\u4e59')), p(text('surplus'))), { chunkedLoad: true, ...tr })
  assert.equal(chunked.controller.attachAfterCreate(), false, 'the map must still refuse')
  assert.deepEqual(chunked.notifications, ['t:kernelMode.unmappableChunked'],
    'a chunk-loaded document names the chunking as the reason')

  const plain = makeHarness(md, doc(p(text('\u7532\u4e59')), p(text('surplus'))), tr)
  assert.equal(plain.controller.attachAfterCreate(), false)
  assert.deepEqual(plain.notifications, ['t:kernelMode.unmappable'],
    'an ordinary unmappable document keeps the generic message')

  // Both strings must exist in BOTH languages — no hardcoded user-facing text.
  const i18n = readFileSync(new URL('../src/renderer/src/i18n.jsx', import.meta.url), 'utf8')
  for (const key of ['kernelMode.unmappable', 'kernelMode.unmappableChunked']) {
    assert.equal((i18n.match(new RegExp(`'${key}':`, 'g')) || []).length, 2,
      `${key} must be declared once per language (en + zh)`)
  }

  // Negative control: `chunkedLoad` must not turn a MAPPABLE large document
  // into a refusal. Attaching is decided by the map, never by the flag.
  const ok = makeHarness(md, doc(p(text('\u7532\u4e59'))), { chunkedLoad: true })
  assert.equal(ok.controller.attachAfterCreate(), true,
    'a chunk-loaded document whose parses DO agree still attaches')
  assert.deepEqual(ok.notifications, [], 'and says nothing')
}

// The arithmetic the ADR in editor-kernel-mode.js cites when it explains why
// the mirroring option (plan Task 5 (d)) was rejected for reasons OTHER than
// the offset maths. Pinned so the ADR cannot quietly become wrong: if these
// ever stop holding, the recorded reasoning has to be revisited.
{
  const build = (ending) => {
    let out = ''
    let i = 0
    while (out.length < 300000) {
      i += 1
      out += `## \u6807\u9898 ${i}${ending}${ending}`
      out += '\u6b63\u6587\u5185\u5bb9 '.repeat(20) + ending + ending
      if (i % 5 === 0) out += `- a${ending}${ending}- b${ending}${ending}`
      if (i % 7 === 0) out += '```js' + ending + `const x = ${i}` + ending + '```' + ending + ending
    }
    return out
  }
  for (const ending of ['\n', '\r\n']) {
    const text = build(ending)
    assert.ok(text.length > CHUNK_THRESHOLD, 'fixture must actually be chunked (positive control)')
    const chunks = splitMarkdown(text, CHUNK_SIZE)
    assert.ok(chunks.length > 1, `${JSON.stringify(ending)}: must produce several chunks`)
    assert.equal(chunks.join('\n'), text, `${JSON.stringify(ending)}: chunks rejoin byte-for-byte`)
    let offset = 0
    for (const chunk of chunks) {
      assert.equal(text.slice(offset, offset + chunk.length), chunk,
        `${JSON.stringify(ending)}: chunk at ${offset} is exactly that slice of the document`)
      offset += chunk.length + 1
    }
    assert.equal(offset - 1, text.length, `${JSON.stringify(ending)}: the offsets cover the document exactly`)
  }
}

// ===========================================================================
// P6 Task 3 — getKernelStatus: the machine-readable degradation state
// ===========================================================================
// The pure presentation rule is pinned in scripts/test-kernel-status.mjs; this
// is the half that needs a real projection map.
//
// THE COUNTED SET WAS REWRITTEN 2026-08-18. It used to be "every pair with no
// charMap", i.e. a statement about the MAP; it is now "every block the user
// can see and cannot edit", a statement about what the user can DO. The old
// rule was wrong in both directions and the cases below pin both corrections:
// containers/opaque leaves are no longer counted (a two-item list used to
// report THREE read-only blocks, so nearly every real document displayed the
// warning permanently), and a textblock the GATEWAY refuses is now counted
// even though it holds a charMap.
{
  // Healthy document: attached, nothing read-only. The negative control — an
  // indicator here would be a false positive, which is worse than silence.
  const md = '\u7532\u4e59\n\n\u4e19\u4e01\n'
  const h = makeHarness(md, doc(p(text('\u7532\u4e59')), p(text('\u4e19\u4e01'))))
  assert.deepEqual(h.controller.getKernelStatus(),
    { state: 'pending', readOnlyBlocks: 0, blocks: 0, reason: null },
    'before attach the status is pending, never normal')
  assert.equal(h.controller.attachAfterCreate(), true)
  const healthy = h.controller.getKernelStatus()
  assert.equal(healthy.state, 'normal')
  assert.equal(healthy.readOnlyBlocks, 0, 'a plain prose document has no read-only blocks')
  assert.ok(healthy.blocks >= 2)
  assert.equal(healthy.reason, null)
}
{
  // THE FALSE POSITIVE, pinned per shape. Every one of these documents is
  // fully editable, and every one of them reported 'partial' before the
  // rewrite because `blockPairs` carries an entry for each CONTAINER and each
  // opaque LEAF, none of which can ever claim a charMap.
  const cases = [
    ['bullet list (used to report THREE read-only blocks)', '- \u7532\n- \u4e59\n',
      doc(bl(li(null, p(text('\u7532'))), li(null, p(text('\u4e59')))))],
    ['blockquote', '> \u7532\u4e59\n', doc(bq(p(text('\u7532\u4e59'))))],
    ['thematic break', '\u7532\n\n---\n\n\u4e59\n',
      doc(p(text('\u7532')), schema.node('hr'), p(text('\u4e59')))],
    ['front matter', '---\ntitle: x\n---\n\n\u7532\n',
      doc(schema.node('frontmatter', { value: 'title: x' }), p(text('\u7532')))],
    ['block image', '![a](x.png)\n\n\u7532\u4e59\n',
      doc(ib({ src: 'x.png' }), p(text('\u7532\u4e59')))],
    // Item 1's tie-in: a hard-break paragraph is typable now, so it must not
    // be reported as read-only either. Before the gateway fix the map DID give
    // it a charMap, which is exactly why the old count could not have seen it.
    ['hard break', '\u7532  \n\u4e59\n',
      doc(p(text('\u7532'), schema.node('hardbreak'), text('\u4e59')))],
    ['quoted hard break', '> \u7532  \n> \u4e59\n',
      doc(bq(p(text('\u7532'), schema.node('hardbreak'), text('\u4e59'))))]
  ]
  for (const [label, md, pmDoc] of cases) {
    const h = makeHarness(md, pmDoc)
    assert.equal(h.controller.attachAfterCreate(), true, `${label}: must attach`)
    const status = h.controller.getKernelStatus()
    assert.equal(status.readOnlyBlocks, 0, `${label}: no block is read-only to the user`)
    assert.equal(status.state, 'normal', `${label}: a healthy document must not warn`)
  }
}
{
  // A document carrying a block the user can READ and cannot EDIT still
  // reports 'partial'. The fixture is block HTML: `remarkHtmlTransformer` wraps
  // it in a PM paragraph, so `isTextblock` is true and a caret genuinely goes
  // there \u2014 but the projection map serves it `charMap: null` (block HTML has
  // no character-level decode contract), so every keystroke is refused.
  const md = '<div>x</div>\n\n\u7532\u4e59\n'
  const h = makeHarness(md, doc(p(ih('<div>x</div>')), p(text('\u7532\u4e59'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const status = h.controller.getKernelStatus()
  assert.equal(status.state, 'partial')
  assert.equal(status.readOnlyBlocks, 1,
    'exactly the one block the user cannot type in \u2014 not the containers around it')
}
{
  // A table whose cells could NOT be zipped is the one non-textblock pair that
  // stays counted: it is an opaque leaf that genuinely holds visible text, so
  // "the user can see it and cannot edit it" is true of it.
  //
  // REWRITTEN 2026-08-19 (audit item 4). The first version of this case
  // branched on whether the table happened to zip and asserted a different
  // count on each side — so it passed no matter which branch ran, and the
  // opaque-leaf-with-visible-text branch of `pairIsReadOnlyToUser` had NO test
  // that could fail: dropping every non-textblock pair from the count left the
  // whole suite green. Both branches are pinned deterministically now.
  //
  // RAGGED (Case 21d's own fixture): the body row is short one cell, the
  // table-map sub-zip refuses, and the table degrades to ONE opaque pair with
  // no nested cell pairs — a leaf the user can read ('a b c') and cannot edit.
  // It MUST be counted, and counted once.
  const md = '| a | b |\n| :-- | --: |\n| c |\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true, 'the ragged-table document must attach')
  const pairs = h.controller.kernel.map.blockPairs
  assert.ok(pairs.some((pair) => pair.pmNode?.type?.name === 'table'),
    'sanity: the table itself is a pair')
  assert.equal(pairs.filter((pair) => pair.tableCell).length, 0,
    'sanity: no cell pair speaks for the ragged table’s interior')
  const status = h.controller.getKernelStatus()
  assert.equal(status.state, 'partial', 'a readable, uneditable table must warn')
  assert.equal(status.readOnlyBlocks, 1,
    'exactly the table — the paragraph after it stays editable and uncounted')
}
{
  // ZIPPED negative control: complete the ragged row and the same table maps
  // cell by cell. A zipped table gets NO pair of its own — its cell pairs
  // cover the editable surface entirely (editor-kernel-projection-map.js:
  // "the table itself gets NO pair when its cells map") — so nothing is left
  // for the count to claim and the document must NOT warn. This is the other
  // half the old conditional could never distinguish.
  const md = '| a | b |\n| :-- | --: |\n| c | d |\n\n甲乙\n'
  const h = makeHarness(md, stubParse(md))
  assert.equal(h.controller.attachAfterCreate(), true, 'the zipped-table document must attach')
  const pairs = h.controller.kernel.map.blockPairs
  assert.equal(pairs.some((pair) => pair.pmNode?.type?.name === 'table'), false,
    'sanity: a zipped table leaves no opaque table pair behind')
  assert.ok(pairs.some((pair) => pair.tableCell && pair.charMap),
    'sanity: the interior really is spoken for by editable cell pairs')
  const status = h.controller.getKernelStatus()
  assert.equal(status.state, 'normal', 'a fully zipped table must not warn')
  assert.equal(status.readOnlyBlocks, 0, 'a zipped table is editable cell by cell')
}
{
  // Whole-document fallback: 'legacy', carrying the reason the toast used.
  const md = '\u7532\u4e59\n'
  const h = makeHarness(md, doc(p(text('\u7532\u4e59')), p(text('surplus'))), { chunkedLoad: true })
  assert.equal(h.controller.attachAfterCreate(), false)
  assert.deepEqual(h.controller.getKernelStatus(),
    { state: 'legacy', readOnlyBlocks: 0, blocks: 0, reason: 'chunked' })
}
{
  // onStatusChange fires on real transitions and is de-duplicated, so a
  // keystroke that leaves the status unchanged costs no host re-render.
  //
  // TIMING (changed with \u00a79 #4, 2026-08-21): the status COUNT is the one
  // consumer that walks every pair's charMap, which under lazy charMaps
  // would force the whole document's materialization on every rebind \u2014 so
  // the publish is now DEFERRED to a short idle debounce instead of running
  // synchronously inside bindMap/attach. `getKernelStatus` itself stays
  // synchronous for direct callers. Dispose still publishes 'off'
  // immediately: a torn-down editor must not leave a stale badge while a
  // timer spins.
  const md = '\u7532\u4e59\n'
  const seen = []
  const h = makeHarness(md, doc(p(text('\u7532\u4e59'))), { onStatusChange: (s) => seen.push(s.state) })
  assert.deepEqual(seen, [], 'nothing is published before attach')
  assert.equal(h.controller.attachAfterCreate(), true)
  assert.deepEqual(seen, [], 'attach schedules the publish off the hot path (lazy charMaps)')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.deepEqual(seen, ['normal'], 'the deferred publish lands after the debounce')
  h.controller.refreshProjectionMap()
  h.controller.refreshProjectionMap()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.deepEqual(seen, ['normal'], 'an unchanged status is not re-published')
  h.controller.dispose()
  assert.deepEqual(seen, ['normal', 'off'],
    'teardown clears the host indicator immediately, no timer wait')
}

// ===========================================================================
// BLOCK-TYPE CONVERSION (Cases B1-B5)
// ===========================================================================
// `runBlockTypeFromQuery` is reached exactly like `runQuoteToggleFromQuery`:
// the slash item's `run` is swapped for it (editor-slash-menu.js's
// `blockTypeRun` / editor-crepe-setup.js's `blockType` option), so NO PM
// structural transaction is ever built and these cases call the controller
// directly. The caret is placed where `shouldShow`'s `atEndOfBlock` guarantees
// it is when an item runs: at the end of the query text.

// Case B1: paragraph "/h2" -> an H2 the user can immediately type into. The
// bytes, the reconciled view, the caret AND the follow-up keystroke are all
// asserted — the keystroke is the point, because a heading the kernel creates
// but cannot map would be a read-only block (that is exactly what the empty
// ATX heading anchor in editor-kernel-projection-map.js exists to prevent).
{
  const h = makeHarness('/h2\n', doc(p(text('/h2'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  assert.equal(h.controller.runBlockTypeFromQuery('heading2', h.view), true)
  assert.equal(h.controller.kernel.doc.text, '## \n', 'the query bytes became the marker, in one commit')
  assert.ok(h.view.state.doc.eq(doc(hd(2))), 'view reconciled to an empty H2')
  assert.equal(h.view.state.selection.head, 1, 'caret sits inside the heading, after the marker')
  assert.deepEqual(h.changes.at(-1), ['## \n', false])

  // The follow-up keystroke: an ordinary plain-text commit through the
  // heading's derived single-point anchor.
  const oldState = h.view.state
  const verdict = dispatchThrough(h, oldState.tr.insertText('T', 1))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing into the new heading is NOT vetoed')
  assert.equal(h.controller.kernel.doc.text, '## T\n', 'the title lands after the marker')
  assert.ok(h.view.state.doc.eq(doc(hd(2, text('T')))))

  // Undo reverses the whole conversion in one step (applyKernelTransaction's
  // default `record: true`), never leaving a half-converted block.
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '## \n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '/h2\n', 'the original query bytes come back')
}

// Case B2: paragraph "/ul" -> a bullet list whose empty item is typable
// (the item's own `syntheticEmptyItemParagraph` anchor).
{
  const h = makeHarness('/ul\n', doc(p(text('/ul'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  assert.equal(h.controller.runBlockTypeFromQuery('bullet', h.view), true)
  assert.equal(h.controller.kernel.doc.text, '- \n')
  assert.ok(h.view.state.doc.eq(doc(bl(li(null, p())), p())), 'view reconciled to a one-item bullet list')

  const oldState = h.view.state
  assert.equal(dispatchThrough(h, oldState.tr.insertText('x', 3)), undefined)
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '- x\n', 'typing into the new item lands after the marker')
}

// Case B3: paragraph "/ol" -> an ordered list. `1.` is the CommonMark default
// start every other list this app writes uses.
{
  const h = makeHarness('/ol\n', doc(p(text('/ol'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  assert.equal(h.controller.runBlockTypeFromQuery('ordered', h.view), true)
  assert.equal(h.controller.kernel.doc.text, '1. \n')
  assert.ok(h.view.state.doc.eq(doc(ol(li(null, p())), p())))
}

// Case B4: heading "# /h2" -> H2. The slash menu IS reachable inside a
// heading (`shouldShow` accepts paragraph|heading), so the existing marker
// must be REWRITTEN, never appended to.
{
  const h = makeHarness('# /h2\n', doc(hd(1, text('/h2'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  assert.equal(h.controller.runBlockTypeFromQuery('heading2', h.view), true)
  assert.equal(h.controller.kernel.doc.text, '## \n', 'the old marker was replaced, not appended to')
  assert.ok(h.view.state.doc.eq(doc(hd(2))))
}

// Case B6 (2026-08-22): paragraph "/h2" INSIDE A BLOCKQUOTE -> an H2 inside
// the SAME quote. The command's quote-chain walk accepts the nested query,
// its reparse proof pins the structure, and `requireMap: true` proves the
// converted document still pairs (an empty quoted heading with a resolvable
// content anchor) BEFORE anything commits. The follow-up keystroke is the
// point, as always: a heading the kernel creates but cannot type into would
// be worse than a refused menu item.
{
  const h = makeHarness('> /h2\n', doc(bq(p(text('/h2'))), p()))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 5)))
  assert.equal(h.controller.runBlockTypeFromQuery('heading2', h.view), true)
  assert.equal(h.controller.kernel.doc.text, '> ## \n', 'the quoted query became a quoted marker, one commit')
  assert.ok(h.view.state.doc.eq(doc(bq(hd(2)), p())), 'view reconciled to an empty H2 inside the quote')
  assert.equal(h.view.state.selection.head, 2, 'caret sits inside the quoted heading, after the marker')

  const verdict = dispatchThrough(h, h.view.state.tr.insertText('T', 2))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing into the quoted heading is NOT vetoed')
  assert.equal(h.controller.kernel.doc.text, '> ## T\n', 'the title lands after the quoted marker')
  assert.ok(h.view.state.doc.eq(doc(bq(hd(2, text('T'))), p())))

  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '> ## \n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '> /h2\n', 'the original quoted query comes back')
}

// Case B7: "/ul" inside a blockquote -> a bullet list inside the quote whose
// empty item is typable (`syntheticEmptyItemParagraph`, under a quote).
{
  const h = makeHarness('> /ul\n', doc(bq(p(text('/ul'))), p()))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 5)))
  assert.equal(h.controller.runBlockTypeFromQuery('bullet', h.view), true)
  assert.equal(h.controller.kernel.doc.text, '> - \n')
  assert.ok(h.view.state.doc.eq(doc(bq(bl(li(null, p()))), p())), 'view: one-item bullet list inside the quote')

  assert.equal(dispatchThrough(h, h.view.state.tr.insertText('x', 4)), undefined)
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '> - x\n', 'typing into the quoted item lands after its marker')
}

// Case IQ1 (2026-08-22): "/table" INSIDE a blockquote -> a quoted table
// skeleton, every row carrying the `> ` prefix, first header cell typable.
{
  const h = makeHarness('> /table\n', doc(bq(p(text('/table'))), p()))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 8)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'table' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '> |  |  |  |\n> | --- | --- | --- |\n> |  |  |  |\n',
    'the quoted query became the whole prefixed skeleton, in one commit')
  assert.ok(h.view.state.doc.eq(doc(bq(tbl([[[''], [''], ['']], [[''], [''], ['']]])), p())),
    'view reconciled to a table inside the quote')
  const caret = h.view.state.selection.head
  assert.equal(caret, 5, 'caret is in the first header cell, under the quote')
  assert.equal(h.controller.kernel.map.pmPosToRaw(caret), 4,
    'and that PM position maps back to the quoted cell content anchor')
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('x', caret))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing into the quoted table cell is NOT vetoed')
  assert.equal(h.controller.kernel.doc.text, '> | x |  |  |\n> | --- | --- | --- |\n> |  |  |  |\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '> |  |  |  |\n> | --- | --- | --- |\n> |  |  |  |\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '> /table\n', 'the original quoted query comes back')
}

// Case IQ2: "/js" inside a blockquote -> a quoted fence whose empty content
// line is `> ` (the FULL prefix — code-map refuses anything less), typable.
{
  const h = makeHarness('> /js\n', doc(bq(p(text('/js'))), p()))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 5)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'code', language: 'javascript' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '> ```javascript\n> \n> ```\n')
  assert.ok(h.view.state.doc.eq(doc(bq(cb('javascript')), p())), 'view: empty JS block inside the quote')
  const caret = h.view.state.selection.head
  assert.equal(caret, 2, 'caret sits inside the quoted code block')
  assert.equal(h.controller.kernel.map.pmPosToRaw(caret), 16,
    'and maps to the quoted content line (its raw unit starts at the line start — the prefix is part of the unit\'s span)')
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('x', caret))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing into the quoted code block is NOT vetoed')
  assert.equal(h.controller.kernel.doc.text, '> ```javascript\n> x\n> ```\n',
    'the character becomes quoted fence content; both fences survive')
}

// Case IQ3: "/task" inside a blockquote -> a quoted seeded task item; the
// first label character DISSOLVES the seed exactly like at top level.
{
  const h = makeHarness('> /task\n', doc(bq(p(text('/task'))), p()))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 7)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'task' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '> - [ ] ' + SEED_NBSP + '\n')
  assert.ok(h.view.state.doc.eq(doc(bq(bl(li(false, p(text(SEED_NBSP))))), p())),
    'view: a checked-false task item inside the quote, carrying the seed')
  const caret = h.view.state.selection.head
  assert.equal(caret, 5, 'caret sits AFTER the seed, inside the quoted item')
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('买', caret))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'the first label character is NOT vetoed')
  assert.equal(h.controller.kernel.doc.text, '> - [ ] 买\n',
    'the seed dissolves under the first label character, inside the quote')
}

// Case B5: an unsupported target refuses fail-closed — nothing committed,
// nothing reconciled, the CURRENT map untouched (no lock-up), and the user
// is told. `task` is the live example: `- [ ] ` reparses to a list item whose
// paragraph carries the checkbox bytes in its own raw span, which the
// projection map refuses to character-map, so the block would be created
// read-only. The command refuses the TARGET rather than relying on
// `requireMap` to catch it after the fact.
{
  const h = makeHarness('/task\n', doc(p(text('/task'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 6)))
  const before = h.notifications.length
  assert.equal(h.controller.runBlockTypeFromQuery('task', h.view), true,
    'the slash item always swallows the invocation, success or refusal')
  assert.equal(h.controller.kernel.doc.text, '/task\n', 'kernel bytes untouched')
  assert.ok(h.view.state.doc.eq(doc(p(text('/task')))), 'view untouched')
  assert.ok(h.controller.kernel.map, 'the current map is untouched too')
  assert.ok(h.notifications.length > before, 'the refusal notifies')
}

// Case B6 (the "slash items do nothing" root cause, 2026-08-17): in a
// DEGRADED tab — one whose `attachAfterCreate` could not build a projection
// map, so the controller handed the tab back to the legacy pipeline — every
// slash entry point must report NOT HANDLED (`false`), never `true`.
//
// This is the contract the menu's fallback rests on (editor-slash-menu.js):
// the kernel routes return `true` for every invocation they own, success AND
// refusal-with-toast, and `false` only when the kernel is not the live
// authority. A `true` here would mean the item swallows the click, runs
// nothing and says nothing — which is exactly the reported symptom, on EVERY
// block-type item and on `quote` alike.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲')), p(text('乙'))))
  assert.equal(h.controller.attachAfterCreate(), false, 'this fixture must degrade')
  assert.equal(h.controller.isActive(), false, 'a degraded controller is not active')
  const before = h.notifications.length
  for (const target of ['heading1', 'heading2', 'bullet', 'ordered']) {
    assert.equal(h.controller.runBlockTypeFromQuery(target, h.view), false,
      `a degraded tab must report '${target}' as NOT handled so the menu can fall back to legacy`)
  }
  assert.equal(h.controller.runQuoteToggleFromQuery(h.view), false,
    'the quote route carries the same contract')
  assert.equal(h.notifications.length, before,
    'a not-handled answer must not toast — the legacy command is about to run instead')
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'and must not touch the bytes')
  for (const route of [{ target: 'table' }, { target: 'code', language: 'javascript' }]) {
    assert.equal(h.controller.runInsertBlockFromQuery(route, h.view), false,
      `a degraded tab must report '${route.target}' as NOT handled too`)
  }
  assert.equal(h.notifications.length, before, 'still no toast on the not-handled path')
}

// ===========================================================================
// BLOCK INSERT (Cases I1-I4)
// ===========================================================================
// `runInsertBlockFromQuery` is reached exactly like `runBlockTypeFromQuery`
// (the slash item's `run` is swapped for it, so NO PM structural transaction
// is ever built) and carries the same contract. What is different — and what
// these cases exist for — is that an inserted block is MULTI-LINE and has an
// interior: the caret has to land somewhere the projection map can serve, and
// the FOLLOW-UP KEYSTROKE is the real assertion in each case. A block the
// kernel creates but cannot type into is worse than a blocked menu item.

// Case I1: paragraph "/table" -> a GFM table skeleton whose first header cell
// is immediately typable.
{
  const h = makeHarness('/table\n', doc(p(text('/table'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 7)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'table' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text,
    '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n',
    'the query bytes became the whole skeleton, in one commit')
  assert.ok(h.view.state.doc.eq(doc(tbl([[[''], [''], ['']], [[''], [''], ['']]]), p())),
    'view reconciled to a 3-column table with one body row')
  assert.deepEqual(h.changes.at(-1), ['|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n', false])

  // The caret sits INSIDE the first header cell — table / header row / cell /
  // paragraph = pos 4 in this schema — and the cell is served by the
  // projection map (a cell pair with no charMap would be read-only).
  const caret = h.view.state.selection.head
  assert.equal(caret, 4, 'caret is in the first header cell')
  assert.equal(h.controller.kernel.map.pmPosToRaw(caret), 2,
    'and that PM position maps back to the cell content anchor')

  // The follow-up keystroke: an ordinary plain-text commit into the cell.
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('x', caret))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing into the new table cell is NOT vetoed')
  assert.equal(h.controller.kernel.doc.text,
    '| x |  |  |\n| --- | --- | --- |\n|  |  |  |\n',
    'the character lands inside the cell delimiters')

  // Undo reverses the whole insert in ONE step, never leaving half a table.
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '/table\n', 'the original query bytes come back')
}

// Case I2: paragraph "/js" -> a fenced code block preset to that language,
// with a typable content line. The blank content line is the point: a fence
// written without one anchors the caret on its own CLOSING fence, and the
// first keystroke would destroy it (pinned byte-for-byte in
// scripts/test-source-kernel-blockinsert.mjs).
{
  const h = makeHarness('/js\n', doc(p(text('/js'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'code', language: 'javascript' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '```javascript\n\n```\n')
  assert.ok(h.view.state.doc.eq(doc(cb('javascript'), p())), 'view reconciled to an empty JS block')
  const caret = h.view.state.selection.head
  assert.equal(caret, 1, 'caret sits inside the code block')
  assert.equal(h.controller.kernel.map.pmPosToRaw(caret), 14,
    'and maps to the start of the block\'s own (empty) content line')

  const verdict = dispatchThrough(h, h.view.state.tr.insertText('x', caret))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing into the new code block is NOT vetoed')
  assert.equal(h.controller.kernel.doc.text, '```javascript\nx\n```\n',
    'the character becomes the block\'s content, and the closing fence survives')
}

// Case I3: a target this command does not own refuses fail-closed — nothing
// committed, nothing reconciled, the CURRENT map untouched, and the user is
// told. `math` is the live example: block math pairs with a PM `code_block`
// that editor-kernel-projection-map.js forces NON-EDITABLE, so the created
// block would have no caret position for the formula the user came to type.
{
  const h = makeHarness('/table\n', doc(p(text('/table'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 7)))
  const before = h.notifications.length
  // (`task` left this list on 2026-08-20 — the U+00A0 seed spelling made it a
  // real, owned target; its positive path is Case I5 below. `divider` and
  // `image` left the same day — the caret-after machinery gave them provable
  // homes; their positive paths are Cases I6/I7 below.)
  for (const route of [{ target: 'math' },
    { target: 'code', language: 'js x' }]) {
    assert.equal(h.controller.runInsertBlockFromQuery(route, h.view), true,
      'the slash item always swallows the invocation, success or refusal')
    assert.equal(h.controller.kernel.doc.text, '/table\n', 'kernel bytes untouched')
    assert.ok(h.view.state.doc.eq(doc(p(text('/table')))), 'view untouched')
    assert.ok(h.controller.kernel.map, 'the current map is untouched too')
  }
  // One toast, not five: `notifyBlocked` collapses repeats of the same code
  // inside its cooldown window. The point of the assertion is that the user is
  // told at all — never that a refusal is silent.
  assert.ok(h.notifications.length > before, 'the refusal notifies')
}

// Case I4: the caret must be at the block's own end (shouldShow's
// `atEndOfBlock` restated on the raw side) — a mid-block invocation would
// replace content the user kept, so it refuses instead.
{
  const h = makeHarness('/table\n', doc(p(text('/table'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 3)))
  const before = h.notifications.length
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'table' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '/table\n', 'a mid-block caret writes nothing')
  assert.ok(h.notifications.length > before)
}

// Case I5 (2026-08-20): `/task` — the U+00A0 seed, end to end through the
// controller. The insert commits the ONE representable "empty" task spelling
// (`- [ ] ` + U+00A0, checked FALSE — every ASCII spelling is checked:null),
// ledgers the seed, and lands the caret AFTER it; the first label keystroke
// then DISSOLVES the seed through the ordinary plain-text gateway path (one
// edit: delete seed + insert label), and undo unwinds dissolve and insert as
// separate steps back to the query bytes.
{
  const NBSP = ' '
  const h = makeHarness('/task\n', doc(p(text('/task'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 6)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'task' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '- [ ] ' + NBSP + '\n',
    'the query bytes became the seed spelling, in one commit')
  assert.ok(h.view.state.doc.eq(doc(bl(li(false, p(text(NBSP)))), p())),
    'view reconciled to a REAL checked:false task item holding the seed')
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, [{ from: 6, to: 7, ascii: '' }],
    'the seed is ledgered with the stands-for-no-keystroke provenance')
  // bullet_list(0) > list_item(1) > paragraph(2) > text(3..4): after-seed = 4.
  const caret = h.view.state.selection.head
  assert.equal(caret, 4, 'the caret lands AFTER the seed (the ruled design)')
  assert.equal(h.controller.kernel.map.pmPosToRaw(caret), 7,
    'and that PM position maps back to the seed\'s end')

  // The first label character: an ordinary plain-text commit that must
  // DISSOLVE the seed — bytes hold exactly the typed label, no U+00A0, empty
  // ledger — and the view must settle on the dissolved parse.
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('x', caret))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'the first label keystroke is NOT vetoed')
  assert.equal(h.controller.kernel.doc.text, '- [ ] x\n',
    'the seed dissolved under the first label character — label exactly as typed')
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, [],
    'the seed\'s ledger entry died with its byte')
  assert.ok(h.view.state.doc.eq(doc(bl(li(false, p(text('x')))), p())),
    'the view settled on the dissolved document')
  assert.ok(h.controller.kernel.map, 'and it maps — the item stays editable')

  // Undo: the dissolve is its own history step, the insert its own.
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '- [ ] ' + NBSP + '\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '/task\n', 'the original query bytes come back')
}

// Case I5b: BACKSPACE ON THE FRESH SEED, end to end through the controller.
// Two contracts pinned, in order:
//  1) The WALL still guards the byte answer (2026-08-20 adversarial audit,
//     Critical): a plain deletion TRANSACTION consuming the ledgered seed
//     (any non-key path — a plugin, a programmatic tr.delete) is vetoed
//     LOUDLY with the empty-task code, because the committed bytes `- [ ] `
//     would demote to checked:null with literal "[ ]" text.
//  2) The KEY takes the Typora exit (2026-08-22 user report — the pre-fix
//     contract made the wall the key's ONLY answer, a dead end whose exits
//     were Enter or undo while the user was simply culling the item):
//     `structuralHandlers.Backspace` routes the ledgered seed item like an
//     empty item, deleting the whole representable marker LINE — the same
//     ledger-gated lift-out Enter has had since the task-Enter matrix. The
//     wall therefore fires only for transactions no structural route owns.
{
  const NBSP = ' '
  const h = makeHarness('/task\n', doc(p(text('/task'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 6)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'task' }, h.view), true)
  const seedBytes = '- [ ] ' + NBSP + '\n'
  assert.equal(h.controller.kernel.doc.text, seedBytes)
  const seedLedger = [{ from: 6, to: 7, ascii: '' }]
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, seedLedger)
  const caret = h.view.state.selection.head // after the seed (pinned = 4 in I5)

  // 1) The text path (a plain character-deletion transaction, the shape any
  //    non-key path produces) hits the WALL: vetoed, bytes and ledger
  //    untouched, the view still shows the checkbox, and the refusal is LOUD
  //    (a toast naming the code fires — never silence).
  const notificationsBefore = h.notifications.length
  const verdict = dispatchThrough(h, h.view.state.tr.delete(caret - 1, caret))
  await flushMicrotasks()
  assert.deepEqual(verdict, { veto: true }, 'the seed deletion is vetoed, view untouched')
  assert.equal(h.controller.kernel.doc.text, seedBytes, 'bytes untouched')
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, seedLedger, 'ledger untouched')
  assert.ok(h.view.state.doc.eq(doc(bl(li(false, p(text(NBSP)))), p())),
    'the checkbox item is still on screen')
  assert.ok(h.notifications.length > notificationsBefore, 'the refusal NOTIFIES — never silent')
  assert.ok(h.notifications.slice(notificationsBefore)
    .some((message) => /empty-task-unrepresentable/.test(message)),
    'with the empty-task wall\'s own code, so the toast names the exits')

  // 2) The KEY is a structural exit: the ledgered seed item is EFFECTIVELY
  //    empty for Backspace (the seed stands for NO keystroke), so the handler
  //    owns the key and removes the whole marker line — no wall, no toast.
  //    Pre-fix (2026-08-22) this pin fails at `handled === true`: the handler
  //    answered false, PM produced the character deletion, and the wall above
  //    was the keystroke's dead end. (A `caret-unmappable` diagnostic is
  //    EXPECTED here and not asserted against: the exit leaves '\n', whose
  //    parse has no block for anchor 0 — the same recorded-fallback Enter's
  //    own seed exit takes on this document.)
  const structuralNotificationsBefore = h.notifications.length
  const handled = h.controller.structuralHandlers.Backspace(h.view.state, h.view.dispatch, h.view)
  await flushMicrotasks()
  assert.equal(handled, true,
    'Backspace on the ledgered seed IS a structural exit — the Typora cull, like Enter')
  assert.equal(h.controller.kernel.doc.text, '\n', 'the marker line is removed — list ended')
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, [],
    'the seed entry died with its line')
  assert.equal(h.notifications.length, structuralNotificationsBefore,
    'a successful exit is silent — no refusal toast')
  assert.ok(!h.view.state.doc.toString().includes('list'),
    'the checkbox item left the screen with its line')

  // 3) Undo unwinds the exit, then the insert — the query bytes come back.
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, seedBytes)
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '/task\n', 'undo returns the query bytes')
}

// Case I5c (2026-08-20 adversarial panel, Important): the IME path reaches
// the dissolve. `commitReplace` — the composition session's SOLE write path —
// used to carry only the trailing-whitespace heal; the dissolve was consulted
// only in the gateway's plain-text branch. So an IME-committed first label
// character (the NORMAL way a Chinese user types the label) landed AFTER the
// seed and permanently embedded the kernel-authored U+00A0 at the label's
// start: file bytes `- [ ] <U+00A0>买菜` where ASCII typing yields
// `- [ ] 买菜`. The seed could never dissolve afterwards
// (`spellTaskSeedInsert`'s blockText===NBSP gate) and the surviving
// `ascii:''` ledger entry kept vouching a byte with no exit. Pre-fix this
// case fails at the byte assertion, showing the embedded U+00A0 (the
// un-dissolved spelling is a registered fixture, so the pre-fix commit LANDS
// instead of being masked by a stub-parse failure).
{
  const h = makeHarness('/task\n', doc(p(text('/task'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 6)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'task' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '- [ ] ' + SEED_NBSP + '\n')
  const caret = h.view.state.selection.head // after the seed (pinned = 4 in I5)

  // One whole MULTI-CHARACTER composition (compose 买菜, commit at onEnd) —
  // the same drive protocol as Case 10: composition transactions mutate the
  // stub view directly, only compositionend's diff reaches the kernel.
  h.controller.composition.onStart()
  assert.equal(h.controller.composition.isActive(), true)
  h.view.updateState(h.view.state.apply(h.view.state.tr.insertText('买菜', caret)))
  h.controller.composition.onEnd()
  await flushMicrotasks()
  assert.equal(h.controller.composition.isActive(), false)
  assert.equal(h.controller.kernel.doc.text, '- [ ] 买菜\n',
    'the seed dissolves under the IME-committed first label — no U+00A0 before the label')
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, [],
    'the seed\'s ledger entry died with its byte')
  assert.ok(h.view.state.doc.eq(doc(bl(li(false, p(text('买菜')))), p())),
    'the view settled on the dissolved parse')
  assert.ok(h.controller.kernel.map, 'and it still maps — the item stays editable')

  // The ime-commit is bracketed as its own undo group (commitReplace's
  // breakGroup fences): first undo returns the seed, second the query bytes.
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '- [ ] ' + SEED_NBSP + '\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '/task\n')
}

// Case I5d (negative control): an IME commit AFTER an existing label has no
// seed to claim — the first label character already dissolved it through the
// plain-text path and the ledger is empty — so the commit is the ordinary
// literal append. Nothing may be deleted.
{
  const h = makeHarness('/task\n', doc(p(text('/task'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 6)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'task' }, h.view), true)
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('x', h.view.state.selection.head))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '- [ ] x\n', 'ASCII first label dissolved (Case I5 pin)')
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, [], 'ledger empty — seed gone')

  // bullet_list(0) > list_item(1) > paragraph(2) > text 'x'(3..4): after = 4.
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  h.controller.composition.onStart()
  h.view.updateState(h.view.state.apply(h.view.state.tr.insertText('买', 4)))
  h.controller.composition.onEnd()
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '- [ ] x买\n',
    'no seed, no dissolve: the IME commit is the literal append')
}

// Case I5e (negative control, fail-closed direction): a USER-authored U+00A0
// — the seed bytes reopened from disk, where the session ledger is empty by
// construction — is NEVER dissolved by an IME commit. The byte is the
// author's; typing appends after it (same pin as the plain path's provenance
// section in scripts/test-source-kernel-task-seed.mjs, now on the IME route).
{
  const h = makeHarness('- [ ] ' + SEED_NBSP + '\n', doc(bl(li(false, p(text(SEED_NBSP)))), p()))
  assert.equal(h.controller.attachAfterCreate(), true)
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, [],
    'a document created from bytes has no provenance')
  // bullet_list(0) > list_item(1) > paragraph(2) > text NBSP(3..4): after = 4.
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  h.controller.composition.onStart()
  h.view.updateState(h.view.state.apply(h.view.state.tr.insertText('买', 4)))
  h.controller.composition.onEnd()
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '- [ ] ' + SEED_NBSP + '买\n',
    'a user-authored U+00A0 survives the IME commit — the kernel never rewrites a byte it did not write')
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, [])
}

// Case I5f (CRLF): the dissolve edit is interior to the seed's own line, so a
// CRLF document keeps its endings byte-for-byte and gains no lone LF.
{
  const h = makeHarness('/task\r\n', doc(p(text('/task'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 6)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'task' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '- [ ] ' + SEED_NBSP + '\r\n')
  const caret = h.view.state.selection.head
  h.controller.composition.onStart()
  h.view.updateState(h.view.state.apply(h.view.state.tr.insertText('买菜', caret)))
  h.controller.composition.onEnd()
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '- [ ] 买菜\r\n',
    'the IME dissolve on a CRLF document commits the dissolved line with its CRLF ending intact')
  assert.equal(/(?<!\r)\n/.test(h.controller.kernel.doc.text), false, 'no lone LF was introduced')
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, [])
}

// Case I5g (2026-08-21 user report 「任务列表的回车解析目前还是坏的」): Enter
// at the end of a task item's label, end to end through the controller's
// structural keymap. Pre-fix, splitListItem wrote the new item as bare
// `- [ ] ` — remark-gfm DEMOTES that to checked:null with literal "[ ]" text
// (the seven-spelling measurement), the caret anchor had no character-map
// unit (`caret-unmappable:split-list-item`), and the next keystroke typed
// into the WRONG item (measured in the built app: Enter then 'x' appended to
// the FIRST item's label). Now the empty side carries the same session-
// ledgered U+00A0 seed `/task` writes, the caret maps to its end, and the
// first label character dissolves it through the same commands.
{
  const h = makeHarness('- [ ] x\n', doc(bl(li(false, p(text('x')))), p()))
  assert.equal(h.controller.attachAfterCreate(), true)
  // bullet_list(0) > list_item(1) > paragraph(2) > text 'x'(3..4): after = 4.
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  const diagnosticsBefore = (globalThis.__hmKernelDiagnostics || []).length
  assert.equal(
    h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view),
    true, 'Enter at the label end is a structural split'
  )
  assert.equal(h.controller.kernel.doc.text, '- [ ] x\n- [ ] ' + SEED_NBSP + '\n',
    'the continuation item carries the seed — pre-fix these bytes were the demoted bare spelling')
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, [{ from: 14, to: 15, ascii: '' }],
    'the Enter-written seed is ledgered exactly like a /task seed')
  assert.ok(h.view.state.doc.eq(
    doc(bl(li(false, p(text('x'))), li(false, p(text(SEED_NBSP)))), p())),
    'the view shows a REAL second checkbox, not literal "[ ]" text')
  assert.equal(h.controller.kernel.map.pmPosToRaw(h.view.state.selection.head), 15,
    'the caret maps to the seed\'s end — pre-fix it was unmappable and stayed in the old item')
  assert.ok(!(globalThis.__hmKernelDiagnostics || []).slice(diagnosticsBefore)
    .some((entry) => entry.type === 'caret-unmappable'),
    'no silent caret failure — pre-fix every task split recorded one')

  // The first label character dissolves the Enter-written seed through the
  // ordinary plain-text path — same machinery as a /task seed.
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('y', h.view.state.selection.head))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '- [ ] x\n- [ ] y\n',
    'the seed dissolved under the first label character')
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, [])

  // Undo unwinds dissolve and split as separate steps.
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '- [ ] x\n- [ ] ' + SEED_NBSP + '\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '- [ ] x\n')
}

// Case I5h (task-Enter matrix cell 3): Enter on the fresh, never-labelled
// seed EXITS the list — the same Typora lift-out an empty PLAIN item takes
// (`- 甲` + Enter + Enter is the shipped parity baseline). The check is
// ledger-gated: Case I5e/section-5-of-the-task-seed-suite pin that a
// reopened (unledgered) seed splits instead. Undo restores the seed line,
// then the query bytes.
{
  const h = makeHarness('/task\n', doc(p(text('/task'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 6)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'task' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '- [ ] ' + SEED_NBSP + '\n')
  assert.equal(
    h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view),
    true, 'Enter on the seed is handled structurally'
  )
  assert.equal(h.controller.kernel.doc.text, '\n',
    'the seed item lifts out — the marker line is gone, nothing demoted')
  assert.deepEqual(h.controller.kernel.doc.whitespaceMarks, [],
    'the seed\'s ledger entry died with its line')
  assert.ok(h.view.state.doc.eq(doc(p())), 'the view settled on the emptied document')

  // Undo: exit and insert unwind separately back to the query bytes.
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '- [ ] ' + SEED_NBSP + '\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '/task\n')
}

// Case I6 (2026-08-20): `/divider` — the first caret-AFTER insert, end to end
// through the controller. The written block has no text position, so the
// REAL assertions are where the caret lands and that the FOLLOW-UP KEYSTROKE
// commits — at the document end that is the trailing placeholder's own
// virtual-pair path (byte-identical to what typing there has always
// committed), mid-document it is the following paragraph's content anchor.
{
  // (a) Document end: caret into the trailing placeholder, typing commits
  // through the virtual pair, undo unwinds insert and keystroke separately.
  const h = makeHarness('/hr\n', doc(p(text('/hr'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'divider' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '---\n',
    'the query bytes became the divider, in one commit')
  assert.ok(h.view.state.doc.eq(doc(hr(), p())),
    'view reconciled to an hr plus the trailing placeholder')
  const caret = h.view.state.selection.head
  assert.equal(caret, 2, 'the caret lands INSIDE the trailing placeholder')
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('X', caret))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing below the new divider is NOT vetoed')
  assert.equal(h.controller.kernel.doc.text, '---\n\nX',
    'the keystroke commits the virtual pair\'s own bytes — separator plus text')
  assert.ok(h.view.state.doc.eq(doc(hr(), p(text('X')))))
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '---\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '/hr\n', 'the original query bytes come back')
}
{
  // (b) Mid-document before a paragraph: the caret lands at the FOLLOWING
  // block's content start and the next keystroke types into it.
  const h = makeHarness('/hr\n\n乙\n', doc(p(text('/hr')), p(text('乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'divider' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '---\n\n乙\n')
  assert.ok(h.view.state.doc.eq(doc(hr(), p(text('乙')))))
  const caret = h.view.state.selection.head
  assert.equal(caret, 2, 'the caret lands at the following paragraph\'s content start')
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('X', caret))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '---\n\nX乙\n',
    'the keystroke types into the block the caret was proven to sit in')
}
// Case I7 (2026-08-20): `/image` — the second caret-AFTER insert. The bytes
// are `![]()`, the view reconciles to the image-block CARD (whose own upload
// UI later routes the src through image-attrs.js), and the caret takes the
// same two proven homes as the divider.
{
  // (a) Document end: caret into the trailing placeholder, typing commits
  // through the virtual pair, undo unwinds insert and keystroke separately.
  const h = makeHarness('/image\n', doc(p(text('/image'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 7)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'image' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '![]()\n',
    'the query bytes became the empty image, in one commit')
  assert.ok(h.view.state.doc.eq(doc(ib({ src: '', alt: '', caption: '' }), p())),
    'view reconciled to the image-block card plus the trailing placeholder')
  const caret = h.view.state.selection.head
  assert.equal(caret, 2, 'the caret lands INSIDE the trailing placeholder')
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('X', caret))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing below the new image is NOT vetoed')
  assert.equal(h.controller.kernel.doc.text, '![]()\n\nX')
  assert.ok(h.view.state.doc.eq(doc(ib({ src: '', alt: '', caption: '' }), p(text('X')))))
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '![]()\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '/image\n', 'the original query bytes come back')
}
{
  // (b) Mid-document before a paragraph: caret at the following block's
  // content start, next keystroke types into it.
  const h = makeHarness('/image\n\n乙\n', doc(p(text('/image')), p(text('乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 7)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'image' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '![]()\n\n乙\n')
  assert.ok(h.view.state.doc.eq(doc(ib({ src: '', alt: '', caption: '' }), p(text('乙')))))
  const caret = h.view.state.selection.head
  assert.equal(caret, 2, 'the caret lands at the following paragraph\'s content start')
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('X', caret))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '![]()\n\nX乙\n')
}
// Case I8 (2026-08-20): `/text` — revert-to-paragraph, end to end. The edit
// is a proven suffix deletion; the REAL assertions are the caret's home in
// each doc-end shape and that typing there commits the right bytes.
{
  // (a) After a PARAGRAPH — the vouched-placeholder home. The reparse cannot
  // represent the emptied paragraph (a trailing blank line is no block), so
  // the controller materializes a vouched placeholder at the document end;
  // typing in it commits with NO separator prefix because the kept bytes
  // provably end in the blank line that stood before the query.
  const h = makeHarness('甲\n\n/text\n', doc(p(text('甲')), p(text('/text'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 9)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'text' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲\n\n',
    'the query block and its surplus line are gone, in one commit')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲')), p())),
    'view shows the remaining paragraph plus the materialized placeholder')
  assert.equal(h.view.state.selection.head, 4, 'the caret lands INSIDE the placeholder')
  assert.ok(h.controller.kernel.map, 'the vouched map is live')
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('X', 4))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing in the placeholder is NOT vetoed')
  assert.equal(h.controller.kernel.doc.text, '甲\n\nX',
    'the keystroke commits at the voucher\'s raw anchor with no separator prefix')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲')), p(text('X')))))
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '甲\n\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '甲\n\n/text\n', 'the original query bytes come back')
}
{
  // (b) After a LIST — the trailing virtual pair home (requireMap proves the
  // anchor pre-commit, the same doc-end home /divider takes).
  const h = makeHarness('- 甲\n\n/text\n', doc(bl(li(null, p(text('甲')))), p(text('/text'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 13)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'text' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '- 甲\n\n')
  assert.ok(h.view.state.doc.eq(doc(bl(li(null, p(text('甲')))), p())),
    'view shows the list plus the trailing placeholder')
  assert.equal(h.view.state.selection.head, 8, 'the caret lands in the trailing placeholder')
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('X', 8))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '- 甲\n\nX',
    'typing commits after the kept blank line — a new paragraph, never a lazy continuation')
}
// Case I8b (2026-08-21): `/text` MID-DOCUMENT — the shape Case I8 (c) used to
// pin as a refusal (`text-needs-document-end`). It now takes the SAME vouched
// split-placeholder session, one position further in: the deletion leaves the
// blank-line gap Enter already produces there, the placeholder is materialized
// at the deleted block's own top-level index, and the follow-up keystroke —
// the real assertion — commits at the voucher's raw anchor.
{
  // (a) Between two paragraphs: the user-reported shape.
  const h = makeHarness('甲\n\n/text\n\n乙\n',
    doc(p(text('甲')), p(text('/text')), p(text('乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 9)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'text' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲\n\n\n\n乙\n',
    'only the query block\'s own bytes go — the separators around it stay')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲')), p(), p(text('乙')))),
    'the placeholder sits exactly where the query block stood, not at the end')
  assert.equal(h.view.state.selection.head, 4, 'the caret lands INSIDE the placeholder')
  assert.ok(h.controller.kernel.map, 'the vouched map is live')
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('X', 4))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing in the placeholder is NOT vetoed')
  assert.equal(h.controller.kernel.doc.text, '甲\n\nX\n\n乙\n',
    'the keystroke commits at the voucher\'s raw anchor — a real paragraph between the two')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲')), p(text('X')), p(text('乙')))))
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '甲\n\n\n\n乙\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '甲\n\n/text\n\n乙\n', 'the original query bytes come back')
}
{
  // (b) The FIRST block of the document — no preceding block at all, so the
  // placeholder's home is top-level index 0.
  const h = makeHarness('/text\n\n乙\n', doc(p(text('/text')), p(text('乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 6)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'text' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '\n\n乙\n')
  assert.ok(h.view.state.doc.eq(doc(p(), p(text('乙')))))
  assert.equal(h.view.state.selection.head, 1)
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('X', 1))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, 'X\n\n乙\n',
    'typing in the first-block placeholder commits at raw 0')
}
{
  // (c) The refusal that REPLACED the positional one: two lists would close
  // over the gap into one, so nothing is committed, the view and map are
  // untouched, and the toast carries the code whose message names the remedy.
  const h = makeHarness('- a\n\n/text\n\n- b\n',
    doc(bl(li(null, p(text('a')))), p(text('/text')), bl(li(null, p(text('b')))), p()))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 13)))
  const before = h.notifications.length
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'text' }, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '- a\n\n/text\n\n- b\n', 'kernel bytes untouched')
  assert.ok(h.view.state.doc.eq(
    doc(bl(li(null, p(text('a')))), p(text('/text')), bl(li(null, p(text('b')))), p())),
  'view untouched')
  assert.ok(h.controller.kernel.map, 'map untouched')
  assert.ok(h.notifications.length > before, 'the refusal notifies')
  assert.ok(h.notifications.at(-1).includes('text-neighbors-would-merge'),
    'the refusal carries its OWN code so the message can name the remedy')
}
// Case I8c (2026-08-21): SESSION PARITY. `/text`'s mid-document placeholder is
// not a second placeholder species — it is the same vouched session Enter's
// degenerate split opens, so every escape from it must behave identically.
// The two halves below are Case 13's `virtualBlockAt` probe and Case 14's
// "type elsewhere" probe, re-run verbatim against a /text-created placeholder.
{
  const h = makeHarness('甲\n\n/text\n\n乙\n',
    doc(p(text('甲')), p(text('/text')), p(text('乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 9)))
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'text' }, h.view), true)
  // Same shape Case 13 asserts for Enter's placeholder: a virtual pair whose
  // insert carries NO separator prefix (the separators are already bytes).
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(4), { raw: 3, prefix: '' })
  // Save DURING the session writes the collapsed bytes — the placeholder is a
  // view fact, never a byte one, exactly as after Enter (`甲乙\n\n\n`).
  assert.equal(h.controller.kernel.doc.text, '甲\n\n\n\n乙\n')
  assert.ok(stubParse(h.controller.kernel.doc.text).eq(doc(p(text('甲')), p(text('乙')))),
    'a file saved mid-session reopens WITHOUT the placeholder — nothing is faked')
  // Case 14's escape: a commit ELSEWHERE ends the session, the orphan is
  // reconciled away, and the map recovers instead of staying null.
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('X', 1))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, 'X甲\n\n\n\n乙\n', 'the elsewhere edit committed normally')
  assert.ok(h.view.state.doc.eq(doc(p(text('X甲')), p(text('乙')))),
    'the orphaned placeholder was reconciled away')
  assert.ok(h.controller.kernel.map, 'map recovered after the orphan cleanup')
  assert.equal(h.controller.kernel.map.pmPosToRaw(1), 0)
}
{
  // (d) Mid-document before a LIST (divider): the named refusal — nothing
  // committed, nothing reconciled, the map untouched, and the toast carries
  // the code whose message names the workaround.
  const h = makeHarness('/hr\n\n- 甲\n', doc(p(text('/hr')), bl(li(null, p(text('甲')))), p()))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  const before = h.notifications.length
  assert.equal(h.controller.runInsertBlockFromQuery({ target: 'divider' }, h.view), true,
    'the slash item swallows the invocation on refusal too')
  assert.equal(h.controller.kernel.doc.text, '/hr\n\n- 甲\n', 'kernel bytes untouched')
  assert.ok(h.view.state.doc.eq(doc(p(text('/hr')), bl(li(null, p(text('甲')))), p())), 'view untouched')
  assert.ok(h.controller.kernel.map, 'the current map is untouched too')
  assert.ok(h.notifications.length > before, 'the refusal notifies')
  assert.ok(h.notifications.at(-1).includes('no-caret-home-after-insert'),
    'the refusal carries its OWN code so the message can name the workaround')
}

// Case HID: heading ids are NOT content (2026-08-17 veto-divergence report).
//
// Two halves of one bug, pinned together because either one alone still leaves
// a user-visible symptom:
//  (a) `safeParse`'s `withHeadingIds` — the parse carries the LIVE ids, so a
//      keystroke's projection check no longer reports a whole-document
//      difference and no reconcile fires (which is what used to remount every
//      node view and wipe every heading id).
//  (b) the gateway's `heading-id` classification — `syncHeadingIdPlugin`'s own
//      refresh batch passes through instead of being vetoed with a toast.
{
  const liveHeading = schema.node('heading', { level: 1, id: '标题' }, [text('标题')])
  const h = makeHarness('# 标题\n\n甲乙\n', doc(liveHeading, p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true, 'a heading document must attach')
  globalThis.__hmKernelDiagnostics = []

  // (a) An ordinary keystroke in the PARAGRAPH must not be read as a heading
  //     difference: no projection mismatch, no reconcile, id untouched.
  const insertAt = liveHeading.nodeSize + 2
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('丙', insertAt))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'the keystroke is allowed')
  assert.equal(h.controller.kernel.doc.text, '# 标题\n\n甲丙乙\n', 'and writes the expected bytes')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'projection-mismatch').length,
    0,
    'an empty parsed heading id must NOT be reported as a content mismatch'
  )
  assert.equal(h.view.state.doc.child(0).attrs.id, '标题',
    'the live heading id survives the keystroke (no whole-document reconcile)')

  // (b) The plugin's own refresh batch: passed through, byte-free, silent.
  const headingKey = new PluginKey('MILKDOWN_HEADING_ID')
  const bytesBefore = h.controller.kernel.doc.text
  const revisionBefore = h.controller.kernel.doc.revision
  const notificationsBefore = h.notifications.length
  const idTr = h.view.state.tr.setMeta(headingKey, true)
  idTr.setNodeMarkup(0, undefined, { ...h.view.state.doc.child(0).attrs, id: '标题-#2' })
  assert.equal(dispatchThrough(h, idTr), undefined, 'the heading-id batch is not vetoed')
  assert.equal(h.controller.kernel.doc.text, bytesBefore, 'and writes no bytes')
  assert.equal(h.controller.kernel.doc.revision, revisionBefore, 'and advances no revision')
  assert.equal(h.notifications.length, notificationsBefore, 'and raises no toast')
  assert.equal(h.view.state.doc.child(0).attrs.id, '标题-#2', 'the view keeps the refreshed id')
  assert.ok(h.controller.kernel.map, 'the map is rebound around the rewritten heading node')
}

// ===========================================================================
// Case CRLF-SB (2026-08-21, soft-break widening): a CRLF list item wrapping
// onto a continuation line — the user-report shape — is TYPABLE. The map's
// `linebreak` unit spans the whole '\r\n' pair plus the continuation indent,
// so a plain insert lands on provable byte boundaries and a delete of the
// soft break removes exactly the ending + prefix (joining the two lines).
// ===========================================================================
{
  const listDoc = (s) => doc(bl(li(null, p(text(s)))))
  const h = makeHarness('- 甲\r\n  乙\r\n', listDoc('甲\n乙'))
  assert.equal(h.controller.attachAfterCreate(), true, 'the CRLF soft-wrapped doc attaches')

  // (a) Type after '乙' (end of the continuation line).
  // PM: bullet_list@0, list_item@1, paragraph@2, text from 3: 甲3 \n4 乙5.
  {
    const verdict = dispatchThrough(h, h.view.state.tr.insertText('X', 6))
    await flushMicrotasks()
    assert.equal(verdict, undefined, 'typing in a CRLF soft-wrapped item is allowed')
    assert.equal(h.controller.kernel.doc.text, '- 甲\r\n  乙X\r\n', 'bytes land after 乙')
    assert.equal(/\r(?!\n)/.test(h.controller.kernel.doc.text), false, 'no lone \\r injected')
  }

  // (b) Type at the continuation line's visible start (just after the break).
  // The linebreak unit ends AFTER the continuation indent, so the insert
  // lands before '乙', not inside the syntax-only indent bytes.
  {
    const verdict = dispatchThrough(h, h.view.state.tr.insertText('Y', 5))
    await flushMicrotasks()
    assert.equal(verdict, undefined, 'typing at the continuation start is allowed')
    assert.equal(h.controller.kernel.doc.text, '- 甲\r\n  Y乙X\r\n',
      'the insert lands right after the linebreak unit (ending + indent)')
  }
}
{
  // (c) Deleting the soft break joins the two lines: exactly the '\r\n  '
  // bytes go, nothing else.
  const listDoc = (s) => doc(bl(li(null, p(text(s)))))
  const h = makeHarness('- 甲\r\n  乙\r\n', listDoc('甲\n乙'))
  assert.equal(h.controller.attachAfterCreate(), true)
  const verdict = dispatchThrough(h, h.view.state.tr.delete(4, 5))
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'deleting the soft break is allowed')
  assert.equal(h.controller.kernel.doc.text, '- 甲乙\r\n', 'the ending and its indent both go')
}

// Case PERF-1 (perf assessment §9 #2 — reuse the map you just built):
// `applyKernelTransaction` builds `nextMap` from (result.doc.text, parsed) to
// validate the transaction, reconciles the view to `parsed`, then rebinds.
// When the reconciled view doc EQUALS the parse output (`.eq`, the ordinary
// success path), the rebind must ADOPT the already-validated map instead of
// rebuilding the identical one — observable through the controller's perf
// counters, and provably the same map: it still serves the committed bytes'
// offsets.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  assert.equal(typeof h.controller.getPerfStats, 'function',
    'controller exposes perf counters (map builds / reuses)')
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))
  const before = h.controller.getPerfStats()
  const handled = h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view)
  assert.equal(handled, true)
  const after = h.controller.getPerfStats()
  assert.equal(after.projectionMapReuses, before.projectionMapReuses + 1,
    'the map proven against the committed bytes is adopted, not rebuilt')
  // The adopted map is bound and correct: same offsets the rebuild would serve
  // (raw 3 = start of the split's second paragraph -> PM pos 4, Case 3's own
  // expectation).
  assert.equal(h.controller.kernel.doc.text, '甲\n\n乙\n')
  assert.equal(h.controller.kernel.map.pmPosToRaw(4), 3)
  assert.equal(h.view.state.selection.head, 4, 'caret restore still works through the adopted map')

  // And a plain-text commit (no nextMap exists on that route) still REBUILDS:
  // reuse must never serve a map for a doc the validation never saw.
  const b2 = h.controller.getPerfStats()
  const tr = h.view.state.tr.insertText('丙', 4)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  const a2 = h.controller.getPerfStats()
  assert.equal(a2.projectionMapReuses, b2.projectionMapReuses, 'plain-text rebind does not reuse')
  assert.ok(a2.projectionMapBuilds > b2.projectionMapBuilds, 'plain-text rebind rebuilds')
}

// Case PERF-2 (perf assessment §9 #5 — debounce the verify parse): the
// post-hoc verify (`verifyPlainTextProjection`) is not a gate — the PM
// transaction is already applied when it runs — so a typing burst must pay
// for ONE coalesced verify parse after the burst settles, not one per
// keystroke. Two invariants ride along and are pinned here:
//   * the REPAIR path stays immediate — when the rebind failed
//     (kernel.map null), verify is the recovery mechanism and must not be
//     delayed (covered by the existing placeholder/task-toggle cases, which
//     would hang unmapped if it were);
//   * a FLUSH forces the pending verify — a save/mode-switch reader never
//     sees a view whose scheduled verification was silently dropped.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const tr = h.view.state.tr.insertText('丙', 2)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  const s1 = h.controller.getPerfStats()
  assert.equal(typeof s1.verifyRuns, 'number', 'perf stats expose verifyRuns')
  assert.equal(s1.verifyRuns, 0,
    'a healthy plain-text commit schedules the verify instead of parsing synchronously')
  await new Promise((resolve) => setTimeout(resolve, 350))
  const s2 = h.controller.getPerfStats()
  assert.equal(s2.verifyRuns, 1, 'the burst settles into exactly one verify run')

  // Forced flush: a pending verify runs NOW when a flush reader asks for the
  // text (mode switch / save), never left dangling behind the debounce.
  const tr2 = h.view.state.tr.insertText('丁', 1)
  const verdict2 = dispatchThrough(h, tr2)
  await flushMicrotasks()
  assert.equal(verdict2, undefined)
  assert.equal(h.controller.getPerfStats().verifyRuns, 1, 'second commit is debounced too')
  const flushed = h.controller.apiOverrides.flushMarkdown()
  assert.equal(flushed, h.controller.kernel.doc.text, 'flush serves the kernel bytes')
  assert.equal(h.controller.getPerfStats().verifyRuns, 2,
    'flushMarkdown forces the pending verify to run immediately')
}

// Case PERF-3 (regression, caught live by test-kernel-mode-ui): the
// DEBOUNCED verify must never fire while a split-placeholder session is
// active. The placeholder is a view-only construct the reparse cannot
// contain, so a verify landing mid-session reads it as a mismatch and its
// repair DELETES the paragraph under the parked caret — the next keystroke
// then lands in whatever block the caret collapses into (measured: 乙段
// typed into the neighbouring list item). The session's own edges already
// verify synchronously (the session-ending commit's hadPlaceholders branch),
// so the scheduled run is simply dropped, not deferred.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  // A plain-text commit first, so a verify is PENDING when the session opens.
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('丙', 2))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  // Enter at the block end opens the split-placeholder session.
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 4)))
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲丙乙\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲丙乙')), p())), 'placeholder parked under the caret')
  // Let every pending debounce fire. The placeholder must survive.
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.ok(h.view.state.doc.eq(doc(p(text('甲丙乙')), p())),
    'the scheduled verify must not delete an active split placeholder')
  // p1('甲丙乙') spans 0..4, so the placeholder sits at pmPos 5, content 6;
  // the split wrote '\n\n' at raw 3, parking the caret at raw 5.
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(6), { raw: 5, prefix: '' },
    'the session voucher survives the debounce window')
  // The continuation keystroke still lands at the blank-line offset.
  const fill = dispatchThrough(h, h.view.state.tr.insertText('丁', 6))
  await flushMicrotasks()
  assert.equal(fill, undefined)
  assert.equal(h.controller.kernel.doc.text, '甲丙乙\n\n丁\n',
    'typing after the wait still fills the placeholder, never a neighbour')
}

// Case PERF-2b (integration review Condition 2 — pin the FULL forced-run
// list, item by item, as the plan demanded). PERF-2 pins `flushMarkdown`;
// the debounce ADR names two more flush readers that must force the pending
// verify before serving bytes, and one route that subsumes it:
//   * `flushMarkdownSettled` — the save path's async reader;
//   * `getRecoveryMarkdown` — the recovery/export reader;
//   * a STRUCTURAL op — `applyKernelTransaction` is parse-first (it
//     reconciles the view against a fresh parse of the committed bytes,
//     strictly subsuming the pending check), and the debounced run re-reads
//     LIVE state at fire time, so a verify armed before the op fires as a
//     no-op diff, never a stale-doc repair.
// (The plan's "blur" item is reasoned away, not pinned: blur reads no bytes,
// the timer fires regardless of focus, and every byte reader above forces
// the flush first — nothing can reach disk past a dropped check.)
{
  // flushMarkdownSettled forces the pending verify.
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('丙', 2))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.getPerfStats().verifyRuns, 0, 'verify pending, not run')
  const settled = await h.controller.apiOverrides.flushMarkdownSettled()
  assert.equal(settled, h.controller.kernel.doc.text, 'settled flush serves the kernel bytes')
  assert.equal(h.controller.getPerfStats().verifyRuns, 1,
    'flushMarkdownSettled forces the pending verify to run immediately')
}
{
  // getRecoveryMarkdown forces the pending verify.
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('丙', 2))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.getPerfStats().verifyRuns, 0, 'verify pending, not run')
  const recovered = h.controller.apiOverrides.getRecoveryMarkdown()
  assert.equal(recovered, h.controller.kernel.doc.text, 'recovery serves the kernel bytes')
  assert.equal(h.controller.getPerfStats().verifyRuns, 1,
    'getRecoveryMarkdown forces the pending verify to run immediately')
}
{
  // Structural-op subsumption: a verify armed by a plain commit, then a
  // mid-block Enter (no placeholder session — both halves carry bytes).
  // The op's own parse-first reconcile already proved view == parse; the
  // still-armed debounced verify must then be a no-op against LIVE state,
  // never a repair driven by the pre-split doc it was scheduled under.
  // Unique spellings ('守…亥') so the structural parse-count delta below is
  // deterministic — no earlier case can have left these strings in the LRU.
  const h = makeHarness('守亥\n', doc(p(text('守亥'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const verdict = dispatchThrough(h, h.view.state.tr.insertText('丙', 2))
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '守丙亥\n')
  assert.equal(h.controller.getPerfStats().verifyRuns, 0, 'verify pending when the op runs')
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 3)))
  const sp0 = getKernelParseStats().parseCalls
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true)
  const structuralParses = getKernelParseStats().parseCalls - sp0
  // One real remark parse: the transaction-validated map's own index build
  // (the committed bytes are a fresh string). The OLD text's index is a memo
  // hit and the adopted map (PERF-1) spares the rebuild — a regression that
  // re-adds either shows up as a second parse here.
  assert.ok(structuralParses <= 1,
    `a structural Enter runs at most 1 kernel parse (got ${structuralParses})`)
  assert.equal(h.controller.kernel.doc.text, '守丙\n\n亥\n', 'the split committed')
  const split = doc(p(text('守丙')), p(text('亥')))
  assert.ok(h.view.state.doc.eq(split), 'view reconciled against the parse of the committed bytes')
  const mismatchesBefore = globalThis.__hmKernelDiagnostics
    .filter((entry) => entry.type === 'projection-mismatch').length
  // Fire whatever is still pending NOW (deterministic — no sleep): the run
  // must read the live post-split doc and find nothing to repair.
  h.controller.apiOverrides.flushMarkdown()
  await flushMicrotasks()
  assert.ok(h.view.state.doc.eq(split), 'the forced run repaired nothing')
  assert.equal(h.controller.kernel.doc.text, '守丙\n\n亥\n', 'and moved no bytes')
  assert.equal(
    globalThis.__hmKernelDiagnostics
      .filter((entry) => entry.type === 'projection-mismatch').length,
    mismatchesBefore,
    'no mismatch was reported — the debounced verify reads live state, never a stale diff'
  )
}

// Case PERF-4 (integration review Condition 3 — deterministic call-count
// upper bounds, replacing sleep-based observation where feasible). The two
// costs the perf branch moved off the hot path are REAL remark parses
// (`getKernelParseStats().parseCalls`) and per-block charMap constructions
// (`getCharacterMapStats().buildCalls`); this case pins an upper bound for
// both, per attach and per keystroke, on fresh document strings (memo keys
// never seen before in this process, so the deltas cannot depend on LRU
// history). A future change that quietly re-adds a full-document parse or an
// eager whole-map charMap pass fails HERE, without any timer.
{
  const h = makeHarness('守甲\n\n守乙\n', doc(p(text('守甲')), p(text('守乙'))))
  const p0 = getKernelParseStats().parseCalls
  const c0 = getCharacterMapStats().buildCalls
  assert.equal(h.controller.attachAfterCreate(), true)
  const attachParses = getKernelParseStats().parseCalls - p0
  const attachCharMaps = getCharacterMapStats().buildCalls - c0
  // Attach: ONE kernel parse (the projection map's index) and ZERO charMap
  // constructions — every non-empty textblock defers behind its getter (#4).
  // An eager whole-map charMap pass regressing would show up here first.
  assert.ok(attachParses <= 1, `attach runs at most 1 kernel parse (got ${attachParses})`)
  assert.equal(attachCharMaps, 0,
    'attach builds no charMap at all — the per-block maps are lazy')

  // Three keystrokes at the end of the first paragraph ('守甲' ends at PM
  // pos 3, then 4, then 5 as it grows). Per keystroke: at most ONE kernel
  // parse (the post-commit rebind's index — the verify parse is debounced
  // off the hot path, PERF-2) and at most TWO charMap constructions (the
  // touched block's proof on the current map + the edit-observability read
  // on the freshly bound map; every other block stays unmaterialized).
  const chars = [['丙', 4], ['丁', 5], ['戊', 6]]
  for (const [ch, pos] of chars) {
    const kp = getKernelParseStats().parseCalls
    const kc = getCharacterMapStats().buildCalls
    const verdict = dispatchThrough(h, h.view.state.tr.insertText(ch, pos - 1))
    await flushMicrotasks()
    assert.equal(verdict, undefined, `keystroke ${ch} allowed`)
    const dp = getKernelParseStats().parseCalls - kp
    const dc = getCharacterMapStats().buildCalls - kc
    assert.ok(dp <= 1, `keystroke ${ch}: at most 1 kernel parse (got ${dp})`)
    assert.ok(dc <= 2, `keystroke ${ch}: at most 2 charMap builds (got ${dc})`)
  }
  assert.equal(h.controller.kernel.doc.text, '守甲丙丁戊\n\n守乙\n', 'the keystrokes landed')
}

console.log('PASS kernel mode headless')
