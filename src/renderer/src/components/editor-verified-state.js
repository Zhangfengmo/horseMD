const DETERMINISTIC_FAILURES = new Set([
  'unowned-source-change',
  'semantic-loss',
  'parser-error'
])

const failureType = (result) => (
  DETERMINISTIC_FAILURES.has(result?.type)
    ? result.type
    : 'unowned-source-change'
)

export function createVerifiedEditorState({
  source,
  canonical,
  expectedDoc,
  verify,
  ownsProposal,
  publish
}) {
  let nextRevision = 0
  let latestCapture = 0
  let settledFailure = null
  let state = {
    revision: 0,
    source: String(source ?? ''),
    canonical: String(canonical ?? ''),
    expectedDoc,
    pending: null,
    status: 'committed',
    failureType: null
  }

  const snapshot = () => ({ ...state })
  const diagnostics = () => ({
    revision: latestCapture,
    committedRevision: state.revision,
    status: state.status,
    failureType: state.failureType
  })

  const capture = (doc) => {
    const captured = Object.freeze({
      revision: ++nextRevision,
      expectedDoc: doc
    })
    latestCapture = captured.revision
    settledFailure = null
    state = {
      ...state,
      pending: captured,
      status: 'pending',
      failureType: null
    }
    return captured
  }

  const propose = (captured, proposal = {}) => {
    if (!captured || captured.revision !== latestCapture) {
      return { ok: false, type: 'pending' }
    }
    if (settledFailure?.revision === captured.revision) {
      return { ok: false, type: settledFailure.type }
    }
    try {
      if (typeof ownsProposal === 'function' && !ownsProposal({ captured, proposal })) {
        return { ok: false, type: 'pending' }
      }
    } catch {
      return { ok: false, type: 'pending' }
    }
    if (typeof verify !== 'function') {
      return { ok: false, type: 'parser-error' }
    }
    try {
      const result = verify({
        candidates: proposal.candidates,
        expectedDoc: captured.expectedDoc,
        canonical: proposal.canonical
      })
      if (!result?.ok) return { ...result, ok: false, type: failureType(result) }
      return {
        ...result,
        ok: true,
        type: 'committed',
        canonical: String(proposal.canonical ?? '')
      }
    } catch (error) {
      return { ok: false, type: 'parser-error', error }
    }
  }

  const commit = (captured, result, { shouldPublish = true } = {}) => {
    if (!captured || captured.revision !== latestCapture) {
      return { ok: false, type: 'pending' }
    }
    if (settledFailure?.revision === captured.revision) {
      return { ok: false, type: settledFailure.type }
    }
    if (result?.type === 'pending') {
      return { ok: false, type: 'pending' }
    }
    if (!result?.ok || typeof result.markdown !== 'string') {
      const type = failureType(result)
      settledFailure = { revision: captured.revision, type }
      state = {
        ...state,
        pending: null,
        status: type,
        failureType: type
      }
      return { ok: false, type }
    }
    state = {
      revision: captured.revision,
      source: result.markdown,
      canonical: String(result.canonical ?? ''),
      expectedDoc: captured.expectedDoc,
      pending: null,
      status: 'committed',
      failureType: null
    }
    settledFailure = null
    if (shouldPublish) {
      try {
        publish?.(state.source)
      } catch {
        // Publication is downstream of the durability boundary. A consumer
        // failure must not roll a verified editor revision back into pending.
      }
    }
    return { ok: true, type: 'committed', markdown: state.source }
  }

  const reset = (next = {}) => {
    latestCapture = ++nextRevision
    settledFailure = null
    state = {
      revision: latestCapture,
      source: String(next.source ?? ''),
      canonical: String(next.canonical ?? ''),
      expectedDoc: next.expectedDoc,
      pending: null,
      status: 'committed',
      failureType: null
    }
    return snapshot()
  }

  return { capture, propose, commit, reset, snapshot, diagnostics }
}
