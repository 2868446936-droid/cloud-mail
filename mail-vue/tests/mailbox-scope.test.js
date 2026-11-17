import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import vm from 'node:vm'
import {createPinia, setActivePinia} from 'pinia'
import {effectScope, nextTick, reactive, ref, watch} from 'vue'
import {useAccountStore} from '../src/store/account.js'

const legacyMailbox = Object.freeze({accountId: 8, email: 'sdfh5ds@example.com', allReceive: 1})
const otherMailbox = Object.freeze({accountId: 9, email: 'other@example.com', allReceive: 0})

function newStore() {
  setActivePinia(createPinia())
  return useAccountStore()
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return {promise, resolve}
}

// Run the real view scripts with transport/lifecycle dependencies replaced, while
// retaining actual Vue watchers and the actual Pinia store used by the sidebar.
function mountView(kind, store, overrides = {}) {
  const source = readFileSync(new URL(`../src/views/${kind}/index.vue`, import.meta.url), 'utf8')
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1]
    .replace(/^import\b[\s\S]*?;\r?\n/gm, '')
  const calls = [], added = [], applied = [], timers = new Map()
  let mount, callbacks, refreshes = 0, timerId = 0
  const emailStore = reactive({
    searchParams: {text: '', startDate: '', endDate: ''},
    fetchList: request => request(0),
    applyFullList: list => applied.push(list),
    contentData: {},
  })
  const sendStore = reactive({searchParams: {text: '', startDate: '', endDate: ''}})
  const viewScope = effectScope()
  const context = vm.createContext({
    console,
    ref,
    watch,
    defineOptions: () => {},
    onMounted: callback => { mount = callback },
    onBeforeUnmount: () => {},
    useEmailStore: () => emailStore,
    useSendStore: () => sendStore,
    useAccountStore: () => store,
    useSettingStore: () => ({settings: {autoRefresh: 0}}),
    isAutoRefreshEnabled: () => true,
    inboxWs: {start: options => { callbacks = options }, stop() {}, sync() {}, retryNow() {}},
    emailList: async (...args) => {
      calls.push(args)
      return {list: [], total: 0, latestEmail: {emailId: 0}}
    },
    emailLatest: overrides.emailLatest || (async () => []),
    sleep: overrides.sleep || (async () => {}),
    window: {
      setTimeout: callback => { timers.set(++timerId, callback); return timerId },
      clearTimeout: id => timers.delete(id),
    },
  })
  const exposed = kind === 'email' ? 'getEmailList, pullLatest, scroll' : 'getEmailList, sendScroll'
  viewScope.run(() => vm.runInContext(script + `\nglobalThis.exposed = {${exposed}}`, context))
  const scroll = kind === 'email' ? context.exposed.scroll : context.exposed.sendScroll
  scroll.value = {
    firstLoad: false,
    latestEmail: {emailId: 0, reqAccountId: store.currentAccountId, allReceive: store.currentAllReceive},
    refreshList: () => { refreshes++ },
    addItem: email => added.push(email),
  }
  mount()
  return {
    ...context.exposed,
    calls, added, applied, timers, callbacks,
    get refreshes() { return refreshes },
    dispose: () => viewScope.stop(),
  }
}

test('selecting a named mailbox ignores a legacy aggregate preference without rewriting it', () => {
  const store = newStore()
  store.selectAccount(legacyMailbox)
  assert.equal(store.currentAccountId, 8)
  assert.equal(store.currentAllReceive, 0)
  assert.equal(store.showAllMail, false)
  assert.equal(store.currentAccount.allReceive, 1)
  assert.equal(legacyMailbox.allReceive, 1)
})

test('aggregate viewing is explicit and another named mailbox returns to single-mailbox scope', () => {
  const store = newStore()
  store.selectAccount(legacyMailbox, true)
  assert.equal(store.currentAllReceive, 1)
  store.selectAccount(otherMailbox)
  assert.equal(store.currentAccountId, 9)
  assert.equal(store.currentAllReceive, 0)
})

test('refreshing server account metadata cannot change the requested viewing scope', () => {
  const store = newStore()
  store.selectAccount(legacyMailbox)
  store.currentAccount = {...legacyMailbox, allReceive: 1}
  assert.equal(store.currentAllReceive, 0)
  store.selectAccount(legacyMailbox, true)
  store.currentAccount = {...legacyMailbox, allReceive: 0}
  assert.equal(store.currentAllReceive, 1)
  store.selectAccount(null)
  assert.equal(store.currentAccountId, 0)
  assert.equal(store.currentAllReceive, 0)
})

