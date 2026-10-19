import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8")
const panel = read("Panel.qml")
const style = read("PanelStyle.qml")
const manifest = JSON.parse(read("manifest.json"))
const bar = manifest.barWidget

// ---- 2. dropdown
test("PanelDropdown: scalable copy of the shell dropdown", () => {
  const d = read("PanelDropdown.qml")
  assert.match(d, /copy of .*Dropdown\.qml/i)
  assert.match(d, /property int fontSize: Style\.font\.body/)
  assert.match(d, /property int labelFontSize: Style\.font\.caption/)
  assert.doesNotMatch(d, /font\.pixelSize: Style\.font\./)
  assert.equal(d.split("font.pixelSize: root.fontSize").length - 1, 3)
  assert.equal(d.split("font.pixelSize: root.labelFontSize").length - 1, 1)
  assert.match(d, /signal changed\(string value\)/)
  assert.match(d, /property bool hasCursor: false/)
})

test("Panel uses PanelDropdown with the caption size", () => {
  assert.doesNotMatch(panel.replace(/PanelDropdown/g, ""), /\bDropdown \{/)
  assert.equal(panel.split("PanelDropdown {").length - 1, 3)
  for (const id of ["groupDropdown", "kindDropdown", "statusDropdown"]) {
    const at = panel.indexOf("id: " + id)
    const block = panel.slice(at, at + 700)
    assert.match(block, /fontSize: root\.look\.font\.caption/, id)
    assert.match(block, /labelFontSize: root\.look\.font\.caption/, id)
    assert.match(block, /accent: root\.look\.accent/, id)
    assert.match(block, /rowHeight: filterControls\.controlHeight/, id)
    assert.match(block, /popupRowHeight: root\.look\.sp\(28\)/, id)
  }
})

test("controlHeight follows the (smaller) text metrics", () => {
  assert.match(panel, /readonly property real controlHeight: Math\.ceil\(filterLabelMetrics\.height \+ root\.look\.sp\(12\)\)/)
})

test("look-applied guard list does not include PanelDropdown", () => {
  assert.doesNotMatch(read("test/look-applied.test.mjs"), /PanelDropdown/)
})

// ---- 3. choice chips
test("choice rows are accent chips", () => {
  const row = panel.slice(panel.indexOf("component ChoiceRow"), panel.indexOf("component ShowToggleCard"))
  assert.match(row, /Rectangle \{/)
  assert.match(row, /radius: root\.look\.sp\(6\)/)
  assert.match(row, /border\.width: 1/)
  assert.match(row, /Qt\.alpha\(root\.look\.accent, 0\.12\)/)
  assert.match(row, /Qt\.alpha\(root\.look\.accent, 0\.45\)/)
  assert.match(row, /Qt\.alpha\(root\.contentForeground, choiceMouse\.containsMouse \? 0\.09 : 0\.05\)/)
  assert.match(row, /Qt\.alpha\(root\.contentForeground, 0\.1\)/)
  assert.match(row, /font\.pixelSize: root\.look\.font\.caption/)
  assert.match(row, /Qt\.PointingHandCursor/)
  assert.match(row, /choiceRow\.picked\(/)
  assert.doesNotMatch(row, /underline/)
  assert.match(row, /property bool swatches: false/)
  assert.match(row, /radius: width \/ 2/)
  assert.match(row, /root\.look\.accentSwatch\(/)
  assert.match(panel, /label: "Accent"[\s\S]{0,200}swatches: true/)
})

test("PanelStyle.accentSwatch maps names to palette colours", () => {
  assert.match(style, /function accentSwatch\(name\) \{\s*return accentSource\.colorOf\(name\)/)
})

// ---- 4. accent switch
test("settings cards use an AccentSwitch, not the grey ToggleSwitch", () => {
  assert.doesNotMatch(panel, /\bToggleSwitch \{/)
  const sw = panel.slice(panel.indexOf("component AccentSwitch"), panel.indexOf("component ShowToggleCard"))
  assert.match(sw, /signal toggled\(\)/)
  assert.match(sw, /property bool checked: false/)
  assert.match(sw, /property bool interactive: true/)
  assert.match(sw, /property bool busy: false/)
  assert.match(sw, /readonly property bool containsMouse: swMouse\.containsMouse/)
  assert.match(sw, /implicitWidth: root\.look\.sp\(34\)/)
  assert.match(sw, /implicitHeight: root\.look\.sp\(18\)/)
  assert.match(sw, /Qt\.alpha\(root\.look\.accent, 0\.3\)/)
  assert.match(sw, /Qt\.alpha\(root\.contentForeground, 0\.1\)/)
  assert.match(sw, /Qt\.alpha\(root\.contentForeground, 0\.25\)/)
  assert.match(sw, /Qt\.darker\(root\.contentForeground, 1\.4\)/)
  assert.match(sw, /radius: height \/ 2/)
  assert.equal(panel.split("AccentSwitch {").length - 1, 2) // the two cards
  assert.match(panel, /AccentSwitch \{\s*id: unverifiedSwitch[\s\S]{0,400}busy: root\.busy/)
})
