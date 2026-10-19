import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"))
const bar = manifest.barWidget

test("manifest declares density, fontSize and accent like omaudiopanel", () => {
  const byKey = Object.fromEntries(bar.schema.map(item => [item.key, item]))
  assert.deepEqual(byKey.density.options, ["compact", "normal", "comfortable"])
  assert.deepEqual(byKey.fontSize.options, ["small", "normal", "large"])
  assert.deepEqual(byKey.accent.options, ["theme", "blue", "cyan", "green", "magenta", "yellow", "red", "orange"])
  for (const key of ["density", "fontSize", "accent"]) {
    assert.equal(byKey[key].type, "enum")
    assert.equal(byKey[key].defaultValue, bar.defaults[key])
  }
  assert.equal(bar.defaults.density, "normal")
  assert.equal(bar.defaults.fontSize, "normal")
  assert.equal(bar.defaults.accent, "theme")
})

test("Panel reads its look from PanelStyle fed by the store's settings", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  assert.match(panel, /PanelStyle\s*\{[^}]*settings:\s*store\.selfSettings/)
  assert.match(panel, /readonly property var look:/)
})
