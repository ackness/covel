export interface OutputEnvelope {
  id?: string
  version?: string
  type?: string
  data?: unknown
  meta?: Record<string, unknown>
  status?: string
}

export interface BlockLike {
  type?: unknown
  data?: unknown
  block_id?: unknown
  output?: unknown
}

export interface NormalizedBlock {
  type: string
  data: unknown
  block_id?: string
  output?: OutputEnvelope
}

export interface NormalizedServerEvent {
  type: string
  output?: OutputEnvelope
  blockId: string
  rawPayload: unknown
  normalizedPayload: unknown
  payload: unknown
}

const TYPE_ALIASES: Record<string, string> = {
  choice: 'choices',
  text_input: 'form',
  textbox: 'form',
  text_box: 'form',
}

function cleanType(raw: unknown): string {
  let value = String(raw || '').trim()
  if (value.toLowerCase().startsWith('json:')) {
    value = value.slice(5)
  }
  return value.trim()
}

function aliasType(value: string): string {
  if (!value) return ''
  const lower = value.toLowerCase()
  return TYPE_ALIASES[lower] || lower
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeOutputEnvelope(raw: unknown): OutputEnvelope | undefined {
  if (!isRecord(raw)) return undefined
  const out: OutputEnvelope = {}
  if (typeof raw.id === 'string' && raw.id.trim()) out.id = raw.id.trim()
  if (typeof raw.version === 'string' && raw.version.trim()) out.version = raw.version.trim()
  const t = aliasType(cleanType(raw.type))
  if (t) out.type = t
  if ('data' in raw) out.data = raw.data
  if (isRecord(raw.meta)) out.meta = raw.meta as Record<string, unknown>
  if (typeof raw.status === 'string' && raw.status.trim()) out.status = raw.status.trim()
  return Object.keys(out).length > 0 ? out : undefined
}

export function resolveBlockType(rawType: unknown, output?: OutputEnvelope): string {
  const direct = aliasType(cleanType(rawType))
  if (direct) return direct
  const fromOutput = aliasType(cleanType(output?.type))
  return fromOutput || ''
}

export function resolveBlockData(rawData: unknown, output?: OutputEnvelope): unknown {
  if (rawData !== undefined) return rawData
  return output?.data
}

export function resolveBlockId(
  rawBlockId: unknown,
  output?: OutputEnvelope,
  fallback = '',
): string {
  const direct = String(rawBlockId || '').trim()
  if (direct) return direct
  const fromOutput = String(output?.id || '').trim()
  if (fromOutput) return fromOutput
  return fallback
}

export function enrichPayloadWithOutput(
  rawData: unknown,
  output?: OutputEnvelope,
): unknown {
  if (!output) return rawData
  if (!isRecord(rawData)) return rawData
  return { ...rawData, _output: output }
}

export function normalizeBlockLike(
  raw: BlockLike,
  fallbackId = '',
): NormalizedBlock | null {
  const output = normalizeOutputEnvelope(raw.output)
  const type = resolveBlockType(raw.type, output)
  if (!type) return null
  const data = resolveBlockData(raw.data, output) ?? {}
  const blockId = resolveBlockId(raw.block_id, output, fallbackId)
  return {
    type,
    data,
    ...(blockId ? { block_id: blockId } : {}),
    ...(output ? { output } : {}),
  }
}

export function normalizeServerEvent(data: Record<string, unknown>): NormalizedServerEvent {
  const output = normalizeOutputEnvelope(data.output)
  const type = resolveBlockType(data.type, output)
  const blockId = resolveBlockId(data.block_id, output)
  const rawPayload = data.data
  const normalizedPayload = resolveBlockData(rawPayload, output)
  return { type, output, blockId, rawPayload, normalizedPayload, payload: normalizedPayload }
}
