import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/components/email-scroll/index.vue', import.meta.url), 'utf8')
const requestStart = source.indexOf('function getEmailList(refresh = false)')
const requestCode = source.slice(requestStart, source.indexOf('\nfunction handleList(', requestStart))
const refreshStart = source.indexOf('function refreshList()')
const refreshCode = source.slice(refreshStart, source.indexOf('\nfunction loadData()', refreshStart))

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return {promise, resolve, reject}
}

// Run the component's real request functions with only transport and rendering
// dependencies replaced, so deliberately reordered responses exercise production code.
function mountRequests({delay = false} = {}) {
  const calls = [], sleeps = []
  let clock = 0, scope = 'all'
  const state = {
    emailList: [],
    loading: {value: false},
    followLoading: {value: false},
    noLoading: {value: false},
    latestEmail: {value: null},
    firstLoad: {value: true},
    total: {value: 0},
    checkAll: {value: false},
    isIndeterminate: {value: false},
  }
  const context = vm.createContext({
    ...state,
    requestGeneration: 0,
    reqLock: false,
    scrollTop: 0,
    queryParam: {size: 2},
    getSkeletonRows: () => {},
    handleList: () => {},
    scrollbarRef: {value: null},
    Date: {now: () => delay ? 0 : (clock += 1000)},
    sleep: () => {
      const wait = deferred()
      sleeps.push(wait)
      return wait.promise
    },
    props: {
      getEmailList(emailId, size) {
        const request = {emailId, size, scope, ...deferred()}
        calls.push(request)
        return request.promise
      },
    },
  })
  vm.runInContext(requestCode + refreshCode, context)
  return {state, calls, sleeps, context, setScope: value => { scope = value }}
}

function response(ids, scope, total = ids.length) {
  return {list: ids.map(emailId => ({emailId})), total, latestEmail: {emailId: ids[0] || 0, reqAccountId: scope}}
}

test('switching from a pending all-mail request to an empty mailbox starts a fresh request and ignores the old result', async () => {
  const {state, calls, context, setScope} = mountRequests()
  const allRequest = context.getEmailList()
  setScope('sdfh5ds')
  const mailboxRequest = context.refreshList()
  assert.deepEqual(calls.map(call => call.scope), ['all', 'sdfh5ds'])
  calls[1].resolve(response([], 'sdfh5ds'))
  assert.equal(await mailboxRequest, true)
  calls[0].resolve(response([91, 90], 'all', 100))
  assert.equal(await allRequest, false)
  assert.deepEqual(state.emailList, [])
  assert.equal(state.total.value, 0)
  assert.equal(state.latestEmail.value.reqAccountId, 'sdfh5ds')
  assert.equal(state.noLoading.value, true)
})

test('refreshing the same mailbox supersedes an older request even though its account ID did not change', async () => {
  const {state, calls, context, setScope} = mountRequests()
  setScope('sdfh5ds')
  const first = context.getEmailList()
  const refreshed = context.refreshList()
  calls[0].resolve(response([9], 'sdfh5ds'))
  assert.equal(await first, false)
  assert.equal(state.loading.value, true)
  calls[1].resolve(response([], 'sdfh5ds'))
  assert.equal(await refreshed, true)
  assert.equal(state.emailList.length, 0)
})

test('an obsolete failure cannot release the current request lock or hide its loading state', async () => {
  const {state, calls, context} = mountRequests()
  const oldRequest = context.getEmailList()
  const currentRequest = context.refreshList()
  calls[0].reject(new Error('old request failed'))
  assert.equal(await oldRequest, false)
  assert.equal(state.loading.value, true)
  assert.equal(context.reqLock, true)
  assert.equal(await context.getEmailList(), false)
  assert.equal(calls.length, 2)
  calls[1].resolve(response([], 'current'))
  assert.equal(await currentRequest, true)
  assert.equal(state.loading.value, false)
  assert.equal(context.reqLock, false)
})

test('a scope switch during the skeleton delay cannot apply a stale response after that delay', async () => {
  const {state, calls, sleeps, context} = mountRequests({delay: true})
  const oldRequest = context.getEmailList()
  calls[0].resolve(response([15], 'old'))
  await new Promise(setImmediate)
  assert.equal(sleeps.length, 1)
  const currentRequest = context.refreshList()
  calls[1].resolve(response([], 'current'))
  await new Promise(setImmediate)
  assert.equal(sleeps.length, 2)
  sleeps[1].resolve()
  assert.equal(await currentRequest, true)
  sleeps[0].resolve()
  assert.equal(await oldRequest, false)
  assert.equal(state.emailList.length, 0)
  assert.equal(state.latestEmail.value.reqAccountId, 'current')
})

test('a refresh clears visible rows immediately and prevents an old pagination response from appending', async () => {
  const {state, calls, context} = mountRequests()
  const first = context.getEmailList()
  calls[0].resolve(response([20, 19], 'old', 4))
  await first
  const nextPage = context.getEmailList()
  assert.equal(calls[1].emailId, 19)
  const refreshed = context.refreshList()
  assert.equal(calls[2].emailId, 0)
  assert.deepEqual(Array.from(state.emailList), [])
  assert.equal(state.total.value, 0)
  assert.equal(state.latestEmail.value, null)
  calls[2].resolve(response([], 'current'))
  await refreshed
  calls[1].resolve(response([18, 17], 'old', 4))
  assert.equal(await nextPage, false)
  assert.equal(state.emailList.length, 0)
  assert.equal(state.total.value, 0)
})

test('normal pagination keeps its request lock and appends the next page once', async () => {
  const {state, calls, context} = mountRequests()
  const first = context.getEmailList()
  calls[0].resolve(response([3, 2], 'one', 3))
  await first
  const nextPage = context.getEmailList()
  assert.equal(await context.getEmailList(), false)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].emailId, 2)
  calls[1].resolve(response([1], 'one', 3))
  assert.equal(await nextPage, true)
  assert.deepEqual(Array.from(state.emailList, row => row.emailId), [3, 2, 1])
  assert.equal(state.noLoading.value, true)
  assert.equal(state.total.value, 3)
})
