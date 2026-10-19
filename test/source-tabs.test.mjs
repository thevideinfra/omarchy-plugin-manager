import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8")
const panel = read("Panel.qml")

test("the Source dropdown is gone and the Installed / Built-in tab strip replaces it", () => {
  assert.doesNotMatch(panel, /groupDropdown|groupFilterControl/)
  const at = panel.indexOf("id: sourceTabs")
  assert.notEqual(at, -1)
  const tabs = panel.slice(at, at + 3200)
  assert.match(tabs, /model: root\.groupOptions/)
  assert.match(tabs, /chosen: root\.groupFilter === modelData\.value/)
  assert.match(tabs, /Qt\.alpha\(root\.look\.accent, 0\.12\)/)
  assert.match(tabs, /Qt\.alpha\(root\.look\.accent, 0\.45\)/)
  assert.match(tabs, /containsMouse \? 0\.09 : 0\.05/)
  assert.match(tabs, /font\.pixelSize: root\.look\.font\.caption/)
  assert.match(tabs, /font\.bold: tab\.chosen/)
  assert.match(tabs, /root\.closeArrange\(\)\s+root\.setGroupFilter\(tab\.modelData\.value\)/)
  assert.match(tabs, /Qt\.PointingHandCursor/)
  assert.doesNotMatch(tabs, /Style\.space|Style\.font\.|Color\.accent/)
})

test("filter block geometry: tabs, then dropdown row, then search, no gap or overlap", () => {
  assert.match(panel, /readonly property real tabsHeight: /)
  assert.match(panel, /readonly property real filtersTop: tabsHeight \+ root\.look\.sp\(8\)/)
  assert.match(panel, /readonly property real searchTop: filtersTop \+ filterRowHeight \+ root\.look\.sp\(8\)/)
  assert.match(panel, /height: searchTop \+ \(root\.look\.showSearch \? controlHeight : 0\)/)
  assert.match(panel, /id: installedFilters[\s\S]{0,200}anchors\.top: parent\.top\s+anchors\.topMargin: filterControls\.filtersTop/)
  assert.match(panel, /id: clearFiltersButton[\s\S]{0,200}y: filterControls\.searchTop/)
})

test("the tab never counts as a filter and clear does not reset it", () => {
  assert.match(panel, /Model\.isFiltering\(kindFilter, statusFilter, searchQuery\)/)
  assert.match(panel, /text: "showing " \+ root\.visibleRows\.length \+ " of " \+ Model\.rowsInGroup\(root\.rows, root\.groupFilter\)\.length|"showing " \+ root\.visibleRows\.length \+ " of " \+ Model\.rowsInGroup\(root\.rows, root\.groupFilter\)\.length/)
  const clear = panel.slice(panel.indexOf("function clearSearch()"), panel.indexOf("function cycleGroupFilter"))
  assert.doesNotMatch(clear, /groupFilter/)
})

test("the s key walks the two tabs", () => {
  assert.match(panel, /function cycleGroupFilter\(\) \{\s+closeArrange\(\)\s+setGroupFilter\(Model\.nextOption\(groupOptions, groupFilter\)\)/)
  assert.match(panel, /t === "s" \|\| t === "S"\) root\.cycleGroupFilter\(\)/)
})

test("a restored origin maps any group to a tab", () => {
  assert.match(panel, /groupFilter = Model\.normalizeGroup\(origin\.group\)/)
})

test("only the selected group's section is drawn", () => {
  assert.match(panel, /Model\.filterRows\(rows, kindFilter, statusFilter, searchQuery, groupFilter\)/)
  assert.match(panel, /visible: root\.installedRows\.length > 0/)
  assert.match(panel, /visible: root\.builtinRows\.length > 0/)
})

test("README documents the tabs", () => {
  const readme = read("README.md")
  assert.match(readme, /Installed.*Built-in.*tabs|tabs.*Installed.*Built-in/s)
  assert.doesNotMatch(readme, /Source filter|Cycle the Source dropdown|\[S\] SOURCE/)
  assert.match(readme, /search.*(within|scoped to).*(selected )?tab/is)
})
