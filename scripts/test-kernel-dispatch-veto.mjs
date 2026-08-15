import assert from 'node:assert/strict'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { Schema } from '@milkdown/prose/model'
import { createSourceTransactionDispatch } from '../src/renderer/src/components/editor-source-transactions.js'

// Minimal schema for testing
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' }
  }
})

const text = (value) => (value ? schema.text(value) : null)
const paragraph = (value) => schema.node('paragraph', null, text(value))
const doc = (...blocks) => schema.node('doc', null, blocks)

// Test case 1: onTransactions returns {veto: true} → updateState NOT called
console.log('Test 1: veto=true blocks updateState')
{
  const initialState = EditorState.create({ schema, doc: doc(paragraph('hello')) })
  let updateStateCalled = false
  let updateStateCount = 0

  const onTransactions = () => ({ veto: true })
  const dispatch = createSourceTransactionDispatch(onTransactions)

  const stubView = {
    state: initialState,
    updateState(newState) {
      updateStateCalled = true
      updateStateCount++
    }
  }

  // Insert text "world"
  const tr = initialState.tr
  tr.insertText('world', 1)

  dispatch.call(stubView, tr)

  assert.equal(updateStateCalled, false, 'updateState should NOT be called when veto=true')
  assert.equal(updateStateCount, 0, 'updateState count should be 0')
  // View state should remain unchanged
  assert.equal(stubView.state, initialState, 'view.state should not change when vetoed')
  console.log('✓ Test 1 passed')
}

// Test case 2: onTransactions returns undefined → updateState called once with applied state
console.log('Test 2: undefined return calls updateState')
{
  const initialState = EditorState.create({ schema, doc: doc(paragraph('hello')) })
  let updateStateArgs = null
  let updateStateCount = 0

  const onTransactions = () => undefined
  const dispatch = createSourceTransactionDispatch(onTransactions)

  const stubView = {
    state: initialState,
    updateState(newState) {
      updateStateArgs = newState
      updateStateCount++
    }
  }

  // Insert text "world"
  const tr = initialState.tr
  tr.insertText('world', 1)

  dispatch.call(stubView, tr)

  assert.equal(updateStateCount, 1, 'updateState should be called once')
  assert.notEqual(updateStateArgs, null, 'updateState should receive a state')
  assert.equal(updateStateArgs.doc.textContent, 'worldhello', 'state should have updated doc')
  console.log('✓ Test 2 passed')
}

// Test case 3: selection-only transaction (no docChanged) → updateState called, onTransactions not consulted for veto
console.log('Test 3: selection-only transaction always applies')
{
  const initialState = EditorState.create({ schema, doc: doc(paragraph('hello')) })
  let updateStateCount = 0
  let onTransactionsCount = 0

  const onTransactions = () => {
    onTransactionsCount++
    return undefined
  }
  const dispatch = createSourceTransactionDispatch(onTransactions)

  const stubView = {
    state: initialState,
    updateState(newState) {
      updateStateCount++
    }
  }

  // Selection-only transaction (setSelection, no docChanged)
  const tr = initialState.tr
  const newSelection = TextSelection.create(initialState.doc, 1, 1)
  tr.setSelection(newSelection)

  dispatch.call(stubView, tr)

  // For selection-only transactions, onTransactions may or may not be called
  // but updateState should always be called
  assert.equal(updateStateCount, 1, 'updateState should be called for selection-only transaction')
  console.log('✓ Test 3 passed')
}

// Test case 4: onTransactions returns object without veto property → updateState called
console.log('Test 4: return object without veto calls updateState')
{
  const initialState = EditorState.create({ schema, doc: doc(paragraph('hello')) })
  let updateStateCount = 0

  const onTransactions = () => ({ other: 'value' })
  const dispatch = createSourceTransactionDispatch(onTransactions)

  const stubView = {
    state: initialState,
    updateState(newState) {
      updateStateCount++
    }
  }

  // Insert text
  const tr = initialState.tr
  tr.insertText('world', 1)

  dispatch.call(stubView, tr)

  assert.equal(updateStateCount, 1, 'updateState should be called when veto is falsy')
  console.log('✓ Test 4 passed')
}

console.log('\nAll tests passed!')
