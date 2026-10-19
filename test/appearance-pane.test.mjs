import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8")
const panel = read("Panel.qml")
const style = read("PanelStyle.qml")

test("setSetting writes through omarchy bar set with --json", () => {
  assert.match(panel, /function setSetting\(key, value\) \{\s*Quickshell\.execDetached\(\["omarchy", "bar", "set", "io\.github\.juancasanueva\.plugin-manager", key, JSON\.stringify\(value\), "--json"\]\)/)
})

test("PanelStyle exposes the accent choices", () => {
  assert.match(style, /readonly property var accentChoices: accentSource\.available/)
})

test("the settings pane has Appearance and Show sections with all keys", () => {
  assert.match(panel, /"Appearance"/)
  assert.match(panel, /"Show"/)
  for (const key of ["density", "fontSize", "accent"]) assert.match(panel, new RegExp('setSetting\\("' + key + '"'))
  for (const key of ["showDescriptions", "showMeta", "showSummary", "showKeyHints"]) {
    assert.match(panel, new RegExp('key: "' + key + '"'))
  }
  assert.match(panel, /\["compact", "normal", "comfortable"\]/)
  assert.match(panel, /\["small", "normal", "large"\]/)
  assert.match(panel, /root\.look\.accentChoices/)
  assert.match(panel, /setSetting\(toggleCard\.key, !root\.look\[toggleCard\.key\]\)/)
})

test("choices follow the live look and use the accent", () => {
  assert.match(panel, /root\.look\.density/)
  assert.match(panel, /root\.look\.fontSizeChoice/)
  assert.match(panel, /root\.look\.accentChoice/)
  assert.match(panel, /component ChoiceRow/)
  assert.match(panel, /color: chosen \? root\.look\.accent : root\.contentForeground/)
})

test("the key hints stack on two lines when they do not fit one", () => {
  const bar = panel.slice(panel.indexOf("id: hintBar"))
  assert.match(bar, /readonly property bool stacked: filterHints\.implicitWidth \+ actionHints\.implicitWidth \+ root\.look\.sp\(12\) > width/)
  assert.match(bar, /height: stacked \? filterHints\.implicitHeight \+ actionHints\.implicitHeight \+ root\.look\.sp\(4\)\s*: Math\.max\(filterHints\.implicitHeight, actionHints\.implicitHeight\)/)
  assert.match(bar, /id: filterHints[\s\S]{0,200}y: hintItem\.stacked \? 0 : \(hintItem\.height - height\) \/ 2/)
  assert.match(bar, /id: actionHints[\s\S]{0,200}y: hintItem\.stacked \? filterHints\.implicitHeight \+ root\.look\.sp\(4\) : \(hintItem\.height - height\) \/ 2/)
})
