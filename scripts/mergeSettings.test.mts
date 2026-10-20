import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  sanitizeMergeSettings,
  validAdapterName,
  validWeight
} from '../src/shared/mergeSettings.ts'

test('defaults: merging off, autopause on, IPv6 auto, nothing excluded or weighted', () => {
  assert.deepEqual(sanitizeMergeSettings(undefined), {
    enabled: false,
    ipv6: 'auto',
    autoPause: true,
    excluded: [],
    weights: {}
  })
  assert.deepEqual(sanitizeMergeSettings('junk'), sanitizeMergeSettings({}))
})

test('every field is checked on its own', () => {
  const settings = sanitizeMergeSettings({
    enabled: 'yes',
    ipv6: 'sometimes',
    autoPause: 0,
    excluded: ['en7', 42, '', 'en7', 'bad\nname'],
    weights: { en0: 3, en7: 0.01, en9: 'auto', 'x\u0000': 1, en1: 100 }
  })
  assert.deepEqual(settings, {
    enabled: false,
    ipv6: 'auto',
    autoPause: true,
    excluded: ['en7'],
    weights: { en0: 3, en1: 100 }
  })
})

test('valid values pass through', () => {
  assert.deepEqual(
    sanitizeMergeSettings({
      enabled: true,
      ipv6: 'off',
      autoPause: false,
      excluded: ['Wi-Fi'],
      weights: { 'Ethernet 3': 0.05 }
    }),
    {
      enabled: true,
      ipv6: 'off',
      autoPause: false,
      excluded: ['Wi-Fi'],
      weights: { 'Ethernet 3': 0.05 }
    }
  )
})

test('adapter names are 1 to 256 bytes without control characters', () => {
  assert.equal(validAdapterName('en0'), true)
  assert.equal(validAdapterName('é'.repeat(128)), true)
  assert.equal(validAdapterName('é'.repeat(129)), false)
  assert.equal(validAdapterName(''), false)
  assert.equal(validAdapterName('tab\there'), false)
  assert.equal(validAdapterName('del\u007f'), false)
  assert.equal(validAdapterName(7), false)
})

test('weights are finite numbers from 0.05 to 100', () => {
  assert.equal(validWeight(0.05), true)
  assert.equal(validWeight(100), true)
  assert.equal(validWeight(0.049), false)
  assert.equal(validWeight(100.1), false)
  assert.equal(validWeight(Number.NaN), false)
  assert.equal(validWeight('3'), false)
})
