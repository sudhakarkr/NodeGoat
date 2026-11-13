"use strict";

const { describe, it } = require('mocha');
const assert = require('assert');
const { errorHandler } = require('../../../app/routes/error');

describe('errorHandler', function () {

  function makeRes() {
    const res = {
      _status: null,
      _rendered: null,
      _renderData: null,
      status(code) {
        this._status = code;
        return this;
      },
      render(template, data) {
        this._rendered = template;
        this._renderData = data;
      }
    };
    return res;
  }

  function makeReq() {
    return {};
  }

  it('calls res.status with 500', function () {
    const err = new Error('something went wrong');
    const req = makeReq();
    const res = makeRes();
    const next = function () {};

    errorHandler(err, req, res, next);

    assert.strictEqual(res._status, 500);
  });

  it('calls res.render with the "error-template" template', function () {
    const err = new Error('render test');
    const req = makeReq();
    const res = makeRes();
    const next = function () {};

    errorHandler(err, req, res, next);

    assert.strictEqual(res._rendered, 'error-template');
  });

  it('passes the error object to res.render as the error property', function () {
    const err = new Error('error object test');
    const req = makeReq();
    const res = makeRes();
    const next = function () {};

    errorHandler(err, req, res, next);

    assert.strictEqual(res._renderData.error, err);
  });

  it('renders with an object that has only the error property', function () {
    const err = new Error('properties test');
    const req = makeReq();
    const res = makeRes();
    const next = function () {};

    errorHandler(err, req, res, next);

    assert.deepStrictEqual(Object.keys(res._renderData), ['error']);
  });

  it('does not call next', function () {
    const err = new Error('next test');
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    const next = function () { nextCalled = true; };

    errorHandler(err, req, res, next);

    assert.strictEqual(nextCalled, false);
  });

  it('works with an error that has a message and stack', function () {
    const err = new Error('detailed error');
    const req = makeReq();
    const res = makeRes();
    const next = function () {};

    // Should not throw
    errorHandler(err, req, res, next);

    assert.strictEqual(res._status, 500);
    assert.strictEqual(res._rendered, 'error-template');
    assert.strictEqual(res._renderData.error, err);
  });

  it('handles an error with a custom message correctly', function () {
    const err = new Error('custom message here');
    const req = makeReq();
    const res = makeRes();
    const next = function () {};

    errorHandler(err, req, res, next);

    assert.strictEqual(res._renderData.error.message, 'custom message here');
  });

});
