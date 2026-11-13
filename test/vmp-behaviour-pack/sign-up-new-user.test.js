"use strict";

const assert = require("assert");
const SessionHandler = require("../../app/routes/session");

// Minimal fake db — provides collection() so UserDAO and AllocationsDAO can construct
const fakeCollection = {
  findOne: function() {},
  insert: function() {},
  findAndModify: function() {}
};

const fakeDb = {
  collection: function() {
    return fakeCollection;
  }
};

describe("SessionHandler", function () {

  let handler;

  before(function () {
    handler = new SessionHandler(fakeDb);
  });

  // ─── displaySignupPage ────────────────────────────────────────────────────

  describe("displaySignupPage", function () {

    it("renders the signup view with empty fields", function () {
      let rendered = null;
      const res = {
        render: function (view, data) {
          rendered = { view, data };
        }
      };
      const req = {};

      handler.displaySignupPage(req, res);

      assert.strictEqual(rendered.view, "signup");
      assert.strictEqual(rendered.data.userName, "");
      assert.strictEqual(rendered.data.password, "");
      assert.strictEqual(rendered.data.passwordError, "");
      assert.strictEqual(rendered.data.email, "");
      assert.strictEqual(rendered.data.userNameError, "");
      assert.strictEqual(rendered.data.emailError, "");
      assert.strictEqual(rendered.data.verifyError, "");
    });

    it("includes environmentalScripts in the render data", function () {
      let renderedData = null;
      const res = {
        render: function (view, data) {
          renderedData = data;
        }
      };
      handler.displaySignupPage({}, res);
      assert.ok(Object.prototype.hasOwnProperty.call(renderedData, "environmentalScripts"));
    });
  });

  // ─── handleSignup — validation failure paths (no DB needed) ──────────────

  describe("handleSignup — validation failures", function () {

    function makeRes() {
      return {
        rendered: null,
        render: function (view, data) {
          this.rendered = { view, data };
        }
      };
    }

    it("renders signup with userNameError when userName is too long", function () {
      const res = makeRes();
      const req = {
        body: {
          userName: "a".repeat(21),   // exceeds 20 chars → invalid
          firstName: "John",
          lastName: "Doe",
          password: "pass",
          verify: "pass",
          email: ""
        }
      };

      handler.handleSignup(req, res, function (err) { throw err || new Error("next called"); });

      assert.strictEqual(res.rendered.view, "signup");
      assert.strictEqual(res.rendered.data.userNameError, "Invalid user name.");
    });

    it("renders signup with firstNameError when firstName is too long", function () {
      const res = makeRes();
      const req = {
        body: {
          userName: "validUser",
          firstName: "a".repeat(101),  // exceeds 100 chars
          lastName: "Doe",
          password: "pass",
          verify: "pass",
          email: ""
        }
      };

      handler.handleSignup(req, res, function (err) { throw err || new Error("next called"); });

      assert.strictEqual(res.rendered.view, "signup");
      assert.strictEqual(res.rendered.data.firstNameError, "Invalid first name.");
    });

    it("renders signup with lastNameError when lastName is too long", function () {
      const res = makeRes();
      const req = {
        body: {
          userName: "validUser",
          firstName: "John",
          lastName: "a".repeat(101),   // exceeds 100 chars
          password: "pass",
          verify: "pass",
          email: ""
        }
      };

      handler.handleSignup(req, res, function (err) { throw err || new Error("next called"); });

      assert.strictEqual(res.rendered.view, "signup");
      assert.strictEqual(res.rendered.data.lastNameError, "Invalid last name.");
    });

    it("renders signup with passwordError when password is too long", function () {
      const res = makeRes();
      const req = {
        body: {
          userName: "validUser",
          firstName: "John",
          lastName: "Doe",
          password: "a".repeat(21),    // exceeds 20 chars
          verify: "a".repeat(21),
          email: ""
        }
      };

      handler.handleSignup(req, res, function (err) { throw err || new Error("next called"); });

      assert.strictEqual(res.rendered.view, "signup");
      assert.strictEqual(
        res.rendered.data.passwordError,
        "Password must be 8 to 18 characters including numbers, lowercase and uppercase letters."
      );
    });

    it("renders signup with verifyError when password and verify do not match", function () {
      const res = makeRes();
      const req = {
        body: {
          userName: "validUser",
          firstName: "John",
          lastName: "Doe",
          password: "secret",
          verify: "different",
          email: ""
        }
      };

      handler.handleSignup(req, res, function (err) { throw err || new Error("next called"); });

      assert.strictEqual(res.rendered.view, "signup");
      assert.strictEqual(res.rendered.data.verifyError, "Password must match");
    });

    it("renders signup with emailError when email is non-empty but invalid", function () {
      const res = makeRes();
      const req = {
        body: {
          userName: "validUser",
          firstName: "John",
          lastName: "Doe",
          password: "secret",
          verify: "secret",
          email: "notanemail"
        }
      };

      handler.handleSignup(req, res, function (err) { throw err || new Error("next called"); });

      assert.strictEqual(res.rendered.view, "signup");
      assert.strictEqual(res.rendered.data.emailError, "Invalid email address");
    });

    it("preserves userName and email in errors object on render", function () {
      const res = makeRes();
      const req = {
        body: {
          userName: "myUser",
          firstName: "John",
          lastName: "Doe",
          password: "pass1",
          verify: "pass2",   // mismatch → verifyError
          email: "user@example.com"
        }
      };

      handler.handleSignup(req, res, function (err) { throw err || new Error("next called"); });

      assert.strictEqual(res.rendered.data.userName, "myUser");
      assert.strictEqual(res.rendered.data.email, "user@example.com");
    });

    it("renders signup with environmentalScripts on validation failure", function () {
      const res = makeRes();
      const req = {
        body: {
          userName: "a".repeat(21),
          firstName: "John",
          lastName: "Doe",
          password: "pass",
          verify: "pass",
          email: ""
        }
      };

      handler.handleSignup(req, res, function () {});

      assert.ok(Object.prototype.hasOwnProperty.call(res.rendered.data, "environmentalScripts"));
    });
  });

  // ─── displayWelcomePage ───────────────────────────────────────────────────

  describe("displayWelcomePage", function () {

    it("redirects to /login when session has no userId", function () {
      let redirected = null;
      const res = {
        redirect: function (url) {
          redirected = url;
        }
      };
      const req = { session: {} };

      handler.displayWelcomePage(req, res, function (err) { throw err || new Error("next called"); });

      assert.strictEqual(redirected, "/login");
    });

    it("redirects to /login when session.userId is falsy (null)", function () {
      let redirected = null;
      const res = {
        redirect: function (url) {
          redirected = url;
        }
      };
      const req = { session: { userId: null } };

      handler.displayWelcomePage(req, res, function (err) { throw err || new Error("next called"); });

      assert.strictEqual(redirected, "/login");
    });

    it("redirects to /login when session.userId is 0 (falsy)", function () {
      let redirected = null;
      const res = {
        redirect: function (url) {
          redirected = url;
        }
      };
      const req = { session: { userId: 0 } };

      handler.displayWelcomePage(req, res, function (err) { throw err || new Error("next called"); });

      assert.strictEqual(redirected, "/login");
    });
  });

});
