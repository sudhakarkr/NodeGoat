"use strict";

const assert = require("assert");

// Minimal fake db
const fakeDb = {
  collection: () => ({
    findOne: () => {},
    find: () => ({ toArray: () => {} }),
    insert: () => {},
    update: () => {},
    updateOne: () => {},
  }),
};

const SessionHandler = require("../../app/routes/session");

describe("SessionHandler", function () {
  let handler;

  before(function () {
    handler = new SessionHandler(fakeDb);
  });

  describe("displayLoginPage", function () {
    it("renders the login view with empty userName, password, loginError", function () {
      let renderedView = null;
      let renderedData = null;

      const req = {};
      const res = {
        render: function (view, data) {
          renderedView = view;
          renderedData = data;
        },
      };
      const next = function () {};

      handler.displayLoginPage(req, res, next);

      assert.strictEqual(renderedView, "login");
      assert.strictEqual(renderedData.userName, "");
      assert.strictEqual(renderedData.password, "");
      assert.strictEqual(renderedData.loginError, "");
    });

    it("includes environmentalScripts in render data", function () {
      let renderedData = null;
      const req = {};
      const res = {
        render: function (view, data) {
          renderedData = data;
        },
      };

      handler.displayLoginPage(req, res, function () {});

      assert.ok(Object.prototype.hasOwnProperty.call(renderedData, "environmentalScripts"));
    });

    it("returns the result of res.render", function () {
      const req = {};
      const sentinel = { sentinel: true };
      const res = {
        render: function () {
          return sentinel;
        },
      };

      const result = handler.displayLoginPage(req, res, function () {});
      assert.strictEqual(result, sentinel);
    });
  });

  describe("handleLoginRequest", function () {
    // Helper: build a SessionHandler whose internal userDAO.validateLogin is overridden.
    // We replace UserDAO in its module exports so that when SessionHandler is required
    // fresh, `new UserDAO(db)` yields our fake. Since SessionHandler is already cached,
    // we must also clear the require cache for it.
    function makeHandlerWithValidateLogin(stub) {
      const sessionPath = require.resolve("../../app/routes/session");
      const userDaoPath = require.resolve("../../app/data/user-dao");
      const allocationsDaoPath = require.resolve("../../app/data/allocations-dao");

      const UserDAOMod = require(userDaoPath);
      const AllocationsDAOMod = require(allocationsDaoPath);
      const OriginalUserDAO = UserDAOMod.UserDAO;
      const OriginalAllocationsDAO = AllocationsDAOMod.AllocationsDAO;

      function FakeUserDAO(db) {
        this.validateLogin = stub;
        this.getUserById = function () {};
        this.getUserByUserName = function () {};
        this.addUser = function () {};
        this.getNextSequence = function () {};
      }
      function FakeAllocationsDAO(db) {
        this.update = function () {};
        this.getByUserIdAndThreshold = function () {};
      }

      UserDAOMod.UserDAO = FakeUserDAO;
      AllocationsDAOMod.AllocationsDAO = FakeAllocationsDAO;

      // clear cached SessionHandler so it re-reads UserDAO from the module
      delete require.cache[sessionPath];

      let h;
      try {
        const FreshSessionHandler = require(sessionPath);
        h = new FreshSessionHandler(fakeDb);
      } finally {
        UserDAOMod.UserDAO = OriginalUserDAO;
        AllocationsDAOMod.AllocationsDAO = OriginalAllocationsDAO;
        // restore the cached SessionHandler to the original for other tests
        delete require.cache[sessionPath];
        require(sessionPath);
      }
      return h;
    }

    it("renders login with invalidUserNameErrorMessage when err.noSuchUser is true", function () {
      let renderedView = null;
      let renderedData = null;

      const h = makeHandlerWithValidateLogin(function (userName, password, cb) {
        cb({ noSuchUser: true }, null);
      });

      const req = {
        body: { userName: "ghost", password: "pass" },
        session: {},
      };
      const res = {
        render: function (view, data) {
          renderedView = view;
          renderedData = data;
        },
        redirect: function () {},
      };
      const next = function () {};

      h.handleLoginRequest(req, res, next);

      assert.strictEqual(renderedView, "login");
      assert.strictEqual(renderedData.loginError, "Invalid username");
      assert.strictEqual(renderedData.userName, "ghost");
      assert.strictEqual(renderedData.password, "");
    });

    it("renders login with invalidPasswordErrorMessage when err.invalidPassword is true", function () {
      let renderedView = null;
      let renderedData = null;

      const h = makeHandlerWithValidateLogin(function (userName, password, cb) {
        cb({ invalidPassword: true }, null);
      });

      const req = {
        body: { userName: "alice", password: "wrongpass" },
        session: {},
      };
      const res = {
        render: function (view, data) {
          renderedView = view;
          renderedData = data;
        },
        redirect: function () {},
      };
      const next = function () {};

      h.handleLoginRequest(req, res, next);

      assert.strictEqual(renderedView, "login");
      assert.strictEqual(renderedData.loginError, "Invalid password");
      assert.strictEqual(renderedData.userName, "alice");
      assert.strictEqual(renderedData.password, "");
    });

    it("calls next(err) when err is a generic error", function () {
      let nextCalledWith = undefined;
      let nextCalled = false;

      const genericError = new Error("db failure");
      const h = makeHandlerWithValidateLogin(function (userName, password, cb) {
        cb(genericError, null);
      });

      const req = {
        body: { userName: "alice", password: "pass" },
        session: {},
      };
      const res = {
        render: function () {},
        redirect: function () {},
      };
      const next = function (err) {
        nextCalled = true;
        nextCalledWith = err;
      };

      h.handleLoginRequest(req, res, next);

      assert.strictEqual(nextCalled, true);
      assert.strictEqual(nextCalledWith, genericError);
    });

    it("sets session.userId and redirects to /dashboard for non-admin user", function () {
      let redirectTarget = null;

      const h = makeHandlerWithValidateLogin(function (userName, password, cb) {
        cb(null, { _id: "user123", isAdmin: false });
      });

      const req = {
        body: { userName: "alice", password: "correct" },
        session: {},
      };
      const res = {
        render: function () {},
        redirect: function (target) {
          redirectTarget = target;
        },
      };
      const next = function () {};

      h.handleLoginRequest(req, res, next);

      assert.strictEqual(req.session.userId, "user123");
      assert.strictEqual(redirectTarget, "/dashboard");
    });

    it("sets session.userId and redirects to /benefits for admin user", function () {
      let redirectTarget = null;

      const h = makeHandlerWithValidateLogin(function (userName, password, cb) {
        cb(null, { _id: "admin456", isAdmin: true });
      });

      const req = {
        body: { userName: "admin", password: "adminpass" },
        session: {},
      };
      const res = {
        render: function () {},
        redirect: function (target) {
          redirectTarget = target;
        },
      };
      const next = function () {};

      h.handleLoginRequest(req, res, next);

      assert.strictEqual(req.session.userId, "admin456");
      assert.strictEqual(redirectTarget, "/benefits");
    });

    it("includes environmentalScripts in noSuchUser render data", function () {
      let renderedData = null;
      let renderedView = null;

      const h = makeHandlerWithValidateLogin(function (userName, password, cb) {
        cb({ noSuchUser: true }, null);
      });

      const req = {
        body: { userName: "ghost", password: "pass" },
        session: {},
      };
      const res = {
        render: function (view, data) {
          renderedView = view;
          renderedData = data;
        },
        redirect: function () {},
      };

      h.handleLoginRequest(req, res, function () {});

      assert.strictEqual(renderedView, "login");
      assert.ok(Object.prototype.hasOwnProperty.call(renderedData, "environmentalScripts"));
    });

    it("includes environmentalScripts in invalidPassword render data", function () {
      let renderedData = null;
      let renderedView = null;

      const h = makeHandlerWithValidateLogin(function (userName, password, cb) {
        cb({ invalidPassword: true }, null);
      });

      const req = {
        body: { userName: "alice", password: "wrongpass" },
        session: {},
      };
      const res = {
        render: function (view, data) {
          renderedView = view;
          renderedData = data;
        },
        redirect: function () {},
      };

      h.handleLoginRequest(req, res, function () {});

      assert.strictEqual(renderedView, "login");
      assert.ok(Object.prototype.hasOwnProperty.call(renderedData, "environmentalScripts"));
    });
  });
});
