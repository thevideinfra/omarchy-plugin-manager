import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")
const widgetSource = read("BarWidget.qml")
const storeSource = read("PluginStore.qml"), panelSource = read("Panel.qml")
const Model = Function(read("Model.js") + "; return { barLayoutSnapshot, barLayoutMove, barSectionMovePlan, findRow }")()
function call(source, name, state, ...args) {
  const match = source.match(new RegExp(`function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}`))
  assert.ok(match, `${name} exists`)
  return Function("state", "args", `with (state) { return (function(${match[1]}) {${match[2]}})(...args) }`)(state, args)
}
// Evaluate the shipped one-line bindings, not a parallel lock implementation.
function binding(source, name, state, fallback = "false") {
  const expression = source.match(new RegExp(`^\\s*(?:(?:readonly )?property (?:bool|alias) )?${name}: ([^\\n]+)`, "m"))?.[1] || fallback
  return Function("state", `with (state) { return (${expression}) }`)(state)
}
function actionStore(owner = null, shellJson = JSON.stringify({ plugins: [{ id: "manager" }] })) {
  const effects = []
  const state = { popupMoveOwner: owner, busyKind: "", barMovePending: null, cleanupProcess: null,
    actionProc: { running: false }, pinnedProc: { running: false }, barMoveProc: { running: false },
    selfId: "manager", selfEntry: {}, selfEntryLoaded: true, selfSettings: {},
    allowUnverifiedUpdates: false, allowUnverifiedInstalls: false, openAs: "popup",
    pendingKind: "", pendingId: "", pendingLabel: "", pendingPlacementNeeded: false,
    rows: [], catalog: [], catalogLoaded: true, pinnedHelperPath: "/fake/helper", noticeScript: "fake",
    shell: { updateEntryInline(id, entry) { effects.push([id, entry]); return true },
      barConfig: { layout: { left: ["a"], center: [], right: [] } } },
    Quickshell: { execDetached(argv) { effects.push(argv) }, env() { return "" } },
    openAsConfig: { reload() {}, text() { return shellJson } },
    Model: Function(read("Model.js") + "; return { withSelfSetting, withOpenAs, parseSelfSettings, parseSelfEntry, selfEntryFromShellConfig, openAs, canEnable, canDisable, needsPlacement, canMove, findRow, moveCommand, enableCommand, disableCommand, successMessage, enableNote, disableNote, moveNote, restartShellCommand, barLayoutMove }")(),
    loadProcessSettled: () => true, updateProcessSettled: () => true }
  state.root = state
  for (const name of ["setStatus", "writeSelfSetting", "setAllowUnverifiedUpdates", "setAllowUnverifiedInstalls", "setOpenAs",
    "runDetached", "startEnable", "startDisable", "startMoveTo", "restartShell", "askRemove", "askInstall", "askEnable", "askDisable", "askMove",
    "confirmPending", "confirmPlacement", "cancelPending", "startAdd", "launchInstall", "runAction", "canStartUpdate", "startUpdate", "runUpdate", "startBarMove"])
    state[name] = (...args) => call(storeSource, name, state, ...args)
  Object.defineProperty(state, "externalBusy", { get: () => binding(panelSource, "externalBusy", state) })
  for (const name of ["busy", "actionRunning"])
    Object.defineProperty(state, name, { get: () => binding(storeSource, name, state) })
  return { state, effects }
}

