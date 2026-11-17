    import { defineStore } from 'pinia'

export const useAccountStore = defineStore('account', {
    state: () => ({
        currentAccountId: 0,
        currentAccount: {},
        changeUserAccountName: '',
        receivedAccountIds: {},
        listRefreshVersion: 0,
    }),
    actions: {
        markReceived(accountId) {
            const id = Number(accountId)
            if (Number.isInteger(id) && id > 0) this.receivedAccountIds[id] = true
        },
        requestListRefresh() {
            this.listRefreshVersion++
        },
    },
})
