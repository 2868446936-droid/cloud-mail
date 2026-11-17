<template>
  <el-dialog
      v-model="visible"
      :title="$t('batchCreateAccounts')"
      class="batch-account-dialog"
      width="560px"
      :close-on-click-modal="!active"
      :close-on-press-escape="!active"
      :show-close="!active"
  >
    <el-form label-position="top" @submit.prevent="startBatch">
      <div class="batch-fields">
        <el-form-item :label="$t('batchAccountCount')">
          <el-input-number
              v-model="quantity"
              :min="MIN_BATCH_COUNT"
              :max="MAX_BATCH_COUNT"
              :step="1"
              :precision="0"
              :disabled="active"
              :aria-label="$t('batchAccountCount')"
          />
        </el-form-item>
        <el-form-item :label="$t('batchAccountDomain')" class="batch-domain">
          <el-select v-model="suffix" :disabled="active" :aria-label="$t('batchAccountDomain')">
            <el-option v-for="domain in settingStore.domainList" :key="domain" :label="domain" :value="domain"/>
          </el-select>
        </el-form-item>
      </div>
      <p class="batch-hint">{{ $t('batchAccountHint', {length: prefixLengthLabel}) }}</p>
      <div class="batch-actions">
        <el-button v-if="!active" type="primary" native-type="submit" :disabled="!settingStore.domainList.length">
          {{ results.length ? $t('batchCreateAgain') : $t('batchCreateAccounts') }}
        </el-button>
        <el-button v-if="active" :disabled="stopRequested" @click="stopBatch">
          {{ stopRequested ? $t('batchStopping') : $t('batchStop') }}
        </el-button>
      </div>
    </el-form>

    <div v-if="targetCount" class="batch-progress" role="status" aria-live="polite">
      <p>{{ $t('batchAccountProgress', {created: results.length, total: targetCount}) }}</p>
      <el-progress :percentage="Math.floor(results.length / targetCount * 100)" :status="status === 'done' ? 'success' : undefined"/>
    </div>

    <div v-if="status === 'verifying'" class="batch-verification">
      <el-alert :title="$t('batchVerificationRequired')" type="warning" :closable="false" show-icon/>
      <div ref="captchaContainer" :key="captchaKey" class="batch-captcha"/>
      <p v-if="captchaLoading">{{ $t('batchVerificationLoading') }}</p>
      <el-alert v-if="captchaError" :title="$t('batchVerificationFailed')" type="error" :closable="false"/>
      <div class="batch-actions">
        <el-button v-if="captchaError" :disabled="busy || captchaLoading" @click="prepareCaptcha">{{ $t('batchRetryVerification') }}</el-button>
        <el-button type="primary" :disabled="!verifyToken || busy" @click="runBatch">{{ $t('batchContinue') }}</el-button>
      </div>
    </div>

    <el-alert v-if="status === 'done'" :title="$t('batchCreateComplete')" type="success" :closable="false" show-icon/>
    <el-alert v-if="status === 'stopped'" :title="$t('batchCreateStopped')" type="info" :closable="false" show-icon/>
    <el-alert v-if="status === 'error'" :title="$t('batchCreateFailed')" :description="failureMessage" type="error" :closable="false" show-icon/>

    <div v-if="results.length" class="batch-results">
      <label for="batch-created-emails">{{ $t('batchCreatedEmails') }}</label>
      <el-input
          id="batch-created-emails"
          :model-value="resultText"
          type="textarea"
          :rows="Math.min(10, Math.max(3, results.length))"
          readonly
          :aria-label="$t('batchCreatedEmails')"
          spellcheck="false"
      />
      <div class="batch-actions">
        <el-button @click="copyResults">{{ $t('batchCopyAll') }}</el-button>
        <el-button @click="downloadResults">{{ $t('batchDownloadText') }}</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup>
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {accountAdd} from '@/request/account.js'
import {useSettingStore} from '@/store/setting.js'
import {reloadTurnstileScript} from '@/utils/turnstile-script.js'
import {generateEmailPrefix, getEmailPrefixLength, MAX_BATCH_COUNT, MIN_BATCH_COUNT, validateBatchCount} from '@/utils/batch-account.js'

