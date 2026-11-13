"use strict";

const { describe, it, before, after } = require('mocha');
const assert = require('assert');
const vmp = require('./_vmp/harness');
const bcrypt = require('../../node_modules/bcrypt-nodejs');

describe('research-external-lookup journey', function () {
  this.timeout(15000);

  const data = vmp.data('research-external-lookup');

  // Build a bcrypt hash of the plaintext password so the in-memory user
  // record matches what validateLogin expects.
  const userRecord = data.record('user#0');
  const plainPassword = userRecord.password;
  const hashedPassword = bcrypt.hashSync(plainPassword, bcrypt.genSaltSync());
  const dbUser = Object.assign({}, userRecord, { password: hashedPassword });

  // Allowed research target: a safe external symbol/url pair
  const allowedUrl = 'http://vmp-test-external.example/';
  const allowedSymbol = 'VMPT';

  // Fake needle: captures calls and returns controlled responses
  let needleCalls = [];
  let needleResponse = {
    statusCode: 200,
    body: '<p>Stock data for VMPT</p>'
  };

  const fakeNeedle = {
    get: function (url, callback) {
      needleCalls.push(url);
      // Simulate async
      setImmediate(() => callback(null, { statusCode: needleResponse.statusCode }, needleResponse.body));
    }
  };

  describe('main path: login then fetch allowed research', function () {
    let app;
    let mongo;

    before(async function () {
      needleCalls = [];
      mongo = vmp.fakes.mongodb({
        users: [dbUser],
        counters: [{ _id: 'userId', seq: 1 }]
      });
      app = await vmp.boot('server.js', {
        fakes: {
          mongodb: mongo,
          needle: fakeNeedle
        },
        env: { NODE_ENV: 'test' }
      });
    });

    after(async function () {
      await app.close();
    });

    it('GET /login renders the login page', async function () {
      const res = await app.request('GET', '/login');
      assert.strictEqual(res.status, 200);
      assert.ok(res.text.includes('login') || res.text.includes('Login') || res.text.includes('userName'),
        'login page should contain login-related content');
    });

    it('POST /login with valid credentials redirects to /benefits (admin user)', async function () {
      const res = await app.request('POST', '/login', {
        form: { userName: userRecord.userName, password: plainPassword }
      });
      assert.strictEqual(res.status, 302);
      assert.ok(
        res.location === '/benefits' || res.location === '/dashboard',
        `expected redirect to /benefits or /dashboard, got ${res.location}`
      );
    });

    it('GET /research without symbol renders the research view', async function () {
      // First log in to establish session
      await app.request('POST', '/login', {
        form: { userName: userRecord.userName, password: plainPassword }
      });

      const res = await app.request('GET', '/research');
      assert.strictEqual(res.status, 200);
      assert.ok(
        res.text.includes('research') || res.text.includes('Research') || res.text.includes('stock'),
        'research page should contain research-related content'
      );
    });

    it('GET /research with symbol fetches via needle and returns content', async function () {
      needleCalls = [];
      // Establish session
      await app.request('POST', '/login', {
        form: { userName: userRecord.userName, password: plainPassword }
      });

      const res = await app.request('GET',
        `/research?url=${encodeURIComponent(allowedUrl)}&symbol=${encodeURIComponent(allowedSymbol)}`);

      assert.strictEqual(res.status, 200);
      assert.ok(needleCalls.length >= 1, 'needle.get should have been called');
      assert.strictEqual(needleCalls[0], allowedUrl + allowedSymbol);
      assert.ok(
        res.text.includes('stock information') || res.text.includes('VMPT') || res.text.includes('Stock data'),
        'response should include fetched content'
      );
    });
  });

  describe('refusal path: unauthenticated access to /research redirects to login', function () {
    let app;
    let mongo;

    before(async function () {
      mongo = vmp.fakes.mongodb({
        users: [dbUser],
        counters: [{ _id: 'userId', seq: 1 }]
      });
      app = await vmp.boot('server.js', {
        fakes: {
          mongodb: mongo,
          needle: fakeNeedle
        },
        env: { NODE_ENV: 'test' }
      });
    });

    after(async function () {
      await app.close();
    });

    it('GET /research without session redirects to /login', async function () {
      const res = await app.request('GET', '/research');
      assert.strictEqual(res.status, 302);
      assert.ok(
        res.location === '/login' || (res.location && res.location.includes('login')),
        `expected redirect to /login, got ${res.location}`
      );
    });
  });

  describe('needle error path: needle returns an error', function () {
    let app;
    let mongo;
    const errorNeedle = {
      get: function (url, callback) {
        setImmediate(() => callback(new Error('connection refused'), null, null));
      }
    };

    before(async function () {
      mongo = vmp.fakes.mongodb({
        users: [dbUser],
        counters: [{ _id: 'userId', seq: 1 }]
      });
      app = await vmp.boot('server.js', {
        fakes: {
          mongodb: mongo,
          needle: errorNeedle
        },
        env: { NODE_ENV: 'test' }
      });
    });

    after(async function () {
      await app.close();
    });

    it('GET /research with symbol and needle error still ends the response', async function () {
      // Establish session
      await app.request('POST', '/login', {
        form: { userName: userRecord.userName, password: plainPassword }
      });

      const res = await app.request('GET',
        `/research?url=${encodeURIComponent(allowedUrl)}&symbol=${encodeURIComponent(allowedSymbol)}`);

      // The handler writes partial content and calls res.end() even on error
      assert.ok(
        res.status === 200 || res.status === 500,
        `expected 200 or 500, got ${res.status}`
      );
      assert.ok(
        res.text.includes('stock information') || res.text === '',
        'response body should be the partial write or empty'
      );
    });
  });
});
