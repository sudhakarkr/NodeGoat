'use strict';
// The Behaviour Pack's test helper (ADR 0080). Written by the platform, not by a
// model, and the same in every repository: the pack's tests use it to start the
// application in this process and talk to it, or to call one handler directly.
//
//   const vmp = require('./_vmp/harness');
//   const app = await vmp.boot('app.js', { fakes: { './db': fakeDb, mongodb: vmp.fakes.mongodb() } });
//   const res = await app.request('POST', '/login', { form: { username: 'a' } });
//   await app.close();
//
// What it does, and only this:
// * boot(): loads the application's entry module with the modules the test
//   fakes swapped in, and makes every server the application starts listen on
//   127.0.0.1 on a free port. Nothing here reaches another host.
// * request(): one HTTP request to that loopback server, keeping cookies, so a
//   journey of several steps keeps its session.
// * load(): one repository module, loaded with the test's fakes in place.
// * fakeReq() / fakeRes(): a request and response to call one handler with.
// * data(): the journey's synthetic records, written beside the tests.
// * fakes.mongodb(seed): an in-memory native mongodb driver, for an application
//   that connects before it listens (below).

const http = require('http');
const net = require('net');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const util = require('util');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// A refusal says what it was given, where that landed, and the form it takes
// (#1822): told only "must be inside the repository", a fix call could not
// see that it had passed a path relative to the test file.
function outside(what, given, resolved) {
  return (
    'vmp harness: the ' + what + ' must be inside the repository: ' + JSON.stringify(given) +
    ' resolves to ' + resolved + '. vmp.boot and vmp.load take a path relative to the ' +
    'repository root, such as "server.js" or "app/routes/index.js", not one relative to the test file.'
  );
}
const PACK = path.resolve(__dirname, '..');
const DEFAULT_TIMEOUT_MS = 10000;

const servers = [];
const waiters = [];
let originalListen = null;

function installListen() {
  if (originalListen) return;
  originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function vmpListen() {
    const args = Array.prototype.slice.call(arguments);
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    const server = this;
    if (server instanceof http.Server) {
      servers.push(server);
      server.once('listening', function () {
        const ready = waiters.splice(0, waiters.length);
        for (let i = 0; i < ready.length; i++) ready[i](server);
      });
    }
    return originalListen.call(server, 0, '127.0.0.1', cb);
  };
}

function resolveFake(key, from) {
  // A fake named by a path ('./db', 'lib/db.js') stands for that file in the
  // repository; one named by a package ('mongodb') for that package.
  if (!(key.charAt(0) === '.' || key.charAt(0) === '/')) return null;
  return path.resolve(from || ROOT, key);
}

function candidates(file) {
  return [file, file + '.js', file + '.json', path.join(file, 'index.js')];
}

function installFakes(fakes) {
  const names = Object.keys(fakes || {});
  if (!names.length) return function () {};
  const byFile = {};
  for (let i = 0; i < names.length; i++) {
    const file = resolveFake(names[i], ROOT);
    if (file) {
      const all = candidates(file);
      for (let j = 0; j < all.length; j++) byFile[all[j]] = fakes[names[i]];
    }
  }
  /* global jest */
  if (typeof jest === 'object' && jest && typeof jest.doMock === 'function') {
    for (let i = 0; i < names.length; i++) {
      const target = resolveFake(names[i], ROOT) || names[i];
      const fake = fakes[names[i]];
      jest.doMock(target, function () { return fake; }, { virtual: true });
    }
    return function () {
      for (let i = 0; i < names.length; i++) jest.dontMock(resolveFake(names[i], ROOT) || names[i]);
    };
  }
  const original = Module._load;
  Module._load = function vmpLoad(request, parent) {
    if (Object.prototype.hasOwnProperty.call(fakes, request) && !resolveFake(request)) {
      return fakes[request];
    }
    if (request.charAt(0) === '.' && parent && parent.filename) {
      const all = candidates(path.resolve(path.dirname(parent.filename), request));
      for (let i = 0; i < all.length; i++) {
        if (Object.prototype.hasOwnProperty.call(byFile, all[i])) return byFile[all[i]];
      }
    }
    return original.apply(this, arguments);
  };
  return function () { Module._load = original; };
}

function forgetApplication() {
  // A fresh application per boot: the repository's own modules are loaded
  // again; its packages and this pack are not.
  const keys = Object.keys(require.cache);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k.indexOf(ROOT + path.sep) === 0 && k.indexOf(path.sep + 'node_modules' + path.sep) < 0 &&
        k.indexOf(PACK + path.sep) !== 0) {
      delete require.cache[k];
    }
  }
}

function looksLikeApp(value) {
  return typeof value === 'function' && (typeof value.handle === 'function' || typeof value.listen === 'function');
}

function listening(since) {
  for (let i = since; i < servers.length; i++) {
    if (servers[i].listening) return servers[i];
  }
  return null;
}

function waitForServer(since, timeoutMs) {
  const now = listening(since);
  if (now) return Promise.resolve(now);
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      const i = waiters.indexOf(done);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error('vmp harness: the application started no server within ' + timeoutMs + ' ms'));
    }, timeoutMs);
    function done(server) {
      clearTimeout(timer);
      resolve(server);
    }
    waiters.push(done);
  });
}

