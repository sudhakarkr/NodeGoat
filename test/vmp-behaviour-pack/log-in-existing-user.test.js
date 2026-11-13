"use strict";

const assert = require("assert");
const vmp = require("./_vmp/harness");

// Require bcrypt-nodejs as a package (found in node_modules)
const bcrypt = require("bcrypt-nodejs");

describe("Journey: Log in as an existing user", function () {
  this.timeout(15000);

  const PLAIN_PASSWORD = "Password1";
  const hashedPassword = bcrypt.hashSync(PLAIN_PASSWORD, bcrypt.genSaltSync());

  const fakeUser = {
    _id: 1,
    userName: "vmp-test-user-1",
    firstName: "Test",
    lastName: "User",
    password: hashedPassword,
    isAdmin: false,
    email: "vmp-test-user-1@example.com"
  };

  function makeFakeDb(findOneImpl) {
    return {
      collection: function (name) {
        return {
          findOne: findOneImpl,
          insert: function (doc, cb) {
            cb(null, { ops: [doc] });
          },
          findAndModify: function (q, sort, update, opts, cb) {
            cb(null, { value: { seq: 999 } });
          },
          update: function (q, upd, opts, cb) {
            if (cb) cb(null);
          }
        };
      }
    };
  }

  function makeFakeMongoose() {
    const fake = function () {
      return { connect: function () {}, on: function () {} };
    };
    fake.connect = function (url, opts, cb) {
      if (typeof opts === "function") {
        opts(null);
      } else if (typeof cb === "function") {
        cb(null);
      }
      return Promise.resolve();
    };
    fake.connection = { on: function () {}, once: function () {} };
    fake.Schema = function () { return {}; };
    fake.Schema.Types = { ObjectId: String, Mixed: Object };
    fake.model = function () { return function () {}; };
    return fake;
  }

  // Fake mongodb driver so server.js's MongoClient.connect never touches a real DB
  function makeFakeMongodb(fakeDb) {
    return {
      MongoClient: {
        connect: function (url, optsOrCb, cb) {
          const callback = typeof optsOrCb === "function" ? optsOrCb : cb;
          if (typeof callback === "function") {
            process.nextTick(() => callback(null, fakeDb));
          }
          return Promise.resolve(fakeDb);
        }
      },
      ObjectId: function (id) { return id; }
    };
  }

  // ---------------------------------------------------------------------------
  // Happy path: load login page
  // ---------------------------------------------------------------------------
  describe("GET /login – display login form", function () {
    let app;

    before(async function () {
      const fakeDb = makeFakeDb(function (query, cb) {
        cb(null, null);
      });
      app = await vmp.boot("server.js", {
        fakes: {
          mongoose: makeFakeMongoose(),
          mongodb: makeFakeMongodb(fakeDb),
          "./db": fakeDb
        },
        env: { NODE_ENV: "test" }
      });
    });

    after(async function () {
      if (app) await app.close();
    });

    it("returns 200 and renders the login view", async function () {
      const res = await app.request("GET", "/login");
      assert.strictEqual(res.status, 200);
      assert.ok(
        res.text.includes("login") ||
        res.text.includes("Login") ||
        res.text.includes("userName") ||
        res.text.includes("password"),
        "Expected login form content in response body"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Happy path: successful login then dashboard
  // ---------------------------------------------------------------------------
  describe("POST /login with valid credentials → GET /dashboard", function () {
    let app;

    before(async function () {
      const fakeDb = makeFakeDb(function (query, cb) {
        if (query && query.userName === fakeUser.userName) {
          return cb(null, fakeUser);
        }
        if (query && query._id === fakeUser._id) {
          return cb(null, fakeUser);
        }
        cb(null, null);
      });

      app = await vmp.boot("server.js", {
        fakes: {
          mongoose: makeFakeMongoose(),
          mongodb: makeFakeMongodb(fakeDb),
          "./db": fakeDb
        },
        env: { NODE_ENV: "test" }
      });
    });

    after(async function () {
      if (app) await app.close();
    });

    it("POST /login redirects to /dashboard for a non-admin user", async function () {
      const res = await app.request("POST", "/login", {
        form: { userName: fakeUser.userName, password: PLAIN_PASSWORD }
      });
      assert.strictEqual(res.status, 302);
      assert.ok(
        res.location === "/dashboard" || (res.headers.location || "").includes("/dashboard"),
        `Expected redirect to /dashboard but got: ${res.location}`
      );
    });

    it("GET /dashboard after login renders the dashboard view with user info", async function () {
      // Login first to establish session
      const loginRes = await app.request("POST", "/login", {
        form: { userName: fakeUser.userName, password: PLAIN_PASSWORD }
      });
      assert.strictEqual(loginRes.status, 302);

      // Follow redirect to /dashboard using the session cookie
      const dashRes = await app.request("GET", "/dashboard");
      assert.strictEqual(dashRes.status, 200);
      assert.ok(
        dashRes.text.includes("dashboard") ||
        dashRes.text.includes("Dashboard") ||
        dashRes.text.includes(fakeUser.firstName) ||
        dashRes.text.includes(fakeUser.lastName),
        "Expected dashboard content in response body"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Sad path: wrong password
  // ---------------------------------------------------------------------------
  describe("POST /login with wrong password", function () {
    let app;

    before(async function () {
      const fakeDb = makeFakeDb(function (query, cb) {
        if (query && query.userName === fakeUser.userName) {
          return cb(null, fakeUser);
        }
        cb(null, null);
      });

      app = await vmp.boot("server.js", {
        fakes: {
          mongoose: makeFakeMongoose(),
          mongodb: makeFakeMongodb(fakeDb),
          "./db": fakeDb
        },
        env: { NODE_ENV: "test" }
      });
    });

    after(async function () {
      if (app) await app.close();
    });

    it("renders the login page again with an invalid-password error", async function () {
      const res = await app.request("POST", "/login", {
        form: { userName: fakeUser.userName, password: "vmp-test-wrong-1" }
      });
      assert.strictEqual(res.status, 200);
      assert.ok(
        res.text.includes("Invalid password"),
        `Expected 'Invalid password' in response but got: ${res.text.slice(0, 500)}`
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Sad path: unknown username
  // ---------------------------------------------------------------------------
  describe("POST /login with unknown username", function () {
    let app;

    before(async function () {
      // findOne always returns null → noSuchUser error
      const fakeDb = makeFakeDb(function (query, cb) {
        cb(null, null);
      });

      app = await vmp.boot("server.js", {
        fakes: {
          mongoose: makeFakeMongoose(),
          mongodb: makeFakeMongodb(fakeDb),
          "./db": fakeDb
        },
        env: { NODE_ENV: "test" }
      });
    });

    after(async function () {
      if (app) await app.close();
    });

    it("renders the login page again with an invalid-username error", async function () {
      const res = await app.request("POST", "/login", {
        form: { userName: "vmp-test-no-such-user", password: "vmp-test-1" }
      });
      assert.strictEqual(res.status, 200);
      assert.ok(
        res.text.includes("Invalid username"),
        `Expected 'Invalid username' in response but got: ${res.text.slice(0, 500)}`
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Sad path: GET /dashboard without being logged in
  // ---------------------------------------------------------------------------
  describe("GET /dashboard without a session", function () {
    let app;

    before(async function () {
      const fakeDb = makeFakeDb(function (query, cb) {
        cb(null, null);
      });

      app = await vmp.boot("server.js", {
        fakes: {
          mongoose: makeFakeMongoose(),
          mongodb: makeFakeMongodb(fakeDb),
          "./db": fakeDb
        },
        env: { NODE_ENV: "test" }
      });
    });

    after(async function () {
      if (app) await app.close();
    });

    it("redirects to /login when no session exists", async function () {
      const res = await app.request("GET", "/dashboard");
      assert.strictEqual(res.status, 302);
      assert.ok(
        res.location === "/login" || (res.headers.location || "").includes("/login"),
        `Expected redirect to /login but got: ${res.location}`
      );
    });
  });
});
