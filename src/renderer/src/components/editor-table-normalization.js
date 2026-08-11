export function normalizeRaggedGfmTables(tree) {
  const visit = (node) => {
    if (!node || typeof node !== 'object') return

    if (node.type === 'table' && Array.isArray(node.children)) {
      const [header, ...body] = node.children
      const headerCells = header?.type === 'tableRow' && Array.isArray(header.children)
        ? header.children
        : null
      if (headerCells?.every((cell) => cell?.type === 'tableCell')) {
        const width = headerCells.length
        for (const row of body) {
          if (row?.type !== 'tableRow' || !Array.isArray(row.children)) continue
          while (row.children.length < width) {
            row.children.push({ type: 'tableCell', children: [] })
          }
        }
      }
    }

    if (Array.isArray(node.children)) node.children.forEach(visit)
  }

  visit(tree)
  return tree
}

export function remarkNormalizeRaggedGfmTables() {
  return (tree) => normalizeRaggedGfmTables(tree)
}
