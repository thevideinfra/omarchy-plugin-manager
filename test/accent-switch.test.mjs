import { readFileSync, existsSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8")
const panel = read("Panel.qml")
const row = read("PluginRow.qml")
const manifest = JSON.parse(read("manifest.json")).barWidget

test("AccentSwitch lives in its own file with the documented API", () => {
  assert.ok(existsSync(new URL("../AccentSwitch.qml", import.meta.url)))
  const sw = read("AccentSwitch.qml")
  assert.match(sw, /^import QtQuick$/m)
  assert.match(sw, /^import qs\.Commons$/m)
  assert.match(sw, /required property var look/)
  assert.match(sw, /property color foreground/)
  assert.match(sw, /property bool checked: false/)
  assert.match(sw, /property bool interactive: true/)
  assert.match(sw, /property bool busy: false/)
  assert.match(sw, /property bool useAccent: true/)
  assert.match(sw, /signal toggled\(\)/)
  assert.match(sw, /readonly property bool containsMouse: swMouse\.containsMouse/)
  assert.match(sw, /implicitWidth: root\.look\.sp\(34\)/)
  assert.match(sw, /implicitHeight: root\.look\.sp\(18\)/)
  assert.match(sw, /radius: height \/ 2/)
  assert.match(sw, /opacity: .*busy.*interactive/)
  assert.match(sw, /enabled: root\.interactive && !root\.busy/)
  assert.match(sw, /Qt\.alpha\(root\.tint, 0\.3\)/)
  assert.match(sw, /useAccent \? root\.look\.accent : root\.foreground/)
  assert.doesNotMatch(sw.replace(/\/\/[^\n]*/g, ""), /Style\.space\(|Style\.font\.|Color\.accent/)
})

test("the inline AccentSwitch is gone from Panel and both uses pass useAccent", () => {
  assert.doesNotMatch(panel, /component AccentSwitch/)
  const uses = panel.split("AccentSwitch {").length - 1
  assert.equal(uses, 2)
  assert.equal(panel.split("useAccent: root.look.accentToggles").length - 1, uses)
  assert.equal(panel.split("foreground: root.contentForeground").length > 1, true)
  assert.match(panel, /AccentSwitch \{\s*id: unverifiedSwitch[\s\S]{0,500}busy: root\.busy/)
})

test("plugin rows use AccentSwitch with the old switch's semantics", () => {
  assert.doesNotMatch(row, /\bToggleSwitch\b/)
  const at = row.indexOf("AccentSwitch {")
  assert.notEqual(at, -1)
  const block = row.slice(at, at + 2400)
  assert.match(block, /id: enabledSwitch/)
  assert.match(block, /look: root\.look/)
  assert.match(block, /visible: root\.row !== null/)
  assert.match(block, /checked: root\.row \? root\.row\.enabled === true : false/)
  assert.match(block, /interactive: root\.canToggle/)
  assert.match(block, /busy: !root\.actionsEnabled/)
  assert.match(block, /opacity: root\.canToggle \? 1 : 0\.4/)
  assert.match(block, /foreground: root\.foreground/)
  assert.match(block, /useAccent: root\.look\.accentToggles/)
  assert.match(block, /onToggled: root\.canDisable \? root\.disableRequested\(\) : root\.enableRequested\(\)/)
  assert.match(block, /visible: enabledSwitch\.containsMouse/)
})

test("accentToggles is a boolean setting, default on, wired like the show* ones", () => {
  const item = manifest.schema.find(i => i.key === "accentToggles")
  assert.equal(item.type, "boolean")
  assert.equal(item.label, "Accent colour on switches")
  assert.equal(item.defaultValue, true)
  assert.equal(manifest.defaults.accentToggles, true)
  assert.match(read("PanelStyle.qml"), /readonly property bool accentToggles: Model\.settingBool\(settings && settings\.accentToggles, true\)/)
  assert.match(panel, /ShowToggleCard \{ key: "accentToggles"; title: "Accent switches"; caption: "Colour the on\/off switches with the accent" \}/)
  assert.match(read("README.md"), /\| `accentToggles` \| on \/ off \| on \|/)
})
