"use strict";

const assert = require("assert");

// We do NOT require session.js at the top level — we always load it fresh via buildHandler.

const path = require("path");

// Resolve the real paths that session.js will require
const userDaoPath  = require.resolve("../../app/data/user-dao");
const allocDaoPath = require.resolve("../../app/data/allocations-dao");
const configPath   = require.resolve("../../config/config");
const sessionPath  = require.resolve("../../app/routes/session");

// Snapshot whatever was already cached (may be undefined)
const originalUserDao  = require.cache[userDaoPath];
const originalAllocDao = require.cache[allocDaoPath];
const originalConfig   = require.cache[configPath];
const originalSession  = require.cache[sessionPath];

function injectFakes(userDaoInstance, allocDaoInstance) {
  // Always remove session from cache so it re-executes with our fakes
  delete require.cache[sessionPath];

  require.cache[userDaoPath] = {
    id: userDaoPath,
    filename: userDaoPath,
    loaded: true,
    exports: { UserDAO: function FakeUserDAO() { return userDaoInstance; } }
  };
  require.cache[allocDaoPath] = {
    id: allocDaoPath,
    filename: allocDaoPath,
    loaded: true,
    exports: { AllocationsDAO: function FakeAllocDAO() { return allocDaoInstance; } }
  };
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { environmentalScripts: ["fake-script.js"] }
  };
}

function restoreOriginals() {
  if (originalUserDao)  require.cache[userDaoPath]  = originalUserDao;
  else                  delete require.cache[userDaoPath];
  if (originalAllocDao) require.cache[allocDaoPath] = originalAllocDao;
  else                  delete require.cache[allocDaoPath];
  if (originalConfig)   require.cache[configPath]   = originalConfig;
  else                  delete require.cache[configPath];
  if (originalSession)  require.cache[sessionPath]  = originalSession;
  else                  delete require.cache[sessionPath];
}

function buildHandler(userDaoInstance, allocDaoInstance) {
  injectFakes(userDaoInstance, allocDaoInstance);
  const SessionHandlerFresh = require("../../app/routes/session");
  const handler = new SessionHandlerFresh({} /* fake db, ignored by our fakes */);
  restoreOriginals();
  return handler;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {
    _rendered: null,
    _redirected: null,
    render(view, data) {
      res._rendered = { view, data };
    },
    redirect(url) {
      res._redirected = url;
    }
  };
  return res;
}

