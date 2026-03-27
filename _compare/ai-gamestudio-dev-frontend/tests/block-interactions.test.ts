import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCharacterSheetInteractionState,
  buildChoicesInteractionState,
  buildFormInitialValues,
  buildGuideInteractionState,
} from '../src/components/game/blockInteractionState.js'

test('choices interaction restores submitted choices and selected indexes', () => {
  const result = buildChoicesInteractionState(
    ['潜行', '冲锋'],
    {
      submitted: true,
      chosen: ['冲锋'],
    },
  )

  assert.equal(result.submitted, true)
  assert.deepEqual(result.chosen, ['冲锋'])
  assert.deepEqual(result.selectedIndexes, [1])
})

test('form interaction restores persisted form values', () => {
  const result = buildFormInitialValues(
    [
      { name: 'codename', type: 'text' },
      { name: 'approved', type: 'checkbox' },
    ],
    {
      formValues: {
        codename: 'Alpha',
        approved: true,
      },
    },
  )

  assert.equal(result.codename, 'Alpha')
  assert.equal(result.approved, true)
})

test('guide interaction restores submitted text and collapsed/custom states', () => {
  const submitted = buildGuideInteractionState({
    submitted: true,
    chosen: '检查地面脚印',
  })
  assert.equal(submitted.submitted, true)
  assert.equal(submitted.chosenText, '检查地面脚印')

  const draft = buildGuideInteractionState({
    collapsed: true,
    customInput: '先观察门口',
  })
  assert.equal(draft.collapsed, true)
  assert.equal(draft.customInput, '先观察门口')
})

test('character sheet interaction restores edited snapshot and lock semantics', () => {
  const result = buildCharacterSheetInteractionState(
    '旧名字',
    { hp: 30, mp: 9 },
    {
      confirmed: true,
      editedName: '艾琳',
      editedAttrs: { hp: 42, mp: 11 },
    },
  )
  assert.equal(result.confirmed, true)
  assert.equal(result.editedName, '艾琳')
  assert.deepEqual(result.editedAttrs, { hp: 42, mp: 11 })

  const lockedResult = buildCharacterSheetInteractionState(
    '旧名字',
    { hp: 30, mp: 9 },
    undefined,
    true,
  )
  assert.equal(lockedResult.confirmed, true)
})
