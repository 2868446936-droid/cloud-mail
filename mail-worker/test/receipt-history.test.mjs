import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import vm from 'node:vm';

const emailConst = {type: {RECEIVE: 0, SEND: 1}, status: {RECEIVE: 0, DELIVERED: 2, SAVING: 6, NOONE: 7, BOUNCED: 3}};

function service(name, dependencies = {}) {
	const source = readFileSync(new URL(`../src/service/${name}-service.js`, import.meta.url), 'utf8')
		.replace(/^import .*$/gm, '')
		.replace(/^export default .*$/gm, '');
	const scope = vm.createContext({emailConst, ...dependencies});
	vm.runInContext(`${source}\nglobalThis.service = ${name}Service`, scope);
	return scope.service;
}

function database(t) {
	const db = new DatabaseSync(':memory:');
	t.after(() => db.close());
	db.exec(`
		CREATE TABLE account (account_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, latest_email_time TEXT);
		CREATE TABLE email (email_id INTEGER PRIMARY KEY, account_id INTEGER, user_id INTEGER, type INTEGER,
			status INTEGER, create_time TEXT, is_del INTEGER DEFAULT 0);
	`);
	const bindingSizes = [];
	const c = {env: {db: {prepare(sql) {
		return {bind(...values) {
			bindingSizes.push(values.length);
			return {run: async () => db.prepare(sql).run(...values)};
		}};
	}}}};
	const addAccount = (id, userId = 1, time = null) => db.prepare('INSERT INTO account VALUES (?, ?, ?)').run(id, userId, time);
	const addEmail = (id, accountId, {userId = 1, type = 0, status = 0, time = '2026-11-17 10:00:00', deleted = 0} = {}) =>
		db.prepare('INSERT INTO email VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, accountId, userId, type, status, time, deleted);
	const marker = id => db.prepare('SELECT latest_email_time AS time FROM account WHERE account_id = ?').get(id)?.time;
	return {db, c, addAccount, addEmail, marker, bindingSizes};
}

test('legacy backfill includes soft-deleted receipts, excludes outgoing/unfinished mail, and stays within the owner', async t => {
	const {c, addAccount, addEmail, marker} = database(t);
	for (const id of [1, 2, 3, 4, 6]) addAccount(id);
	addAccount(5, 2);
	addEmail(1, 1);
	addEmail(2, 1, {time: '2026-11-17 12:00:00', deleted: 1});
	addEmail(3, 2, {type: 1, status: 2});
	addEmail(4, 3, {status: 6});
	addEmail(5, 4, {status: 7});
	addEmail(6, 5, {userId: 2});
	addEmail(7, 6, {userId: 2});
	await service('account').preserveReceivedHistory(c, {userId: 1});
	assert.equal(marker(1), '2026-11-17 12:00:00');
	for (const id of [2, 3, 4, 5, 6]) assert.equal(marker(id), null);
});

test('receipt history survives deleting all mail and cannot be overwritten by an older arrival', async t => {
	const {db, c, addAccount, addEmail, marker} = database(t);
	addAccount(1);
	addEmail(1, 1);
	const accounts = service('account');
	await accounts.preserveReceivedHistory(c, {userId: 1});
	db.exec('DELETE FROM email');
	await accounts.preserveReceivedHistory(c, {userId: 1});
	await accounts.markReceived(c, {accountId: 1, userId: 1, type: 0, status: 0, createTime: '2026-11-16 10:00:00'});
	assert.equal(marker(1), '2026-11-17 10:00:00');
	await accounts.markReceived(c, {accountId: 1, userId: 1, type: 0, status: 0, createTime: '2026-11-18 10:00:00'});
	assert.equal(marker(1), '2026-11-18 10:00:00');
});

test('only a completed incoming message for the mailbox owner can set the live marker', async t => {
	const {c, addAccount, marker} = database(t);
	addAccount(1);
	const accounts = service('account');
	const received = {accountId: 1, userId: 1, type: 0, status: 0, createTime: '2026-11-17 10:00:00'};
	for (const change of [{type: 1}, {status: 6}, {status: 7}, {userId: 2}, {accountId: 0}, {userId: 0}]) {
		await accounts.markReceived(c, {...received, ...change});
		assert.equal(marker(1), null);
	}
	await accounts.markReceived(c, received);
	assert.equal(marker(1), received.createTime);
});

test('targeted deletion backfill handles more than D1 parameter limits without changing unrelated accounts', async t => {
	const {c, addAccount, addEmail, marker, bindingSizes} = database(t);
	const ids = Array.from({length: 105}, (_, i) => i + 1);
	for (const id of ids) { addAccount(id); addEmail(id, id); }
	addAccount(200); addEmail(200, 200);
	await service('account').preserveReceivedHistory(c, {emailIds: ids});
	for (const id of ids) assert.equal(marker(id), '2026-11-17 10:00:00');
	assert.equal(marker(200), null);
	assert.deepEqual(bindingSizes, [100, 5]);
});

test('empty preservation scope cannot run a global backfill', async t => {
	const {c, addAccount, addEmail, marker, bindingSizes} = database(t);
	addAccount(1); addEmail(1, 1);
	const accounts = service('account');
	await accounts.preserveReceivedHistory(c);
	await accounts.preserveReceivedHistory(c, {emailIds: []});
	await accounts.preserveReceivedHistory(c, {emailIds: [0, '1', -1, NaN]});
	assert.equal(marker(1), null);
	assert.deepEqual(bindingSizes, []);
});

test('the first account page backfills all user addresses without repeating the update for later pages', async t => {
	const {c, addAccount, addEmail, marker, bindingSizes} = database(t);
	addAccount(1); addEmail(1, 1);
	addAccount(40); addEmail(40, 40);
	const chain = {from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain, all: async () => []};
	const noop = () => {};
	const accounts = service('account', {
		orm: () => ({select: () => chain}), account: {}, isDel: {NORMAL: 0},
		and: noop, eq: noop, or: noop, lt: noop, gt: noop, desc: noop, asc: noop
	});
	await accounts.list(c, {accountId: 0, size: 30}, 1);
	assert.equal(marker(1), '2026-11-17 10:00:00');
	assert.equal(marker(40), '2026-11-17 10:00:00');
	await accounts.list(c, {accountId: 30, size: 30, lastSort: 0}, 1);
	assert.deepEqual(bindingSizes, [1]);
});

test('Cloudflare completion records receipt after successful storage and returns the stored email', async () => {
	const calls = [];
	const row = {emailId: 5, type: 0, status: 0, accountId: 1, userId: 1, createTime: '2026-11-17 10:00:00'};
	const chain = {
		set: () => chain, where: () => chain, returning: () => chain,
		get: async () => { calls.push('stored'); return row; }
	};
	const emails = service('email', {
		orm: () => ({update: () => chain}), email: {}, isDel: {NORMAL: 0}, eq: () => {},
		accountService: {markReceived: async (_c, saved) => { assert.equal(saved, row); calls.push('marked'); }}
	});
	assert.equal(await emails.completeReceive({}, 0, 5), row);
	assert.deepEqual(calls, ['stored', 'marked']);
});

test('physical deletion preserves legacy evidence before deleting the received email', async t => {
	const {db, c, addAccount, addEmail, marker} = database(t);
	addAccount(1); addEmail(1, 1);
	const chain = {where: () => chain, run: async () => db.exec('DELETE FROM email WHERE email_id = 1')};
	const emails = service('email', {
		accountService: service('account'),
		attService: {removeByEmailIds: async () => {}}, starService: {removeByEmailIds: async () => {}},
		orm: () => ({delete: () => chain}), email: {}, inArray: () => {}
	});
	await emails.physicsDelete(c, {emailIds: '1'});
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email').get().n, 0);
	assert.equal(marker(1), '2026-11-17 10:00:00');
});

test('on-site delivery marks the receiver before notifying and never marks the sender', async t => {
	const {c, addAccount, marker} = database(t);
	addAccount(1); addAccount(2);
	c.env.admin = 'receiver@example.com';
	const order = [];
	const receiver = {accountId: 1, userId: 1, email: 'receiver@example.com'};
	let insertValues;
	const select = {from: () => select, where: () => select, all: async () => [receiver]};
	const insert = {values: values => {insertValues = values; return insert;}, returning: () => insert, get: async () => {
		order.push('stored'); return {...insertValues, emailId: 10};
	}};
	const update = {set: () => update, where: () => update, run: async () => {}};
	const accounts = service('account');
	const emails = service('email', {
		settingService: {query: async () => ({noRecipient: 0})},
		orm: () => ({select: () => select, insert: () => insert, update: () => update}),
		account: {}, email: {}, sql: () => {}, inArray: () => {}, eq: () => {},
		roleService: {selectByUserIds: async () => [{userId: 1, banEmail: '', availDomain: ''}]},
		emailUtils: {getName: value => value.split('@')[0]},
		accountService: {markReceived: async (...args) => {await accounts.markReceived(...args); order.push('marked');}},
		notifyMailWsFromContext: () => order.push('notified')
	});
	const result = await emails.HandleOnSiteEmail(c, [receiver.email], {
		emailId: 7, accountId: 2, userId: 1, type: 1, createTime: '2026-11-17 12:00:00'
	}, []);
	assert.equal(result.length, 1);
	assert.equal(marker(1), '2026-11-17 12:00:00');
	assert.equal(marker(2), null);
	assert.deepEqual(order, ['stored', 'marked', 'notified']);
});
