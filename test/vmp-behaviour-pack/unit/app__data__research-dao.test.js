"use strict";

const { strict: assert } = require("assert");
const { ResearchDAO } = require("../../../app/data/research-dao");

describe("ResearchDAO", function () {

  describe("constructor", function () {

    it("returns a ResearchDAO instance when called with new", function () {
      const dao = new ResearchDAO(null);
      assert.ok(dao instanceof ResearchDAO);
    });

    it("returns a ResearchDAO instance when called WITHOUT new", function () {
      // When called without new, this points to global; the function
      // detects that and calls itself correctly.
      const dao = ResearchDAO(null);
      assert.ok(dao instanceof ResearchDAO);
    });

    it("exposes getBySymbol as a function on the instance", function () {
      const dao = new ResearchDAO(null);
      assert.equal(typeof dao.getBySymbol, "function");
    });

    it("accepts a db argument (even a plain object)", function () {
      const fakeDb = { name: "fakeDb" };
      const dao = new ResearchDAO(fakeDb);
      assert.ok(dao instanceof ResearchDAO);
    });

  });

  describe("getBySymbol", function () {

    it("returns undefined for a truthy symbol", function () {
      const dao = new ResearchDAO(null);
      const result = dao.getBySymbol("AAPL", function () {});
      assert.equal(result, undefined);
    });

    it("returns undefined for a falsy symbol", function () {
      const dao = new ResearchDAO(null);
      const result = dao.getBySymbol("", function () {});
      assert.equal(result, undefined);
    });

    it("returns undefined when no callback is provided", function () {
      const dao = new ResearchDAO(null);
      const result = dao.getBySymbol("GOOG");
      assert.equal(result, undefined);
    });

    it("does NOT call the callback (callback is never invoked)", function () {
      const dao = new ResearchDAO(null);
      let called = false;
      dao.getBySymbol("AAPL", function () { called = true; });
      assert.equal(called, false);
    });

    it("does NOT call the callback for falsy symbol either", function () {
      const dao = new ResearchDAO(null);
      let called = false;
      dao.getBySymbol(null, function () { called = true; });
      assert.equal(called, false);
    });

    it("returns undefined when symbol is null", function () {
      const dao = new ResearchDAO(null);
      const result = dao.getBySymbol(null, function () {});
      assert.equal(result, undefined);
    });

    it("returns undefined when symbol is undefined", function () {
      const dao = new ResearchDAO(null);
      const result = dao.getBySymbol(undefined, function () {});
      assert.equal(result, undefined);
    });

  });

});
