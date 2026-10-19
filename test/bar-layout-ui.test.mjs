import { readFileSync, existsSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
const storeSource = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
// The retained headless move owner; read lazily so a missing file fails only its tests.
const ownerUrl = new URL("../MoveOwner.qml", import.meta.url)
const owner = existsSync(ownerUrl) ? readFileSync(ownerUrl, "utf8") : ""
const Model = Function(readFileSync(new URL("../Model.js", import.meta.url), "utf8") +
  "; return { barLayoutSnapshot, barLayoutMove, parseSelfSettings }")()
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
  assert.equal(call(storeSource, "writeSelfSetting", state, "allowUnverifiedUpdates", true, false), false)
  assert.equal(state.statusSource, "")
  assert.equal(state.statusIsError, true)
  state.setStatus("Plugin removed", false)
  assert.equal(state.statusSource, "")
  assert.equal(state.statusIsError, false)
})

// The owner as the shell retains it: hidden, keepLoaded, never summoned into a
// window. The popup's board dispatches through it (see popup-arrange tests).
function lifecycle() {
  const events = []
  const shell = { barConfig: { layout: { left: ["same", { id: "same", settings: { n: 2 } }], center: [], right: [] } } }
  const proc = { running: false }
  const store = { shell, barMovePending: null, barMoveExited: true, barMoveFailed: false, barMoveBytes: 0,
    cancelPending() { events.push("cancel confirmation") }, loadOnOpen() { events.push("load") },
    reload() { events.push("load") }, refreshUpdateData() { events.push("load") },
    setStatus(text, error) { this.status = text; this.statusIsError = error } }
  Object.defineProperty(store, "busy", { get: () => store.barMovePending !== null })
  for (const name of ["startBarMove", "finishBarMove", "reconcileBarMove"])
    store[name] = (...args) => call(storeSource, name, { root: store, barMoveProc: proc, Model }, ...args)
  const state = { shell, store, Model, JSON, opened: false, pluginId: "manager", barSnapshot: null,
    popupMoves: { continuationActive: false, generation: 0 },
    PopupBridge: { openPopup() { events.push("popup"); return true }, closePopups() { events.push("close popups") } } }
  state.root = state
  for (const name of ["open", "close", "refreshBarLayout", "startPopupMove", "recoverPopupMove"])
    state[name] = (...args) => call(owner, name, state, ...args)
  Object.defineProperty(state, "barMovePending", { get: () => store.barMovePending !== null })
  const begin = () => {
    state.refreshBarLayout()
    assert.equal(state.startPopupMove(state.barSnapshot, "left", 1, "right", 0), true)
    return store.barMovePending
  }
  return { state, store, shell, proc, events, begin }
}

test("retained eager construction stays hidden and cannot initiate inventory work or dispatch", () => {
  const { state, events } = lifecycle()
  assert.equal(state.recoverPopupMove(), false)
  assert.equal(state.startPopupMove(null, "left", 0, "right", 0), false)
  assert.deepEqual(events, [])
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url)))
  assert.equal(manifest.keepLoaded, true)
  assert.deepEqual(manifest.kinds, ["bar-widget", "panel"])
  assert.equal(manifest.entryPoints.panel, "MoveOwner.qml")
  assert.equal(manifest.entryPoints.barWidget, "BarWidget.qml")
  assert.doesNotMatch(owner, /loadOnOpen|\.reload\(|refreshUpdateData|watchConfig: true|Component\.onCompleted:/)
  assert.match(owner, /PluginStore \{[\s\S]*?selfId: root\.pluginId[\s\S]*?shell: root\.shell/)
  assert.match(storeSource, /id: shellConfig[\s\S]*?preload: false[\s\S]*?blockAllReads: true/)
  assert.doesNotMatch(storeSource, /Component\.onCompleted:/)
})

test("pending hide/summon preserves ownership, snapshot plan and lock without new IO", () => {
  const { state, store, events, begin } = lifecycle()
  const plan = begin()
  state.close()
  assert.equal(state.opened, false)
  assert.equal(store.barMovePending, plan)
  state.open('{"screen":"DP-1"}')
  assert.equal(state.opened, false)
  assert.equal(store.barMovePending, plan)
  assert.equal(events.includes("cancel confirmation"), false)
  assert.equal(events.includes("load"), false)
  assert.equal(state.startPopupMove(state.barSnapshot, "left", 0, "center", 0), false)
  call(storeSource, "restartShell", { busy: store.busy, actionProc: { running: false },
    runDetached() { assert.fail("pending move must block restart") } })
})

test("a stale drop cannot dispatch through the owner", () => {
  const { state, shell, store } = lifecycle()
  state.refreshBarLayout()
  const stale = state.barSnapshot
  shell.barConfig.layout.left.reverse()
  state.refreshBarLayout()
  assert.equal(state.startPopupMove(stale, "left", 0, "right", 0), false)
  assert.equal(store.barMovePending, null)
  assert.match(store.status, /refused/)
})

