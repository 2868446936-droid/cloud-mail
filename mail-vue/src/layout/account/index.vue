<template>
  <div class="account-box">
    <div class="head-opt">
      <Icon v-perm="'account:add'" class="icon add" icon="ion:add-outline" width="23" height="23" @click="add"/>
      <Icon class="icon refresh" icon="ion:reload" width="18" height="18" @click="refresh"/>
      <el-button v-perm="'account:add'" class="batch-create" size="small" type="primary" plain
                 @click="showBatchAdd = true">{{ $t('batchCreateAccounts') }}</el-button>
    </div>
    <el-scrollbar class="scrollbar" ref="scrollbarRef">
      <div v-infinite-scroll="getAccountList" :infinite-scroll-distance="600" :infinite-scroll-immediate="false">
        <section v-for="group in accountGroups" :key="group.key" class="account-group" :aria-label="$t(group.title)">
          <h3 class="group-heading">
            <button type="button" class="group-title" :aria-expanded="expandedGroups[group.key]"
                    :aria-controls="`mailbox-group-${group.key}`"
                    @click="expandedGroups[group.key] = !expandedGroups[group.key]">
              <Icon icon="ion:chevron-down-outline" width="14" height="14" class="group-chevron"
                    :class="{'is-collapsed': !expandedGroups[group.key]}" aria-hidden="true"/>
              <span class="group-label">{{ $t(group.title) }}</span>
              <span v-if="noLoading" class="group-count">{{ group.items.length }}</span>
            </button>
          </h3>
          <div v-show="expandedGroups[group.key]" :id="`mailbox-group-${group.key}`">
            <p v-if="!group.items.length && noLoading" class="group-empty">{{ $t('accountGroupEmpty') }}</p>
            <div class="item" :class="itemBg(item.accountId)" v-for="item in group.items" :key="item.accountId">
              <button type="button" class="account-name" :title="item.email" :aria-label="item.email"
                      :aria-pressed="accountStore.currentAccountId === item.accountId" @click="changeAccount(item)">
                {{ item.email.split('@')[0] }}
              </button>
              <el-dropdown trigger="click" placement="bottom-end" @click.stop>
                <button type="button" class="account-actions" :class="{'is-active': isAllMailView(item)}"
                        :title="$t('mailboxActions', {email: item.email})"
                        :aria-label="$t('mailboxActions', {email: item.email})" @click.stop>
                  <Icon icon="ion:ellipsis-horizontal" width="18" height="18" aria-hidden="true"/>
                </button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item disabled>{{ item.email }}</el-dropdown-item>
                    <el-dropdown-item @click="copyAccount(item.email)">{{ $t('copyMailboxAddress') }}</el-dropdown-item>
                    <el-dropdown-item @click="setAllReceive(item)">
                      {{ isAllMailView(item) ? $t('showOnlyMailboxMail') : $t('showAllMailboxMail') }}
                    </el-dropdown-item>
                    <el-dropdown-item v-if="hasPerm('email:send')" @click="openSetName(item)">{{ $t('rename') }}</el-dropdown-item>
                    <el-dropdown-item v-if="item.accountId !== userStore.user.account.accountId" @click="setAsTop(item)">{{ $t('pin') }}</el-dropdown-item>
                    <el-dropdown-item v-if="item.accountId !== userStore.user.account.accountId && hasPerm('account:delete')"
                                      @click="remove(item)">{{ $t('delete') }}
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>
        </section>

        <!-- Initial Loading Skeleton -->
        <template v-if="loading">
          <el-skeleton v-for="i in skeletonRows" :key="i" animated>
            <template #template>
              <div class="item skeleton-row"><el-skeleton-item variant="text" style="width: 70%; height: 14px"/></div>
            </template>
          </el-skeleton>
        </template>

        <!-- Follow Loading Skeleton -->
        <template v-if="followLoading">
          <el-skeleton animated>
            <template #template>
              <div class="item skeleton-row"><el-skeleton-item variant="text" style="width: 70%; height: 14px"/></div>
            </template>
          </el-skeleton>
        </template>

        <div class="load-more" v-if="!noLoading && !loading">
          <el-button text size="small" :loading="followLoading" @click="getAccountList">{{ $t('loadMoreMailboxes') }}</el-button>
        </div>

        <div class="noLoading" v-if="noLoading && accounts.length > 0">
          <div>{{ $t('noMoreData') }}</div>
        </div>
      </div>

    </el-scrollbar>
    <BatchAccountDialog v-model="showBatchAdd" @settled="refreshAfterBatch" />
    <el-dialog v-model="showAdd" :title="$t('addAccount')">
      <div class="container">
        <el-input v-model="addForm.email" ref="addRef" type="text" :placeholder="$t('emailAccount')" autocomplete="off" @keyup.enter="submit">
          <template #append>
            <div @click.stop="openSelect">
              <el-select
                  ref="mySelect"
                  v-model="addForm.suffix"
                  :placeholder="$t('select')"
                  class="select"
              >
                <el-option
                    v-for="item in domainList"
                    :key="item"
                    :label="item"
                    :value="item"
                />
              </el-select>
              <div>
                <span>{{ addForm.suffix }}</span>
                <Icon class="setting-icon" icon="mingcute:down-small-fill" width="20" height="20"/>
              </div>
            </div>
          </template>
        </el-input>
        <el-button class="btn" type="primary" @click="submit" :loading="addLoading"
        >{{ $t('add') }}
        </el-button>
      </div>
      <div
          ref="turnstileContainer"
          :key="turnstileContainerKey"
          class="add-email-turnstile"
          :class="verifyShow ? 'turnstile-show' : 'turnstile-hide'"
          :data-sitekey="settingStore.settings.siteKey"
          data-callback="onTurnstileSuccess"
          data-error-callback="onTurnstileError"
      >
        <span style="font-size: 12px;color: #F56C6C" v-if="botJsError">{{ $t('verifyModuleFailed', {action: $t('add')}) }}</span>
      </div>
    </el-dialog>
    <el-dialog v-model="setNameShow" :title="$t('changeUserName')">
      <div class="container">
        <el-input v-model="accountName" type="text" :placeholder="$t('username')" autocomplete="off" @keyup.enter="setName">
        </el-input>
        <el-button class="btn" type="primary" @click="setName" :loading="setNameLoading"
        >{{ $t('save') }}
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>
<script setup>
import {Icon} from "@iconify/vue";
import {computed, nextTick, reactive, ref, watch} from "vue";
import {
  accountList,
  accountAdd,
  accountDelete,
  accountSetName,
  accountSetAsTop
} from "@/request/account.js";
import {sleep} from "@/utils/time-utils.js"
import {isEmail} from "@/utils/verify-utils.js";
import {useSettingStore} from "@/store/setting.js";
import {useAccountStore} from "@/store/account.js";
import {useUserStore} from "@/store/user.js";
import {hasPerm} from "@/perm/perm.js"
import {useI18n} from "vue-i18n";
import {reloadTurnstileScript} from "@/utils/turnstile-script.js";
import BatchAccountDialog from "@/components/BatchAccountDialog.vue";
import {groupAccounts} from "@/utils/account-groups.js";

