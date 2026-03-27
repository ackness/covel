/** Minimal YAML frontmatter parser for world docs. */

export interface WorldMeta {
  name: string
  description: string
  genre: string
  tags: string[]
  language: string
  plugins: string[]
}

const FM_RE = /^---\n([\s\S]*?)\n---\n?/

export function parseFrontmatter(doc: string): { meta: WorldMeta; body: string } {
  const m = FM_RE.exec(doc)
  if (!m) return { meta: emptyMeta(), body: doc }
  const yaml = m[1]
  const body = doc.slice(m[0].length)
  const meta = emptyMeta()
  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (!kv) continue
    const [, key, raw] = kv
    const val = raw.replace(/^["']|["']$/g, '').trim()
    if (key === 'name') meta.name = val
    else if (key === 'description') meta.description = val
    else if (key === 'genre') meta.genre = val
    else if (key === 'language') meta.language = val
    else if (key === 'tags') meta.tags = parseArray(val)
    else if (key === 'plugins') meta.plugins = parseArray(val)
  }
  return { meta, body }
}

function parseArray(val: string): string[] {
  const m = val.match(/^\[(.*)?\]$/)
  if (!m) return val ? [val] : []
  return (m[1] || '').split(',').map(s => s.trim()).filter(Boolean)
}

export function serializeFrontmatter(meta: WorldMeta, body: string): string {
  const lines: string[] = []
  if (meta.name) lines.push(`name: "${meta.name}"`)
  if (meta.description) lines.push(`description: "${meta.description}"`)
  if (meta.genre) lines.push(`genre: ${meta.genre}`)
  if (meta.tags.length) lines.push(`tags: [${meta.tags.join(', ')}]`)
  if (meta.language) lines.push(`language: ${meta.language}`)
  if (meta.plugins.length) lines.push(`plugins: [${meta.plugins.join(', ')}]`)
  if (!lines.length) return body
  return `---\n${lines.join('\n')}\n---\n\n${body}`
}

export function emptyMeta(): WorldMeta {
  return { name: '', description: '', genre: '', tags: [], language: '', plugins: [] }
}

export function hasFrontmatter(doc: string): boolean {
  return FM_RE.test(doc)
}
