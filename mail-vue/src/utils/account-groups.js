// Group only the rendered view: the original order is the API pagination cursor.
export function groupAccounts(accounts, receivedAccountIds = {}) {
  const received = {key: 'received', title: 'accountsReceived', items: []}
  const neverReceived = {key: 'neverReceived', title: 'accountsNeverReceived', items: []}
  for (const account of accounts) {
    const group = account.latestEmailTime || receivedAccountIds[account.accountId] ? received : neverReceived
    group.items.push(account)
  }
  return [received, neverReceived]
}
