import { readFileSync, existsSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")

test("Panel.qml has no Browse, catalog, or expanded-panel code", () => {
  const source = read("Panel.qml")
  for (const word of [/browse/i, /catalog/i, /marketplace/i, /Expanded/, /PluginDetails/, /CatalogCard/, /activeTab/, /openAs/])
    assert.doesNotMatch(source, word)
})

test("deleted files stay deleted", () => {
  for (const name of ["Expanded.qml", "CatalogCard.qml", "CatalogDetailsPane.qml", "PluginDetails.qml", "InstalledListRow.qml", "InstalledDetails.qml"])
    assert.equal(existsSync(new URL(`../${name}`, import.meta.url)), false, name)
})

test("store, model and bridge carry no browse or open-as code", () => {
  for (const name of ["PluginStore.qml", "Model.js", "PopupBridge.js", "BarWidget.qml", "MoveOwner.qml"]) {
    const source = read(name)
    for (const word of [/browse/i, /openAs/, /tiledExpandedPanel/, /Expanded/])
      assert.doesNotMatch(source, word, `${name} ${word}`)
  }
})
