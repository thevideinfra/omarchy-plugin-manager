// Model.js is loaded by QML, so it has no module system of its own. Reading
// and evaluating the source keeps the shipped file free of node-isms while
// still letting the parsing rules be tested outside a running shell.
import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const source = readFileSync(new URL("../Model.js", import.meta.url), "utf8")
const Model = new Function(
  source + `
  return {
    densityScale, fontSizeScale, parsePalette, accentChoices, paletteAccent, choiceSetting
  }`
)()

test("densityScale matches omaudiopanel: compact < normal < comfortable, all below stock, unknown is normal", () => {
  assert.equal(Model.densityScale("compact"), 0.61)
  assert.equal(Model.densityScale("normal"), 0.71)
  assert.equal(Model.densityScale("comfortable"), 0.83)
  assert.equal(Model.densityScale("bogus"), 0.71)
  assert.equal(Model.densityScale(undefined), 0.71)
})

test("fontSizeScale matches omaudiopanel: small < normal < large, unknown is normal", () => {
  assert.equal(Model.fontSizeScale("small"), 0.85)
  assert.equal(Model.fontSizeScale("normal"), 0.95)
  assert.equal(Model.fontSizeScale("large"), 1.07)
  assert.equal(Model.fontSizeScale("bogus"), 0.95)
})

test("parsePalette reads quoted hex colours only", () => {
  const p = Model.parsePalette('accent = "#89b4fa"\nblue = "#6E7FB8"\nname = "not hex"\n# x = "#112233"\n')
  assert.equal(p.accent, "#89b4fa")
  assert.equal(p.blue, "#6E7FB8")
  assert.equal(p.name, undefined)
  assert.equal(p.x, undefined)
})

test("accentChoices offers theme plus the palette colours it has, in order", () => {
  assert.deepEqual(Model.accentChoices({ red: "#ff0000", blue: "#0000ff" }), ["theme", "blue", "red"])
  assert.deepEqual(Model.accentChoices({}), ["theme"])
  assert.deepEqual(Model.accentChoices(null), ["theme"])
})

test("paletteAccent returns the palette colour, null for theme or unknown", () => {
  const p = { blue: "#6E7FB8" }
  assert.equal(Model.paletteAccent("blue", p), "#6E7FB8")
  assert.equal(Model.paletteAccent("theme", p), null)
  assert.equal(Model.paletteAccent("orange", p), null)
  assert.equal(Model.paletteAccent(undefined, p), null)
})

test("accent names only resolve to the palette's own accent colours", () => {
  const p = { blue: "#6E7FB8", background: "#000000" }
  for (const bad of ["constructor", "toString", "__proto__", "hasOwnProperty", "background"])
    assert.equal(Model.paletteAccent(bad, p), null, bad)
  assert.equal(Model.paletteAccent("constructor", {}), null)
  assert.equal(Model.paletteAccent("blue", p), "#6E7FB8")
  assert.equal(Model.paletteAccent("blue", {}), null)
  assert.deepEqual(Model.accentChoices({}), ["theme"])
  assert.deepEqual(Model.accentChoices(Object.create({ blue: "#0000ff", red: "#ff0000" })), ["theme"])
})

test("choiceSetting returns an allowed string value, else the fallback", () => {
  const allowed = ["compact", "normal", "comfortable"]
  assert.equal(Model.choiceSetting({ density: "compact" }, "density", allowed, "normal"), "compact")
  assert.equal(Model.choiceSetting({ density: "huge" }, "density", allowed, "normal"), "normal")
  assert.equal(Model.choiceSetting({ density: 3 }, "density", allowed, "normal"), "normal")
  assert.equal(Model.choiceSetting({}, "density", allowed, "normal"), "normal")
  assert.equal(Model.choiceSetting(null, "density", allowed, "normal"), "normal")
})