const {t} = useI18n();
const userStore = useUserStore();
const accountStore = useAccountStore();
const settingStore = useSettingStore();
const showAdd = ref(false)
const showBatchAdd = ref(false)
const addLoading = ref(false);
const domainList = computed(() => settingStore.domainList)
const accounts = reactive([])
const accountGroups = computed(() => groupAccounts(accounts, accountStore.receivedAccountIds))
const expandedGroups = reactive({received: false, neverReceived: true})
const noLoading = ref(false)
const loading = ref(false)
const followLoading = ref(false);
const accountRefreshPending = ref(false);
const verifyShow = ref(false)
const setNameShow = ref(false)
const setNameLoading = ref(false)
const accountName = ref(null)
const addRef = ref({})
const scrollbarRef = ref({})
let account = null
let turnstileId = null
const botJsError = ref(false)
let verifyToken = ''
let verifyErrorCount = 0
let turnstileRecoveryAttempted = false
const turnstileContainer = ref(null)
const turnstileContainerKey = ref(0)
let first = true
const addForm = reactive({
  email: '',
  suffix: settingStore.domainList[0]
})
let skeletonRows = 10
const queryParams = {
  size: 30
}

const mySelect = ref()

if (hasPerm('account:query')) {
  getAccountList()
}

watch(() => accountStore.changeUserAccountName, () => {
  accounts[0].name = accountStore.changeUserAccountName
})