for (const lock of ["owner", "local"]) {
  test(`${lock} lock blocks actual popup setters, inventory actions and restart without consuming confirmations`, () => {
    const owner = { busy: lock === "owner" }
    const attempts = [
      s => s.setAllowUnverifiedUpdates(true), s => s.setAllowUnverifiedInstalls(true), s => s.setOpenAs("window"),
      s => s.runDetached("test", "test", ["fake"]), s => s.startEnable({ id: "a", name: "A", enabled: false }, "right"),
      s => s.startDisable({ id: "a", name: "A", enabled: true }), s => s.restartShell(),
      s => s.askRemove({ id: "a", removable: true }),
      s => s.askInstall({ id: "a", installable: true, updateSnapshot: { repository: "fake", verifiedCommit: "a" } }),
      s => s.askEnable({ id: "a", enabled: false }), s => s.askDisable({ id: "a", enabled: true, canDisable: true }),
      s => s.askMove({ id: "a", enabled: true, kinds: ["bar-widget"], barSection: "left" }),
      s => s.startMoveTo({ id: "a", enabled: true, kinds: ["bar-widget"], barSection: "left" }, "right"),
      s => s.confirmPending(), s => s.confirmPlacement("right"), s => s.startAdd("right"),
      s => s.launchInstall({}, "A"), s => s.runAction("remove", "A", ["fake"]),
      s => s.startUpdate({ id: "a" }), s => s.runUpdate({ id: "a" })
    ]
    for (const attempt of attempts) {
      const { state, effects } = actionStore(owner)
      if (lock === "local") state.busyKind = "remove"
      state.pendingKind = "remove"; state.pendingId = "a"; state.pendingLabel = "A"
      attempt(state)
      assert.equal(effects.length, 0, String(attempt))
      assert.equal(state.actionProc.running || state.pinnedProc.running, false, String(attempt))
      assert.equal(state.pendingKind, "remove", String(attempt))
      assert.equal(state.pendingId, "a", String(attempt))
      assert.equal(state.busyKind, lock === "local" ? "remove" : "", "external lock must not latch local state")
    }
  })
}

// The popup's store loads late and never watches shell.json, so how it opens
// is written over the entry as the file has it at the click, not as the store
// last saw it.
test("setOpenAs writes over shell.json as it is now, not the store's copy", () => {
  const file = JSON.stringify({ plugins: [{ id: "manager", position: "right", openAs: "window" }] })
  // Not loaded yet: still writes, keeping the entry's other keys.
  const early = actionStore(null, file)
  early.state.selfEntryLoaded = false; early.state.selfEntry = {}
  assert.equal(early.state.setOpenAs("overlay"), true)
  assert.deepEqual(early.effects, [["manager", { position: "right", openAs: "overlay" }]])
  // Stale: the store still thinks overlay after the window wrote window.
  const stale = actionStore(null, file)
  stale.state.openAs = "overlay"; stale.state.selfSettings = { openAs: "overlay" }
  assert.equal(stale.state.setOpenAs("overlay"), true)
  assert.equal(stale.effects.length, 1, "the file says window, so overlay is written")
  // The file can trail the host by a write, so the write always goes and the
  // host decides; its "nothing changed" is still a saved setting.
  const same = actionStore(null, file)
  same.state.shell.updateEntryInline = (id, entry) => { same.effects.push([id, entry]); return false }
  assert.equal(same.state.setOpenAs("window"), true)
  assert.equal(same.effects.length, 1)
  // A refusal for a mode the file does not hold is a failed write, not
  // "nothing changed": the form stays put and the store keeps its setting.
  const refused = actionStore(null, file)
  refused.state.selfSettings = { openAs: "window" }
  refused.state.shell.updateEntryInline = (id, entry) => { refused.effects.push([id, entry]); return false }
  assert.equal(refused.state.setOpenAs("overlay"), false)
  assert.equal(refused.effects.length, 1)
  assert.deepEqual(refused.state.selfSettings, { openAs: "window" })
  // Unreadable, or no entry: refuse rather than rewrite the entry from nothing.
  for (const text of ["", "{", JSON.stringify({ plugins: [] })]) {
    const broken = actionStore(null, text)
    assert.equal(broken.state.setOpenAs("overlay"), false, text)
    assert.equal(broken.effects.length, 0, text)
  }
})

