import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  generateEmailPrefix,
  getEmailPrefixLength,
  validateBatchCount
} from '../src/utils/batch-account.js'

test('batch quantity accepts only whole numbers from 1 through 100', () => {
  for (let count = 1; count <= 100; count++) {
    assert.equal(validateBatchCount(count), true, `valid quantity ${count}`)
  }
  for (const count of [0, -1, 101, 1.5, NaN, Infinity, -Infinity, undefined, null, '', '10', true, [], {}]) {
    assert.equal(validateBatchCount(count), false, `invalid quantity ${String(count)}`)
  }
})

test('prefix length respects configured minimums and the email local-part limit', () => {
  assert.equal(getEmailPrefixLength(), 12)
  assert.equal(getEmailPrefixLength(0), 12)
  assert.equal(getEmailPrefixLength(3), 12)
  for (const minimum of [12, 13, 24, 63, 64]) {
    assert.equal(getEmailPrefixLength(minimum), minimum)
  }
  assert.equal(getEmailPrefixLength('24'), 24, 'numeric settings values remain compatible')
})

test('invalid prefix settings fail explicitly instead of generating an invalid address', () => {
  for (const minimum of [-1, 1.5, 65, 100, NaN, Infinity, -Infinity, 'invalid']) {
    assert.throws(() => getEmailPrefixLength(minimum), RangeError)
    assert.throws(() => generateEmailPrefix(minimum), RangeError)
  }
})

test('generated prefixes always contain lowercase letters followed by digits at supported lengths', () => {
  for (const minimum of [0, 12, 13, 24, 64]) {
    for (let sample = 0; sample < 128; sample++) {
      const prefix = generateEmailPrefix(minimum)
      assert.match(prefix, /^[a-z]+[0-9]+$/)
      assert.equal(prefix.length, Math.max(12, minimum))
    }
  }
})

test('both character types are guaranteed even when the random source returns only zeros', context => {
  context.mock.method(globalThis.crypto, 'getRandomValues', array => {
    array.fill(0)
    return array
  })
  assert.match(generateEmailPrefix(), /^a+0+$/)
  assert.match(generateEmailPrefix(64), /^a+0+$/)
})
