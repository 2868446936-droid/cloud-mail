import assert from 'node:assert/strict'
import {test} from 'node:test'
import {getOpenAiVerificationCode} from '../src/utils/openai-code.js'

const mail = overrides => ({
  type: 0,
  sendEmail: 'otp@tm1.openai.com',
  subject: 'Your temporary ChatGPT login code',
  text: 'Please use this verification code to continue: 001234',
  ...overrides,
})

test('extracts a six-digit code from an OpenAI verification message and preserves leading zeroes', () => {
  assert.equal(getOpenAiVerificationCode(mail()), '001234')
  assert.equal(getOpenAiVerificationCode(mail({sendEmail: ' NOREPLY@OPENAI.COM '})), '001234')
  assert.equal(getOpenAiVerificationCode(mail({sendEmail: 'otp@chatgpt.com'})), '001234')
  assert.equal(getOpenAiVerificationCode(mail({sendEmail: 'noreply@mail.chatgpt.com'})), '001234')
  assert.equal(getOpenAiVerificationCode(mail({type: '0'})), '001234')
})

test('uses full historical text beyond the brief-list cutoff and supports a brief summary while details load', () => {
  assert.equal(getOpenAiVerificationCode(mail({text: `${'Welcome to ChatGPT. '.repeat(30)} Your verification code is 345678.`})), '345678')
  assert.equal(getOpenAiVerificationCode(mail({text: '', listText: 'Your verification code is 456789.'})), '456789')
  assert.equal(getOpenAiVerificationCode(mail({text: 'Your verification code is 345678.', listText: 'Old summary: 987654'})), '345678')
})

test('recognizes English, Spanish and Chinese verification templates', () => {
  assert.equal(getOpenAiVerificationCode(mail({subject: 'Your temporary ChatGPT code', text: '123456'})), '123456')
  assert.equal(getOpenAiVerificationCode(mail({subject: 'Tu código de verificación temporal de ChatGPT', text: 'Ingresa este código para continuar: 576574'})), '576574')
  assert.equal(getOpenAiVerificationCode(mail({subject: '您的临时 ChatGPT 验证码', text: '请输入此验证码以继续：１２３４５６'})), '123456')
  assert.equal(getOpenAiVerificationCode(mail({subject: 'Sign in', text: 'Your code is 123456.'})), '123456')
})

test('extracts HTML-only codes without counting CSS, script, title, attributes, comments or URL digits', () => {
  const content = `<!doctype html><html><head><title>123123</title><style>.code {color:#998877}</style></head>
    <body><!-- 333333 --><script>window.value = 222222</script>
    <div>Use this verification code:</div><p class="x987654"><b>00</b><strong>1234</strong></p>
    <a href="https://openai.com/654321">Help</a><p>https://help.openai.com/876543</p></body></html>`
  assert.equal(getOpenAiVerificationCode(mail({text: '', content})), '001234')
})

test('decodes HTML numeric and common whitespace entities and tolerates formatting characters', () => {
  assert.equal(getOpenAiVerificationCode(mail({text: '', content: '<p>Verification&nbsp;code:</p><p>&#48;&#x30;&#49;&#50;&#51;&#52;</p>'})), '001234')
  assert.equal(getOpenAiVerificationCode(mail({text: 'Your verification code is 00\u200b1234.'})), '001234')
  assert.equal(getOpenAiVerificationCode(mail({text: '', content: '<div>123</div><div>456</div>'})), '')
})

test('requires an incoming message from the exact OpenAI domain boundary, not its display name', () => {
  for (const sendEmail of ['otp@notopenai.com', 'otp@openai.com.example.org', 'otp@chatgpt.com.evil.test', 'otp@evilchatgpt.com', 'otp@foo..openai.com', 'OpenAI <otp@example.org>', 'OpenAI', 'otp@example.org']) {
    assert.equal(getOpenAiVerificationCode(mail({sendEmail, name: 'OpenAI'})), '', sendEmail)
  }
  for (const type of [1, '1', undefined, null]) assert.equal(getOpenAiVerificationCode(mail({type})), '')
})

test('rejects invoice and security-notification numbers, even if an AI code was stored', () => {
  for (const subject of ['Your OpenAI invoice', 'Your ChatGPT subscription', 'Your security alert', 'Your multi-factor authentication settings have changed', '您的多重身份验证设置已更改', 'Your password has been added']) {
    assert.equal(getOpenAiVerificationCode(mail({subject, text: 'Reference 123456. Previous verification code: 123456.', code: '123456'})), '', subject)
  }
  assert.equal(getOpenAiVerificationCode(mail({subject: 'Welcome to OpenAI', text: 'Account reference 123456.', code: '123456'})), '')
})

test('requires a single unambiguous code and never copies a different or absent AI value', () => {
  assert.equal(getOpenAiVerificationCode(mail({code: '999999'})), '001234')
  assert.equal(getOpenAiVerificationCode(mail({text: 'Use your verification code.', code: '999999'})), '')
  assert.equal(getOpenAiVerificationCode(mail({text: 'Your verification code is 123456. Another code: 654321.'})), '')
  assert.equal(getOpenAiVerificationCode(mail({text: 'Your verification code is 123456.', content: '<p>Your verification code is 654321.</p>'})), '')
  assert.equal(getOpenAiVerificationCode(mail({text: 'Your verification code is 001234.', content: '<p>001234</p>'})), '001234')
})

test('does not take six digits out of a longer number, alphanumeric token, email address or URL', () => {
  for (const text of ['1234567', 'A123456B', '123456@example.com', 'https://openai.com/123456']) {
    assert.equal(getOpenAiVerificationCode(mail({text})), '', text)
  }
})