test("owner unlock and removal restore popup actions; local busy and owner-free Expanded stay independent", () => {
  const owner = { busy: true }, { state, effects } = actionStore(owner)
  assert.equal(state.busy, true)
  owner.busy = false
  assert.equal(state.busy, false)
  assert.equal(state.setOpenAs("window"), true)
  state.restartShell()
  state.askDisable({ id: "a", name: "A", enabled: true, canDisable: true })
  assert.equal(effects.length, 3)
  state.busyKind = "remove"; owner.busy = true; owner.busy = false
  assert.equal(state.busy, true)
  state.busyKind = ""
  assert.equal(state.busy, false)
  owner.busy = true; state.popupMoveOwner = null
  assert.equal(state.busy, false)
  state.runAction("remove", "A", ["fake"])
  assert.equal(state.actionProc.running, true)
  const legacy = actionStore().state
  assert.equal(legacy.busy, false)
  assert.equal(legacy.setAllowUnverifiedUpdates(true), true)
  assert.match(storeSource, /property bool externalBusy: false/)
  assert.match(panelSource, /readonly property alias busy: store\.busy/)
})

test("active local processes reject a move before reading host layout, including after busyKind clears", () => {
  for (const process of ["actionProc", "pinnedProc", "cleanupProcess"]) {
    const { state } = actionStore()
    state[process] = { running: true }
    Object.defineProperty(state.shell.barConfig, "layout", { get() { throw Error("preflight must not run") } })
    assert.equal(state.startBarMove({}, "left", 0, "right", 0), false)
    const p = popup({ busy: false, pending: false })
    p.state.store = state
    p.state.openArrange()
    assert.equal(p.state.requestBarMove({}, "left", 0, "right", 0), false)
    assert.equal(p.events.some(Array.isArray), false)
    if (process === "cleanupProcess") {
      state.cleanupProcess.running = false
      assert.equal(state.busy, true, "cleanup owns the lock until its result settles")
      assert.equal(state.actionRunning, true)
      assert.equal(state.startBarMove({}, "left", 0, "right", 0), false)
      state.cleanupProcess = null
      assert.equal(state.busy, false)
      assert.equal(state.actionRunning, false)
    }
  }
})

function popup(owner = null) {
  const events = []
  const state = { popupMoveOwner: owner, opened: false, arrangeOpen: false, settingsOpen: true,
    store: { actionRunning: false, statusRefreshes: 0, refreshUpdateData() { this.statusRefreshes++ } },
    busy: false, confirming: false, placing: false,
    bar: {}, anchorItem: {},
    barBoard: { heldSnapshot: null, cancelDrag() { this.heldSnapshot = null; events.push("cancel drag") } },
    settingsPane: { visible: true, forceActiveFocus() {} },
    revokeReleaseNavigation() {}, returnFocusToList() {},
    open() { this.opened = true }, close() { this.opened = false },
    hostWidget: { cancelPopupArrange() { events.push("cancel return") },
      requestPopupMove(...args) { events.push(args); return true } } }
  state.root = state
  for (const name of ["openArrange", "closeArrange", "requestBarMove", "useCurrentLayout", "openSettings", "clearSearch", "handleArrangeKey"])
    state[name] = (...args) => call(panelSource, name, state, ...args)
  return { state, events }
}

test("popup Arrange opens locally and reports actual readiness", () => {
  const { state, events } = popup()
  assert.equal(state.openArrange(), true)
  assert.equal(state.opened && state.arrangeOpen, true)
  assert.equal(state.settingsOpen, false)
  assert.equal(events.includes("cancel return"), true)
  state.settingsPane.visible = false
  events.length = 0
  assert.equal(state.openArrange(), false)
  assert.equal(events.includes("cancel return"), false)
  state.opened = false
  state.open = () => {}
  assert.equal(state.openArrange(), false)
  assert.doesNotMatch(panelSource, /onClicked: root\.expand\("arrange"\)/)
})

