import { expect, it } from "vitest";
import { jsonStringLength } from "./jsonStringLength.js";

it.each([
  "",
  "Assembly-CSharp.dll",
  '"quoted" \ back\slash',
  "\b\f\n\r\t",
  "\u0000\u0001\u001f\u007f",
  "한국어 ünïcödé",
  "pair 😀 end",
  "lone \ud800 high",
  "lone \udc00 low",
  "\udc00\ud800 reversed",
  "trailing \ud83d",
  Array.from({ length: 0x80 }, (_, unit) => String.fromCharCode(unit)).join(""),
])("matches JSON.stringify for %j", (value) => {
  expect(jsonStringLength(value)).toBe(JSON.stringify(value).length);
});

it("stops counting once the budget is passed", () => {
  const value = "\u0001".repeat(1_000_000);
  const counted = jsonStringLength(value, 100);
  expect(counted).toBeGreaterThan(100);
  expect(counted).toBeLessThanOrEqual(100 + 6);
});
