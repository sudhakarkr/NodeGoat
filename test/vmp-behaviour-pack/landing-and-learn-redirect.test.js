"use strict";

const assert = require("assert");
const { describe, it, before, after } = require("mocha");
const vmp = require("./_vmp/harness");

const data = vmp.data("landing-and-learn-redirect");

describe("Landing and learn redirect journey", function () {
  this.timeout(15000);

  let userRecord;

  before(function () {
    userRecord = data.record(data.forNeed("authenticated user"));
  });

  function makeApp() {
    const bcrypt = require("../../node_modules/bcrypt-nodejs");
    const hashedPassword = bcrypt.hashSync(userRecord.password, bcrypt.genSaltSync());

    const dbUser = {
      _id: 1,
      userName: userRecord.userName,
      firstName: userRecord.firstName,
      lastName: userRecord.lastName,
      isAdmin: userRecord.isAdmin,
      benefitStartDate: userRecord.benefitStartDate,
      password: hashedPassword
    };

    const fakeUsersCollection = {
      findOne: (query, callback) => {
        if (
          query.userName === dbUser.userName ||
          query._id === dbUser._id ||
          (typeof query._id === "number" && query._id === parseInt(String(dbUser._id)))
        ) {
          callback(null, dbUser);
        } else {
          callback(null, null);
        }
      },
      insert: (doc, callback) => {
        callback(null, { ops: [doc] });
      }
    };

    const fakeAllocationsCollection = {
      findOne: (query, callback) => { callback(null, null); },
      update: (query, update, opts, callback) => { if (callback) callback(null); }
    };

    const fakeCountersCollection = {
      findAndModify: (query, sort, update, opts, callback) => {
        callback(null, { value: { seq: 999 } });
      }
    };

    const fakeDb = {
      collection: (name) => {
        if (name === "users") return fakeUsersCollection;
        if (name === "allocations") return fakeAllocationsCollection;
        if (name === "counters") return fakeCountersCollection;
        return {
          findOne: (q, cb) => cb(null, null),
          find: () => ({ toArray: (cb) => cb(null, []) }),
          insert: (doc, cb) => cb(null, { ops: [doc] }),
          update: (q, u, o, cb) => { if (cb) cb(null); },
          findAndModify: (q, s, u, o, cb) => { if (cb) cb(null, { value: { seq: 1 } }); }
        };
      }
    };

    const fakeModel = {
      findOne: () => ({ exec: (cb) => cb && cb(null, null) }),
      find: () => ({ exec: (cb) => cb && cb(null, []) }),
      count: () => ({ exec: (cb) => cb && cb(null, 0) }),
      remove: () => ({ exec: (cb) => cb && cb(null) }),
      updateOne: () => ({ exec: (cb) => cb && cb(null) }),
      create: (doc, cb) => { if (cb) cb(null, doc); },
      save: (cb) => { if (cb) cb(null); }
    };

    const fakeMongoose = {
      connect: () => {},
      connection: {
        on: () => {},
        once: () => {},
        close: (cb) => { if (cb) cb(); }
      },
      Schema: function Schema(def) { return def; },
      model: () => fakeModel
    };
    fakeMongoose.Schema.Types = { ObjectId: "ObjectId" };

    // Fake mongodb driver so MongoClient.connect never touches the network
    const fakeMongoClient = {
      connect: (url, opts, cb) => {
        const callback = typeof opts === "function" ? opts : cb;
        if (callback) callback(null, fakeDb);
      }
    };
    const fakeMongodb = {
      MongoClient: fakeMongoClient,
      ObjectId: function ObjectId(id) { return id; }
    };

    return vmp.boot("server.js", {
      fakes: {
        mongoose: fakeMongoose,
        mongodb: fakeMongodb,
        "./db": fakeDb,
        "./app/db": fakeDb,
        "../db": fakeDb
      },
      env: { NODE_ENV: "test" }
    });
  }

  describe("Main path: visit landing, login, follow learn link", function () {
    let app;

    before(async function () {
      app = await makeApp();
    });

    after(async function () {
      if (app) await app.close();
    });

    it("GET / without a session redirects to /login", async function () {
      const res = await app.request("GET", "/");
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.location, "/login");
    });

    it("GET /login renders the login page", async function () {
      const res = await app.request("GET", "/login");
      assert.strictEqual(res.status, 200);
      assert.ok(
        res.text.includes("login") || res.text.includes("Login") || res.text.includes("userName"),
        "Expected login page content"
      );
    });

    it("POST /login with valid credentials redirects to /benefits for admin user", async function () {
      const res = await app.request("POST", "/login", {
        form: {
          userName: userRecord.userName,
          password: userRecord.password
        }
      });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.location, "/benefits");
    });

    it("GET /learn with a url query param redirects to the given URL when logged in", async function () {
      const loginRes = await app.request("POST", "/login", {
        form: {
          userName: userRecord.userName,
          password: userRecord.password
        }
      });
      assert.strictEqual(loginRes.status, 302);

      const learnUrl = "https://www.khanacademy.org/economics-finance-domain/core-finance/investment-vehicles-tutorial/ira-401ks/v/traditional-iras";
      const res = await app.request("GET", `/learn?url=${encodeURIComponent(learnUrl)}`);
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.location, learnUrl);
    });
  });

  describe("Refusal: GET /learn without being logged in redirects to /login", function () {
    let app;

    before(async function () {
      app = await makeApp();
    });

    after(async function () {
      if (app) await app.close();
    });

    it("GET /learn without session redirects to /login", async function () {
      const learnUrl = "https://www.khanacademy.org/economics-finance-domain/core-finance/investment-vehicles-tutorial/ira-401ks/v/traditional-iras";
      const res = await app.request("GET", `/learn?url=${encodeURIComponent(learnUrl)}`);
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.location, "/login");
    });
  });

  describe("POST /login with invalid username renders login with error", function () {
    let app;

    before(async function () {
      app = await makeApp();
    });

    after(async function () {
      if (app) await app.close();
    });

    it("POST /login with unknown userName renders login page with error", async function () {
      const res = await app.request("POST", "/login", {
        form: {
          userName: "vmp-test-nonexistent",
          password: "vmp-test-1"
        }
      });
      assert.strictEqual(res.status, 200);
      assert.ok(
        res.text.includes("Invalid username") || res.text.includes("login"),
        "Expected error message on login page"
      );
    });
  });
});
