    import { defineStore } from 'pinia'

export const useAccountStore = defineStore('account', {
    state: () => ({
        currentAccountId: 0,
        currentAccount: {},
        showAllMail: false,
        changeUserAccountName: '',
        receivedAccountIds: {},
        listRefreshVersion: 0,
    }),
    getters: {
        // Viewing scope is explicit UI state, never a legacy mailbox preference.
        currentAllReceive: state => state.showAllMail ? 1 : 0,
    },
    actions: {
        selectAccount(account, allReceive = false) {
            this.$patch({
                currentAccountId: account?.accountId || 0,
                currentAccount: account || {},
                showAllMail: Boolean(account && allReceive),
            })
        },
        markReceived(accountId) {
            const id = Number(accountId)
            if (Number.isInteger(id) && id > 0) this.receivedAccountIds[id] = true
        },
        requestListRefresh() {
            this.listRefreshVersion++
        },
    },
})
