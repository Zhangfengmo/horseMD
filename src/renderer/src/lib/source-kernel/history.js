// Undo/Redo 记录源码事务及其逆事务；ProseMirror 历史不再是持久化来源。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// 设计要点：
// - 每个 undo 组保存原始事务（forward）与 applySourceTransaction 产出的逆事务
//   （inverse，已经是 multi-edit-aware、逐字节精确的独立可用事务）。
// - 组内只有一步时，直接复用 forward/inverse（重设 baseRevision），零推导、零风险。
// - 连续 insert-text 单编辑合并成组时，用 combineChain() 把整条链推导成
//   "组前文档坐标系下的一个等价编辑"：因为合并规则保证下一步的 from 恰好落在
//   上一步插入文本的末尾（相邻、不重叠），链上第 i 步消费的字符数
//   (to - from) 逐项累加即可得到组合编辑消费的总长度，插入串直接拼接。
//   这个不变量对 undo 分支同样成立——把每一步 inverse 的 insert（也就是被
//   替换掉的原文）按正向顺序拼接，就是"组前文本"里被组合编辑吃掉的那一段。
// - doc.revision 在 undo/redo 时同样单调递增（不会随撤销回退），所以“历史是否与
//   文档同步”不能靠比较某个历史时刻的 revision 快照，而要靠一个随本对象
//   record/undo/redo 调用链滚动前进的指针 lastKnownRevision：只要调用者一直用
//   本对象返回的结果去驱动下一次 apply，doc.revision 就应该等于我们上次留下的
//   值；一旦不等，说明外部动作打断了这条线性链，拒绝返回可能已经过期的事务。

const firstEdit = (txnLike) => {
  if (Array.isArray(txnLike.edits)) return txnLike.edits[0]
  return { from: txnLike.from, to: txnLike.to, insert: txnLike.insert }
}

// 单编辑、intent 为 'insert-text' 的事务才可能参与合并；其余一律返回 null。
const asCoalescableEdit = (txn) => {
  if (txn.intent !== 'insert-text') return null
  if (Array.isArray(txn.edits) && txn.edits.length !== 1) return null
  return firstEdit(txn)
}

// 把一条“依次应用”的单编辑链，合并成组前文档坐标系下的一个等价编辑。
// entries: [{ from, to, insert }, ...]，每一项的 from/to 是它被应用时（即上一步
// 应用之后）所在文档的坐标——合并规则保证 entries[i].from === 组的 tailOffset，
// 也就是紧接着上一步插入文本的末尾，因此整条链在“组前文档”里天然是连续的一段。
const combineChain = (entries) => {
  const from = entries[0].from
  let consumed = 0
  let insert = ''
  for (const entry of entries) {
    consumed += entry.to - entry.from
    insert += String(entry.insert ?? '')
  }
  return { from, to: from + consumed, insert }
}

const buildForwardTransaction = (group, revision) => {
  if (group.steps.length === 1) {
    return { ...group.steps[0].forward, baseRevision: revision }
  }
  const chain = combineChain(group.steps.map((step) => step.forwardEdit))
  return {
    baseRevision: revision,
    from: chain.from,
    to: chain.to,
    insert: chain.insert,
    intent: 'insert-text',
    selection: null
  }
}

const buildInverseTransaction = (group, revision) => {
  if (group.steps.length === 1) {
    return { ...group.steps[0].inverse, baseRevision: revision }
  }
  // 组合正向编辑得到插入串落点（from 在“组前”和“组后”坐标系中数值相同，
  // 因为它左侧的内容完全未被这一组触及）；再把每一步 inverse 保存的原文
  // 按正向顺序拼接，即为组合编辑要恢复的原始内容。
  const forwardChain = combineChain(group.steps.map((step) => step.forwardEdit))
  const insert = group.steps.map((step) => step.inverseEdit.insert).join('')
  return {
    baseRevision: revision,
    from: forwardChain.from,
    to: forwardChain.from + forwardChain.insert.length,
    insert,
    intent: 'history-invert',
    selection: null
  }
}