for (const [kind, type] of [['email', 0], ['send', 1]]) {
  test(`${kind} requests use explicit single-mailbox scope despite the saved allReceive flag`, async t => {
    const store = newStore()
    store.selectAccount(legacyMailbox)
    const view = mountView(kind, store)
    t.after(view.dispose)
    const result = await view.getEmailList(0, 50)
    assert.deepEqual(view.calls[0].slice(0, 7), [8, 0, 0, 0, 50, type, 0])
    assert.equal(result.latestEmail.reqAccountId, 8)
    assert.equal(result.latestEmail.allReceive, 0)
    store.selectAccount(legacyMailbox, true)
    await nextTick()
    await view.getEmailList(0, 50)
    assert.equal(view.calls[1][1], 1)
  })
}

test('clicking the same mailbox after aggregate viewing refreshes both inbox and sent views', async t => {
  const store = newStore()
  store.selectAccount(legacyMailbox, true)
  const inbox = mountView('email', store)
  const sent = mountView('send', store)
  t.after(inbox.dispose)
  t.after(sent.dispose)
  store.selectAccount(legacyMailbox)
  await nextTick()
  assert.equal(store.currentAccountId, 8)
  assert.equal(store.currentAllReceive, 0)
  assert.equal(inbox.refreshes, 1)
  assert.equal(sent.refreshes, 1)
  store.currentAccount = {...legacyMailbox}
  await nextTick()
  assert.equal(inbox.refreshes, 1)
  assert.equal(sent.refreshes, 1)
})

test('socket messages from another mailbox do not refresh a named inbox with a legacy aggregate flag', t => {
  const store = newStore()
  store.selectAccount(legacyMailbox)
  const view = mountView('email', store)
  t.after(view.dispose)
  view.callbacks.onMessage({type: 'new_message', accountId: 9})
  assert.equal(store.receivedAccountIds[9], true)
  assert.equal(view.timers.size, 0)
  store.selectAccount(legacyMailbox, true)
  view.callbacks.onMessage({type: 'new_message', accountId: 9})
  assert.equal(view.timers.size, 1)
})

test('an aggregate realtime response is discarded after returning to the same named mailbox', async t => {
  const pending = deferred()
  const store = newStore()
  store.selectAccount(legacyMailbox, true)
  const view = mountView('email', store, {emailLatest: () => pending.promise})
  t.after(view.dispose)
  const pull = view.pullLatest()
  store.selectAccount(legacyMailbox)
  await nextTick()
  pending.resolve([{emailId: 30, accountId: 9}])
  await pull
  assert.equal(view.applied.length, 0)
  assert.equal(view.added.length, 0)
})

test('a delayed realtime insertion stops when viewing scope changes between messages', async t => {
  const delayedInsertion = deferred()
  const insertionStarted = deferred()
  const store = newStore()
  store.selectAccount(legacyMailbox, true)
  const view = mountView('email', store, {
    emailLatest: async () => [{emailId: 30, accountId: 9}, {emailId: 31, accountId: 9}],
    sleep: () => { insertionStarted.resolve(); return delayedInsertion.promise },
  })
  t.after(view.dispose)
  const pull = view.pullLatest()
  await insertionStarted.promise
  assert.deepEqual(view.added.map(email => email.emailId), [30])
  store.selectAccount(legacyMailbox)
  await nextTick()
  delayedInsertion.resolve()
  await pull
  assert.deepEqual(view.added.map(email => email.emailId), [30])
})

test('leaving and returning to the same aggregate scope still invalidates an old realtime request', async t => {
  const pending = deferred()
  const store = newStore()
  store.selectAccount(legacyMailbox, true)
  const view = mountView('email', store, {emailLatest: () => pending.promise})
  t.after(view.dispose)
  const pull = view.pullLatest()
  store.selectAccount(otherMailbox)
  await nextTick()
  store.selectAccount(legacyMailbox, true)
  await nextTick()
  pending.resolve([{emailId: 32, accountId: 9}])
  await pull
  assert.equal(view.applied.length, 0)
  assert.equal(view.added.length, 0)
})
