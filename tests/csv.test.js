import test from "node:test";
import assert from "node:assert/strict";
import { csvField, serializeScheduleCsv, SCHEDULE_COLUMNS } from "../src/core/csv.js";

test("CSV escapes delimiters, quotes and embedded newlines", () => {
  assert.equal(csvField('A, "B"'), '"A, ""B"""');
  assert.equal(csvField("line 1\nline 2"), '"line 1\nline 2"');
  assert.equal(csvField(null), "");
});
test("schedule CSV uses UTF-8 BOM and current schedule columns with Windows line endings", () => {
  const csv = serializeScheduleCsv([{id:"e1",type:"wall",story:"Ground, Floor",zoneNumber:"Z-01",zoneName:"Living Room",zoneCategory:"Living",length:2,area:6,perimeter:10,material:'Concrete "A"'}]);
  assert.ok(csv.startsWith("\ufeff"+SCHEDULE_COLUMNS.join(",")+"\r\n"));
  assert.ok(csv.includes('"Ground, Floor"'));
  assert.ok(csv.includes('"Concrete ""A"""'));
  assert.ok(csv.endsWith("\r\n"));
});
test("schedule CSV handles empty data and configurable columns", () => {
  assert.equal(serializeScheduleCsv([], ["id","name"]), "\ufeffid,name\r\n");
  assert.throws(() => serializeScheduleCsv({}, ["id"]), TypeError);
});
