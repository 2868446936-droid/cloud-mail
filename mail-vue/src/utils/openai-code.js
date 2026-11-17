const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', zerowidthspace: '',
}

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, value) => {
    if (value[0] !== '#') return ENTITIES[value.toLowerCase()] ?? entity
    const hex = value[1]?.toLowerCase() === 'x'
    const point = Number.parseInt(value.slice(hex ? 2 : 1), hex ? 16 : 10)
    return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity
  })
}

// Text-only conversion: no DOM insertion, resource loading, or script execution.
// Block boundaries stay separated; inline formatting may split a displayed code.
function htmlText(html) {
  return decodeEntities(String(html || '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|head|title|template|noscript|svg|math)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<\/?(?:br|p|div|tr|td|th|li|ul|ol|table|section|article|header|footer|h[1-6]|pre|hr)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ''))
}

function normalize(text) {
  return String(text || '').normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
}

function semanticText(text) {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

const VERIFICATION = /验证码|驗證碼|校验码|校驗碼|动态码|動態碼|一次性代[码碼]|\b(?:verification|login|log-in|sign-in|authentication|security|confirmation|temporary|one-time|one time)\s+(?:(?:chatgpt|openai)\s+)?code\b|\b(?:chatgpt|openai)\s+(?:(?:temporary|login|verification|authentication|security)\s+)?code\b|\b(?:your|this)\s+code\s+(?:is\b|to\s+(?:continue|sign\s*in|log\s*in)\b)|\bcodigo\s+(?:de\s+)?(?:verificacion|inicio\s+de\s+sesion|acceso|autenticacion|seguridad|temporal|un\s+solo\s+uso)\b/
const NOT_VERIFICATION = /\b(?:invoice|receipt|billing|subscription|payment)\b|\bsecurity\s+(?:alert|notification)\b|\b(?:authentication|security|verification)\s+settings\b|\bpassword\s+(?:(?:was|has been)\s+)?added\b|\bnew\s+login\s+(?:to|from|detected)\b|\bnew\s+sign-in\b|\bsign-in\s+detected\b|[发發]票|[账賬]单|[账賬]單|付款|[订訂][阅閱]|登[录錄]通知|(?:设置|設定).*(?:更改|变更|變更)/

export function getOpenAiVerificationCode(email) {
  if (!email || (email.type !== 0 && email.type !== '0')) return ''
  const sender = String(email.sendEmail || '').trim().toLowerCase()
  const match = sender.match(/^[^@\s<>]+@((?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,})$/)
  const domain = match?.[1]
  if (!domain || !['openai.com', 'chatgpt.com'].some(provider => domain === provider || domain.endsWith(`.${provider}`))) return ''

  const subject = normalize(decodeEntities(String(email.subject || '')))
  if (NOT_VERIFICATION.test(semanticText(subject))) return ''

  const fullBodies = [normalize(email.text), normalize(htmlText(email.content))].filter(text => text.trim())
  const body = fullBodies.length ? fullBodies.join('\n') : normalize(email.listText)
  const visibleText = `${subject}\n${body}`
  if (!VERIFICATION.test(semanticText(visibleText))) return ''

  // Ignore numeric URL/tracking/contact fragments, and never trust an AI-extracted
  // code that is absent from the message. Preserve leading zeroes as a string.
  const codeText = visibleText
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b[\w.+%-]+@[\w.-]+\.[a-z]{2,}\b/gi, ' ')
  const codes = new Set(Array.from(codeText.matchAll(/(?<![a-z\d])(\d{6})(?![a-z\d])/gi), match => match[1]))
  return codes.size === 1 ? [...codes][0] : ''
}
