"use strict";

const assert = require("assert");
const path = require("path");
const Module = require("module");

// --- Fake DAO setup via require cache manipulation ---
const userDAOPath = path.resolve(__dirname, "../../app/data/user-dao.js");
const allocationsDAOPath = path.resolve(__dirname, "../../app/data/allocations-dao.js");
const configPath = path.resolve(__dirname, "../../config/config.js");

let fakeValidateLogin;

const fakeUserDAOModule = {
  UserDAO: function FakeUserDAO(db) {
    this.validateLogin = (userName, password, cb) => fakeValidateLogin(userName, password, cb);
    this.getUserById = (id, cb) => cb(null, null);
    this.getUserByUserName = (name, cb) => cb(null, null);
    this.addUser = (u, f, l, p, e, cb) => cb(null, {_id: "uid1"});
  }
};

const fakeAllocationsDAOModule = {
  AllocationsDAO: function FakeAllocationsDAO(db) {
    this.update = (id, s, f, b, cb) => cb && cb(null);
  }
};

const fakeConfigModule = {
  environmentalScripts: ["script1.js"]
};

// Inject into require cache
require.cache[userDAOPath] = { id: userDAOPath, filename: userDAOPath, loaded: true, exports: fakeUserDAOModule };
require.cache[allocationsDAOPath] = { id: allocationsDAOPath, filename: allocationsDAOPath, loaded: true, exports: fakeAllocationsDAOModule };
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: fakeConfigModule };

const SessionHandler = require("../../app/routes/session.js");

