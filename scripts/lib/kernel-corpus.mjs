// Deterministic synthetic Markdown corpus for kernel measurement + large-doc
// tests.
//
// Re-creates the generator described in
// `.superpowers/kernel-performance-assessment.md` §1.1 (whose probe lived in
// /tmp and was deleted with the rest of the measurement scaffolding). Block
// mix per document: ~60 % prose paragraphs, 10 % lists (bullet + ordered),
// 10 % fenced `js` code, 8 % GFM tables, 8 % headings, 4 % blockquotes, 3 %
// block math, 2 % standalone images. Paragraphs carry realistic inline
// decoration (`**strong**`, `*em*`, `` `code` ``, links, `$x$`, `==hl==`,
// `<span>`), and the text is ~50 % CJK — the app's primary audience and the
// more expensive parse.
//
// Seeded (MINSTD LCG, the same constants scripts/test-kernel-combination-matrix.mjs
// uses) so every run of every suite sees byte-identical documents.
//
// IMPORTANT for the chunk-attach work: the mix deliberately includes
// BLANK-LINE-SEPARATED LIST PAIRS (`loose list, blank line, more items`),
// because that is the canonical shape on which a chunked parse and a
// whole-document parse structurally disagree — one loose list whole vs two
// lists chunked. A corpus without it would make the chunk repair look
// unnecessary.

const CJK = '文档编辑器内核源码保真度块级映射证明字节回归测试用例段落标题列表表格代码'
const ASCII = 'the quick brown fox jumps over a lazy dog while parsing markdown blocks'

export function makeRng(seed = 42) {
  let state = (seed >>> 0) || 1
  return () => {
    state = (state * 48271) % 2147483647
    return state / 2147483647
  }
}

function words(rnd, count, cjkRatio = 0.5) {
  const out = []
  for (let i = 0; i < count; i += 1) {
    if (rnd() < cjkRatio) {
      const start = Math.floor(rnd() * (CJK.length - 4))
      out.push(CJK.slice(start, start + 2 + Math.floor(rnd() * 3)))
    } else {
      const parts = ASCII.split(' ')
      out.push(parts[Math.floor(rnd() * parts.length)])
    }
  }
  return out.join('')
}

function paragraph(rnd, n) {
  const pieces = [words(rnd, 6 + Math.floor(rnd() * 10))]
  const decorations = [
    () => `**${words(rnd, 2)}**`,
    () => `*${words(rnd, 2)}*`,
    () => `\`code_${n}\``,
    () => `[${words(rnd, 2)}](https://example.com/p${n})`,
    () => `$E=mc^${1 + (n % 7)}$`,
    () => `==${words(rnd, 2)}==`,
    () => `<span>${words(rnd, 2)}</span>`
  ]
  const count = 1 + Math.floor(rnd() * 3)
  for (let i = 0; i < count; i += 1) {
    pieces.push(decorations[Math.floor(rnd() * decorations.length)]())
    pieces.push(words(rnd, 3 + Math.floor(rnd() * 8)))
  }
  return pieces.join('')
}

function listBlock(rnd, n, ordered) {
  const items = 3 + Math.floor(rnd() * 4)
  const lines = []
  for (let i = 0; i < items; i += 1) {
    lines.push(`${ordered ? `${i + 1}.` : '-'} ${words(rnd, 4 + Math.floor(rnd() * 6))}`)
  }
  return lines.join('\n')
}

function fence(rnd, n) {
  const lines = [`\`\`\`js`]
  const count = 4 + Math.floor(rnd() * 8)
  for (let i = 0; i < count; i += 1) {
    lines.push(`  const v${i} = compute(${n}, ${i}) // ${words(rnd, 2, 0.2)}`)
  }
  lines.push('```')
  return lines.join('\n')
}

function table(rnd, n) {
  const rows = 3 + Math.floor(rnd() * 3)
  const lines = [`| ${words(rnd, 2)} | ${words(rnd, 2)} | ${words(rnd, 2)} |`, '| --- | :--- | ---: |']
  for (let i = 0; i < rows; i += 1) {
    lines.push(`| ${words(rnd, 2)} | ${words(rnd, 3)} | ${n}-${i} |`)
  }
  return lines.join('\n')
}

