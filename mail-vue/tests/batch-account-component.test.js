import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import vm from 'node:vm'
import * as utilities from '../src/utils/batch-account.js'

const component = readFileSync(new URL('../src/components/BatchAccountDialog.vue', import.meta.url), 'utf8')
const script = component.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*$/gm, '')

// Execute the component's actual plain-JavaScript script with only its platform
// dependencies substituted. This exercises request and CAPTCHA transitions
// without duplicating the batch algorithm or requiring a browser/test framework.
function mountScript(accountAdd, settingsOverrides = {}) {
  const events = [], widgets = [], messages = [], clipboard = [], downloads = [], timers = [], revoked = []
  const settings = {
    domainList: ['@example.com'],
    settings: {minEmailPrefix: 3, addEmailVerify: 1, addVerifyOpen: false, siteKey: 'test', ...settingsOverrides}
  }
  const context = vm.createContext({
    ...utilities,
    console,
    Blob,
    ref: value => ({value}),
    computed: value => Object.defineProperty({}, 'value', typeof value === 'function' ? {get: value} : value),
    watch: (get, callback, options) => { if (options?.immediate) callback(get()) },
    nextTick: async () => { vm.runInContext('captchaContainer.value = {}', context) },
    onBeforeUnmount: () => {},
    defineProps: () => ({modelValue: true}),
    defineEmits: () => (...args) => events.push(args),
    useI18n: () => ({t: key => key}),
    useSettingStore: () => settings,
    accountAdd,
    window: {
      turnstile: {
        remove: () => {},
        render: (container, callbacks) => { widgets.push(callbacks); return widgets.length }
      }
    },
    reloadTurnstileScript: async () => { throw new Error('Unexpected SDK reload') },
    ElMessage: {
      error: message => messages.push({type: 'error', message}),
      success: message => messages.push({type: 'success', message})
    },
    navigator: {clipboard: {writeText: async text => { clipboard.push(text) }}},
    URL: {
      createObjectURL: blob => { downloads.push({blob}); return 'blob:test-download' },
      revokeObjectURL: url => revoked.push(url)
    },
    document: {
      body: {appendChild: () => {}},
      createElement: tag => {
        assert.equal(tag, 'a')
        const link = {click() { this.clicked = true }, remove() { this.removed = true }}
        downloads.at(-1).link = link
        return link
      }
    },
    setTimeout: callback => { timers.push(callback) }
  })
  vm.runInContext(script + '\nglobalThis.exposed = {quantity, results, status, verifyToken, startBatch, runBatch, stopBatch, copyResults, downloadResults}', context)
  return {state: context.exposed, events, widgets, messages, clipboard, downloads, timers, revoked}
}

test('batch requests run sequentially and display addresses confirmed by the server', async () => {
  let concurrent = 0, maximumConcurrent = 0, calls = 0
  const {state} = mountScript(async () => {
    calls++
    concurrent++
    maximumConcurrent = Math.max(maximumConcurrent, concurrent)
    await Promise.resolve()
    concurrent--
    return {accountId: calls, email: `saved${calls}@example.com`, addVerifyOpen: false}
  })
  state.quantity.value = 3
  await state.startBatch()
  assert.equal(maximumConcurrent, 1)
  assert.equal(calls, 3)
  assert.equal(state.status.value, 'done')
  assert.deepEqual(Array.from(state.results.value), ['saved1@example.com', 'saved2@example.com', 'saved3@example.com'])
})

test('invalid quantity is rejected before any creation request', async () => {
  let calls = 0
  const {state} = mountScript(async () => { calls++ })
  state.quantity.value = 101
  await state.startBatch()
  assert.equal(calls, 0)
  assert.equal(state.status.value, 'idle')
})

for (const error of [{code: 403, message: 'Quota reached'}, new Error('Network Error')]) {
  test(`${error.message} preserves partial results and never automatically retries`, async () => {
    let calls = 0
    const {state} = mountScript(async () => {
      calls++
      if (calls > 1) throw error
      return {accountId: 1, email: 'saved@example.com'}
    })
    state.quantity.value = 3
    await state.startBatch()
    await state.runBatch()
    assert.equal(calls, 2)
    assert.equal(state.status.value, 'error')
    assert.deepEqual(Array.from(state.results.value), ['saved@example.com'])
  })
}

