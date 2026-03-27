import assert from 'node:assert/strict'
import test from 'node:test'
import {
  enrichPayloadWithOutput,
  normalizeBlockLike,
  normalizeOutputEnvelope,
  resolveBlockData,
  resolveBlockId,
  resolveBlockType,
} from '../src/services/outputContract.js'

test('resolveBlockType supports aliases and output fallback', () => {
  const out = normalizeOutputEnvelope({ type: 'json:choice' })
  assert.equal(resolveBlockType(undefined, out), 'choices')
  assert.equal(resolveBlockType('text_input', undefined), 'form')
  assert.equal(resolveBlockType('video_clip', undefined), 'video_clip')
})

test('resolveBlockData and resolveBlockId can read from output envelope', () => {
  const out = normalizeOutputEnvelope({
    id: 'out-1',
    type: 'notification',
    data: { level: 'info', title: 'T', content: 'C' },
  })
  assert.deepEqual(resolveBlockData(undefined, out), {
    level: 'info',
    title: 'T',
    content: 'C',
  })
  assert.equal(resolveBlockId(undefined, out), 'out-1')
})

test('normalizeBlockLike keeps event/status types and upgrades aliases', () => {
  const choice = normalizeBlockLike({
    output: {
      id: 'b-choice',
      type: 'choice',
      data: { prompt: '去哪？', options: ['A', 'B'] },
    },
  })
  assert.equal(choice?.type, 'choices')
  assert.equal(choice?.block_id, 'b-choice')
  assert.deepEqual(choice?.data, { prompt: '去哪？', options: ['A', 'B'] })

  const form = normalizeBlockLike({
    type: 'text_input',
    data: { id: 'f1', title: '输入', fields: [] },
  })
  assert.equal(form?.type, 'form')

  const event = normalizeBlockLike({
    type: 'event',
    data: { event_id: 'e1', action: 'create' },
  })
  assert.equal(event?.type, 'event')

  const state = normalizeBlockLike({
    output: {
      id: 'st-1',
      type: 'state_update',
      data: {
        characters: [{ id: 'c1', name: '艾琳' }],
        world: { weather: 'fog' },
      },
    },
  })
  assert.equal(state?.type, 'state_update')
  assert.deepEqual(state?.data, {
    characters: [{ id: 'c1', name: '艾琳' }],
    world: { weather: 'fog' },
  })

  const audio = normalizeBlockLike({
    output: { id: 'a1', type: 'audio_clip', data: { url: '/a.mp3' } },
  })
  assert.equal(audio?.type, 'audio_clip')

  const video = normalizeBlockLike({
    output: { id: 'v1', type: 'video_clip', data: { url: '/v.mp4' } },
  })
  assert.equal(video?.type, 'video_clip')
})

test('enrichPayloadWithOutput only annotates object payloads', () => {
  const output = normalizeOutputEnvelope({ id: 'out-x', type: 'notification' })
  assert.deepEqual(
    enrichPayloadWithOutput({ title: 'hi' }, output),
    { title: 'hi', _output: output },
  )
  assert.equal(enrichPayloadWithOutput('plain', output), 'plain')
})