watch(() => settingStore.domainList, (list) => {
  if (!addForm.suffix && list.length > 0) {
    addForm.suffix = list[0]
  }
}, {immediate: true})


const openSelect = () => {
  mySelect.value.toggleMenu()
}

async function recoverTurnstile() {
  if (turnstileRecoveryAttempted) return
  turnstileRecoveryAttempted = true
  botJsError.value = false
  verifyToken = ''
  turnstileId = null
  turnstileContainerKey.value++
  try {
    const api = await reloadTurnstileScript()
    await nextTick()
    if (!showAdd.value || !turnstileContainer.value) return
    turnstileId = api.render(turnstileContainer.value)
  } catch (error) {
    botJsError.value = true
    console.warn('Turnstile recovery failed', error)
  } finally {
    turnstileRecoveryAttempted = false
  }
}

window.onTurnstileError = (e) => {
  if (verifyErrorCount >= 4) {
    return
  }
  verifyErrorCount++
  console.warn('人机验加载失败', e)
  setTimeout(() => {
    nextTick(() => {
      if (!turnstileId) {
        turnstileId = window.turnstile.render('.add-email-turnstile')
      } else {
        window.turnstile.reset(turnstileId);
      }
    })
  }, 1500)
};

window.onTurnstileSuccess = (token) => {
  verifyToken = token;
};

function getSkeletonRows() {
  if (accounts.length > 20) return skeletonRows = 20
  if (accounts.length === 0) return skeletonRows = 1
  skeletonRows = accounts.length
}

function setName() {

  if (setNameLoading.value) return

  let name = accountName.value

  if (name === account.name) {
    setNameShow.value = false
    return
  }

  if (!name) {
    ElMessage({
      message: t('emptyUserNameMsg'),
      type: 'error',
      plain: true,
    })
    return;
  }

  setNameLoading.value = true
  accountSetName(account.accountId, name).then(() => {
    account.name = name
    setNameShow.value = false

    if (account.accountId === userStore.user.account.accountId) {
      userStore.user.name = name
    }

    ElMessage({
      message: t('saveSuccessMsg'),
      type: "success",
      plain: true
    })
  }).finally(() => {
    setNameLoading.value = false
  })
}

function openSetName(accountItem) {
  accountName.value = accountItem.name
  account = accountItem
  setNameShow.value = true
}

function setAllReceive(account) {
  accountStore.selectAccount(account, !isAllMailView(account))
}

function isAllMailView(account) {
  return accountStore.currentAccountId === account.accountId && accountStore.showAllMail
}


function itemBg(accountId) {
  return accountStore.currentAccountId === accountId ? 'item-choose' : ''
}



function remove(account) {
  ElMessageBox.confirm(t('delConfirm', {msg: account.email}), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    accountDelete(account.accountId).then(() => {
      const index = accounts.findIndex(item => item.accountId === account.accountId);
      accounts.splice(index, 1);
      if (accounts.length < queryParams.size) {
        getAccountList()
      }
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true,
      })
    })
  });
}

function refresh() {
  if (loading.value || followLoading.value) {
    accountRefreshPending.value = true
    return
  }
  loading.value = false
  followLoading.value = false
  noLoading.value = false
  queryParams.accountId = 0
  queryParams.lastSort = null
  getSkeletonRows();
  scrollbarRef.value.setScrollTop(0)
  accounts.splice(0, accounts.length)
  getAccountList()
}

function refreshAfterBatch() {
  refresh()
  userStore.refreshUserInfo()
}

watch([loading, followLoading], ([initialLoading, nextPageLoading]) => {
  if (accountRefreshPending.value && !initialLoading && !nextPageLoading) {
    accountRefreshPending.value = false
    refresh()
  }
})

