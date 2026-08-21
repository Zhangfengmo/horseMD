const W = process.cwd()
process.chdir(W)
const { Schema } = await import('@milkdown/prose/model')
const { buildProjectionMap } = await import(process.cwd() + '/src/renderer/src/components/editor-kernel-projection-map.js')

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    blockquote: { content: 'block+', group: 'block' },
    code_block: { content: 'text*', group: 'block', code: true, attrs: { language: { default: '' } } },
    text: { group: 'inline' }
  }
})
const doc = schema.node('doc', null, [
  schema.node('blockquote', null, [schema.node('code_block', { language: 'javascript' })]),
  schema.node('paragraph')
])
const text = '> ```javascript\n> \n> ```\n'
const map = buildProjectionMap(text, doc)
console.log('map:', !!map)
if (map) {
  console.log('pairs:', map.blockPairs.map((p) => ({ type: p.pmNode.type.name, pmPos: p.pmPos, hasCharMap: !!p.charMap, virtual: !!p.virtual })))
  console.log('rawToPmPos(18):', JSON.stringify(map.rawToPmPos(18)))
  console.log('rawToPmPos(16):', JSON.stringify(map.rawToPmPos(16)))
}
