import assert from 'node:assert/strict'
import { createVerifiedEditorState } from '../src/renderer/src/components/editor-verified-state.js'

const doc = (name) => Object.freeze({ name })
const doc0 = doc('doc-0')
const doc1 = doc('doc-1')
const doc2 = doc('doc-2')
const doc3 = doc('doc-3')

const committed = (markdown, canonical) => ({
  ok: true,
  type: 'committed',
  markdown,
  canonical
})

const failed = (type) => ({ ok: false, type })

const run = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

run('captures immutable expected documents with monotonic revisions', () => {
  const state = createVerifiedEditorState({
    source: 'old',
    canonical: 'old-c',
    expectedDoc: doc0,
    verify: () => failed('semantic-loss')
  })
  const first = state.capture(doc1)
  const second = state.capture(doc2)
  assert.equal(first.revision, 1)
  assert.equal(second.revision, 2)
  assert.equal(first.expectedDoc, doc1)
  assert.equal(second.expectedDoc, doc2)
  assert.equal(Object.isFrozen(first), true)
  assert.throws(() => { first.revision = 99 }, TypeError)
  assert.throws(() => { first.expectedDoc = doc3 }, TypeError)
})

run('commits every verified field atomically before publication', () => {
  const events = []
  let state
  state = createVerifiedEditorState({
    source: 'old',
    canonical: 'old-c',
    expectedDoc: doc0,
    verify: () => committed('new', 'new-c'),
    publish: (markdown) => {
      const current = state.snapshot()
      events.push({
        markdown,
        revision: current.revision,
        source: current.source,
        canonical: current.canonical,
        expectedDoc: current.expectedDoc,
        pending: current.pending,
        status: current.status
      })
    }
  })
  const capture = state.capture(doc1)
  const result = state.commit(capture, committed('new', 'new-c'))
  assert.deepEqual(result, { ok: true, type: 'committed', markdown: 'new' })
  assert.deepEqual(state.snapshot(), {
    revision: 1,
    source: 'new',
    canonical: 'new-c',
    expectedDoc: doc1,
    pending: null,
    status: 'committed',
    failureType: null
  })
  assert.deepEqual(events, [{
    markdown: 'new',
    revision: 1,
    source: 'new',
    canonical: 'new-c',
    expectedDoc: doc1,
    pending: null,
    status: 'committed'
  }])
})

run('typed deterministic failures never advance committed fields', () => {
  for (const type of ['semantic-loss', 'parser-error', 'unowned-source-change']) {
    const state = createVerifiedEditorState({
      source: 'trusted',
      canonical: 'trusted-c',
      expectedDoc: doc0,
      verify: () => failed(type)
    })
    const capture = state.capture(doc1)
    assert.deepEqual(state.commit(capture, failed(type)), { ok: false, type })
    const snapshot = state.snapshot()
    assert.equal(snapshot.revision, 0)
    assert.equal(snapshot.source, 'trusted')
    assert.equal(snapshot.canonical, 'trusted-c')
    assert.equal(snapshot.expectedDoc, doc0)
    assert.equal(snapshot.pending, null)
    assert.equal(snapshot.status, type)
    assert.equal(snapshot.failureType, type)
  }
})

run('a deterministic failure is final until a newer document is captured', () => {
  let verifyCalls = 0
  const state = createVerifiedEditorState({
    source: 'trusted',
    canonical: 'trusted-c',
    expectedDoc: doc0,
    verify: () => {
      verifyCalls += 1
      return committed('unexpected', 'unexpected-c')
    }
  })
  const capture = state.capture(doc1)
  assert.deepEqual(state.commit(capture, failed('semantic-loss')), {
    ok: false,
    type: 'semantic-loss'
  })
  assert.deepEqual(state.propose(capture, {
    candidates: [{ markdown: 'retry' }],
    canonical: 'retry-c'
  }), { ok: false, type: 'semantic-loss' })
  assert.deepEqual(state.commit(capture, committed('retry', 'retry-c')), {
    ok: false,
    type: 'semantic-loss'
  })
  assert.equal(verifyCalls, 0)
  assert.equal(state.snapshot().source, 'trusted')
  assert.deepEqual(state.diagnostics(), {
    revision: 1,
    committedRevision: 0,
    status: 'semantic-loss',
    failureType: 'semantic-loss'
  })
  assert.deepEqual(Object.keys(state.diagnostics()), [
    'revision',
    'committedRevision',
    'status',
    'failureType'
  ], 'diagnostics never expose source, canonical, or documents')

  const newer = state.capture(doc2)
  const proposal = state.propose(newer, {
    candidates: [{ markdown: 'newer' }],
    canonical: 'newer-c'
  })
  assert.equal(verifyCalls, 1)
  assert.equal(state.commit(newer, proposal).ok, true)
  assert.equal(state.snapshot().source, 'unexpected')
  assert.deepEqual(state.diagnostics(), {
    revision: 2,
    committedRevision: 2,
    status: 'committed',
    failureType: null
  })
})

