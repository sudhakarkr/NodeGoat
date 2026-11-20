'use strict';

// Regression test for SSJS injection via eval() in handleContributionsUpdate.
// The original code evaluates req.body.* with eval(), allowing arbitrary code
// execution. The fix uses parseInt(), so a malicious payload becomes NaN and
// never reaches the DAO or executes side effects.

const path = require('path');
const assert = require('assert');

const modulePath = path.join(__dirname, '..', 'app', 'routes', 'contributions.js');
const ContributionsHandler = require(modulePath);

// Sentinel that would be flipped if eval() ran attacker-controlled code.
global.__vmp_pwned = false;

// Minimal fake DB / DAO environment. The DAO constructor just stores db;
// we don't invoke update() in the failure path because validation should
// reject non-numeric input first.
const fakeDb = {
    collection: () => ({
        // no-ops; should never be reached in this test
        findOne: () => {},
        update: () => {},
        updateOne: () => {}
    })
};

const handler = new ContributionsHandler(fakeDb);

// Payload that, under eval(), sets the sentinel to true and returns 5.
// Under parseInt(), it parses to NaN (string doesn't start with a digit).
const evilPayload = '(global.__vmp_pwned = true, 5)';

const req = {
    body: {
        preTax: evilPayload,
        afterTax: '5',
        roth: '5'
    },
    session: { userId: 1 }
};

let rendered = null;
let nextErr = null;

const res = {
    render: (view, locals) => {
        rendered = { view, locals };
    }
};

const next = (err) => {
    nextErr = err;
};

try {
    handler.handleContributionsUpdate(req, res, next);
} catch (e) {
    // Fixed code may throw if parseInt path encounters something odd; that's
    // still fine — what matters is the sentinel was not flipped.
}

if (global.__vmp_pwned === true) {
    console.error('FAIL: eval() executed attacker-controlled payload (SSJS injection present).');
    process.exit(1);
}

// Additionally confirm the handler treated the malicious string as invalid
// rather than silently passing a numeric value derived from eval.
// Under the fix: either next(Error) was called, or an "Invalid contribution
// percentages" render occurred. Under the original code (if the payload
// somehow didn't flip the sentinel), eval would produce 5 and the request
// would proceed to the DAO update — neither next-with-error nor an
// updateError render would happen.
const gotError = nextErr instanceof Error;
const gotInvalidRender = rendered && rendered.locals && typeof rendered.locals.updateError === 'string';

assert.ok(
    gotError || gotInvalidRender,
    'Expected handler to reject non-numeric contribution input (via next(err) or updateError render), ' +
    'but it accepted the malicious payload.'
);

console.log('OK: eval() no longer executes request body; malicious payload rejected.');
process.exit(0);
