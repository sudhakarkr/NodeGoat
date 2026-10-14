'use strict';

// Regression test for SSRF in app/routes/research.js
// The original code builds `url = req.query.url + req.query.symbol` and
// passes it directly to needle.get, allowing an attacker to supply ANY URL
// (e.g. http://169.254.169.254/ or http://evil.example.com/).
// The fix restricts req.query.url to a known allowlist and validates the symbol.
//
// This test stubs out `needle` via require.cache so that calling needle.get
// records the URL instead of making a real network call. It then invokes
// the handler with an attacker-controlled URL and asserts that no outbound
// request to that URL is made (fixed behaviour), while the vulnerable code
// WOULD have called needle.get with the attacker's URL.

const path = require('path');
const assert = require('assert');
const Module = require('module');

// --- Stub `needle` before loading the module under test ---
const needleStubCalls = [];
const needleStubPath = require.resolve('needle');
require.cache[needleStubPath] = {
    id: needleStubPath,
    filename: needleStubPath,
    loaded: true,
    exports: {
        get: function (url, cb) {
            needleStubCalls.push(url);
            // Simulate an immediate error so the handler finishes synchronously-ish.
            process.nextTick(() => cb(new Error('stubbed'), null, null));
        }
    }
};

const researchModulePath = path.resolve(__dirname, '../app/routes/research.js');
const ResearchHandler = require(researchModulePath);

// Minimal fake res object capturing status and body.
function makeRes() {
    const res = {
        statusCode: 200,
        _status: null,
        _written: [],
        _ended: false,
        _headers: null,
        writeHead: function (code, headers) { this.statusCode = code; this._headers = headers; },
        status: function (code) { this._status = code; this.statusCode = code; return this; },
        write: function (chunk) { this._written.push(String(chunk)); },
        end: function (chunk) { if (chunk) this._written.push(String(chunk)); this._ended = true; return this; },
        render: function () { this._ended = true; }
    };
    return res;
}

const handler = new ResearchHandler(/* db */ {});

const attackerUrl = 'http://169.254.169.254/latest/meta-data/';
const req = { query: { url: attackerUrl, symbol: 'AAPL' } };
const res = makeRes();

handler.displayResearch(req, res);

// Give the nextTick callback a chance to fire if it was scheduled.
setImmediate(() => {
    const attackerCall = needleStubCalls.find(u => typeof u === 'string' && u.indexOf('169.254.169.254') !== -1);
    if (attackerCall) {
        console.error('VULNERABLE: needle.get was called with attacker-controlled URL:', attackerCall);
        process.exit(1);
    }
    // Also assert the response indicates rejection (fixed code returns 400).
    assert.strictEqual(res.statusCode, 400, 'Expected handler to reject disallowed URL with 400, got ' + res.statusCode);
    console.log('OK: SSRF blocked, no outbound request to attacker URL.');
    process.exit(0);
});