function boot(entry, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const file = path.resolve(ROOT, entry);
  if (file.indexOf(ROOT + path.sep) !== 0) {
    return Promise.reject(new Error(outside('entry', entry, file)));
  }
  installListen();
  const env = opts.env || {};
  const envKeys = Object.keys(env);
  for (let i = 0; i < envKeys.length; i++) process.env[envKeys[i]] = String(env[envKeys[i]]);
  const since = servers.length;
  const removeFakes = installFakes(opts.fakes || {});
  let exported;
  try {
    forgetApplication();
    exported = require(file);
  } catch (err) {
    removeFakes();
    return Promise.reject(err);
  }
  if (!listening(since) && looksLikeApp(exported)) {
    // The module hands its application back instead of starting it.
    http.createServer(exported).listen();
  } else if (!listening(since) && exported && looksLikeApp(exported.app)) {
    http.createServer(exported.app).listen();
  }
  return waitForServer(since, timeoutMs).then(
    function (server) { return started(server, exported, removeFakes); },
    function (err) { removeFakes(); throw err; }
  );
}

function started(server, exported, removeFakes) {
  const port = server.address().port;
  const cookies = {};
  let closed = false;
  return {
    port: port,
    server: server,
    exported: exported,
    cookies: cookies,
    request: function (method, urlPath, options) {
      return request(port, cookies, method, urlPath, options || {});
    },
    close: function () {
      if (closed) return Promise.resolve();
      closed = true;
      removeFakes();
      return new Promise(function (resolve) {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(function () { resolve(); });
      });
    },
  };
}