test("host updates refresh the raw snapshot, duplicates included, before reconciling", () => {
  const { state, store, shell, begin } = lifecycle()
  const plan = begin()
  const original = store.reconcileBarMove
  store.reconcileBarMove = accept => {
    assert.equal(state.barSnapshot.key, Model.barLayoutSnapshot(shell.barConfig.layout).key)
    assert.equal(accept, false)
    return original(accept)
  }
  shell.barConfig.layout = plan.expected.layout
  state.refreshBarLayout()
  assert.equal(state.barSnapshot.rows.find(row => row.section === "right").entry.settings.n, 2)
  assert.equal(store.barMovePending, plan, "host update alone cannot release running client")
  assert.match(owner, /onShellChanged: refreshBarLayout\(\)/)
  assert.match(owner, /function onBarConfigChanged\(\) \{ root\.refreshBarLayout\(\) \}/)
})

test("exit and host layout can arrive in either order, without retrying", () => {
  for (const hostFirst of [false, true]) {
    const { state, store, shell, proc, begin } = lifecycle()
    const plan = begin()
    if (hostFirst) { shell.barConfig.layout = plan.expected.layout; state.refreshBarLayout() }
    proc.running = false
    store.finishBarMove(0)
    if (!hostFirst) {
      assert.equal(store.barMovePending, plan, "exit is not confirmation")
      shell.barConfig.layout = plan.expected.layout
      state.refreshBarLayout()
    }
    assert.equal(store.barMovePending, null)
    assert.equal(proc.running, false)
    assert.deepEqual(proc.command.slice(4), plan.command)
  }
})

test("timeout/mismatch recovery needs an explicit recover and unavailable layout allows safe hiding", () => {
  for (const exitCode of [0, 124, 137]) {
    const { state, store, shell, proc, begin } = lifecycle()
    const plan = begin()
    assert.equal(state.recoverPopupMove(), false, "a running client cannot be recovered")
    proc.running = false
    store.finishBarMove(exitCode)
    shell.barConfig.layout = null
    state.refreshBarLayout()
    assert.equal(state.barSnapshot, null)
    assert.equal(state.recoverPopupMove(), false)
    state.close()
    assert.equal(store.barMovePending, plan)
    state.open("{}")
    shell.barConfig.layout = { left: ["new", "new"], center: [], right: [] }
    state.refreshBarLayout()
    assert.equal(store.barMovePending, plan, "fresh but mismatched config is not acceptance")
    assert.equal(state.barSnapshot.rows.length, 2)
    assert.equal(state.recoverPopupMove(), true)
    assert.equal(store.barMovePending, null)
    assert.equal(proc.running, false)
  }
})

test("Arrange wires a themed board to guarded persistence with inventory labels", () => {
  assert.match(owner, /Model\.barLayoutSnapshot\(root\.shell[^\n]*barConfig\.layout/)
  assert.match(panel, /readonly property var barSnapshot: popupMoveOwner \? popupMoveOwner\.snapshot : null/)
  const board = panel.split("BarLayoutPane {")[1].split("Flickable {")[0]
  assert.match(board, /labels\[row\.id\] = row\.name/)
  assert.match(board, /snapshot: root\.barSnapshot/)
  assert.match(board, /busy: root\.arrangeBusy/)
  assert.match(board, /onMoveRequested:[\s\S]*?root\.requestBarMove\(/)
  for (const property of ["fill", "rowFill", "foreground", "mutedForeground", "borderColor", "accent", "fontFamily", "fontPixelSize", "spacing", "radius", "rowHeight"])
    assert.match(board, new RegExp(`${property}: (root\\.|Color\\.|Style\\.)`))
})

test("Arrange status exposes pending outcomes and refused IDs instead of generic busy or inventory errors", () => {
  const pane = panel.split("id: arrangeStatus")[1].split("BarLayoutPane {")[0]
  const [status, hint] = [...pane.matchAll(/text: ([\s\S]*?)\n\s*color:/g)].map(m => Function("root", `return ${m[1]}`))
  const root = { popupMoveOwner: { status: "Move outcome unknown", exited: false }, barMovePending: true, barSnapshot: {} }
  assert.equal(status(root), "Move outcome unknown")
  assert.match(hint(root), /Saving/)
  root.popupMoveOwner.exited = true
  assert.match(hint(root), /Accept it without retrying/)
  root.barMovePending = false
  root.popupMoveOwner.status = "Move refused: this entry ID cannot be transported by omarchy-bar."
  assert.equal(status(root), root.popupMoveOwner.status)
  root.barSnapshot = null
  assert.match(status(root), /layout unavailable/i)
})