const props = defineProps({modelValue: Boolean})
const emit = defineEmits(['update:modelValue', 'created', 'settled'])
const {t} = useI18n()
const settingStore = useSettingStore()
const status = ref('idle')
const busy = ref(false)
const quantity = ref(10)
const suffix = ref(settingStore.domainList[0] || '')
const targetCount = ref(0)
const results = ref([])
const failureMessage = ref('')
const stopRequested = ref(false)
const verifyToken = ref('')
const captchaContainer = ref(null)
const captchaKey = ref(0)
const captchaLoading = ref(false)
const captchaError = ref(false)
const active = computed(() => status.value === 'running' || status.value === 'verifying')
const resultText = computed(() => results.value.join('\n'))
const visible = computed({
  get: () => props.modelValue,
  set: value => {
    if (!value && active.value) return
    emit('update:modelValue', value)
  }
})
const prefixLengthLabel = computed(() => {
  try {
    return getEmailPrefixLength(settingStore.settings.minEmailPrefix ?? 0)
  } catch {
    return '—'
  }
})
let batchSuffix = ''
let batchMinLength = 0
let pendingEmail = ''
let forceCaptcha = false
let widgetId = null
let captchaEpoch = 0
let unmounted = false
let lastSettledCount = 0

watch(() => settingStore.domainList, domains => {
  if (!active.value && !domains.includes(suffix.value)) suffix.value = domains[0] || ''
}, {immediate: true})

function clearCaptcha() {
  captchaEpoch++
  verifyToken.value = ''
  captchaLoading.value = false
  if (widgetId !== null) {
    try { window.turnstile?.remove(widgetId) } catch { /* The SDK may already have reset. */ }
    widgetId = null
  }
  captchaKey.value++
}

function needsVerification() {
  const settings = settingStore.settings
  return forceCaptcha || settings.addEmailVerify === 0 || (settings.addEmailVerify === 2 && settings.addVerifyOpen)
}

async function prepareCaptcha() {
  clearCaptcha()
  const epoch = captchaEpoch
  captchaError.value = false
  captchaLoading.value = true
  try {
    await nextTick()
    const api = window.turnstile?.render ? window.turnstile : await reloadTurnstileScript()
    if (unmounted || epoch !== captchaEpoch || status.value !== 'verifying') return
    if (!settingStore.settings.siteKey || !captchaContainer.value) throw new Error('Verification is unavailable')
    widgetId = api.render(captchaContainer.value, {
      sitekey: settingStore.settings.siteKey,
      callback: token => {
        if (epoch !== captchaEpoch || unmounted) return
        verifyToken.value = token
        captchaError.value = false
      },
      'expired-callback': () => {
        if (epoch === captchaEpoch) verifyToken.value = ''
      },
      'error-callback': () => {
        if (epoch !== captchaEpoch) return
        verifyToken.value = ''
        captchaError.value = true
      }
    })
  } catch {
    if (epoch === captchaEpoch) captchaError.value = true
  } finally {
    if (epoch === captchaEpoch) captchaLoading.value = false
  }
}

async function startBatch() {
  if (active.value || busy.value) return
  if (!validateBatchCount(quantity.value)) {
    ElMessage.error(t('batchInvalidCount', {max: MAX_BATCH_COUNT}))
    return
  }
  if (!settingStore.domainList.includes(suffix.value)) {
    ElMessage.error(t('batchSelectDomain'))
    return
  }
  try {
    batchMinLength = getEmailPrefixLength(settingStore.settings.minEmailPrefix ?? 0)
  } catch {
    ElMessage.error(t('batchInvalidPrefixLength'))
    return
  }
  clearCaptcha()
  batchSuffix = suffix.value
  pendingEmail = ''
  forceCaptcha = false
  targetCount.value = quantity.value
  results.value = []
  lastSettledCount = 0
  failureMessage.value = ''
  stopRequested.value = false
  status.value = 'running'
  await runBatch()
}