export function createSourceHistory() {
  const undoStack = [] // { steps: [{ forward, inverse, forwardEdit, inverseEdit }], tailOffset, coalescable }
  const redoStack = []
  let coalescing = true
  let lastKnownRevision = null
  // Undo of the LAST successful `pop`, armed by `pop` and consumed by
  // `rollbackReplay` (re-review finding, 2026-08-17). `pop` has three side
  // effects — it moves a group between the stacks, advances
  // `lastKnownRevision`, and clears `coalescing` — and they all happen BEFORE
  // the caller has had a chance to apply the transaction it returned. If that
  // apply then fails, the pointer is one revision ahead of the document and
  // every later undo AND redo returns null (`history-frozen`): a single
  // refusal froze the whole stack, not just the one operation. Restoring all
  // three makes a failed replay a true no-op.
  let pendingRollback = null

  const record = (applyResult, txn) => {
    pendingRollback = null
    redoStack.length = 0
    const edit = asCoalescableEdit(txn)
    const step = {
      forward: txn,
      inverse: applyResult.inverse,
      forwardEdit: edit || firstEdit(txn),
      inverseEdit: firstEdit(applyResult.inverse)
    }
    const last = undoStack[undoStack.length - 1]
    if (edit && coalescing && last && last.coalescable && last.tailOffset === edit.from) {
      last.steps.push(step)
      last.tailOffset = edit.from + String(edit.insert ?? '').length
    } else {
      undoStack.push({
        steps: [step],
        tailOffset: edit ? edit.from + String(edit.insert ?? '').length : null,
        coalescable: !!edit
      })
    }
    coalescing = !!edit
    lastKnownRevision = applyResult.doc.revision
  }

  const pop = (fromStack, toStack, doc, build) => {
    if (lastKnownRevision !== null && doc.revision !== lastKnownRevision) return null
    const group = fromStack[fromStack.length - 1]
    if (!group) return null
    const previousRevision = lastKnownRevision
    const previousCoalescing = coalescing
    // The revision the caller is holding RIGHT NOW, i.e. before it applies
    // what we are about to return. `rollbackReplay` requires the caller's
    // document to still be at this revision — see its own comment.
    const revisionBeforeReplay = doc.revision
    fromStack.pop()
    toStack.push(group)
    const transaction = build(group, doc.revision)
    lastKnownRevision = doc.revision + 1
    // Undo/redo is itself a coalescing boundary: whatever gets typed next must
    // start a fresh group, even if its `from` numerically lands on the tail of
    // the group we just replayed. Without this, a same-position commit right
    // after an undo/redo silently re-merges into a group that was already
    // popped off (and re-pushed onto) the opposite stack, corrupting both.
    coalescing = false
    pendingRollback = (currentDoc) => {
      // Guarded on THREE things, because this is a public method on the
      // history object and its safety must not rest on caller discipline
      // (re-review round 2, finding C1 — `pop` arms unconditionally, so a
      // late call after a SUCCESSFUL replay would push the group back onto a
      // stack that has already moved past it and re-create exactly the frozen
      // stack this whole round removed):
      //  1. the caller's document must still be at the revision `pop` was
      //     built against — a successful apply advances it, so this alone
      //     makes "roll back a replay that actually landed" impossible;
      //  2. this group must still be the one `pop` moved;
      //  3. `record` (any successful commit) disarms the whole thing.
      if (!currentDoc || currentDoc.revision !== revisionBeforeReplay) return false
      if (toStack[toStack.length - 1] !== group) return false
      toStack.pop()
      fromStack.push(group)
      lastKnownRevision = previousRevision
      coalescing = previousCoalescing
      return true
    }
    return transaction
  }

  return {
    record,
    undo: (doc) => pop(undoStack, redoStack, doc, buildInverseTransaction),
    redo: (doc) => pop(redoStack, undoStack, doc, buildForwardTransaction),
    // Put the last undo/redo back exactly as it was, for a caller whose
    // apply of the returned transaction FAILED. `doc` is the caller's CURRENT
    // document: it must still be at the revision the replay was built
    // against, which is what proves the apply did not land (see
    // `pendingRollback`). Returns true when something was actually restored.
    rollbackReplay: (doc) => {
      const rollback = pendingRollback
      pendingRollback = null
      return rollback ? rollback(doc) : false
    },
    breakGroup: () => {
      coalescing = false
    },
    depth: () => undoStack.length
  }
}
