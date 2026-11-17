import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import vm from 'node:vm'
import {createPinia, setActivePinia} from 'pinia'
import {computed, reactive, ref} from 'vue'
import {groupAccounts} from '../src/utils/account-groups.js'
import {useAccountStore} from '../src/store/account.js'

function newStore() {
  setActivePinia(createPinia())
  return useAccountStore()
}

test('receipt history splits all mailboxes into two stable groups', () => {
  const accounts = [
    {accountId: 1, latestEmailTime: null},
    {accountId: 2, latestEmailTime: '2026-11-17 11:10:00'},
    {accountId: 3},
    {accountId: 4, latestEmailTime: '2026-11-16 09:00:00'},
    {accountId: 5, latestEmailTime: ''},
  ]
  const groups = groupAccounts(accounts)
  assert.deepEqual(groups.map(group => group.key), ['received', 'neverReceived'])
  assert.deepEqual(groups[0].items.map(account => account.accountId), [2, 4])
  assert.deepEqual(groups[1].items.map(account => account.accountId), [1, 3, 5])
  assert.equal(groups.flatMap(group => group.items).length, accounts.length)
})

test('grouping preserves the raw pagination cursor and account object identities', () => {
  const accounts = Object.freeze([
    Object.freeze({accountId: 9, sort: 999, latestEmailTime: null}),
    Object.freeze({accountId: 10, sort: 0, latestEmailTime: null}),
    Object.freeze({accountId: 11, sort: 0, latestEmailTime: '2026-11-17 11:10:00'}),
  ])
  const cursor = accounts.at(-1)
  const groups = groupAccounts(accounts)
  assert.strictEqual(groups[0].items[0], accounts[2])
  assert.strictEqual(groups[1].items[0], accounts[0])
  assert.strictEqual(accounts.at(-1), cursor)
  assert.deepEqual(accounts.map(account => account.accountId), [9, 10, 11])
})

test('loading another page neither duplicates addresses nor changes raw ordering', () => {
  const accounts = [
    {accountId: 1, latestEmailTime: null},
    {accountId: 2, latestEmailTime: '2026-11-17 11:10:00'},
  ]
  groupAccounts(accounts)
  accounts.push(
    {accountId: 3, latestEmailTime: '2026-11-17 12:10:00'},
    {accountId: 4, latestEmailTime: null},
  )
  const groups = groupAccounts(accounts)
  assert.deepEqual(groups[0].items.map(account => account.accountId), [2, 3])
  assert.deepEqual(groups[1].items.map(account => account.accountId), [1, 4])
  assert.equal(new Set(groups.flatMap(group => group.items).map(account => account.accountId)).size, 4)
  assert.equal(accounts.at(-1).accountId, 4)
})

test('both category headings remain available for an empty account list', () => {
  assert.deepEqual(groupAccounts([]).map(group => [group.title, group.items.length]), [
    ['accountsReceived', 0],
    ['accountsNeverReceived', 0],
  ])
})

test('a real Pinia receipt update immediately regroups the mailbox without changing selection', () => {
  const store = newStore()
  store.currentAccountId = 1
  store.currentAccount = {accountId: 1, allReceive: 0}
  const accounts = reactive([{accountId: 1, latestEmailTime: null}, {accountId: 2, latestEmailTime: null}])
  const groups = computed(() => groupAccounts(accounts, store.receivedAccountIds))
  assert.equal(groups.value[0].items.length, 0)
  store.markReceived('2')
  assert.deepEqual(groups.value[0].items.map(account => account.accountId), [2])
  assert.deepEqual(groups.value[1].items.map(account => account.accountId), [1])
  assert.equal(store.currentAccountId, 1)
  assert.equal(store.currentAccount.accountId, 1)
  // A stale list response cannot erase evidence already received through the socket.
  accounts[1] = {accountId: 2, latestEmailTime: null}
  assert.equal(groups.value[0].items[0].accountId, 2)
})

test('receipt notifications for missing or invalid account IDs do not create phantom mailboxes', () => {
  const store = newStore()
  for (const id of [undefined, null, '', 0, -1, 1.5, NaN, 'not-an-id']) store.markReceived(id)
  assert.deepEqual(Object.keys(store.receivedAccountIds), [])
  store.markReceived(9)
  store.markReceived(9)
  assert.deepEqual(Object.keys(store.receivedAccountIds), ['9'])
  assert.deepEqual(groupAccounts([], store.receivedAccountIds).map(group => group.items), [[], []])
})

const inboxSource = readFileSync(new URL('../src/views/email/index.vue', import.meta.url), 'utf8')
const inboxScript = inboxSource.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import\b[\s\S]*?;\r?\n/gm, '')

// Run the actual inbox callbacks with transport/lifecycle dependencies replaced.
function mountInbox(store) {
  const timers = []
  let mount, callbacks
  const context = vm.createContext({
    console,
    ref,
    defineOptions: () => {},
    onMounted: callback => { mount = callback },
    onBeforeUnmount: () => {},
    watch: () => {},
    useEmailStore: () => ({}),
    useAccountStore: () => store,
    useSettingStore: () => ({settings: {autoRefresh: 0}}),
    isAutoRefreshEnabled: () => true,
    inboxWs: {start: options => { callbacks = options }},
    window: {
      setTimeout: callback => { timers.push(callback); return timers.length },
      clearTimeout: () => {},
    },
  })
  vm.runInContext(inboxScript, context)
  mount()
  return {callbacks, timers}
}

test('mail for an unselected mailbox updates its group without refreshing the selected inbox', () => {
  const store = newStore()
  store.currentAccountId = 1
  store.currentAccount = {accountId: 1, allReceive: 0}
  const {callbacks, timers} = mountInbox(store)
  callbacks.onMessage({type: 'new_message', accountId: 2})
  assert.equal(store.receivedAccountIds[2], true)
  assert.equal(timers.length, 0)
  callbacks.onMessage({type: 'new_message', accountId: 1})
  assert.equal(store.receivedAccountIds[1], true)
  assert.equal(timers.length, 1)
})

test('socket reconnection requests both mailbox-history and message catch-up', () => {
  const store = newStore()
  const {callbacks, timers} = mountInbox(store)
  const previousVersion = store.listRefreshVersion
  callbacks.onReconnect()
  assert.equal(store.listRefreshVersion, previousVersion + 1)
  assert.equal(timers.length, 1)
})