function request(port, cookies, method, urlPath, opts) {
  const headers = {};
  const given = opts.headers || {};
  const names = Object.keys(given);
  for (let i = 0; i < names.length; i++) headers[names[i].toLowerCase()] = given[names[i]];
  let body = null;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
  } else if (opts.form !== undefined) {
    body = new URLSearchParams(opts.form).toString();
    if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (opts.body !== undefined) {
    body = typeof opts.body === 'string' || Buffer.isBuffer(opts.body) ? opts.body : String(opts.body);
  }
  if (body !== null) headers['content-length'] = Buffer.byteLength(body);
  const jar = Object.keys(cookies).map(function (k) { return k + '=' + cookies[k]; }).join('; ');
  if (jar && !headers.cookie) headers.cookie = jar;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise(function (resolve, reject) {
    const req = http.request(
      { host: '127.0.0.1', port: port, method: String(method).toUpperCase(), path: urlPath, headers: headers, agent: false },
      function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          const set = [].concat(res.headers['set-cookie'] || []);
          for (let i = 0; i < set.length; i++) {
            const pair = set[i].split(';')[0];
            const at = pair.indexOf('=');
            if (at > 0) cookies[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
          }
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            headers: res.headers,
            location: res.headers.location || null,
            text: text,
            json: function () { return JSON.parse(text); },
          });
        });
      }
    );
    req.setTimeout(timeoutMs, function () {
      req.destroy(new Error('vmp harness: no answer to ' + method + ' ' + urlPath + ' within ' + timeoutMs + ' ms'));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

// --- one handler, called directly ---------------------------------------------

function load(entry, options) {
  // A repository module, loaded fresh with the given fakes in place; they stay
  // in place until close(), so a module that requires lazily gets them too.
  const opts = options || {};
  const file = path.resolve(ROOT, entry);
  if (file.indexOf(ROOT + path.sep) !== 0) throw new Error(outside('module', entry, file));
  const removeFakes = installFakes(opts.fakes || {});
  try {
    forgetApplication();
    return { module: require(file), close: removeFakes };
  } catch (err) {
    removeFakes();
    throw err;
  }
}

function fakeReq(options) {
  const o = options || {};
  const headers = {};
  const given = o.headers || {};
  const names = Object.keys(given);
  for (let i = 0; i < names.length; i++) headers[names[i].toLowerCase()] = given[names[i]];
  const url = o.url || o.path || '/';
  const req = {
    method: String(o.method || 'GET').toUpperCase(),
    url: url,
    originalUrl: url,
    path: o.path || url.split('?')[0],
    params: o.params || {},
    query: o.query || {},
    body: o.body === undefined ? {} : o.body,
    headers: headers,
    cookies: o.cookies || {},
    signedCookies: o.signedCookies || {},
    session: o.session || {},
    files: o.files,
    user: o.user,
    ip: '127.0.0.1',
    get: function (name) { return headers[String(name).toLowerCase()]; },
    header: function (name) { return headers[String(name).toLowerCase()]; },
  };
  const extra = o.extra || {};
  const keys = Object.keys(extra);
  for (let i = 0; i < keys.length; i++) req[keys[i]] = extra[keys[i]];
  return req;
}

function fakeRes() {
  let settle;
  const done = new Promise(function (resolve) { settle = resolve; });
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    view: null,
    locals: {},
    redirectedTo: null,
    cookies: {},
    ended: false,
    nextCalled: false,
    nextError: undefined,
    done: done,
    status: function (code) { res.statusCode = code; return res; },
    set: function (name, value) {
      if (typeof name === 'object') {
        const keys = Object.keys(name);
        for (let i = 0; i < keys.length; i++) res.headers[keys[i].toLowerCase()] = name[keys[i]];
      } else {
        res.headers[String(name).toLowerCase()] = value;
      }
      return res;
    },
    header: function (name, value) { return res.set(name, value); },
    setHeader: function (name, value) { res.headers[String(name).toLowerCase()] = value; },
    get: function (name) { return res.headers[String(name).toLowerCase()]; },
    getHeader: function (name) { return res.headers[String(name).toLowerCase()]; },
    type: function (value) { res.headers['content-type'] = value; return res; },
    cookie: function (name, value) { res.cookies[name] = value; return res; },
    clearCookie: function (name) { delete res.cookies[name]; return res; },
    json: function (value) { res.body = value; return finish(); },
    send: function (value) { res.body = value; return finish(); },
    end: function (value) { if (value !== undefined) res.body = value; return finish(); },
    sendStatus: function (code) { res.statusCode = code; return finish(); },
    render: function (view, locals, cb) {
      res.view = view;
      if (typeof locals === 'function') { cb = locals; locals = {}; }
      res.locals = locals || {};
      if (typeof cb === 'function') { cb(null, ''); return undefined; }
      return finish();
    },
    redirect: function (a, b) {
      if (typeof a === 'number') { res.statusCode = a; res.redirectedTo = b; } else { res.statusCode = 302; res.redirectedTo = a; }
      return finish();
    },
    next: function (err) { res.nextCalled = true; res.nextError = err; return finish(); },
  };
  function finish() {
    if (!res.ended) { res.ended = true; settle(res); }
    return res;
  }
  return res;
}

// --- the journey's data ---------------------------------------------------------

function data(journey) {
  const file = path.join(PACK, 'data', journey + '.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const records = doc.records || {};
  return {
    journey: doc.journey,
    sources: doc.sources || [],
    ids: function () { return Object.keys(records); },
    entity: function (id) { return records[id] ? records[id].entity : undefined; },
    record: function (id) {
      if (!Object.prototype.hasOwnProperty.call(records, id)) throw new Error('vmp harness: no record ' + id);
      return JSON.parse(JSON.stringify(records[id].values));
    },
    forNeed: function (name) {
      const needs = doc.needs || [];
      for (let i = 0; i < needs.length; i++) if (needs[i].name === name) return needs[i].record;
      return undefined;
    },
  };
}

// --- ready-made fakes -----------------------------------------------------------
//
// An in-memory stand-in for the native `mongodb` driver (#1827). The sandbox is
// offline, so an application that connects before it listens (NodeGoat) cannot
// be started without one, and a fake written for each test broke in the same
// few ways. Use it as the module:
//
//   const mongo = vmp.fakes.mongodb({ users: [data.record('user#0')] });
//   const app = await vmp.boot('server.js', { fakes: { mongodb: mongo } });
//   new MemosDAO(mongo.db());          // a connected db, for a module that takes one
//   mongo.docs('memos');               // copies of what the application wrote
//
// The connected value is a Db and a client at once, so code written for the 2.x
// driver (`connect(url, (err, db) => db.collection(...))`) and for 3.x and later
// (`client.db().collection(...)`) both work. Every database name sees the same
// collections. Every call takes a callback or returns a promise, as the driver
// does. Ids come from a counter and nothing reads the clock: a run is the same
// every time. A query or update operator it does not know is an error naming
// this fake, never a silent non-match.

function fakeMongodb(seed) {
  const store = {};
  let counter = 0;
  const FAKE = 'vmp mongodb fake: ';

  function unsupported(what) {
    return new Error(FAKE + what + ' is not supported; reach that code at a lower level');
  }

  // -- ids ----------------------------------------------------------------------
  function ObjectID(id) {
    if (!(this instanceof ObjectID)) return new ObjectID(id);
    let hex;
    if (id === undefined || id === null) {
      counter += 1;
      hex = ('000000000000000000000000' + counter.toString(16)).slice(-24);
    } else if (id && typeof id.toHexString === 'function') {
      hex = String(id.toHexString()).toLowerCase();
    } else if (typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id)) {
      hex = id.toLowerCase();
    } else {
      throw new TypeError(
        FAKE + 'an ObjectID is made from nothing or from 24 hex characters, not ' + JSON.stringify(id)
      );
    }
    Object.defineProperty(this, '_hex', { value: hex, enumerable: false });
  }
  ObjectID.prototype._bsontype = 'ObjectID';
  ObjectID.prototype.toHexString = function () { return this._hex; };
  ObjectID.prototype.toString = function () { return this._hex; };
  ObjectID.prototype.toJSON = function () { return this._hex; };
  ObjectID.prototype.equals = function (other) { return isId(other) && String(other.toHexString()).toLowerCase() === this._hex; };
  ObjectID.prototype.getTimestamp = function () { return new Date(parseInt(this._hex.slice(0, 8), 16) * 1000); };
  ObjectID.prototype[util.inspect.custom] = function () { return 'ObjectID("' + this._hex + '")'; };
  ObjectID.isValid = function (v) {
    return isId(v) || (typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v));
  };
  ObjectID.createFromHexString = function (hex) { return new ObjectID(hex); };

  // -- values -------------------------------------------------------------------
  function isId(v) { return !!v && typeof v === 'object' && typeof v.toHexString === 'function'; }
  function isPlain(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) &&
      !(v instanceof RegExp) && !isId(v) && !Buffer.isBuffer(v);
  }
  function isOperators(v) {
    if (!isPlain(v)) return false;
    const keys = Object.keys(v);
    return keys.length > 0 && keys.every(function (k) { return k.charAt(0) === '$'; });
  }
  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v instanceof Date) return new Date(v.getTime());
    if (isId(v)) return new ObjectID(v.toHexString());
    if (Buffer.isBuffer(v)) return Buffer.from(v);
    if (v instanceof RegExp) return new RegExp(v.source, v.flags);
    if (v && typeof v === 'object') {
      const out = {};
      const keys = Object.keys(v);
      for (let i = 0; i < keys.length; i++) out[keys[i]] = clone(v[keys[i]]);
      return out;
    }
    return v;
  }
  function same(a, b) {
    if (isId(a) || isId(b)) return isId(a) && isId(b) && String(a.toHexString()).toLowerCase() === String(b.toHexString()).toLowerCase();
    if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
        a.every(function (x, i) { return same(x, b[i]); });
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      return ka.length === kb.length && ka.every(function (k, i) { return k === kb[i] && same(a[k], b[k]); });
    }
    if (a === undefined) a = null;
    if (b === undefined) b = null;
    return a === b;
  }
  // The store's order across types (null, numbers, strings, objects, arrays,
  // ids, booleans, dates), then within one.
  function rank(v) {
    if (v === undefined || v === null) return 0;
    if (typeof v === 'number') return 1;
    if (typeof v === 'string') return 2;
    if (Array.isArray(v)) return 4;
    if (isId(v)) return 5;
    if (typeof v === 'boolean') return 6;
    if (v instanceof Date) return 7;
    return 3;
  }
  function order(a, b) {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (ra === 0) return 0;
    if (ra === 5) a = a.toHexString(), b = b.toHexString();
    if (ra === 7) a = a.getTime(), b = b.getTime();
    if (ra === 3 || ra === 4) a = JSON.stringify(a), b = JSON.stringify(b);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  // Comparable only within one kind, as the store compares.
  function comparable(a, b) {
    const ra = rank(a);
    return ra !== 0 && ra === rank(b);
  }

  // -- paths ----------------------------------------------------------------------
  function found(doc, path) {
    // Every value at a dotted path, an array's elements beside the array.
    let here = [doc];
    const parts = String(path).split('.');
    for (let i = 0; i < parts.length; i++) {
      const next = [];
      for (let j = 0; j < here.length; j++) {
        const v = here[j];
        if (Array.isArray(v) && !/^\d+$/.test(parts[i])) {
          for (let k = 0; k < v.length; k++) {
            if (v[k] && typeof v[k] === 'object' && parts[i] in v[k]) next.push(v[k][parts[i]]);
          }
        } else if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, parts[i])) {
          next.push(v[parts[i]]);
        }
      }
      here = next;
    }
    const out = [];
    for (let i = 0; i < here.length; i++) {
      if (here[i] === undefined) continue;
      out.push(here[i]);
      if (Array.isArray(here[i])) for (let k = 0; k < here[i].length; k++) out.push(here[i][k]);
    }
    return out;
  }
  function getPath(doc, path) {
    const parts = String(path).split('.');
    let v = doc;
    for (let i = 0; i < parts.length; i++) {
      if (!v || typeof v !== 'object') return undefined;
      v = v[parts[i]];
    }
    return v;
  }
  function setPath(doc, path, value) {
    const parts = String(path).split('.');
    let v = doc;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!v[parts[i]] || typeof v[parts[i]] !== 'object') v[parts[i]] = {};
      v = v[parts[i]];
    }
    v[parts[parts.length - 1]] = value;
  }
  function unsetPath(doc, path) {
    const parts = String(path).split('.');
    let v = doc;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!v || typeof v !== 'object') return;
      v = v[parts[i]];
    }
    if (v && typeof v === 'object') delete v[parts[parts.length - 1]];
  }

  // -- queries --------------------------------------------------------------------
  function regex(pattern, options) {
    if (pattern instanceof RegExp) return options ? new RegExp(pattern.source, options) : pattern;
    return new RegExp(String(pattern), options || '');
  }
  function equals(vals, x) {
    // null matches a missing field too, as in the store.
    if (x === null || x === undefined) return vals.length === 0 || vals.some(function (v) { return v === null; });
    return vals.some(function (v) { return same(v, x); });
  }
  function matchesValue(doc, path, cond) {
    const vals = found(doc, path);
    if (cond instanceof RegExp) return vals.some(function (v) { return typeof v === 'string' && cond.test(v); });
    if (!isOperators(cond)) return equals(vals, cond);
    const ops = Object.keys(cond);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const x = cond[op];
      let ok;
      switch (op) {
        case '$eq': ok = equals(vals, x); break;
        case '$ne': ok = !matchesValue(doc, path, { $eq: x }); break;
        case '$gt': ok = vals.some(function (v) { return comparable(v, x) && order(v, x) > 0; }); break;
        case '$gte': ok = vals.some(function (v) { return comparable(v, x) && order(v, x) >= 0; }); break;
        case '$lt': ok = vals.some(function (v) { return comparable(v, x) && order(v, x) < 0; }); break;
        case '$lte': ok = vals.some(function (v) { return comparable(v, x) && order(v, x) <= 0; }); break;
        case '$in':
          if (!Array.isArray(x)) throw new Error(FAKE + '$in needs an array');
          ok = x.some(function (e) { return matchesValue(doc, path, e); });
          break;
        case '$nin':
          if (!Array.isArray(x)) throw new Error(FAKE + '$nin needs an array');
          ok = !x.some(function (e) { return matchesValue(doc, path, e); });
          break;
        case '$exists': ok = (vals.length > 0) === !!x; break;
        case '$regex': {
          const re = regex(x, cond.$options);
          ok = vals.some(function (v) { return typeof v === 'string' && re.test(v); });
          break;
        }
        case '$options': ok = true; break;
        case '$not': ok = !matchesValue(doc, path, x); break;
        case '$size': ok = vals.some(function (v) { return Array.isArray(v) && v.length === x; }); break;
        case '$all':
          if (!Array.isArray(x)) throw new Error(FAKE + '$all needs an array');
          ok = x.every(function (e) { return matchesValue(doc, path, e); });
          break;
        case '$elemMatch':
          ok = vals.some(function (v) {
            return Array.isArray(v) && v.some(function (el) {
              return isPlain(el) && !isOperators(x) ? matches(el, x) : matchesValue({ v: el }, 'v', x);
            });
          });
          break;
        default:
          throw unsupported('the query operator ' + op);
      }
      if (!ok) return false;
    }
    return true;
  }
  function matches(doc, query) {
    if (query === undefined || query === null) return true;
    if (!isPlain(query)) {
      // find(id): the driver reads a bare value as an _id.
      return matchesValue(doc, '_id', query);
    }
    const keys = Object.keys(query);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const q = query[k];
      if (k === '$and' || k === '$or' || k === '$nor') {
        if (!Array.isArray(q)) throw new Error(FAKE + k + ' needs an array');
        const hits = q.map(function (sub) { return matches(doc, sub); });
        if (k === '$and' && !hits.every(Boolean)) return false;
        if (k === '$or' && !hits.some(Boolean)) return false;
        if (k === '$nor' && hits.some(Boolean)) return false;
      } else if (k === '$comment') {
        continue;
      } else if (k.charAt(0) === '$') {
        throw unsupported('the query operator ' + k);
      } else if (!matchesValue(doc, k, q)) {
        return false;
      }
    }
    return true;
  }

  // -- updates --------------------------------------------------------------------
  function isUpdate(update) {
    return isPlain(update) && Object.keys(update).some(function (k) { return k.charAt(0) === '$'; });
  }
  function applyUpdate(doc, update, inserting) {
    if (!isUpdate(update)) {
      if (!isPlain(update)) throw new Error(FAKE + 'an update is a document');
      const id = doc._id;
      const keys = Object.keys(doc);
      for (let i = 0; i < keys.length; i++) delete doc[keys[i]];
      const repl = clone(update);
      if (id !== undefined) doc._id = id;
      const rk = Object.keys(repl);
      for (let i = 0; i < rk.length; i++) if (rk[i] !== '_id' || id === undefined) doc[rk[i]] = repl[rk[i]];
      return;
    }
    const ops = Object.keys(update);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const fields = update[op] || {};
      const names = Object.keys(fields);
      for (let j = 0; j < names.length; j++) {
        const f = names[j];
        if (f.indexOf('$') >= 0) throw unsupported('the positional update path ' + f);
        const x = fields[f];
        const now = getPath(doc, f);
        switch (op) {
          case '$set': setPath(doc, f, clone(x)); break;
          case '$setOnInsert': if (inserting) setPath(doc, f, clone(x)); break;
          case '$unset': unsetPath(doc, f); break;
          case '$inc': setPath(doc, f, (typeof now === 'number' ? now : 0) + x); break;
          case '$mul': setPath(doc, f, (typeof now === 'number' ? now : 0) * x); break;
          case '$min': if (now === undefined || order(x, now) < 0) setPath(doc, f, clone(x)); break;
          case '$max': if (now === undefined || order(x, now) > 0) setPath(doc, f, clone(x)); break;
          case '$push':
          case '$addToSet': {
            const list = Array.isArray(now) ? now : [];
            const each = isPlain(x) && Array.isArray(x.$each) ? x.$each : [x];
            for (let k = 0; k < each.length; k++) {
              if (op === '$push' || !list.some(function (e) { return same(e, each[k]); })) list.push(clone(each[k]));
            }
            setPath(doc, f, list);
            break;
          }
          case '$pull':
            if (Array.isArray(now)) {
              setPath(doc, f, now.filter(function (e) {
                return !(isPlain(x) && isPlain(e) ? matches(e, x) : matchesValue({ v: e }, 'v', x));
              }));
            }
            break;
          default:
            throw unsupported('the update operator ' + op);
        }
      }
    }
  }
  function fromQuery(query) {
    // An upsert starts from the query's plain equalities.
    const doc = {};
    if (!isPlain(query)) return doc;
    const keys = Object.keys(query);
    for (let i = 0; i < keys.length; i++) {
      const q = query[keys[i]];
      if (keys[i].charAt(0) === '$') continue;
      if (isOperators(q)) {
        if (Object.prototype.hasOwnProperty.call(q, '$eq')) setPath(doc, keys[i], clone(q.$eq));
      } else if (!(q instanceof RegExp)) {
        setPath(doc, keys[i], clone(q));
      }
    }
    return doc;
  }

  // -- calls: a callback when given, else a promise ------------------------------
  function split(args) {
    const list = Array.prototype.slice.call(args);
    while (list.length && list[list.length - 1] === undefined) list.pop();
    const cb = typeof list[list.length - 1] === 'function' ? list.pop() : null;
    return { args: list, cb: cb };
  }
  function answer(cb, work) {
    let value;
    let error = null;
    try { value = work(); } catch (err) { error = err; }
    if (cb) {
      process.nextTick(function () { if (error) cb(error, null); else cb(null, value); });
      return undefined;
    }
    return error ? Promise.reject(error) : Promise.resolve(value);
  }
  function rows(name) {
    if (!Object.prototype.hasOwnProperty.call(store, name)) store[name] = [];
    return store[name];
  }
  function assignId(doc) {
    if (doc._id === undefined) doc._id = new ObjectID();
    return doc;
  }
  function addRow(name, doc) {
    const list = rows(name);
    if (list.some(function (r) { return same(r._id, doc._id); })) {
      const err = new Error('E11000 duplicate key error collection: ' + name + ' index: _id_ dup key: { _id: ' +
        JSON.stringify(doc._id) + ' }');
      err.code = 11000;
      throw err;
    }
    list.push(clone(doc));
  }
  function sortSpec(spec, dir) {
    if (spec === undefined || spec === null) return [];
    if (typeof spec === 'string') return [[spec, direction(dir === undefined ? 1 : dir)]];
    if (Array.isArray(spec)) {
      return spec.map(function (s) { return Array.isArray(s) ? [s[0], direction(s[1])] : [String(s), 1]; });
    }
    return Object.keys(spec).map(function (k) { return [k, direction(spec[k])]; });
  }
  function direction(d) {
    if (d === -1 || d === 'desc' || d === 'descending') return -1;
    if (d === 1 || d === 'asc' || d === 'ascending' || d === undefined) return 1;
    throw unsupported('the sort direction ' + JSON.stringify(d));
  }
  function sorted(list, spec) {
    if (!spec.length) return list;
    return list.map(function (d, i) { return [d, i]; }).sort(function (a, b) {
      for (let i = 0; i < spec.length; i++) {
        const va = found(a[0], spec[i][0])[0];
        const vb = found(b[0], spec[i][0])[0];
        const c = order(va, vb);
        if (c) return c * spec[i][1];
      }
      return a[1] - b[1];
    }).map(function (p) { return p[0]; });
  }
  function projected(doc, projection) {
    if (!isPlain(projection) || !Object.keys(projection).length) return doc;
    const keys = Object.keys(projection);
    const including = keys.some(function (k) { return k !== '_id' && projection[k]; });
    let out;
    if (including) {
      out = {};
      for (let i = 0; i < keys.length; i++) {
        if (projection[keys[i]] && keys[i] !== '_id') {
          const v = getPath(doc, keys[i]);
          if (v !== undefined) setPath(out, keys[i], v);
        }
      }
      if (projection._id === undefined || projection._id) { if (doc._id !== undefined) out._id = doc._id; }
    } else {
      out = doc;
      for (let i = 0; i < keys.length; i++) if (!projection[keys[i]]) unsetPath(out, keys[i]);
    }
    return out;
  }
  function selected(name, query) {
    return rows(name).filter(function (d) { return matches(d, query); });
  }

  // -- the cursor -------------------------------------------------------------------
  function Cursor(produce) {
    this._produce = produce;
    this._sort = [];
    this._skip = 0;
    this._limit = 0;
    this._projection = null;
    this._mapped = null;
    this._out = null;
    this._at = 0;
  }
  Cursor.prototype._all = function () {
    if (this._out === null) {
      let list = sorted(this._produce(), this._sort);
      if (this._skip) list = list.slice(this._skip);
      if (this._limit) list = list.slice(0, Math.abs(this._limit));
      const projection = this._projection;
      const mapped = this._mapped;
      this._out = list.map(function (d) {
        const doc = projected(clone(d), projection);
        return mapped ? mapped(doc) : doc;
      });
    }
    return this._out;
  };
  Cursor.prototype.sort = function (spec, dir) { this._sort = sortSpec(spec, dir); return this; };
  Cursor.prototype.skip = function (n) { this._skip = n; return this; };
  Cursor.prototype.limit = function (n) { this._limit = n; return this; };
  Cursor.prototype.project = function (p) { this._projection = p; return this; };
  Cursor.prototype.map = function (fn) {
    const before = this._mapped;
    this._mapped = before ? function (d) { return fn(before(d)); } : fn;
    return this;
  };
  Cursor.prototype.batchSize = function () { return this; };
  Cursor.prototype.maxTimeMS = function () { return this; };
  Cursor.prototype.hint = function () { return this; };
  Cursor.prototype.toArray = function (cb) {
    const self = this;
    return answer(typeof cb === 'function' ? cb : null, function () {
      const rest = self._all().slice(self._at);
      self._at = self._all().length;
      return rest;
    });
  };
  Cursor.prototype.count = function () {
    const s = split(arguments);
    const self = this;
    return answer(s.cb, function () {
      // As the driver: skip and limit apply only when asked to.
      if (s.args[0] === true) return self._all().length;
      return self._produce().length;
    });
  };
  Cursor.prototype.next = function (cb) {
    const self = this;
    return answer(typeof cb === 'function' ? cb : null, function () {
      const all = self._all();
      return self._at < all.length ? all[self._at++] : null;
    });
  };
  Cursor.prototype.hasNext = function (cb) {
    const self = this;
    return answer(typeof cb === 'function' ? cb : null, function () { return self._at < self._all().length; });
  };
  Cursor.prototype.forEach = function (iterator, end) {
    const self = this;
    return answer(typeof end === 'function' ? end : null, function () {
      const all = self._all();
      while (self._at < all.length) {
        if (iterator(all[self._at++]) === false) break;
      }
      return undefined;
    });
  };
  Cursor.prototype.close = function (cb) { return answer(typeof cb === 'function' ? cb : null, function () { return undefined; }); };
  Cursor.prototype[Symbol.asyncIterator] = function () {
    const self = this;
    return { next: function () {
      const all = self._all();
      return Promise.resolve(self._at < all.length ? { value: all[self._at++], done: false } : { value: undefined, done: true });
    } };
  };

  // -- a collection -------------------------------------------------------------------
  function findOptions(opts) {
    // find(query, fields) in the 2.x driver; find(query, { projection, sort, ... }) later.
    if (!isPlain(opts)) return {};
    const known = ['projection', 'fields', 'sort', 'skip', 'limit'];
    if (Object.keys(opts).some(function (k) { return known.indexOf(k) >= 0; })) return opts;
    return { projection: opts };
  }
  function Collection(name) {
    this.collectionName = name;
    this.namespace = 'vmp.' + name;
  }
  const C = Collection.prototype;
  C.find = function () {
    const s = split(arguments);
    const name = this.collectionName;
    const query = s.args[0];
    const opts = findOptions(s.args[1]);
    const cursor = new Cursor(function () { return selected(name, query); });
    if (opts.sort) cursor.sort(opts.sort);
    if (opts.skip) cursor.skip(opts.skip);
    if (opts.limit) cursor.limit(opts.limit);
    if (opts.projection || opts.fields) cursor.project(opts.projection || opts.fields);
    if (s.cb) { process.nextTick(function () { s.cb(null, cursor); }); return undefined; }
    return cursor;
  };
  C.findOne = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () {
      const opts = findOptions(s.args[1]);
      let list = sorted(selected(name, s.args[0]), sortSpec(opts.sort));
      if (opts.skip) list = list.slice(opts.skip);
      return list.length ? projected(clone(list[0]), opts.projection || opts.fields) : null;
    });
  };
  function insertAll(name, docs) {
    docs.forEach(function (d) {
      if (!isPlain(d)) throw new Error(FAKE + 'an inserted document is an object');
      assignId(d);
    });
    docs.forEach(function (d) { addRow(name, d); });
    const ids = {};
    docs.forEach(function (d, i) { ids[i] = d._id; });
    return {
      acknowledged: true,
      insertedCount: docs.length,
      insertedIds: ids,
      insertedId: docs.length ? docs[0]._id : undefined,
      ops: docs,
      result: { ok: 1, n: docs.length },
    };
  }
  C.insertOne = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () { return insertAll(name, [s.args[0]]); });
  };
  C.insertMany = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () {
      if (!Array.isArray(s.args[0])) throw new Error(FAKE + 'insertMany takes an array');
      return insertAll(name, s.args[0]);
    });
  };
  C.insert = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () {
      return insertAll(name, Array.isArray(s.args[0]) ? s.args[0] : [s.args[0]]);
    });
  };
  function updateRows(name, query, update, opts, many) {
    const options = opts || {};
    const list = rows(name);
    const hits = list.filter(function (d) { return matches(d, query); });
    const touched = many ? hits : hits.slice(0, 1);
    let modified = 0;
    for (let i = 0; i < touched.length; i++) {
      const before = clone(touched[i]);
      applyUpdate(touched[i], update, false);
      if (!same(before, touched[i])) modified += 1;
    }
    let upsertedId = null;
    if (!hits.length && options.upsert) {
      const doc = isUpdate(update) ? fromQuery(query) : {};
      if (!isUpdate(update) && isPlain(query) && query._id !== undefined && !isOperators(query._id)) doc._id = clone(query._id);
      applyUpdate(doc, update, true);
      assignId(doc);
      addRow(name, doc);
      upsertedId = doc._id;
    }
    const n = touched.length + (upsertedId === null ? 0 : 1);
    return {
      acknowledged: true,
      matchedCount: touched.length,
      modifiedCount: modified,
      upsertedCount: upsertedId === null ? 0 : 1,
      upsertedId: upsertedId,
      result: { ok: 1, n: n, nModified: modified },
    };
  }
  C.updateOne = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () { return updateRows(name, s.args[0], s.args[1], s.args[2], false); });
  };
  C.updateMany = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () { return updateRows(name, s.args[0], s.args[1], s.args[2], true); });
  };
  C.update = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () {
      const opts = s.args[2] || {};
      return updateRows(name, s.args[0], s.args[1], opts, !!opts.multi);
    });
  };
  C.replaceOne = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () {
      if (isUpdate(s.args[1])) throw new Error(FAKE + 'a replacement holds no update operator');
      return updateRows(name, s.args[0], s.args[1], s.args[2], false);
    });
  };
  C.save = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () {
      const doc = s.args[0];
      if (doc && doc._id !== undefined) return updateRows(name, { _id: doc._id }, doc, { upsert: true }, false);
      return insertAll(name, [doc]);
    });
  };
  function removeRows(name, query, many) {
    const list = rows(name);
    let removed = 0;
    for (let i = 0; i < list.length;) {
      if ((many || !removed) && matches(list[i], query)) {
        list.splice(i, 1);
        removed += 1;
      } else {
        i += 1;
      }
    }
    return { acknowledged: true, deletedCount: removed, result: { ok: 1, n: removed } };
  }
  C.deleteOne = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () { return removeRows(name, s.args[0], false); });
  };
  C.deleteMany = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () { return removeRows(name, s.args[0], true); });
  };
  C.remove = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () {
      const opts = s.args[1] || {};
      return removeRows(name, s.args[0], !(opts.single || opts.justOne));
    });
  };
  C.count = C.countDocuments = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () {
      const opts = s.args[1] || {};
      let n = selected(name, s.args[0]).length - (opts.skip || 0);
      if (n < 0) n = 0;
      return opts.limit ? Math.min(n, opts.limit) : n;
    });
  };
  C.estimatedDocumentCount = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () { return rows(name).length; });
  };
  C.distinct = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () {
      const out = [];
      selected(name, s.args[1]).forEach(function (d) {
        found(d, s.args[0]).forEach(function (v) {
          if (!Array.isArray(v) && !out.some(function (o) { return same(o, v); })) out.push(clone(v));
        });
      });
      return out;
    });
  };
  function findAndChange(name, query, sort, change, opts) {
    // The { value, ok } answer of the 2.x to 5.x drivers.
    const options = opts || {};
    const hit = sorted(selected(name, query), sortSpec(sort))[0];
    if (change === null) {
      if (!hit) return { value: null, ok: 1 };
      const gone = clone(hit);
      const list = rows(name);
      list.splice(list.indexOf(hit), 1);
      return { value: projected(gone, options.projection || options.fields), ok: 1, lastErrorObject: { n: 1 } };
    }
    const after = options.new === true || options.returnOriginal === false || options.returnDocument === 'after';
    if (hit) {
      const before = clone(hit);
      applyUpdate(hit, change, false);
      const value = after ? clone(hit) : before;
      return { value: projected(value, options.projection || options.fields), ok: 1, lastErrorObject: { n: 1, updatedExisting: true } };
    }
    if (!options.upsert) return { value: null, ok: 1, lastErrorObject: { n: 0, updatedExisting: false } };
    const res = updateRows(name, query, change, { upsert: true }, false);
    const doc = rows(name).filter(function (d) { return same(d._id, res.upsertedId); })[0];
    return {
      value: after ? projected(clone(doc), options.projection || options.fields) : null,
      ok: 1,
      lastErrorObject: { n: 1, updatedExisting: false, upserted: res.upsertedId },
    };
  }
  C.findAndModify = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () {
      const opts = s.args[3] || {};
      return findAndChange(name, s.args[0], s.args[1], opts.remove ? null : s.args[2], opts);
    });
  };
  C.findOneAndUpdate = C.findOneAndReplace = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () {
      const opts = s.args[2] || {};
      return findAndChange(name, s.args[0], opts.sort, s.args[1], opts);
    });
  };
  C.findOneAndDelete = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () {
      const opts = s.args[1] || {};
      return findAndChange(name, s.args[0], opts.sort, null, opts);
    });
  };
  C.findAndRemove = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () { return findAndChange(name, s.args[0], s.args[1], null, s.args[2]); });
  };
  C.aggregate = function () {
    const s = split(arguments);
    const name = this.collectionName;
    const stages = Array.isArray(s.args[0]) ? s.args[0] : [];
    const cursor = new Cursor(function () {
      let list = rows(name).slice();
      for (let i = 0; i < stages.length; i++) {
        const st = Object.keys(stages[i] || {})[0];
        const x = stages[i][st];
        if (st === '$match') list = list.filter(function (d) { return matches(d, x); });
        else if (st === '$sort') list = sorted(list, sortSpec(x));
        else if (st === '$skip') list = list.slice(x);
        else if (st === '$limit') list = list.slice(0, x);
        else if (st === '$project') list = list.map(function (d) { return projected(clone(d), x); });
        else if (st === '$count') list = [{ [x]: list.length }];
        else throw unsupported('the aggregation stage ' + st);
      }
      return list;
    });
    if (s.cb) { process.nextTick(function () { s.cb(null, cursor); }); return undefined; }
    return cursor;
  };
  C.drop = function () {
    const s = split(arguments);
    const name = this.collectionName;
    return answer(s.cb, function () { delete store[name]; return true; });
  };
  C.createIndex = C.ensureIndex = function () {
    const s = split(arguments);
    return answer(s.cb, function () { return 'vmp_index'; });
  };
  C.createIndexes = C.dropIndex = C.dropIndexes = function () {
    const s = split(arguments);
    return answer(s.cb, function () { return true; });
  };
  C.indexes = C.indexInformation = function () {
    const s = split(arguments);
    return answer(s.cb, function () { return [{ v: 2, key: { _id: 1 }, name: '_id_' }]; });
  };

  // -- a database, and the client that is one too ------------------------------------
  const collections = {};
  function collection(name) {
    if (typeof name !== 'string' || !name) throw new TypeError(FAKE + 'a collection is named by a string');
    if (!collections[name]) collections[name] = new Collection(name);
    return collections[name];
  }
  function Db(name) { this.databaseName = name || 'test'; }
  const D = Db.prototype;
  D.collection = function () {
    const s = split(arguments);
    const c = collection(s.args[0]);
    if (s.cb) process.nextTick(function () { s.cb(null, c); });
    return c;
  };
  D.createCollection = function () {
    const s = split(arguments);
    return answer(s.cb, function () { rows(s.args[0]); return collection(s.args[0]); });
  };
  D.dropCollection = function () {
    const s = split(arguments);
    return answer(s.cb, function () { delete store[s.args[0]]; return true; });
  };
  D.dropDatabase = function () {
    const s = split(arguments);
    return answer(s.cb, function () {
      Object.keys(store).forEach(function (k) { delete store[k]; });
      return true;
    });
  };
  D.collections = function () {
    const s = split(arguments);
    return answer(s.cb, function () { return Object.keys(store).map(collection); });
  };
  D.listCollections = function () {
    return new Cursor(function () {
      return Object.keys(store).map(function (n) { return { name: n, type: 'collection' }; });
    });
  };
  D.close = function () {
    const s = split(arguments);
    return answer(s.cb, function () { return undefined; });
  };
  D.db = function (name) { return new Db(name || this.databaseName); };

  function MongoClient(url, options) {
    if (!(this instanceof MongoClient)) return new MongoClient(url, options);
    Db.call(this, 'test');
    this.url = url;
  }
  MongoClient.prototype = Object.create(Db.prototype);
  MongoClient.prototype.constructor = MongoClient;
  MongoClient.prototype.connect = function (cb) {
    const self = this;
    return answer(typeof cb === 'function' ? cb : null, function () { return self; });
  };
  MongoClient.prototype.isConnected = function () { return true; };
  MongoClient.prototype.db = function (name) { return new Db(name); };
  MongoClient.connect = function () {
    const s = split(arguments);
    const client = new MongoClient(s.args[0], s.args[1]);
    return answer(s.cb, function () { return client; });
  };

  // -- the seed ---------------------------------------------------------------------
  if (seed !== undefined && seed !== null) {
    if (!isPlain(seed)) throw new TypeError(FAKE + 'the seed is { collection: [documents] }');
    Object.keys(seed).forEach(function (name) {
      if (!Array.isArray(seed[name])) throw new TypeError(FAKE + 'the seed for ' + name + ' is an array of documents');
      insertAll(name, seed[name].map(clone));
    });
  }

  return {
    MongoClient: MongoClient,
    ObjectID: ObjectID,
    ObjectId: ObjectID,
    Db: Db,
    connect: MongoClient.connect,
    // For the test: a connected database, and what a collection holds now.
    db: function (name) { return new Db(name); },
    docs: function (name) { return Object.prototype.hasOwnProperty.call(store, name) ? clone(store[name]) : []; },
  };
}

const fakes = { mongodb: fakeMongodb };

module.exports = { boot: boot, load: load, fakeReq: fakeReq, fakeRes: fakeRes, data: data, fakes: fakes, ROOT: ROOT };
