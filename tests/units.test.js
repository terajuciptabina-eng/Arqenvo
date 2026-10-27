import test from "node:test";
import assert from "node:assert/strict";
import {formatLength,formatLengthValue,parseLength,formatArea,normalizeUnitSystem} from "../src/core/units.js";

test("Metric dimensions render in millimetres",()=> {
  assert.equal(formatLength(3,"metric"),"3,000 mm");
  assert.equal(formatLength(0.9,"metric"),"900 mm");
});
test("Imperial dimensions use feet and rounded whole inches",()=> {
  assert.equal(formatLength(3,"imperial"),"9′ 10″");
  assert.equal(formatLength(0.9,"imperial"),"2′ 11″");
  assert.equal(formatLength(2.7,"imperial"),"8′ 10″");
  assert.equal(formatLength(6,"imperial"),"19′ 8″");
});
test("Imperial inputs convert back to internal metres",()=> {
  assert.ok(Math.abs(parseLength("9' 10\"","imperial")-3)<0.003);
  assert.ok(Math.abs(parseLength("3 ft 0 in","imperial")-0.9144)<1e-9);
});
test("Metric inputs accept mm, cm and m",()=> {
  assert.equal(parseLength("3000 mm","metric"),3);
  assert.equal(parseLength("90 cm","metric"),0.9);
  assert.equal(parseLength("2.7 m","metric"),2.7);
});
test("Areas use selected unit system",()=> {
  assert.equal(formatArea(10,"metric"),"10.00 m²");
  assert.equal(formatArea(10,"imperial"),"107.64 ft²");
});
test("Unknown unit settings safely fall back to Metric",()=> {
  assert.equal(normalizeUnitSystem("unknown"),"metric");
  assert.equal(formatLength(1,"unknown"),"1,000 mm");
});
