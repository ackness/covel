import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeServerEvent } from '../src/services/outputContract.js'

test('normalizeServerEvent resolves type/data/id from output envelope fallback', () => {
  const normalized = normalizeServerEvent({
    type: '',
    data: undefined,
    block_id: '',
    output: {
      id: 'out-choice-1',
      version: '1.0',
      type: 'choice',
      data: { prompt: '你要做什么？', options: ['潜行', '观察'] },
      meta: { plugin: 'guide' },
      status: 'done',
    },
  })

  assert.equal(normalized.type, 'choices')
  assert.equal(normalized.blockId, 'out-choice-1')
  assert.deepEqual(normalized.normalizedPayload, {
    prompt: '你要做什么？',
    options: ['潜行', '观察'],
  })
  assert.deepEqual(normalized.payload, {
    prompt: '你要做什么？',
    options: ['潜行', '观察'],
  })
})

test('normalizeServerEvent preserves status-bar payloads and future media types', () => {
  const notification = normalizeServerEvent({
    type: 'notification',
    output: {
      id: 'out-note',
      type: 'notification',
      data: { level: 'warning', title: '警告', content: '危险区域' },
    },
  })
  assert.equal(notification.type, 'notification')
  assert.equal(notification.blockId, 'out-note')
  assert.deepEqual(notification.normalizedPayload, {
    level: 'warning',
    title: '警告',
    content: '危险区域',
  })

  const eventPayload = {
    id: 'e1',
    session_id: 's1',
    event_type: 'quest',
    name: '调查异响',
    description: '港口异常声音',
    status: 'active',
    source: 'dm',
    visibility: 'known',
  }
  const event = normalizeServerEvent({
    type: 'event',
    data: eventPayload,
    block_id: 'out-event',
  })
  assert.equal(event.type, 'event')
  assert.equal(event.blockId, 'out-event')
  assert.deepEqual(event.normalizedPayload, eventPayload)

  const audio = normalizeServerEvent({
    type: 'audio_clip',
    output: { id: 'a1', type: 'audio_clip', data: { url: '/voice.mp3' } },
  })
  assert.equal(audio.type, 'audio_clip')
  assert.equal(audio.blockId, 'a1')

  const video = normalizeServerEvent({
    type: 'video_clip',
    output: { id: 'v1', type: 'video_clip', data: { url: '/cutscene.mp4' } },
  })
  assert.equal(video.type, 'video_clip')
  assert.equal(video.blockId, 'v1')
})