async function runBatch() {
  if (busy.value || !active.value) return
  busy.value = true
  status.value = 'running'
  try {
    while (results.value.length < targetCount.value && !unmounted) {
      if (stopRequested.value) {
        status.value = 'stopped'
        break
      }
      if (needsVerification() && !verifyToken.value) {
        status.value = 'verifying'
        await prepareCaptcha()
        break
      }
      if (!pendingEmail) pendingEmail = generateEmailPrefix(batchMinLength) + batchSuffix
      const token = verifyToken.value
      verifyToken.value = '' // Turnstile tokens are single use, including failed requests.
      try {
        const account = await accountAdd(pendingEmail, token)
        if (!account?.email || !account.accountId) throw new Error(t('batchUncertainResult'))
        results.value.push(account.email)
        pendingEmail = ''
        settingStore.settings.addVerifyOpen = account.addVerifyOpen
        forceCaptcha = false
        emit('created', account)
        clearCaptcha()
      } catch (error) {
        clearCaptcha()
        if (unmounted) break
        if (stopRequested.value) {
          status.value = 'stopped'
        } else if (error?.code === 400) {
          // The server rejected this address before inserting it. Keep it for verification.
          forceCaptcha = true
          status.value = 'verifying'
          await prepareCaptcha()
        } else {
          // Never retry an uncertain network result: the server might have saved it already.
          status.value = 'error'
          failureMessage.value = error?.message || t('batchUnknownError')
          pendingEmail = ''
        }
        break
      }
    }
    if (results.value.length === targetCount.value) status.value = 'done'
    else if (stopRequested.value) status.value = 'stopped'
  } catch (error) {
    status.value = 'error'
    failureMessage.value = error?.message || t('batchUnknownError')
  } finally {
    busy.value = false
    if (status.value !== 'verifying') clearCaptcha()
    notifySettled()
  }
}

function stopBatch() {
  stopRequested.value = true
  clearCaptcha()
  if (!busy.value) {
    status.value = 'stopped'
    notifySettled()
  }
}

function notifySettled() {
  // An uncertain network failure can follow a successful server insert, so refresh then too.
  if (unmounted || (results.value.length === lastSettledCount && status.value !== 'error')) return
  lastSettledCount = results.value.length
  emit('settled', {status: status.value, created: results.value.length, total: targetCount.value})
}

async function copyResults() {
  try {
    await navigator.clipboard.writeText(resultText.value)
    ElMessage.success(t('copySuccessMsg'))
  } catch {
    ElMessage.error(t('copyFailMsg'))
  }
}

function downloadResults() {
  const url = URL.createObjectURL(new Blob([resultText.value + '\n'], {type: 'text/plain;charset=utf-8'}))
  const link = document.createElement('a')
  link.href = url
  link.download = `mailboxes-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

onBeforeUnmount(() => {
  unmounted = true
  stopRequested.value = true
  clearCaptcha()
})
</script>

<style>
.el-overlay .el-dialog.batch-account-dialog {
  width: min(560px, calc(100vw - 40px)) !important;
}
</style>

<style scoped>
.batch-fields {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.batch-domain {
  flex: 1;
  min-width: 180px;
}
.batch-hint {
  margin: 0 0 16px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}
.batch-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.batch-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.batch-progress, .batch-verification, .batch-results {
  margin: 20px 0;
}
.batch-captcha {
  margin-top: 12px;
}
.batch-results label {
  display: block;
  margin-bottom: 8px;
}
.batch-results :deep(textarea) {
  font-family: monospace;
  line-height: 1.6;
}
</style>
