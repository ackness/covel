import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '../src/types'
import { useNotificationStore } from '../src/stores/notificationStore.js'

function makeMessageWithNotification(
  id: string,
  blockId: string,
  title: string,
): Message {
  return {
    id,
    session_id: 'session-1',
    role: 'assistant',
    content: '...',
    turn_id: 'turn-1',
    message_type: 'narration',
    created_at: '2026-02-17T00:00:00.000Z',
    blocks: [
      {
        type: 'notification',
        block_id: blockId,
        data: {
          level: 'warning',
          title,
          content: 'alert',
        },
      },
    ],
  }
}

function resetStore() {
  useNotificationStore.getState().clear()
}

test('notification store hydrates from messages and avoids duplicates by block_id', () => {
  resetStore()
  const store = useNotificationStore.getState()
  store.resetForSession('session-1')
  store.hydrateFromMessages('session-1', [
    makeMessageWithNotification('m1', 'b1', 'A'),
  ])
  store.hydrateFromMessages('session-1', [
    makeMessageWithNotification('m2', 'b1', 'A-duplicate'),
  ])

  const notifications = useNotificationStore.getState().notifications
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].id, 'b1')
  assert.equal(notifications[0].unread, false)
})

test('notification store records live notifications as unread and markAllRead clears unread', () => {
  resetStore()
  const store = useNotificationStore.getState()
  store.resetForSession('session-1')
  store.addLiveNotification(
    'session-1',
    {
      level: 'warning',
      title: 'Corruption',
      content: 'value increased',
    },
    {
      id: 'live-1',
      turnId: 'turn-1',
      createdAt: '2026-02-17T00:00:01.000Z',
    },
  )

  let notifications = useNotificationStore.getState().notifications
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].unread, true)

  store.markAllRead()
  notifications = useNotificationStore.getState().notifications
  assert.equal(notifications[0].unread, false)
})

test('notification store ignores live notifications from non-active session', () => {
  resetStore()
  const store = useNotificationStore.getState()
  store.resetForSession('session-1')
  store.addLiveNotification('session-2', {
    level: 'warning',
    title: 'Wrong Session',
    content: 'should be ignored',
  })
  const notifications = useNotificationStore.getState().notifications
  assert.equal(notifications.length, 0)
})

test('notification store hydrates when type/data are carried in output envelope', () => {
  resetStore()
  const store = useNotificationStore.getState()
  store.resetForSession('session-1')
  store.hydrateFromMessages('session-1', [
    {
      id: 'm-output',
      session_id: 'session-1',
      role: 'assistant',
      content: '...',
      turn_id: 'turn-2',
      message_type: 'narration',
      created_at: '2026-02-17T00:00:02.000Z',
      blocks: [
        {
          type: '',
          data: undefined,
          output: {
            id: 'out-notice-1',
            type: 'notification',
            data: {
              level: 'success',
              title: '同步成功',
              content: '状态栏已更新',
            },
          },
        },
      ],
    },
  ])

  const notifications = useNotificationStore.getState().notifications
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].id, 'out-notice-1')
  assert.equal(notifications[0].level, 'success')
  assert.equal(notifications[0].title, '同步成功')
})
