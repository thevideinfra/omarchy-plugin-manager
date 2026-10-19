import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

// Model.js is plain QML-style JS with no module system; evaluate it like model.test.mjs does.
const Model = new Function(readFileSync(new URL("../Model.js", import.meta.url), "utf8") + "\nreturn { actionHints }")()
const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8")
const panel = read("Panel.qml")
const style = read("PanelStyle.qml")
const manifest = JSON.parse(read("manifest.json"))
const bar = manifest.barWidget

// ---- 1. search toggle
test("showSearch: manifest default and schema", () => {
  assert.equal(bar.defaults.showSearch, true)
  const item = bar.schema.find(i => i.key === "showSearch")
  assert.equal(item.type, "boolean")
  assert.equal(item.defaultValue, true)
  assert.equal(item.label, "Show the search box")
})

test("showSearch: PanelStyle exposes it through settingBool", () => {
  assert.match(style, /readonly property bool showSearch: Model\.settingBool\(settings && settings\.showSearch, true\)/)
})

test("showSearch: settings card in the Show section", () => {
  assert.match(panel, /ShowToggleCard \{ key: "showSearch"; title: "Search"; caption: "Search box above the list" \}/)
})

test("showSearch: field hidden and filter block shrinks without a gap", () => {
  assert.match(panel, /height: filterRowHeight \+ \(root\.look\.showSearch \? root\.look\.sp\(8\) \+ controlHeight : 0\)/)
  assert.match(panel, /id: searchFieldLoader[\s\S]{0,600}active: root\.opened && root\.look\.showSearch/)
  assert.match(panel, /id: searchFieldLoader[\s\S]{0,600}visible: root\.look\.showSearch/)
  assert.match(panel, /id: clearFiltersButton[\s\S]{0,300}visible: root\.look\.showSearch && root\.searchText !== ""/)
})

test("showSearch: action hints drop SEARCH when off", () => {
  assert.ok(Model.actionHints(false).some(h => h.key === "/"))
  assert.ok(Model.actionHints(false, true).some(h => h.key === "/"))
  assert.ok(!Model.actionHints(false, false).some(h => h.key === "/"))
  assert.equal(Model.actionHints(true, false).length, 3)
  assert.match(panel, /Model\.actionHints\(root\.bulkUpdatableCount > 0, root\.look\.showSearch\)/)
})

test("showSearch: slash does nothing while hidden, turning off clears the term", () => {
  assert.match(panel, /if \(t === "\/"\) \{ if \(root\.look\.showSearch\) root\.focusSearchField\(\) \}/)
  // The loader is inactive while the box is off, so the field is null and focusing is a no-op.
  assert.match(panel, /function focusSearchField\(\) \{\s*var field = searchFieldLoader\.item\s*if \(!field\) return/)
  assert.match(panel, /Connections \{\s*target: root\.look\s*function onShowSearchChanged\(\) \{ if \(!root\.look\.showSearch\) root\.clearSearch\(\) \}/)
})

