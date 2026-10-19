import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
const storeSource = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
const Model = Function(readFileSync(new URL("../Model.js", import.meta.url), "utf8") +
  "; return { barLayoutSnapshot, barLayoutMove, tiledExpandedPanel, openAs, expandedModeFromPayload, parseSelfSettings, selfEntryFromShellConfig, expandedTabFromPayload, expandedPageFromPayload, expandedScreenFromPayload }")()
function call(source, name, state, ...args) {
  const match = source.match(new RegExp(`  function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}`))
  assert.ok(match, `${name} exists`)
  return new Function("state", "args", `with (state) { return (function(${match[1]}) {${match[2]}})(...args) }`)(state, args)
}

test("Settings hides layout status without masking ordinary outcomes or changing move ownership", () => {
  for (const source of [panel]) {
    const body = source.match(/\/\/ ---- Status:[\s\S]*?text: \{([\s\S]*?)\n\s*\}/)[1]
    const text = Function("root", "Model", body)
    const owner = { status: "Waiting for layout", statusIsError: true, pending: true }
    const state = { settingsOpen: true, arrangeOpen: false, browsing: false, busy: true,
      barMovePending: true, popupMoveOwner: owner, placementNotice: "", barSnapshot: {},
      statusSource: "layout", status: "Layout outcome", loadError: "", catalogError: "" }
    for (const status of ["Bar layout updated", "Current layout accepted", "Waiting", "Unknown", "Refused"]) {
      state.status = status
      for (const pending of [false, true]) {
        state.barMovePending = pending
        assert.equal(text(state, {}), "")
        assert.equal(state.barMovePending, pending)
        assert.equal(owner.pending, true)
      }
    }
    state.statusSource = ""
    for (const status of ["Could not save the setting", "Settings outcome", "Plugin removed"]) {
      state.status = status
      assert.equal(text(state, {}), status, "local outcomes win over retained owner status in Settings")
    }
    state.settingsOpen = false
    for (const arrangeOpen of [false, true]) {
      state.arrangeOpen = arrangeOpen
      assert.equal(text(state, {}), owner.status)
    }
    state.barMovePending = false; state.busy = false; state.arrangeOpen = false
    for (const status of ["Plugin removed", "Could not save the setting"]) {
      state.status = status
      assert.equal(text(state, {}), status)
    }
    assert.match(source, /property alias statusSource: store\.statusSource/)
  }
})



test("status source resets for settings errors and ordinary inventory outcomes", () => {
  const state = { status: "", statusIsError: false, statusSource: "" }
  state.setStatus = (...args) => call(storeSource, "setStatus", state, ...args)
  state.setStatus("Move outcome", true, "layout")
  assert.equal(state.statusSource, "layout")
  Object.assign(state, { busy: false, selfEntryLoaded: false })
  assert.equal(call(storeSource, "writeSelfSetting", state, "tiledExpandedPanel", true, false), false)
  assert.equal(state.statusSource, "")
  assert.equal(state.statusIsError, true)
  state.setStatus("Plugin removed", false)
  assert.equal(state.statusSource, "")
  assert.equal(state.statusIsError, false)
})








