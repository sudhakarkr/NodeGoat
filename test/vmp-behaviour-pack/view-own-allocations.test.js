"use strict";

const assert = require("assert");
const SessionHandler = require("../../app/routes/session");

// Fake collection: just needs to exist so DAOs don't throw at construction.
const fakeCollection = {
  findOne() {},
  insert() {},
  update() {},
  find() { return { toArray() {} }; },
  findAndModify() {}
};

const fakeDb = {
  collection() {
    return fakeCollection;
  }
};

describe("SessionHandler – displayLoginPage", () => {
  let handler;

  before(() => {
    handler = new SessionHandler(fakeDb);
  });

  it("calls res.render with template name \"login\"", function () {
    let renderedTemplate = null;

    const fakeRes = {
      render(template, data) {
        renderedTemplate = template;
      }
    };

    handler.displayLoginPage({}, fakeRes, () => {});

    assert.strictEqual(renderedTemplate, "login");
  });

  it("passes userName as empty string", function () {
    let renderedData = null;
    const fakeRes = {
      render(template, data) { renderedData = data; }
    };

    handler.displayLoginPage({}, fakeRes, () => {});

    assert.strictEqual(renderedData.userName, "");
  });

  it("passes password as empty string", function () {
    let renderedData = null;
    const fakeRes = {
      render(template, data) { renderedData = data; }
    };

    handler.displayLoginPage({}, fakeRes, () => {});

    assert.strictEqual(renderedData.password, "");
  });

  it("passes loginError as empty string", function () {
    let renderedData = null;
    const fakeRes = {
      render(template, data) { renderedData = data; }
    };

    handler.displayLoginPage({}, fakeRes, () => {});

    assert.strictEqual(renderedData.loginError, "");
  });

  it("passes environmentalScripts property", function () {
    let renderedData = null;
    const fakeRes = {
      render(template, data) { renderedData = data; }
    };

    handler.displayLoginPage({}, fakeRes, () => {});

    assert.ok(Object.prototype.hasOwnProperty.call(renderedData, "environmentalScripts"));
  });

  it("returns whatever res.render returns", function () {
    const sentinel = Symbol("sentinel");
    const fakeRes = {
      render() { return sentinel; }
    };

    const result = handler.displayLoginPage({}, fakeRes, () => {});

    assert.strictEqual(result, sentinel);
  });
});

describe("SessionHandler – handleLoginRequest", () => {
  let handler;

  before(() => {
    handler = new SessionHandler(fakeDb);
  });

  it("calls userDAO.validateLogin with userName and password from req.body", function (done) {
    let capturedUserName = null;
    let capturedPassword = null;

    // Override collection so validateLogin callback can be intercepted.
    const interceptCollection = {
      findOne(query, callback) {
        capturedUserName = query.userName;
        // Simulate noSuchUser error to avoid hitting session logic.
        const err = new Error("no such user");
        err.noSuchUser = true;
        callback(err, null);
      },
      insert() {},
      update() {},
      find() { return { toArray() {} }; },
      findAndModify() {}
    };

    const interceptDb = {
      collection() {
        return interceptCollection;
      }
    };

    const h = new SessionHandler(interceptDb);

    const fakeReq = {
      body: { userName: "alice", password: "secret" }
    };
    let renderedTemplate = null;
    let renderedData = null;
    const fakeRes = {
      render(template, data) {
        renderedTemplate = template;
        renderedData = data;
      },
      redirect() {}
    };

    h.handleLoginRequest(fakeReq, fakeRes, () => {});

    // validateLogin is async via findOne; since fakeCollection is synchronous
    // the callback fires immediately.
    assert.strictEqual(renderedTemplate, "login");
    assert.strictEqual(renderedData.userName, "alice");
    assert.strictEqual(renderedData.password, "");
    assert.strictEqual(renderedData.loginError, "Invalid username");
    assert.ok(Object.prototype.hasOwnProperty.call(renderedData, "environmentalScripts"));
    done();
  });

  it("renders login with invalidPassword error when password is wrong", function (done) {
    const bcrypt = require("bcrypt-nodejs");
    const hashedPassword = bcrypt.hashSync("correctpass", bcrypt.genSaltSync());

    const interceptCollection = {
      findOne(query, callback) {
        // Return a user so password comparison runs.
        callback(null, { _id: 1, userName: "bob", password: hashedPassword, isAdmin: false });
      },
      insert() {},
      update() {},
      find() { return { toArray() {} }; },
      findAndModify() {}
    };

    const interceptDb = {
      collection() { return interceptCollection; }
    };

    const h = new SessionHandler(interceptDb);

    const fakeReq = {
      body: { userName: "bob", password: "wrongpass" }
    };
    let renderedTemplate = null;
    let renderedData = null;
    const fakeRes = {
      render(template, data) {
        renderedTemplate = template;
        renderedData = data;
      },
      redirect() {}
    };

    h.handleLoginRequest(fakeReq, fakeRes, () => {});

    assert.strictEqual(renderedTemplate, "login");
    assert.strictEqual(renderedData.loginError, "Invalid password");
    assert.strictEqual(renderedData.userName, "bob");
    assert.strictEqual(renderedData.password, "");
    assert.ok(Object.prototype.hasOwnProperty.call(renderedData, "environmentalScripts"));
    done();
  });

  it("redirects to /dashboard for a non-admin user on successful login", function (done) {
    const bcrypt = require("bcrypt-nodejs");
    const hashedPassword = bcrypt.hashSync("mypass", bcrypt.genSaltSync());

    const interceptCollection = {
      findOne(query, callback) {
        callback(null, { _id: 42, userName: "carol", password: hashedPassword, isAdmin: false });
      },
      insert() {},
      update() {},
      find() { return { toArray() {} }; },
      findAndModify() {}
    };

    const interceptDb = {
      collection() { return interceptCollection; }
    };

    const h = new SessionHandler(interceptDb);

    const fakeSession = {};
    const fakeReq = {
      body: { userName: "carol", password: "mypass" },
      session: fakeSession
    };
    let redirectTarget = null;
    const fakeRes = {
      render() {},
      redirect(url) { redirectTarget = url; }
    };

    h.handleLoginRequest(fakeReq, fakeRes, () => {});

    assert.strictEqual(redirectTarget, "/dashboard");
    assert.strictEqual(fakeSession.userId, 42);
    done();
  });

  it("redirects to /benefits for an admin user on successful login", function (done) {
    const bcrypt = require("bcrypt-nodejs");
    const hashedPassword = bcrypt.hashSync("adminpass", bcrypt.genSaltSync());

    const interceptCollection = {
      findOne(query, callback) {
        callback(null, { _id: 99, userName: "dave", password: hashedPassword, isAdmin: true });
      },
      insert() {},
      update() {},
      find() { return { toArray() {} }; },
      findAndModify() {}
    };

    const interceptDb = {
      collection() { return interceptCollection; }
    };

    const h = new SessionHandler(interceptDb);

    const fakeSession = {};
    const fakeReq = {
      body: { userName: "dave", password: "adminpass" },
      session: fakeSession
    };
    let redirectTarget = null;
    const fakeRes = {
      render() {},
      redirect(url) { redirectTarget = url; }
    };

    h.handleLoginRequest(fakeReq, fakeRes, () => {});

    assert.strictEqual(redirectTarget, "/benefits");
    assert.strictEqual(fakeSession.userId, 99);
    done();
  });
});
