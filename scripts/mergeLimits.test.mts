import assert from 'node:assert/strict'
import { test } from 'node:test'
import { limitExcludeReason, limitExclusions } from '../src/shared/mergeLimits.ts'

const off = {
  metered: false,
  excludeWhenLimited: false,
  used: 0
}

test('the option is off unless it is turned on', () => {
  assert.equal(limitExcludeReason(off), null)
  assert.equal(limitExcludeReason({ ...off, metered: true, dataLimit: 10, used: 10 }), null)
  assert.equal(limitExcludeReason({ ...off, excludeWhenLimited: true }), null)
})

test('metered excludes once the option is on, before a data cap is reached', () => {
  assert.equal(
    limitExcludeReason({
      metered: true,
      excludeWhenLimited: true,
      dataLimit: 100,
      used: 40
    }),
    'metered'
  )
  assert.equal(limitExcludeReason({ metered: true, excludeWhenLimited: true, used: 0 }), 'metered')
})

test('a reached data cap excludes when the network is not metered', () => {
  assert.equal(
    limitExcludeReason({
      metered: false,
      excludeWhenLimited: true,
      dataLimit: 100,
      used: 100
    }),
    'cap'
  )
  assert.equal(
    limitExcludeReason({
      metered: false,
      excludeWhenLimited: true,
      dataLimit: 100,
      used: 99
    }),
    null
  )
  assert.equal(limitExcludeReason({ metered: false, excludeWhenLimited: true, used: 100 }), null)
})

test('several networks are decided on their own', () => {
  assert.deepEqual(
    limitExclusions({
      wifi: { metered: false, excludeWhenLimited: true, dataLimit: 5, used: 5 },
      phone: { metered: true, excludeWhenLimited: true, used: 0 },
      lan: { metered: true, excludeWhenLimited: false, dataLimit: 1, used: 9 }
    }),
    { wifi: 'cap', phone: 'metered' }
  )
})
