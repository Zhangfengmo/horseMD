// Table placeholder provenance is coordinate-based, so it may be reused only
// while ProseMirror proves that every existing cell kept the same coordinate.
// Transaction mappings are the authority here: final cell text cannot
// distinguish a move from a batch edit, especially when rows/columns repeat.

const collectTableCells = (doc) => {
  const tables = []
  doc?.descendants?.((node, position) => {
    if (node?.type?.name !== 'table') return true
    const rows = []
    node.forEach((row, rowOffset) => {
      const cells = []
      row.forEach((cell, cellOffset) => {
        const name = cell?.type?.name
        if (name === 'table_cell' || name === 'table_header') {
          cells.push(position + 1 + rowOffset + 1 + cellOffset)
        }
      })
      rows.push(cells)
    })
    tables.push(rows)
    return false
  })
  return tables
}

const sameShape = (left, right) => (
  left.length === right.length &&
  left.every((rows, table) => (
    rows.length === right[table]?.length &&
    rows.every((cells, row) => cells.length === right[table]?.[row]?.length)
  ))
)

const transitionKeepsCoordinates = (transaction) => {
  if (!transaction?.docChanged) return true
  const previous = collectTableCells(transaction.before)
  const next = collectTableCells(transaction.doc)
  if (!sameShape(previous, next)) return false
  for (let table = 0; table < previous.length; table += 1) {
    for (let row = 0; row < previous[table].length; row += 1) {
      for (let column = 0; column < previous[table][row].length; column += 1) {
        const mapped = transaction.mapping.mapResult(previous[table][row][column], 1)
        if (
          mapped.deleted ||
          mapped.deletedAcross ||
          mapped.pos !== next[table][row][column]
        ) return false
      }
    }
  }
  return true
}

const transitionKeepsExistingCoordinates = (transaction) => {
  if (!transaction?.docChanged) return { ok: true, insertedTables: 0 }
  const previous = collectTableCells(transaction.before)
  const next = collectTableCells(transaction.doc)
  const insertedTables = next.length - previous.length
  if (insertedTables < 0 || insertedTables > 1) return { ok: false, insertedTables: 0 }
  const mappedTables = new Set()
  for (let table = 0; table < previous.length; table += 1) {
    let mappedTable = null
    for (let row = 0; row < previous[table].length; row += 1) {
      for (let column = 0; column < previous[table][row].length; column += 1) {
        const mapped = transaction.mapping.mapResult(previous[table][row][column], 1)
        if (mapped.deleted || mapped.deletedAcross) return { ok: false, insertedTables: 0 }
        let coordinate = null
        for (let nextTable = 0; nextTable < next.length && !coordinate; nextTable += 1) {
          if (next[nextTable]?.[row]?.[column] === mapped.pos) {
            coordinate = { table: nextTable, row, column }
          }
        }
        if (!coordinate) return { ok: false, insertedTables: 0 }
        if (mappedTable == null) mappedTable = coordinate.table
        if (mappedTable !== coordinate.table) return { ok: false, insertedTables: 0 }
      }
    }
    if (mappedTable == null || mappedTables.has(mappedTable)) {
      return { ok: false, insertedTables: 0 }
    }
    mappedTables.add(mappedTable)
    if (!sameShape([previous[table]], [next[mappedTable]])) {
      return { ok: false, insertedTables: 0 }
    }
  }
  return { ok: true, insertedTables }
}

export const tableCoordinatesRemainStable = (transactions) => (
  Array.isArray(transactions) &&
  transactions.every(transitionKeepsCoordinates)
)

export const tableInsertionKeepsExistingCoordinates = (transactions) => {
  return isTableInsertionCoordinateProofComplete(
    advanceTableInsertionCoordinateProof({
      proof: null,
      baselineProven: true,
      transactions
    })
  )
}

const invalidInsertionProof = () => Object.freeze({
  valid: false,
  insertedTables: 0
})

export const isTableInsertionCoordinateProofComplete = (proof) => (
  proof?.valid === true && proof.insertedTables === 1
)

// Milkdown's table slash command clears the query and inserts the table in two
// separate doc-changing dispatches. Accumulate those batches while proving
// that every pre-existing cell kept its logical coordinate. A zero-insertion
// batch is valid progress, exactly one inserted table completes the proof, and
// any invalid transition or second insertion poisons the whole intent.
export const advanceTableInsertionCoordinateProof = ({
  proof,
  baselineProven,
  transactions
}) => {
  if (
    baselineProven !== true ||
    !Array.isArray(transactions) ||
    (proof && (
      proof.valid !== true ||
      !Number.isInteger(proof.insertedTables) ||
      proof.insertedTables < 0 ||
      proof.insertedTables > 1
    ))
  ) return invalidInsertionProof()

  let insertedTables = proof?.insertedTables || 0
  for (const transaction of transactions) {
    const result = transitionKeepsExistingCoordinates(transaction)
    if (!result.ok) return invalidInsertionProof()
    insertedTables += result.insertedTables
    if (insertedTables > 1) return invalidInsertionProof()
  }
  return Object.freeze({ valid: true, insertedTables })
}