test("popup drops use only the host bridge with unchanged raw index and pre-removal gap", () => {
  const { state, events } = popup()
  state.openArrange()
  const args = [{ key: "raw" }, "left", 2, "left", 4]
  assert.equal(state.requestBarMove(...args), false)
  state.popupMoveOwner = { busy: false, pending: false }
  assert.equal(state.requestBarMove(...args), true)
  assert.deepEqual(events.at(-1), args)
  for (const flag of ["busy", "pending"]) {
    state.popupMoveOwner[flag] = true
    assert.equal(state.requestBarMove(...args), false)
    state.popupMoveOwner[flag] = false
  }
  state.arrangeOpen = false
  assert.equal(state.requestBarMove(...args), false)
  assert.doesNotMatch(panelSource, /store\.startBarMove|popupMoveOwner\.start\(/)
})

test("popup recovery is explicit, requires exit and a snapshot, and never dispatches", () => {
  let recoveries = 0
  const { state } = popup({ pending: true, exited: false, snapshot: {}, recover() { recoveries++; return true } })
  state.openArrange()
  assert.equal(state.useCurrentLayout(), false)
  state.popupMoveOwner.exited = true
  state.popupMoveOwner.snapshot = null
  assert.equal(state.useCurrentLayout(), false)
  state.popupMoveOwner.snapshot = {}
  assert.equal(state.useCurrentLayout(), true)
  assert.equal(recoveries, 1)
  state.closeArrange()
  assert.equal(state.useCurrentLayout(), false)
})

test("explicit navigation cancels return even after an automatic close; drag Escape is consumed first", () => {
  const { state, events } = popup()
  const Qt = { Key_Escape: 1, Key_Backspace: 2 }
  state.Qt = Qt
  state.openArrange()
  state.barBoard.heldSnapshot = {}
  assert.equal(state.handleArrangeKey({ key: 1 }), true)
  assert.equal(state.arrangeOpen, true)
  assert.equal(state.handleArrangeKey({ key: 1 }), true)
  assert.equal(state.arrangeOpen, false)
  for (const leave of [() => state.openSettings(), () => state.clearSearch()]) {
    state.openArrange()
    state.arrangeOpen = false // automatic close/rebuild must not revoke the retained route
    leave()
    assert.equal(events.at(-1), "cancel return")
  }
  assert.equal(state.handleArrangeKey({ key: 9 }), false)
  const closed = panelSource.match(/onOpenedChanged: \{\s*if \(!opened\) \{([^\n]*)/)[1]
  assert.doesNotMatch(closed, /closeArrange|cancelPopupArrange/)
  assert.doesNotMatch(panelSource, /Component\.onDestruction:.*cancel/)
})

test("popup overlay projects owner status, blocks background focus, and injects the board theme", () => {
  const pane = panelSource.split("id: arrangeStatus")[1].split("Flickable {")[0]
  const expression = pane.match(/text: ([\s\S]*?)\n\s*color:/)[1]
  const text = root => Function("root", `return ${expression}`)(root)
  assert.match(text({ popupMoveOwner: null }), /not ready/)
  const root = { popupMoveOwner: { status: "Unknown outcome" }, barMovePending: true, barSnapshot: null }
  assert.equal(text(root), "Unknown outcome")
  root.barMovePending = false
  assert.match(text(root), /layout unavailable/i)
  root.barSnapshot = {}
  assert.equal(text(root), "Unknown outcome")
  assert.match(panelSource, /blocked: .*root\.arrangeOpen/)
  assert.match(panelSource, /focusTarget: root\.arrangeOpen \? settingsPane : keyCatcher/)
  assert.match(panelSource, /arrangeBusy: !popupMoveOwner \|\| popupMoveOwner\.busy \|\| barMovePending/)
  for (const property of ["fill", "rowFill", "foreground", "mutedForeground", "borderColor", "accent", "fontFamily", "fontPixelSize", "spacing", "radius", "rowHeight"])
    assert.match(pane.split("BarLayoutPane {")[1], new RegExp(`${property}: (root\\.|Color\\.|Style\\.)`))
})

const installedOrigin = () => ({ tab: "installed", selectedId: "a", query: "A", group: "all", kind: "all", status: "all", scroll: 125 })
function placementPopup(owner = { busy: false, pending: false, status: "Moved", statusIsError: false }) {
  const p = popup(owner), s = p.state
  Object.assign(s, { Model, pendingKind: "move", pendingPlacementNeeded: false, pendingId: "a",
    rows: [{ id: "a", name: "A", enabled: true, kinds: ["bar-widget"], barSection: "left" }],
    searchText: "A", searchQuery: "A", groupFilter: "all", kindFilter: "all", statusFilter: "all",
    kindOptions: [{ value: "all" }, { value: "bar" }], listColumn: { forceLayout() {} },
    listScroll: { contentY: 125, contentHeight: 500, height: 200 }, selectedIndex: 0,
    placementRefreshStarted: false, placementRowsReady: false, loading: false, loadError: "",
    searchDebounce: { stop() {} }, setStatus(text, error, source) { s.status = text; s.statusIsError = error; s.statusSource = source } })
  s.visibleRows = s.rows; s.selectedRow = s.rows[0]
  s.bar.shell = { barConfig: { layout: { left: ["a"], center: [], right: [] } } }
  Object.assign(s.store, { confirmPlacement() { p.events.push("legacy chooser") },
    cancelPending() { s.pendingKind = ""; p.events.push("chooser closed") },
    reload() { s.loading = true; p.events.push("reload"); return true } })
  for (const name of ["confirmPlacement", "openPlacementView", "flushSearch"])
    s[name] = (...args) => call(panelSource, name, s, ...args)
  s.opened = true; s.settingsOpen = false
  return p
}

test("popup chooser dispatches the shipped positional plan and closes only on acceptance", () => {
  const { state: s, events } = placementPopup()
  s.confirmPlacement("right")
  const [snapshot, from, index, section, gap, origin] = events.find(Array.isArray)
  assert.equal(snapshot.key, Model.barLayoutSnapshot(s.bar.shell.barConfig.layout).key)
  assert.deepEqual([from, index, section, gap], ["left", 0, "right", 0])
  assert.deepEqual(origin, installedOrigin())
  assert.equal(s.pendingKind, ""); assert.equal(s.opened, true)
  assert.equal(events.includes("legacy chooser"), false)
  for (const mode of ["enable", "install"]) {
    s.pendingKind = mode; s.pendingPlacementNeeded = mode === "install"
    s.confirmPlacement("left")
    assert.equal(events.at(-1), "legacy chooser")
  }
})

test("popup refused, missing, stale and owner-busy choices never detach or consume the chooser", () => {
  for (const change of [s => s.popupMoveOwner = null, s => s.popupMoveOwner.busy = true,
    s => s.rows = [], s => s.rows[0].barSection = "center",
    s => s.hostWidget = null, s => s.hostWidget.requestPopupMove = () => false]) {
    const { state: s, events } = placementPopup()
    change(s); s.confirmPlacement("right")
    assert.equal(s.pendingKind, "move")
    assert.equal(s.statusSource, "layout")
    assert.equal(events.some(Array.isArray), false)
    assert.equal(events.includes("legacy chooser"), false)
  }
})

test("Installed restoration waits for fresh rows, preserves view, and safely loses a missing selection", () => {
  for (const missing of [false, true]) {
    const { state: s, events } = placementPopup()
    const origin = { ...installedOrigin(), group: "installed", kind: "bar", status: "enabled" }
    assert.equal(s.openPlacementView(origin, false), false)
    assert.equal(events.filter(e => e === "reload").length, 1)
    s.rows = missing ? [] : [{ id: "a", name: "Refreshed" }]; s.visibleRows = s.rows
    s.loading = false; s.clampSelection = () => {}
    Function("root", panelSource.match(/function onRowsLoaded\(\) \{([\s\S]*?)\n    \}/)[1])(s)
    s.searchText = "other"; s.listScroll.contentY = 0
    assert.equal(s.openPlacementView(origin, false), true)
    assert.equal(s.searchQuery, "A")
    assert.deepEqual([s.groupFilter, s.kindFilter, s.statusFilter], ["installed", "bar", "enabled"])
    assert.equal(s.selectedIndex, missing ? -1 : 0); assert.equal(s.listScroll.contentY, 125)
    assert.equal(s.arrangeOpen, false)
    assert.equal(s.statusSource, "layout")
    if (missing) assert.match(s.status, /no longer.*visible/i)
  }
  const { state: s } = placementPopup()
  s.store.reload = () => false
  assert.equal(s.openPlacementView(installedOrigin(), false), false)
  assert.equal(s.placementRefreshStarted, false, "an older in-flight read cannot restore selection")
  assert.equal(s.openPlacementView(installedOrigin(), true), true)
  assert.match(s.status, /inventory.*refresh/i)
})

