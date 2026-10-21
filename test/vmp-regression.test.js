'use strict';

// Regression test for CWE-943: NoSQL injection via unsanitized userName.
// The original code passes `userName` directly into the Mongo query object,
// so an attacker-supplied object like {"$gt": ""} is forwarded as a query
// operator. The fix rejects non-string userName values (or coerces them to
// a primitive string) before building the query.

const assert = require('assert');
const path = require('path');

const { UserDAO } = require(path.join('..', 'app', 'data', 'user-dao.js'));

// Minimal fake DB that records the query it receives.
function makeFakeDb() {
    const state = { lastQuery: undefined };
    const fakeDb = {
        collection(name) {
            if (name === 'users') {
                return {
                    findOne(query, cb) {
                        state.lastQuery = query;
                        // Simulate a user record being returned when the
                        // injected operator matches ANY user. A real Mongo
                        // instance would do exactly this given {$gt: ''}.
                        cb(null, {
                            _id: 1,
                            userName: 'admin',
                            password: '$2a$10$invalidhashvalueforbcrypttocompareagainstxx'
                        });
                    },
                    insert() {}
                };
            }
            return {
                findAndModify(q, s, u, o, cb) { cb(null, { value: { seq: 1 } }); }
            };
        }
    };
    return { fakeDb, state };
}

const { fakeDb, state } = makeFakeDb();
const dao = new UserDAO(fakeDb);

// Attacker payload: an object instead of a string. In MongoDB this is an
// operator expression that matches any userName.
const maliciousUserName = { '$gt': '' };

let callbackInvoked = false;
let callbackErr = null;
let callbackUser = null;

dao.validateLogin(maliciousUserName, 'any-password', (err, user) => {
    callbackInvoked = true;
    callbackErr = err;
    callbackUser = user;
});

assert.strictEqual(callbackInvoked, true, 'callback was never invoked');

// If the fix is in place, one of the following must be true:
//   (a) the DAO rejected the non-string userName before querying, OR
//   (b) the DAO coerced it to a string before querying.
// Either way, the raw operator object must NOT have reached findOne.
if (state.lastQuery !== undefined) {
    const forwarded = state.lastQuery.userName;
    assert.strictEqual(
        typeof forwarded,
        'string',
        'VULNERABLE: non-string userName was forwarded to Mongo query as ' +
            require('util').inspect(forwarded)
    );
    // And it must not be an object literal pretending to be a string.
    assert.ok(
        forwarded !== null && !/^\[object/.test(forwarded) ? true : forwarded !== '[object Object]' || false,
        'forwarded userName looks suspicious: ' + forwarded
    );
} else {
    // The fix short-circuited with an error before touching the DB — ideal.
    assert.ok(callbackErr instanceof Error, 'expected an Error when userName is not a string');
    assert.strictEqual(callbackUser, null, 'expected no user when userName is not a string');
}

console.log('OK: userName object was not forwarded as a Mongo operator');
