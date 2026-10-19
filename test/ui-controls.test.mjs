import { readFileSync, existsSync } from "node:fs"
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
  assert.equal(panel.split("PanelDropdown {").length - 1, 2)
  for (const id of ["kindDropdown", "statusDropdown"]) {
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
  const row = panel.slice(panel.indexOf("component ChoiceRow"), panel.indexOf("component AccentSwatchRow"))
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
  // The accent row is swatches now, not name chips.
  assert.doesNotMatch(row, /swatches|accentSwatch/)
  assert.doesNotMatch(panel, /label: "Accent"[\s\S]{0,200}ChoiceRow|swatches: true/)
})

test("accent choices are round swatches with a ring and a name tooltip", () => {
  const at = panel.indexOf("component AccentSwatchRow")
  assert.notEqual(at, -1)
  const comp = panel.slice(at, panel.indexOf("component ShowToggleCard"))
  assert.match(comp, /model: root\.look\.accentChoices/)
  assert.match(comp, /chosen: root\.look\.accentChoice === modelData/)
  assert.match(comp, /isTheme: modelData === "theme"/)
  assert.match(comp, /height: root\.look\.sp\(23\)/)
  assert.match(comp, /radius: height \/ 2/)
  assert.match(comp, /color: swatch\.isTheme \? Qt\.alpha\(root\.contentForeground, 0\.06\) : root\.look\.accentSwatch\(modelData\)/)
  assert.match(comp, /border\.width: chosen \? 2 : 1/)
  assert.match(comp, /border\.color: chosen \? root\.contentForeground/)
  assert.match(comp, /text: "Theme"/)
  assert.match(comp, /root\.look\.accentSwatch\("theme"\)/)
  assert.match(comp, /font\.bold: swatch\.chosen/)
  assert.match(comp, /Qt\.PointingHandCursor/)
  assert.match(comp, /root\.setSetting\("accent", swatch\.modelData\)/)
  assert.match(comp, /PanelToolTip \{\s*visible: swatchMouse\.containsMouse\s*text: swatch\.isTheme \? "Theme accent" : swatch\.modelData\.charAt\(0\)\.toUpperCase\(\) \+ swatch\.modelData\.slice\(1\)/)
  assert.doesNotMatch(comp, /Color\.accent|Style\.space|Style\.font\./)
  assert.match(panel, /AccentSwatchRow \{/)
})

test("PanelStyle.accentSwatch maps names to palette colours", () => {
  assert.match(style, /function accentSwatch\(name\) \{\s*return accentSource\.colorOf\(name\)/)
})

// ---- 4. accent switch
test("settings cards use an AccentSwitch, not the grey ToggleSwitch", () => {
  assert.doesNotMatch(panel, /\bToggleSwitch \{/)
  const sw = read("AccentSwitch.qml")
  assert.match(sw, /signal toggled\(\)/)
  assert.match(sw, /implicitWidth: root\.look\.sp\(34\)/)
  assert.match(sw, /implicitHeight: root\.look\.sp\(18\)/)
  assert.match(sw, /Qt\.alpha\(root\.tint, 0\.3\)/)
  assert.match(sw, /Qt\.alpha\(root\.foreground, 0\.1\)/)
  assert.match(sw, /Qt\.alpha\(root\.foreground, 0\.25\)/)
  assert.match(sw, /Qt\.darker\(root\.foreground, 1\.4\)/)
  assert.match(sw, /radius: height \/ 2/)
  assert.equal(panel.split("AccentSwitch {").length - 1, 2) // the two cards
  assert.match(panel, /AccentSwitch \{\s*id: unverifiedSwitch[\s\S]{0,500}busy: root\.busy/)
})

test("PanelDropdown imports qs.Ui for the types the shell copy got implicitly", () => {
  const d = read("PanelDropdown.qml")
  assert.match(d, /^import qs\.Ui$/m)
  assert.match(d, /^import qs\.Commons$/m)
})

test("every qs.Ui type PanelDropdown uses is covered by an import", { skip: !existsSync("/usr/share/omarchy/shell/Ui/qmldir") }, () => {
  const d = read("PanelDropdown.qml")
  const exported = [...readFileSync("/usr/share/omarchy/shell/Ui/qmldir", "utf8").matchAll(/^([A-Z]\w+)\s+\d/gm)].map(m => m[1])
  const code = d.replace(/\/\/[^\n]*/g, "")
  for (const type of exported)
    if (new RegExp("\\b" + type + "\\b").test(code)) assert.match(d, /^import qs\.Ui$/m, type)
})