run('only a genuinely newer capture makes a stale result pending', () => {
  const state = createVerifiedEditorState({
    source: 'old',
    canonical: 'old-c',
    expectedDoc: doc0,
    verify: () => committed('new', 'new-c')
  })
  const first = state.capture(doc1)
  assert.deepEqual(state.commit(first, failed('semantic-loss')), {
    ok: false,
    type: 'semantic-loss'
  })
  assert.equal(state.snapshot().status, 'semantic-loss')

  const second = state.capture(doc2)
  const third = state.capture(doc3)
  assert.deepEqual(state.commit(second, committed('stale', 'stale-c')), {
    ok: false,
    type: 'pending'
  })
  assert.equal(state.snapshot().pending, third)
  assert.equal(state.snapshot().status, 'pending')
  assert.equal(state.commit(third, committed('latest', 'latest-c')).ok, true)
  assert.equal(state.snapshot().source, 'latest')
})

run('stale proposals cannot verify or publish over a newer capture', () => {
  let verifyCalls = 0
  const published = []
  const state = createVerifiedEditorState({
    source: 'old',
    canonical: 'old-c',
    expectedDoc: doc0,
    verify: ({ candidates, expectedDoc, canonical }) => {
      verifyCalls += 1
      return committed(`${candidates[0].markdown}:${expectedDoc.name}`, canonical)
    },
    publish: (markdown) => published.push(markdown)
  })
  const first = state.capture(doc1)
  const second = state.capture(doc2)
  assert.deepEqual(state.propose(first, {
    candidates: [{ markdown: 'stale' }],
    canonical: 'stale-c'
  }), { ok: false, type: 'pending' })
  assert.equal(verifyCalls, 0)
  assert.deepEqual(published, [])
  const proposal = state.propose(second, {
    candidates: [{ markdown: 'latest' }],
    canonical: 'latest-c'
  })
  assert.equal(state.commit(second, proposal).ok, true)
  assert.deepEqual(published, ['latest:doc-2'])
})

run('proposal candidates retain their own durable context', () => {
  const durableContext = Object.freeze({
    emptyTableCells: Object.freeze([{ table: 0, row: 1, column: 2 }])
  })
  let verifiedInput = null
  const candidates = [{ markdown: '| short |', durableContext }]
  const state = createVerifiedEditorState({
    source: 'old',
    canonical: 'old-c',
    expectedDoc: doc0,
    verify: (input) => {
      verifiedInput = input
      return committed(input.candidates[0].markdown, input.canonical)
    }
  })
  const capture = state.capture(doc1)
  const proposal = state.propose(capture, { candidates, canonical: 'next-c' })
  assert.equal(verifiedInput.expectedDoc, doc1)
  assert.equal(verifiedInput.candidates[0], candidates[0])
  assert.equal(verifiedInput.candidates[0].durableContext, durableContext)
  assert.equal(proposal.canonical, 'next-c')
})

run('reset invalidates captures and establishes a clean committed baseline', () => {
  const state = createVerifiedEditorState({
    source: 'old',
    canonical: 'old-c',
    expectedDoc: doc0,
    verify: () => committed('stale', 'stale-c')
  })
  const capture = state.capture(doc1)
  const reset = state.reset({ source: 'reset', canonical: 'reset-c', expectedDoc: doc2 })
  assert.deepEqual(reset, {
    revision: 2,
    source: 'reset',
    canonical: 'reset-c',
    expectedDoc: doc2,
    pending: null,
    status: 'committed',
    failureType: null
  })
  assert.deepEqual(state.commit(capture, committed('stale', 'stale-c')), {
    ok: false,
    type: 'pending'
  })
  assert.deepEqual(state.snapshot(), reset)
})

run('publication failure never rolls back a committed revision', () => {
  const state = createVerifiedEditorState({
    source: 'old',
    canonical: 'old-c',
    expectedDoc: doc0,
    verify: () => committed('new', 'new-c'),
    publish: () => { throw new Error('consumer failed') }
  })
  const capture = state.capture(doc1)
  assert.doesNotThrow(() => state.commit(capture, committed('new', 'new-c')))
  assert.equal(state.snapshot().revision, 1)
  assert.equal(state.snapshot().source, 'new')
  assert.equal(state.snapshot().status, 'committed')
})

console.log('\nverified editor state: all cases passed')
