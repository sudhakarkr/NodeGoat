'use strict';

// Regression test for SSJS injection via eval() in contributions handler.
// Before the fix: req.body.preTax is passed to eval(), so a payload like
// "global.__PWNED__ = true, 5" will execute arbitrary JS AND evaluate to 5
// (so it passes isNaN/>=0 validation and reaches the DAO).
// After the fix: parseInt() is used, which cannot execute arbitrary code.

const path = require('path');
const assert = require('assert');
const Module = require('module');

// Stub out the ContributionsDAO require so we don't need a real DB.
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;

const daoStubPath = '__stub_contributions_dao__';
const configStubPath = '__stub_config__';

const daoCalls = [];

Module._load = function(request, parent, ...rest) {
    if (request === '../data/contributions-dao') {
        return {
            ContributionsDAO: function(db) {
                this.getByUserId = (userId, cb) => cb(null, {});
                this.update = (userId, preTax, afterTax, roth, cb) => {
                    daoCalls.push({ userId, preTax, afterTax, roth });
                    cb(null, {});
                };
            }
        };
    }
    if (request === '../../config/config') {
        return { environmentalScripts: [] };
    }
    return originalLoad.call(this, request, parent, ...rest);
};

const modulePath = path.resolve(__dirname, '..', 'app', 'routes', 'contributions.js');
// We need to require it as if from app/routes/, so that the relative requires
// resolve. Easiest: require the absolute path; the relative requires inside
// are intercepted by our _load hook above.
const ContributionsHandler = require(modulePath);

// Ensure the sentinel is not set beforehand.
delete global.__SSJS_PWNED__;

const handler = new ContributionsHandler({});

// Craft a payload that:
//  - Under eval(): executes `global.__SSJS_PWNED__ = true` as a side effect,
//    and the comma operator yields 5 (a valid number) so it passes validation.
//  - Under parseInt(): parses the leading digits (none before the identifier),
//    yielding NaN, so no injection occurs and no DB update happens.
const injectionPayload = "(global.__SSJS_PWNED__ = true, 5)";

const req = {
    body: {
        preTax: injectionPayload,
        afterTax: "5",
        roth: "5"
    },
    session: { userId: 'test-user' }
};

let renderedView = null;
const res = {
    render: (view, opts) => { renderedView = { view, opts }; }
};

function next(err) {
    if (err) throw err;
}

handler.handleContributionsUpdate(req, res, next);

// The core assertion: arbitrary code must NOT have executed.
if (global.__SSJS_PWNED__ === true) {
    console.error('VULNERABLE: eval() executed injected JS payload (global.__SSJS_PWNED__ was set).');
    process.exit(1);
}

// Secondary assertion: with parseInt, the preTax payload parses to NaN,
// so the handler must render the "Invalid contribution percentages" error
// rather than calling the DAO.update.
assert.strictEqual(daoCalls.length, 0, 'DAO.update should not be called with invalid input');
assert.ok(renderedView, 'A view should have been rendered');
assert.strictEqual(
    renderedView.opts.updateError,
    'Invalid contribution percentages',
    'Expected invalid-contribution error for non-numeric payload under parseInt'
);

console.log('OK: SSJS injection payload did not execute and was rejected as invalid.');
process.exit(0);
