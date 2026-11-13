"use strict";

const assert = require("assert");
const bcrypt = require("bcrypt-nodejs");
const SessionHandler = require("../../app/routes/session");

// Provide a fakeDb whose .collection() returns a stub with the methods DAOs call
const fakeCollection = {
  findOne: function() {},
  find: function() { return { toArray: function() {} }; },
  insert: function() {},
  update: function() {},
  findAndModify: function() {}
};

const fakeDb = {
  collection: function(name) {
    return fakeCollection;
  }
};

describe("SessionHandler - displayLoginPage and handleLoginRequest", function () {
  let handler;

  before(function () {
    handler = new SessionHandler(fakeDb);
  });

  describe("displayLoginPage", function () {
    it("calls res.render with 'login' and correct default fields", function () {
      let renderCalled = false;
      let renderView = null;
      let renderData = null;

      const req = {};
      const res = {
        render: function (view, data) {
          renderCalled = true;
          renderView = view;
          renderData = data;
        }
      };
      const next = function () {};

      handler.displayLoginPage(req, res, next);

      assert.strictEqual(renderCalled, true, "res.render should have been called");
      assert.strictEqual(renderView, "login", "should render the 'login' view");
      assert.strictEqual(renderData.userName, "", "userName should be empty string");
      assert.strictEqual(renderData.password, "", "password should be empty string");
      assert.strictEqual(renderData.loginError, "", "loginError should be empty string");
      assert.ok("environmentalScripts" in renderData, "environmentalScripts should be present");
    });

    it("returns the result of res.render", function () {
      const sentinelValue = { sentinel: true };
      const req = {};
      const res = {
        render: function (view, data) {
          return sentinelValue;
        }
      };
      const next = function () {};

      const result = handler.displayLoginPage(req, res, next);
      assert.strictEqual(result, sentinelValue, "should return whatever res.render returns");
    });

    it("does not call next", function () {
      let nextCalled = false;
      const req = {};
      const res = {
        render: function () {}
      };
      const next = function () {
        nextCalled = true;
      };

      handler.displayLoginPage(req, res, next);
      assert.strictEqual(nextCalled, false, "next should not be called");
    });
  });

  describe("handleLoginRequest", function () {
    it("calls userDAO.validateLogin with userName and password from req.body", function () {
      let validateLoginCalledWith = null;

      // Override the collection to capture validateLogin calls
      const captureCollection = {
        findOne: function(query, callback) {
          validateLoginCalledWith = query;
          // Don't call callback - just capture the call
        },
        find: function() { return { toArray: function() {} }; },
        insert: function() {},
        update: function() {},
        findAndModify: function() {}
      };

      const captureDb = {
        collection: function(name) {
          return captureCollection;
        }
      };

      const captureHandler = new SessionHandler(captureDb);

      const req = {
        body: { userName: "testuser", password: "testpass" }
      };
      const res = {
        render: function() {},
        redirect: function() {}
      };
      const next = function() {};

      captureHandler.handleLoginRequest(req, res, next);

      assert.ok(validateLoginCalledWith !== null, "findOne should have been called");
      assert.strictEqual(validateLoginCalledWith.userName, "testuser", "should query by userName");
    });

    it("renders login with invalidUserNameErrorMessage when noSuchUser error", function () {
      let renderedView = null;
      let renderedData = null;

      const noSuchUserCollection = {
        findOne: function(query, callback) {
          const err = new Error("no such user");
          err.noSuchUser = true;
          callback(err, null);
        },
        find: function() { return { toArray: function() {} }; },
        insert: function() {},
        update: function() {},
        findAndModify: function() {}
      };

      const noSuchUserDb = {
        collection: function(name) {
          return noSuchUserCollection;
        }
      };

      const noSuchUserHandler = new SessionHandler(noSuchUserDb);

      const req = {
        body: { userName: "baduser", password: "pass" }
      };
      const res = {
        render: function(view, data) {
          renderedView = view;
          renderedData = data;
        },
        redirect: function() {}
      };
      const next = function() {};

      noSuchUserHandler.handleLoginRequest(req, res, next);

      assert.strictEqual(renderedView, "login", "should render login view");
      assert.strictEqual(renderedData.userName, "baduser", "should echo userName");
      assert.strictEqual(renderedData.password, "", "password should be empty");
      assert.strictEqual(renderedData.loginError, "Invalid username", "should show invalid username message");
      assert.ok("environmentalScripts" in renderedData, "environmentalScripts should be present");
    });

    it("renders login with invalidPasswordErrorMessage when invalidPassword error", function () {
      let renderedView = null;
      let renderedData = null;

      const invalidPassCollection = {
        findOne: function(query, callback) {
          const err = new Error("invalid password");
          err.invalidPassword = true;
          callback(err, null);
        },
        find: function() { return { toArray: function() {} }; },
        insert: function() {},
        update: function() {},
        findAndModify: function() {}
      };

      const invalidPassDb = {
        collection: function(name) {
          return invalidPassCollection;
        }
      };

      const invalidPassHandler = new SessionHandler(invalidPassDb);

      const req = {
        body: { userName: "gooduser", password: "wrongpass" }
      };
      const res = {
        render: function(view, data) {
          renderedView = view;
          renderedData = data;
        },
        redirect: function() {}
      };
      const next = function() {};

      invalidPassHandler.handleLoginRequest(req, res, next);

      assert.strictEqual(renderedView, "login", "should render login view");
      assert.strictEqual(renderedData.userName, "gooduser", "should echo userName");
      assert.strictEqual(renderedData.password, "", "password should be empty");
      assert.strictEqual(renderedData.loginError, "Invalid password", "should show invalid password message");
      assert.ok("environmentalScripts" in renderedData, "environmentalScripts should be present");
    });

    it("calls next with error for generic db errors", function () {
      let nextCalledWithError = null;

      const genericErrCollection = {
        findOne: function(query, callback) {
          const err = new Error("db error");
          callback(err, null);
        },
        find: function() { return { toArray: function() {} }; },
        insert: function() {},
        update: function() {},
        findAndModify: function() {}
      };

      const genericErrDb = {
        collection: function(name) {
          return genericErrCollection;
        }
      };

      const genericErrHandler = new SessionHandler(genericErrDb);

      const req = {
        body: { userName: "user", password: "pass" }
      };
      const res = {
        render: function() {},
        redirect: function() {}
      };
      const next = function(err) {
        nextCalledWithError = err;
      };

      genericErrHandler.handleLoginRequest(req, res, next);

      assert.ok(nextCalledWithError !== null, "next should be called with error");
      assert.strictEqual(nextCalledWithError.message, "db error", "should pass the db error to next");
    });

    it("redirects to /dashboard for non-admin user on successful login", function () {
      let redirectTarget = null;

      // Need a real bcrypt hash so compareSync succeeds
      const plainPassword = "testpass";
      const hashedPassword = bcrypt.hashSync(plainPassword, bcrypt.genSaltSync());

      const successCollection = {
        findOne: function(query, callback) {
          callback(null, { _id: 42, isAdmin: false, password: hashedPassword });
        },
        find: function() { return { toArray: function() {} }; },
        insert: function() {},
        update: function(query, update, callback) {
          if (typeof callback === "function") callback(null, {});
        },
        findAndModify: function() {}
      };

      const successDb = {
        collection: function(name) {
          return successCollection;
        }
      };

      const successHandler = new SessionHandler(successDb);

      const req = {
        body: { userName: "user", password: plainPassword },
        session: {}
      };
      const res = {
        render: function() {},
        redirect: function(target) {
          redirectTarget = target;
        }
      };
      const next = function() {};

      successHandler.handleLoginRequest(req, res, next);

      assert.strictEqual(redirectTarget, "/dashboard", "non-admin should redirect to /dashboard");
      assert.strictEqual(req.session.userId, 42, "should set session userId");
    });

    it("redirects to /benefits for admin user on successful login", function () {
      let redirectTarget = null;

      // Need a real bcrypt hash so compareSync succeeds
      const plainPassword = "adminpass";
      const hashedPassword = bcrypt.hashSync(plainPassword, bcrypt.genSaltSync());

      const adminCollection = {
        findOne: function(query, callback) {
          callback(null, { _id: 1, isAdmin: true, password: hashedPassword });
        },
        find: function() { return { toArray: function() {} }; },
        insert: function() {},
        update: function(query, update, callback) {
          if (typeof callback === "function") callback(null, {});
        },
        findAndModify: function() {}
      };

      const adminDb = {
        collection: function(name) {
          return adminCollection;
        }
      };

      const adminHandler = new SessionHandler(adminDb);

      const req = {
        body: { userName: "admin", password: plainPassword },
        session: {}
      };
      const res = {
        render: function() {},
        redirect: function(target) {
          redirectTarget = target;
        }
      };
      const next = function() {};

      adminHandler.handleLoginRequest(req, res, next);

      assert.strictEqual(redirectTarget, "/benefits", "admin should redirect to /benefits");
      assert.strictEqual(req.session.userId, 1, "should set session userId");
    });
  });
});