function makeReq(body, session) {
  return {
    body: body || {},
    session: session || {}
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SessionHandler", function () {

  // ── displayLoginPage ──────────────────────────────────────────────────────
  describe("displayLoginPage", function () {

    let handler;

    before(function () {
      const userDaoInstance  = { validateLogin: function() {} };
      const allocDaoInstance = { update: function() {} };
      handler = buildHandler(userDaoInstance, allocDaoInstance);
    });

    it("renders the 'login' view", function () {
      const req  = makeReq();
      const res  = makeRes();
      const next = function() {};

      handler.displayLoginPage(req, res, next);

      assert.strictEqual(res._rendered.view, "login");
    });

    it("passes userName as empty string", function () {
      const req  = makeReq();
      const res  = makeRes();
      handler.displayLoginPage(req, res, function() {});

      assert.strictEqual(res._rendered.data.userName, "");
    });

    it("passes password as empty string", function () {
      const req  = makeReq();
      const res  = makeRes();
      handler.displayLoginPage(req, res, function() {});

      assert.strictEqual(res._rendered.data.password, "");
    });

    it("passes loginError as empty string", function () {
      const req  = makeReq();
      const res  = makeRes();
      handler.displayLoginPage(req, res, function() {});

      assert.strictEqual(res._rendered.data.loginError, "");
    });

    it("includes environmentalScripts in render data", function () {
      const req  = makeReq();
      const res  = makeRes();
      handler.displayLoginPage(req, res, function() {});

      assert.ok("environmentalScripts" in res._rendered.data);
    });

    it("does not redirect", function () {
      const req  = makeReq();
      const res  = makeRes();
      handler.displayLoginPage(req, res, function() {});

      assert.strictEqual(res._redirected, null);
    });
  });

  // ── handleLoginRequest ────────────────────────────────────────────────────
  describe("handleLoginRequest", function () {

    // Helper: build a handler whose validateLogin calls back with the given outcome
    function buildHandlerWithLoginResult(cb) {
      const userDaoInstance  = { validateLogin: cb };
      const allocDaoInstance = { update: function() {} };
      return buildHandler(userDaoInstance, allocDaoInstance);
    }

    it("renders login with 'Invalid username' error when noSuchUser error is returned", function () {
      const handler = buildHandlerWithLoginResult(function(userName, password, callback) {
        callback({ noSuchUser: true });
      });

      const req  = makeReq({ userName: "ghost", password: "whatever" });
      const res  = makeRes();
      const next = function() {};

      handler.handleLoginRequest(req, res, next);

      assert.strictEqual(res._rendered.view, "login");
      assert.strictEqual(res._rendered.data.loginError, "Invalid username");
    });

    it("echoes userName back when noSuchUser error is returned", function () {
      const handler = buildHandlerWithLoginResult(function(userName, password, callback) {
        callback({ noSuchUser: true });
      });

      const req  = makeReq({ userName: "ghost", password: "whatever" });
      const res  = makeRes();

      handler.handleLoginRequest(req, res, function() {});

      assert.strictEqual(res._rendered.data.userName, "ghost");
    });

    it("clears password in render data when noSuchUser error is returned", function () {
      const handler = buildHandlerWithLoginResult(function(userName, password, callback) {
        callback({ noSuchUser: true });
      });

      const req  = makeReq({ userName: "ghost", password: "s3cr3t" });
      const res  = makeRes();

      handler.handleLoginRequest(req, res, function() {});

      assert.strictEqual(res._rendered.data.password, "");
    });

    it("renders login with 'Invalid password' error when invalidPassword error is returned", function () {
      const handler = buildHandlerWithLoginResult(function(userName, password, callback) {
        callback({ invalidPassword: true });
      });

      const req  = makeReq({ userName: "alice", password: "wrong" });
      const res  = makeRes();

      handler.handleLoginRequest(req, res, function() {});

      assert.strictEqual(res._rendered.view, "login");
      assert.strictEqual(res._rendered.data.loginError, "Invalid password");
    });

    it("echoes userName back when invalidPassword error is returned", function () {
      const handler = buildHandlerWithLoginResult(function(userName, password, callback) {
        callback({ invalidPassword: true });
      });

      const req  = makeReq({ userName: "alice", password: "wrong" });
      const res  = makeRes();

      handler.handleLoginRequest(req, res, function() {});

      assert.strictEqual(res._rendered.data.userName, "alice");
    });

    it("clears password in render data when invalidPassword error is returned", function () {
      const handler = buildHandlerWithLoginResult(function(userName, password, callback) {
        callback({ invalidPassword: true });
      });

      const req  = makeReq({ userName: "alice", password: "wrong" });
      const res  = makeRes();

      handler.handleLoginRequest(req, res, function() {});

      assert.strictEqual(res._rendered.data.password, "");
    });

    it("calls next with the error when an unexpected error is returned", function () {
      const unexpectedErr = new Error("db exploded");
      const handler = buildHandlerWithLoginResult(function(userName, password, callback) {
        callback(unexpectedErr);
      });

      const req  = makeReq({ userName: "alice", password: "pass" });
      const res  = makeRes();
      let nextArg;
      const next = function(arg) { nextArg = arg; };

      handler.handleLoginRequest(req, res, next);

      assert.strictEqual(nextArg, unexpectedErr);
    });

    it("sets req.session.userId and redirects to /dashboard for a non-admin user", function () {
      const fakeUser = { _id: "user-123", isAdmin: false };
      const handler = buildHandlerWithLoginResult(function(userName, password, callback) {
        callback(null, fakeUser);
      });

      const req  = makeReq({ userName: "alice", password: "pass" }, {});
      const res  = makeRes();

      handler.handleLoginRequest(req, res, function() {});

      assert.strictEqual(req.session.userId, "user-123");
      assert.strictEqual(res._redirected, "/dashboard");
    });

    it("redirects to /benefits for an admin user", function () {
      const fakeAdmin = { _id: "admin-456", isAdmin: true };
      const handler = buildHandlerWithLoginResult(function(userName, password, callback) {
        callback(null, fakeAdmin);
      });

      const req  = makeReq({ userName: "admin", password: "adminpass" }, {});
      const res  = makeRes();

      handler.handleLoginRequest(req, res, function() {});

      assert.strictEqual(req.session.userId, "admin-456");
      assert.strictEqual(res._redirected, "/benefits");
    });

    it("passes userName and password from req.body to validateLogin", function () {
      let capturedUser, capturedPass;
      const handler = buildHandlerWithLoginResult(function(userName, password, callback) {
        capturedUser = userName;
        capturedPass = password;
        // never call callback — we only care about what was passed
      });

      const req  = makeReq({ userName: "bob", password: "secret" }, {});
      const res  = makeRes();

      handler.handleLoginRequest(req, res, function() {});

      assert.strictEqual(capturedUser, "bob");
      assert.strictEqual(capturedPass, "secret");
    });

    it("includes environmentalScripts in render data on noSuchUser error", function () {
      const handler = buildHandlerWithLoginResult(function(userName, password, callback) {
        callback({ noSuchUser: true });
      });

      const req  = makeReq({ userName: "ghost", password: "x" });
      const res  = makeRes();

      handler.handleLoginRequest(req, res, function() {});

      assert.ok("environmentalScripts" in res._rendered.data);
    });

    it("includes environmentalScripts in render data on invalidPassword error", function () {
      const handler = buildHandlerWithLoginResult(function(userName, password, callback) {
        callback({ invalidPassword: true });
      });

      const req  = makeReq({ userName: "alice", password: "x" });
      const res  = makeRes();

      handler.handleLoginRequest(req, res, function() {});

      assert.ok("environmentalScripts" in res._rendered.data);
    });
  });
});