watch(() => accountStore.listRefreshVersion, () => {
  if (hasPerm('account:query')) refresh()
})

function changeAccount(account) {
  accountStore.selectAccount(account)
}

function add() {
  addForm.suffix = addForm.suffix || settingStore.domainList[0]
  showAdd.value = true
  setTimeout(() => {
    addRef.value.focus()
  }, 100)
}

function setAsTop(account) {
  accountSetAsTop(account.accountId).then(() => {
    ElMessage({
      message: t('setSuccess'),
      type: 'success',
      plain: true,
    })

    refresh()

  });
}

async function copyAccount(account) {
  try {
    await navigator.clipboard.writeText(account);
    ElMessage({
      message: t('copySuccessMsg'),
      type: 'success',
      plain: true,
    })
  } catch (err) {
    console.error(`${t('copyFailMsg')}:`, err);
    ElMessage({
      message: t('copyFailMsg'),
      type: 'error',
      plain: true,
    })
  }
}

function getAccountList() {

  if (loading.value || followLoading.value || noLoading.value) return;

  if (accounts.length === 0) {
    loading.value = true
  } else {
    followLoading.value = true
  }

  let start = Date.now();

  const accountId = accounts.length > 0 ? accounts.at(-1).accountId : 0;
  const lastSort = accounts.length > 0 ? accounts.at(-1).sort : null;

  accountList(accountId, queryParams.size, lastSort).then(async list => {

    let end = Date.now();
    let duration = end - start;
    if (duration < 300) {
      await sleep(300 - duration)
    }

    if (list.length < queryParams.size) {
      noLoading.value = true
    }
    accounts.push(...list)

    const selected = accounts.find(item => item.accountId === accountStore.currentAccountId)
    if (selected) accountStore.currentAccount = selected
    else if ((!accountStore.currentAccountId || noLoading.value) && accounts.length) changeAccount(accounts[0])
    else if (noLoading.value && !accounts.length) {
      accountStore.selectAccount(null)
    }

    loading.value = false
    followLoading.value = false
    first = false
  }).catch(() => {
    loading.value = false
    followLoading.value = false
  })
}