describe("SessionHandler", function () {
  let handler;

  beforeEach(function () {
    fakeValidateLogin = (u, p, cb) => cb(null, { _id: "uid1", isAdmin: false });
    handler = new SessionHandler({});
  });

  // ---- displayLoginPage ----
  describe("displayLoginPage", function () {
    it("renders the login view with empty userName, password and loginError", function () {
      let rendered = null;
      const req = {};
      const res = {
        render: (view, data) => { rendered = { view, data }; }
      };
      handler.displayLoginPage(req, res, () => {});
      assert.strictEqual(rendered.view, "login");
      assert.strictEqual(rendered.data.userName, "");
      assert.strictEqual(rendered.data.password, "");
      assert.strictEqual(rendered.data.loginError, "");
    });

    it("passes environmentalScripts from config", function () {
      let rendered = null;
      const req = {};
      const res = {
        render: (view, data) => { rendered = { view, data }; }
      };
      handler.displayLoginPage(req, res, () => {});
      assert.deepStrictEqual(rendered.data.environmentalScripts, ["script1.js"]);
    });

    it("returns the result of res.render", function () {
      const req = {};
      const res = {
        render: (view, data) => "render-result"
      };
      const result = handler.displayLoginPage(req, res, () => {});
      assert.strictEqual(result, "render-result");
    });
  });

  // ---- handleLoginRequest ----
  describe("handleLoginRequest", function () {
    it("redirects to /dashboard when login succeeds for non-admin user", function () {
      fakeValidateLogin = (u, p, cb) => cb(null, { _id: "uid1", isAdmin: false });
      let redirectTarget = null;
      let sessionUserId = null;
      const req = {
        body: { userName: "alice", password: "pass1" },
        session: {
          set userId(v) { sessionUserId = v; },
          get userId() { return sessionUserId; }
        }
      };
      const res = {
        redirect: (url) => { redirectTarget = url; },
        render: () => {}
      };
      handler.handleLoginRequest(req, res, () => {});
      assert.strictEqual(redirectTarget, "/dashboard");
      assert.strictEqual(sessionUserId, "uid1");
    });

    it("redirects to /benefits when login succeeds for admin user", function () {
      fakeValidateLogin = (u, p, cb) => cb(null, { _id: "adminId", isAdmin: true });
      let redirectTarget = null;
      const req = {
        body: { userName: "admin", password: "adminpass" },
        session: {}
      };
      const res = {
        redirect: (url) => { redirectTarget = url; },
        render: () => {}
      };
      handler.handleLoginRequest(req, res, () => {});
      assert.strictEqual(redirectTarget, "/benefits");
    });

    it("renders login with invalidUserNameErrorMessage when noSuchUser error", function () {
      fakeValidateLogin = (u, p, cb) => cb({ noSuchUser: true });
      let rendered = null;
      const req = {
        body: { userName: "ghost", password: "x" },
        session: {}
      };
      const res = {
        render: (view, data) => { rendered = { view, data }; },
        redirect: () => {}
      };
      handler.handleLoginRequest(req, res, () => {});
      assert.strictEqual(rendered.view, "login");
      assert.strictEqual(rendered.data.loginError, "Invalid username");
      assert.strictEqual(rendered.data.userName, "ghost");
      assert.strictEqual(rendered.data.password, "");
    });

    it("renders login with invalidPasswordErrorMessage when invalidPassword error", function () {
      fakeValidateLogin = (u, p, cb) => cb({ invalidPassword: true });
      let rendered = null;
      const req = {
        body: { userName: "alice", password: "wrong" },
        session: {}
      };
      const res = {
        render: (view, data) => { rendered = { view, data }; },
        redirect: () => {}
      };
      handler.handleLoginRequest(req, res, () => {});
      assert.strictEqual(rendered.view, "login");
      assert.strictEqual(rendered.data.loginError, "Invalid password");
      assert.strictEqual(rendered.data.userName, "alice");
      assert.strictEqual(rendered.data.password, "");
    });

    it("calls next with error for unexpected errors", function () {
      const unexpectedErr = new Error("db down");
      fakeValidateLogin = (u, p, cb) => cb(unexpectedErr);
      let nextArg = null;
      const req = {
        body: { userName: "alice", password: "pass" },
        session: {}
      };
      const res = {
        render: () => {},
        redirect: () => {}
      };
      handler.handleLoginRequest(req, res, (err) => { nextArg = err; });
      assert.strictEqual(nextArg, unexpectedErr);
    });

    it("includes environmentalScripts in noSuchUser render", function () {
      fakeValidateLogin = (u, p, cb) => cb({ noSuchUser: true });
      let rendered = null;
      const req = {
        body: { userName: "ghost", password: "x" },
        session: {}
      };
      const res = {
        render: (view, data) => { rendered = { view, data }; },
        redirect: () => {}
      };
      handler.handleLoginRequest(req, res, () => {});
      assert.deepStrictEqual(rendered.data.environmentalScripts, ["script1.js"]);
    });

    it("includes environmentalScripts in invalidPassword render", function () {
      fakeValidateLogin = (u, p, cb) => cb({ invalidPassword: true });
      let rendered = null;
      const req = {
        body: { userName: "alice", password: "wrong" },
        session: {}
      };
      const res = {
        render: (view, data) => { rendered = { view, data }; },
        redirect: () => {}
      };
      handler.handleLoginRequest(req, res, () => {});
      assert.deepStrictEqual(rendered.data.environmentalScripts, ["script1.js"]);
    });
  });

  // ---- displayLogoutPage ----
  describe("displayLogoutPage", function () {
    it("destroys the session and redirects to /", function () {
      let destroyCalled = false;
      let redirectTarget = null;
      const req = {
        session: {
          destroy: (cb) => { destroyCalled = true; cb(); }
        }
      };
      const res = {
        redirect: (url) => { redirectTarget = url; }
      };
      handler.displayLogoutPage(req, res);
      assert.strictEqual(destroyCalled, true);
      assert.strictEqual(redirectTarget, "/");
    });

    it("passes a callback to session.destroy", function () {
      let callbackReceived = false;
      const req = {
        session: {
          destroy: (cb) => { callbackReceived = typeof cb === "function"; }
        }
      };
      const res = {
        redirect: () => {}
      };
      handler.displayLogoutPage(req, res);
      assert.strictEqual(callbackReceived, true);
    });

    it("redirect happens inside the destroy callback (not before)", function () {
      let redirectBeforeDestroy = true;
      let storedCb;
      const req = {
        session: {
          destroy: (cb) => { storedCb = cb; }
        }
      };
      let redirectTarget = null;
      const res = {
        redirect: (url) => { redirectTarget = url; }
      };
      handler.displayLogoutPage(req, res);
      // redirect not called yet
      assert.strictEqual(redirectTarget, null);
      // now invoke the stored callback
      storedCb();
      assert.strictEqual(redirectTarget, "/");
    });
  });
});
