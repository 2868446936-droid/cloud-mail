import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import vm from 'node:vm'
import {computed, reactive} from 'vue'
import {getOpenAiVerificationCode} from '../src/utils/openai-code.js'

const source = readFileSync(new URL('../src/components/email-scroll/index.vue', import.meta.url), 'utf8')
const codesStart = source.indexOf('const openAiCodes = computed(() => {')
const codesScript = source.slice(codesStart, source.indexOf('const expandList = reactive([])', codesStart))
const copyStart = source.indexOf('async function copyCode(code)')
const copyScript = source.slice(copyStart, source.indexOf('\nfunction handleDelete()', copyStart))

function mountCodes({type = 'all-email', clipboardError = false} = {}) {
  const emailList = reactive([])
  const emailStore = reactive({detailMap: {}})
  const props = reactive({type})
  const writes = [], messages = []
  const context = vm.createContext({
    computed, emailList, emailStore, props, getOpenAiVerificationCode,
    navigator: {clipboard: {writeText: async value => {
      if (clipboardError) throw new Error('Clipboard unavailable')
      writes.push(value)
    }}},
    ElMessage: message => messages.push(message),
    t: key => key,
    console: {error: () => {}},
  })
  vm.runInContext(codesScript + copyScript + '\nglobalThis.codes = openAiCodes', context)
  return {emailList, emailStore, props, codes: context.codes, copyCode: context.copyCode, writes, messages}
}

function verification(emailId, overrides = {}) {
  return {
    emailId,
    type: 0,
    sendEmail: 'otp@tm1.openai.com',
    subject: 'Your temporary ChatGPT login code',
    text: 'Your verification code is 001234.',
    ...overrides,
  }
}

test('historical mail gains its copy button when the full body arrives after a truncated brief list', () => {
  const {emailList, emailStore, codes} = mountCodes()
  const preamble = 'Important account information. '.repeat(20)
  emailList.push(verification(1, {text: undefined, listText: preamble.slice(0, 300)}))
  assert.equal(codes.value.has(1), false)

  emailStore.detailMap[1] = verification(1, {text: preamble + '\nYour verification code is 001234.'})
  assert.equal(codes.value.get(1), '001234')
})

test('future realtime OpenAI and ChatGPT mail gains copy buttons as cached full messages enter the list', () => {
  const {emailList, emailStore, codes} = mountCodes()
  emailList.push(verification(1))
  assert.equal(codes.value.size, 1)

  // Realtime delivery caches complete messages before adding rows to the visible list.
  emailStore.detailMap[2] = verification(2, {text: 'Your verification code is 654321.'})
  emailStore.detailMap[3] = verification(3, {
    sendEmail: 'noreply@chatgpt.com',
    text: 'Your verification code is 009876.',
  })
  assert.equal(codes.value.size, 1)
  emailList.push(verification(2, {text: undefined}), verification(3, {sendEmail: 'noreply@chatgpt.com', text: undefined}))
  assert.equal(codes.value.get(2), '654321')
  assert.equal(codes.value.get(3), '009876')
})

test('full body updates can remove an uncertain code instead of leaving a stale copy button', () => {
  const {emailList, emailStore, codes} = mountCodes()
  emailList.push(verification(1))
  assert.equal(codes.value.get(1), '001234')

  emailStore.detailMap[1] = verification(1, {text: 'Your verification code is 001234. Another verification code is 654321.'})
  assert.equal(codes.value.has(1), false)

  emailStore.detailMap[1] = verification(1, {text: 'Your verification code is 009876.'})
  assert.equal(codes.value.get(1), '009876')
  emailList.splice(0)
  assert.equal(codes.value.size, 0)
})

test('copy buttons are limited to inbound verification mail from the requested providers and the all-mail view', () => {
  const {emailList, props, codes} = mountCodes()
  emailList.push(
    verification(1),
    verification(2, {sendEmail: 'otp@example.net', name: 'OpenAI', code: '001234'}),
    verification(3, {subject: 'Your new plan', text: 'Invoice number: 123456.'}),
    verification(4, {type: 1}),
  )
  assert.deepEqual(Array.from(codes.value.keys()), [1])
  for (const type of ['email', 'send', 'star', 'draft']) {
    props.type = type
    assert.equal(codes.value.size, 0)
  }
  props.type = 'all-email'
  assert.deepEqual(Array.from(codes.value.keys()), [1])
})

test('the copy handler writes only the extracted code and preserves leading zeroes', async () => {
  const {emailList, codes, copyCode, writes, messages} = mountCodes()
  emailList.push(verification(1))
  await copyCode(codes.value.get(1))
  assert.deepEqual(writes, ['001234'])
  assert.equal(messages.at(-1).type, 'success')
  assert.equal(messages.at(-1).message, 'copySuccessMsg')
})

test('a clipboard failure reports failure instead of claiming that a code was copied', async () => {
  const {emailList, codes, copyCode, writes, messages} = mountCodes({clipboardError: true})
  emailList.push(verification(1))
  await copyCode(codes.value.get(1))
  assert.deepEqual(writes, [])
  assert.equal(messages.at(-1).type, 'error')
  assert.equal(messages.at(-1).message, 'copyFailMsg')
})

test('an expired or empty code does not overwrite the clipboard or report success', async () => {
  const {copyCode, writes, messages} = mountCodes()
  for (const value of [undefined, null, '', '  ', 123456]) await copyCode(value)
  assert.deepEqual(writes, [])
  assert.deepEqual(messages, [])
})