function submit() {

  if (addLoading.value) return

  if (!addForm.email) {
    ElMessage({
      message: t('emptyEmailMsg'),
      type: "error",
      plain: true
    })
    return
  }

  if (addForm.email.length < settingStore.settings.minEmailPrefix) {
    ElMessage({
      message: t('minEmailPrefix', {msg: settingStore.settings.minEmailPrefix}),
      type: 'error',
      plain: true,
    })
    return
  }

  if (!isEmail(addForm.email + addForm.suffix)) {
    ElMessage({
      message: t('notEmailMsg'),
      type: "error",
      plain: true
    })
    return
  }

  if (!verifyToken && (settingStore.settings.addEmailVerify === 0 || (settingStore.settings.addEmailVerify === 2 && settingStore.settings.addVerifyOpen))) {
    if (turnstileRecoveryAttempted) return
    if (!verifyShow.value) {
      verifyShow.value = true
      nextTick(() => {
        if (!turnstileId) {
          try {
            turnstileId = window.turnstile.render('.add-email-turnstile')
          } catch (e) {
            botJsError.value = true
            console.log('人机验证js加载失败')
            recoverTurnstile()
          }
        } else {
          window.turnstile.reset('.add-email-turnstile')
        }
      })
    } else if (botJsError.value) {
      recoverTurnstile()
    } else {
      ElMessage({
        message: t('botVerifyMsg'),
        type: "error",
        plain: true
      })
    }
    return;
  }

  addLoading.value = true
  accountAdd(addForm.email + addForm.suffix, verifyToken).then(account => {
    addLoading.value = false
    addForm.email = ''
    refresh()
    verifyToken = ''
    settingStore.settings.addVerifyOpen = account.addVerifyOpen
    ElMessage({
      message: t('addSuccessMsg'),
      type: "success",
      plain: true
    })
    verifyShow.value = false
    showAdd.value = false
    userStore.refreshUserInfo()
  }).catch(res => {
    if (res.code === 400) {
      verifyToken = ''
      if (turnstileId) {
        window.turnstile.reset(turnstileId)
      } else {
        nextTick(() => {
          turnstileId = window.turnstile.render('.add-email-turnstile')
        })
      }
      verifyShow.value = true
    }
    addLoading.value = false
  })
}
</script>
<style>
path[fill="#ffdda1"] {
  fill: #ffdd7d;
}
</style>
<style scoped lang="scss">
.account-box {

  border-right: 1px solid var(--el-border-color) !important;
  background-color: var(--el-bg-color);
  height: 100%;
  overflow: hidden;

  .head-opt {
    display: flex;
    align-items: center;
    height: 38px;
    box-shadow: var(--header-actions-border);
    padding-left: 10px;
    padding-right: 10px;

    .icon {
      cursor: pointer;
    }

    .refresh {
      margin-left: 10px;
    }

    .add {
      margin-left: 2px;
    }

    .batch-create {
      margin-left: auto;
      padding: 5px 8px;
    }

    .head-opt:not(.add) .refresh {
      margin-left: 5px;
    }
  }

  .scrollbar {
    width: 100%;
    height: calc(100% - 38px);
    overflow: auto;
    @media (max-width: 767px) {
      height: calc(100% - 98px);
    }

    .empty {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
    }

    .noLoading {
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 10px 0;
      color: var(--secondary-text-color);
    }
  }

  .btn {
    width: 100%;
    margin-top: 15px;
  }

  .group-heading {
    margin: 0;
  }

  .group-title {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 34px;
    padding: 6px 10px;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    color: var(--el-text-color-regular);
  }

  .group-label {
    flex: 1;
  }

  .group-chevron {
    flex-shrink: 0;
    transition: transform .15s;
  }

  .group-chevron.is-collapsed {
    transform: rotate(-90deg);
  }

  .group-count {
    color: var(--el-text-color-secondary);
    font-weight: 400;
  }

  .group-empty {
    padding: 4px 14px 14px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .account-group + .account-group {
    border-top: 1px solid var(--el-border-color-lighter);
  }

  .item {
    display: flex;
    align-items: center;
    min-height: 32px;
    margin: 2px 6px;
    border-radius: 5px;
    color: var(--el-text-color-primary);
  }

  .item:hover, .group-title:hover {
    background-color: var(--el-fill-color-light);
  }

  .account-name {
    flex: 1;
    min-width: 0;
    height: 32px;
    padding: 5px 8px;
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 13px;
    text-align: left;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .account-actions {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    margin-right: 2px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--el-text-color-secondary);
    cursor: pointer;
  }

  .account-actions:hover, .account-actions.is-active {
    color: var(--el-color-primary);
    background-color: var(--el-color-primary-light-9);
  }

  .account-name:focus-visible, .account-actions:focus-visible, .group-title:focus-visible {
    outline: 2px solid var(--el-color-primary);
    outline-offset: -2px;
  }

  .skeleton-row {
    padding: 8px;
  }

  .load-more {
    display: flex;
    justify-content: center;
    padding: 5px;
  }

  .item-choose {
    background: var(--choose-account-background);
  }
}


.setting-icon {
  position: relative;
  top: 6px;
}

:deep(.el-input-group__append) {
  padding: 0 !important;
  padding-left: 8px !important;
  background: var(--el-bg-color);
}

:deep(.el-dialog) {
  width: 400px !important;
  @media (max-width: 440px) {
    width: calc(100% - 40px) !important;
    margin-right: 20px !important;
    margin-left: 20px !important;
  }
}

.select {
  position: absolute;
  right: 30px;
  width: 100px;
  opacity: 0;
  pointer-events: none;
}

:deep(.el-pagination .el-select) {
  width: 100px;
  background: var(--el-bg-color);
}

.add-email-turnstile {
  margin-top: 15px;
}

.turnstile-show {
  opacity: 1;
}

.turnstile-hide {
  opacity: 0;
  pointer-events: none;
  position: fixed;
}

</style>