// A CHUNK TRAP: one loose bullet list whose two item runs are separated by a
// blank line, positioned so that `splitMarkdown`'s cut lands on THAT blank
// line. The whole-document parse sees ONE loose list; the chunked parse sees
// TWO tight lists, one per chunk. This is the canonical chunk-vs-whole
// structural disagreement (measured on real repo docs — see the ADR in
// editor-kernel-mode.js), reproduced deterministically instead of hoped for:
// a corpus that happens not to straddle a boundary would make the chunk
// repair look unnecessary.
//
// `firstRunChars` is the budget for the run BEFORE the blank line. The caller
// sizes it so that `splitMarkdown`'s running counter crosses its target while
// inside that run — the internal blank line is then the first blank line at or
// after the threshold, which is exactly where the cut happens.
function chunkTrap(rnd, n, firstRunChars) {
  const runOne = []
  let used = 0
  let i = 0
  while (used < firstRunChars) {
    const line = `- ${words(rnd, 5 + Math.floor(rnd() * 5))} ${n}.${i}`
    runOne.push(line)
    used += line.length + 1
    i += 1
  }
  const runTwo = []
  for (let k = 0; k < 3; k += 1) runTwo.push(`- ${words(rnd, 5)} ${n}.b${k}`)
  return `${runOne.join('\n')}\n\n${runTwo.join('\n')}`
}

// Generate ~`targetChars` of markdown. The final block is always a plain
// paragraph so @milkdown/plugin-trailing adds no synthetic node.
//
// `chunkTraps` (default false) plants one `chunkTrap` at every `CHUNK_SIZE`
// boundary — use it whenever the test is ABOUT the chunked load path.
export function makeCorpus(targetChars, seed = 42, { chunkTraps = false, chunkSize = 40000 } = {}) {
  const rnd = makeRng(seed)
  const blocks = []
  let size = 0
  let n = 0
  // Distance since the last planted trap, in the same units `splitMarkdown`
  // counts (raw chars incl. line endings). The trap is planted while the
  // counter still has room for the trap's first run.
  let sinceCut = 0
  const TRAP_RUN = 2500
  while (size < targetChars) {
    n += 1
    let block
    if (chunkTraps && sinceCut >= chunkSize - TRAP_RUN - 200 && size + TRAP_RUN < targetChars) {
      block = chunkTrap(rnd, n, chunkSize - sinceCut + 40)
      blocks.push(block)
      size += block.length + 2
      sinceCut = 3 * 40 // the trap's second run + join, well under the next target
      continue
    }
    if (n % 12 === 1) {
      block = `## ${words(rnd, 3)} ${n}`
    } else {
      const r = rnd()
      if (r < 0.6) block = paragraph(rnd, n)
      else if (r < 0.66) block = listBlock(rnd, n, false)
      else if (r < 0.70) block = listBlock(rnd, n, true)
      // The chunk-vs-whole disagreement shape: two item runs separated by a
      // blank line. Whole-document parse => ONE loose list; a chunk boundary
      // that falls between them => TWO lists.
      else if (r < 0.74) block = `${listBlock(rnd, n, false)}\n\n${listBlock(rnd, n, false)}`
      else if (r < 0.82) block = fence(rnd, n)
      else if (r < 0.90) block = table(rnd, n)
      else if (r < 0.94) block = `> ${words(rnd, 8 + Math.floor(rnd() * 8))}`
      else if (r < 0.97) block = `$$\n\\sum_{i=1}^{${n}} x_i^2\n$$`
      else block = `![${words(rnd, 2)}](./images/fig-${n}.png)`
    }
    blocks.push(block)
    size += block.length + 2
    sinceCut += block.length + 2
  }
  blocks.push(paragraph(rnd, n + 1))
  return `${blocks.join('\n\n')}\n`
}

export function toCrlf(text) {
  return text.replace(/\r?\n/g, '\r\n')
}
