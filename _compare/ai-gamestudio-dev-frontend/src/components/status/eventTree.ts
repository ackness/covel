import type { GameEvent } from '../../types'

function eventTime(event: GameEvent): number {
  const t = Date.parse(event.created_at || '')
  return Number.isFinite(t) ? t : 0
}

function sortEventsByTime(events: GameEvent[]): GameEvent[] {
  return [...events].sort((a, b) => eventTime(a) - eventTime(b))
}

function createsCycle(
  sourceById: Map<string, GameEvent>,
  parentId: string,
  childId: string,
): boolean {
  const visited = new Set<string>()
  let cursor: string | undefined = parentId
  while (cursor && !visited.has(cursor)) {
    if (cursor === childId) return true
    visited.add(cursor)
    cursor = sourceById.get(cursor)?.parent_event_id
  }
  return false
}

export function buildEventForest(events: GameEvent[]): GameEvent[] {
  const ordered = sortEventsByTime(events)
  const sourceById = new Map<string, GameEvent>()
  const nodeById = new Map<string, GameEvent>()
  for (const event of ordered) {
    sourceById.set(event.id, event)
    nodeById.set(event.id, { ...event, children: [] })
  }

  const roots: GameEvent[] = []
  for (const event of ordered) {
    const node = nodeById.get(event.id)
    if (!node) continue
    const parentId = event.parent_event_id
    if (!parentId) {
      roots.push(node)
      continue
    }
    const parentNode = nodeById.get(parentId)
    if (!parentNode || createsCycle(sourceById, parentId, event.id)) {
      roots.push(node)
      continue
    }
    parentNode.children = [...(parentNode.children || []), node]
  }

  const sortChildren = (node: GameEvent) => {
    if (!node.children || node.children.length === 0) return
    node.children = sortEventsByTime(node.children)
    for (const child of node.children) {
      sortChildren(child)
    }
  }
  for (const root of roots) {
    sortChildren(root)
  }
  return sortEventsByTime(roots)
}