test('an uncertain first request emits a list refresh even with no confirmed successes', async () => {
  const {state, events} = mountScript(async () => { throw new Error('Network Error') })
  state.quantity.value = 2
  await state.startBatch()
  assert.equal(state.results.value.length, 0)
  const settled = events.filter(([name]) => name === 'settled')
  assert.equal(settled.length, 1)
  assert.equal(settled[0][1].status, 'error')
})

test('a CAPTCHA rejection waits for verification and resumes the same candidate', async () => {
  const calls = []
  const {state, widgets} = mountScript(async (email, token) => {
    calls.push({email, token})
    if (calls.length === 1) throw {code: 400, message: 'Verification required'}
    return {accountId: calls.length, email, addVerifyOpen: false}
  })
  state.quantity.value = 2
  await state.startBatch()
  assert.equal(calls.length, 1)
  assert.equal(state.status.value, 'verifying')
  widgets.at(-1).callback('fresh-token')
  await state.runBatch()
  assert.equal(state.status.value, 'done')
  assert.equal(calls.length, 3)
  assert.equal(calls[0].email, calls[1].email)
  assert.equal(calls[1].token, 'fresh-token')
  assert.equal(calls[2].token, '')
})

test('always-on CAPTCHA requires a fresh token for every successful mailbox', async () => {
  const tokens = []
  const {state, widgets} = mountScript(async (email, token) => {
    tokens.push(token)
    return {accountId: tokens.length, email, addVerifyOpen: true}
  }, {addEmailVerify: 0})
  state.quantity.value = 2
  await state.startBatch()
  assert.equal(tokens.length, 0)
  widgets.at(-1).callback('first-token')
  await state.runBatch()
  assert.equal(state.status.value, 'verifying')
  assert.equal(tokens.length, 1)
  widgets.at(-1).callback('second-token')
  await state.runBatch()
  assert.equal(state.status.value, 'done')
  assert.deepEqual(tokens, ['first-token', 'second-token'])
})

test('COUNT CAPTCHA pauses when the server reports that its threshold was reached', async () => {
  const tokens = []
  const {state, widgets} = mountScript(async (email, token) => {
    tokens.push(token)
    return {accountId: tokens.length, email, addVerifyOpen: true}
  }, {addEmailVerify: 2})
  state.quantity.value = 2
  await state.startBatch()
  assert.equal(state.status.value, 'verifying')
  assert.deepEqual(tokens, [''])
  widgets.at(-1).callback('threshold-token')
  await state.runBatch()
  assert.equal(state.status.value, 'done')
  assert.deepEqual(tokens, ['', 'threshold-token'])
})

test('stopping an in-flight batch retains its completed request without starting another', async () => {
  let resolveRequest, calls = 0
  const {state} = mountScript(async email => {
    calls++
    return new Promise(resolve => { resolveRequest = () => resolve({accountId: 1, email}) })
  })
  state.quantity.value = 3
  const running = state.startBatch()
  state.stopBatch()
  resolveRequest()
  await running
  assert.equal(calls, 1)
  assert.equal(state.status.value, 'stopped')
  assert.equal(state.results.value.length, 1)
})

test('copy and text download contain every confirmed mailbox, one per line', async () => {
  let calls = 0
  const {state, clipboard, downloads, timers, revoked, messages} = mountScript(async () => {
    calls++
    return {accountId: calls, email: `saved${calls}@example.com`}
  })
  state.quantity.value = 3
  await state.startBatch()
  const expected = 'saved1@example.com\nsaved2@example.com\nsaved3@example.com'
  await state.copyResults()
  assert.deepEqual(clipboard, [expected])
  assert.deepEqual(messages.at(-1), {type: 'success', message: 'copySuccessMsg'})
  state.downloadResults()
  assert.equal(downloads.length, 1)
  assert.equal(await downloads[0].blob.text(), expected + '\n')
  assert.equal(downloads[0].blob.type, 'text/plain;charset=utf-8')
  assert.match(downloads[0].link.download, /^mailboxes-.+\.txt$/)
  assert.equal(downloads[0].link.href, 'blob:test-download')
  assert.equal(downloads[0].link.clicked, true)
  assert.equal(downloads[0].link.removed, true)
  timers.forEach(callback => callback())
  assert.deepEqual(revoked, ['blob:test-download'])
})
