import { readFileSync, existsSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const files = ["Panel.qml", "PluginRow.qml", "SettingsInfo.qml", "ActionConfirmDialog.qml", "ChoiceDialog.qml", "BarLayoutPane.qml"]
  .filter(name => existsSync(new URL(`../${name}`, import.meta.url)))

test("scaled tokens only come from the look object", () => {
  for (const name of files) {
    const source = readFileSync(new URL(`../${name}`, import.meta.url), "utf8")
      .replace(/\/\/[^\n]*/g, "")
    assert.doesNotMatch(source, /Style\.space\(/, `${name} Style.space`)
    assert.doesNotMatch(source, /Style\.font\.(?!family)/, `${name} Style.font`)
    assert.doesNotMatch(source, /Color\.accent/, `${name} Color.accent`)
    assert.doesNotMatch(source, /Style\.spacing\./, `${name} Style.spacing`)
  }
})

test("every child that takes a look is handed one by Panel", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  for (const type of ["PluginRow", "SettingsInfo", "ActionConfirmDialog", "ChoiceDialog", "BarLayoutPane"]) {
    if (!existsSync(new URL(`../${type}.qml`, import.meta.url))) continue
    const child = readFileSync(new URL(`../${type}.qml`, import.meta.url), "utf8")
    assert.match(child, /required property var look/, `${type} declares look`)
    for (const block of panel.matchAll(new RegExp(`${type}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, "g")))
      assert.match(block[1], /look:\s*root\.look/, `${type} instance gets look`)
  }
})

test("search field padding stays at the shell's default xs spacing of 3px", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  assert.match(panel, /verticalPadding: root\.look\.sp\(3\)/)
})
