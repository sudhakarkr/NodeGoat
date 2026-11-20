'use strict';

// Regression test: ensure req.body.preTax is NOT passed to eval().
// In the original code, eval(req.body.preTax) would execute arbitrary
// JavaScript. We inject a payload that sets a global flag when eval'd.
// If the flag is set after handling the request, eval ran -> fail.

const path = require('path');
const assert = require('assert');

// Stub out the DAO module before requiring the handler.
const Module = require('module');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;

const daoPath = path.resolve(__dirname, '../app/data/contributions-dao.js');
const configPath = path.resolve(__dirname, '../config/config.js');

require.cache[daoPath] = {
    id: daoPath,
    filename: daoPath,
    loaded: true,
    exports: {
        ContributionsDAO: function ContributionsDAO() {
            this.getByUserId = function (userId, cb) { cb(null, {}); };
            this.update = function (userId, preTax, afterTax, roth, cb) {
                cb(null, {});
            };
        }
    }
};

require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { environmentalScripts: [] }
};

const ContributionsHandler = require('../app/routes/contributions.js');

const handler = new ContributionsHandler({});

// Payload: valid JS expression that has a side effect (sets a global flag)
// AND evaluates to a number so it would pass the numeric validation branch.
global.__EVAL_PWNED__ = false;
const payload = '(global.__EVAL_PWNED__ = true, 5)';

const req = {
    body: { preTax: payload, afterTax: '5', roth: '5' },
    session: { userId: 1 }
};

let rendered = false;
let nextCalled = false;
const res = {
    render: function () { rendered = true; }
};
const next = function () { nextCalled = true; };

try {
    handler.handleContributionsUpdate(req, res, next);
} catch (e) {
    // Fine — the fixed code may reject non-numeric input; what matters is
    // that eval did not execute the payload.
}

if (global.__EVAL_PWNED__ === true) {
    console.error('FAIL: req.body.preTax was passed through eval(); side effect executed.');
    process.exit(1);
}

// Also: with Number(), the payload string is NaN. The fixed code must not
// treat it as a valid numeric contribution of 5 (which eval would have made it).
// So either next(err) is called, or render is called with updateError — but
// the DAO update callback path (which would set updateSuccess) must NOT run
// with this payload. We accept either rendered-with-error or next-called;
// the key assertion is simply that eval did not fire, already checked above.

console.log('OK: eval() was not used on req.body.preTax');
process.exit(0);
