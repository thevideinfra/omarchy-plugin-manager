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
  assert.match(panel, /PanelStyle\s*\{[^}]*settings:[^}]*store\.selfSettings/)
  assert.match(panel, /readonly property var look:/)
})

test("Panel prefers the live host settings over the store's copy", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  assert.match(panel, /settings:\s*root\.settings && Object\.keys\(root\.settings\)\.length > 0 \? root\.settings : store\.selfSettings/)
})

test("the caption floor never exceeds the stock caption size", () => {
  const style = readFileSync(new URL("../PanelStyle.qml", import.meta.url), "utf8")
  assert.match(style, /Math\.max\(Math\.min\(9, Style\.font\.caption\), scaled\(Style\.font\.caption\)\)/)
})

const TOGGLES = {
  showDescriptions: "Show descriptions",
  showMeta: "Show details line (author, kind, version)",
  showSummary: "Show summary counts in the header",
  showKeyHints: "Show key hints"
}
const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8")

test("manifest declares the four show/hide booleans, default true", () => {
  const byKey = Object.fromEntries(bar.schema.map(item => [item.key, item]))
  for (const [key, label] of Object.entries(TOGGLES)) {
    assert.equal(byKey[key].type, "boolean")
    assert.equal(byKey[key].label, label)
    assert.equal(byKey[key].defaultValue, true)
    assert.equal(bar.defaults[key], true)
  }
})

test("PanelStyle exposes the four booleans through Model.settingBool, default true", () => {
  const style = read("PanelStyle.qml")
  for (const key of Object.keys(TOGGLES)) {
    assert.match(style, new RegExp("readonly property bool " + key + ": Model\\.settingBool\\(settings && settings\\." + key + ", true\\)"))
  }
})

test("PluginRow gates the description and details line on the look", () => {
  const row = read("PluginRow.qml")
  assert.match(row, /look\.showDescriptions/)
  assert.match(row, /look\.showMeta/)
})

test("Panel gates the summary and the hint bar, and the list reclaims the hint space", () => {
  const panel = read("Panel.qml")
  assert.match(panel, /root\.look\.showSummary && text !== ""/)
  assert.match(panel, /id: hintBar[\s\S]{0,400}visible: root\.look\.showKeyHints/)
  assert.match(panel, /anchors\.bottom: root\.look\.showKeyHints \? hintBar\.top : parent\.bottom/)
})
