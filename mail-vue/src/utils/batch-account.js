export const MIN_BATCH_COUNT = 1
export const MAX_BATCH_COUNT = 100

export function validateBatchCount(value) {
  return Number.isInteger(value) && value >= MIN_BATCH_COUNT && value <= MAX_BATCH_COUNT
}

export function getEmailPrefixLength(minLength = 0) {
  const length = Number(minLength)
  if (!Number.isInteger(length) || length < 0 || length > 64) {
    throw new RangeError('Invalid minimum email prefix length')
  }
  return Math.max(12, length)
}

function randomCharacters(alphabet, length) {
  const limit = 256 - (256 % alphabet.length)
  const bytes = new Uint8Array(length * 2)
  let result = ''
  while (result.length < length) {
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= limit) continue
      result += alphabet[byte % alphabet.length]
      if (result.length === length) break
    }
  }
  return result
}

// A letter prefix and a numeric suffix guarantee both character types in every name.
export function generateEmailPrefix(minLength = 0) {
  const length = getEmailPrefixLength(minLength)
  const digitCount = Math.max(4, Math.floor(length / 3))
  return randomCharacters('abcdefghijklmnopqrstuvwxyz', length - digitCount)
    + randomCharacters('0123456789', digitCount)
}
