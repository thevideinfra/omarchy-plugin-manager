import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Everything the plugin manager knows and does, with no window attached: the
// installed rows and their update check, the verified-snapshot catalog that
// authorizes updates, and the commands that update, remove, enable and
// disable plugins.
//
// It holds no window: the popup binds to it. Nothing here knows about
// selection, filters, dialogs or focus — those are decisions the surface
// makes, and the store only reports what happened through its signals.
//
// Every command runs as an argv array, never through a shell, so a repository
// url or a plugin id can never become a command. The scripts below take their
// variable parts as positional arguments for the same reason.
Item {
  id: root

  // ---- Installed plugins --------------------------------------------------

  property var rows: []
  property bool loading: false
  property string loadError: ""

  // Checked in the background after the rows are already on screen, so a
  // surface never waits on the network to show what is installed.
  property bool checkingUpdates: false
  readonly property int behindCount: Model.countBehind(rows)
  readonly property int installedTotal: Model.countRemovable(rows)

  // A Process is reusable only after both its exit and collector callbacks
  // have settled. The callbacks may arrive in either order, so `running` alone
  // is not enough to decide that a fresh load/check pair can safely start.
  property bool loadProcessExited: true
  property bool loadOutputFinished: true
  property bool updateProcessExited: true
  property bool updateOutputFinished: true
  property bool freshUpdateCycleQueued: false
  readonly property bool updateActionsEnabled:
    !busy && loadProcessSettled() && updateProcessSettled()

  // Held so a report that lands while the rows are being rebuilt is not lost.
  // Model.applyUpdateReport binds every replay to the freshly loaded checkout
  // HEAD, so an old generation can remain pending without regaining authority.
  property string pendingUpdateReport: ""
  // One retry per load attempt; cleared by the next successful read.
  property bool loadRetried: false
  // Set by loadOnOpen(): the catalog and the update check wait until the
  // list has landed. The catalog parse holds the main thread for seconds in
  // QML, and the list read needs the shell to answer an IPC call in that
  // same window; run together, the list came back empty.
  property bool openLoadPending: false

  // ---- Marketplace catalog ------------------------------------------------
  //
  // The catalog omarchyplugins.com publishes. Read from the disk cache first —
  // it is what tells the Installed rows who is verified and which snapshot an
  // update may install — and fetched afresh on request.

  property var catalog: []
  readonly property var verifiedIds: Model.verifiedIdSet(catalog)
  readonly property var starsById: Model.catalogStarsById(catalog)
  property bool catalogLoading: false
  property bool catalogLoaded: false
  property string catalogError: ""

  // ---- In-flight action ---------------------------------------------------

  property string busyKind: ""   // "update" | "bulk-update" | "remove" | "cleanup"
  onBusyKindChanged: if (busyKind !== "") invalidateUpdateData()
  onBusyChanged: Qt.callLater(drainUpdateDataRefresh)
  onActionRunningChanged: Qt.callLater(drainUpdateDataRefresh)
  // Which row an update is running on, by id: busyId carries the label for
  // messages, and labels are not unique.
  property string busyRowId: ""
  property string busyId: ""
  // Only popup stores opt into the retained owner's lock. Never feed this
  // projection back into that owner or copy it into local action state.
  property bool externalBusy: false
  readonly property bool busy: busyKind !== "" || barMovePending !== null || externalBusy || cleanupProcess !== null
  readonly property bool actionRunning: actionProc.running || pinnedProc.running || cleanupProcess !== null

  // Kept past the exit so a late stderr can still upgrade the message it
  // belongs to (see actionProc below).
  property string actionStderr: ""
  property string lastActionKind: ""
  property int lastExitCode: 0

  property string status: ""
  property bool statusIsError: false
  // Presentation scope only; move ownership stays in barMovePending.
  property string statusSource: ""

  // ---- Pending confirmation -----------------------------------------------
  //
  // What is being asked, and about which plugin. Shared here rather than in
  // the surface; only the dialogs that put the question on screen belong to
  // it.

  // The plugin id of the surface using this store. Disabling that one plugin
  // takes the surface down with it, which is the single disable that needs a
  // warning before it runs.
  property string selfId: ""

  // The scoped shell API of the surface that owns this store, when it has
  // one. It is the sanctioned way to write this plugin's inline shell.json
  // entry; a store without it can only read.
  property var shell: null

  // This plugin's own inline shell.json entry, as the loader printed it.
  // Read here rather than from the shell API because both surfaces need it,
  // the popup has no shell API of its own, and shell.json is already what the
  // store watches: a write goes through the host, the host rewrites the
  // file, the watcher reloads, and every surface sees the same value.
  // Two views of that entry: `selfEntry` is the whole thing, kept so a write
  // can hand every key back to the host (updateEntryInline replaces the
  // entry, it does not merge); `selfSettings` is the strict view the panel
  // reads. `selfEntryLoaded` says the last load actually produced the entry:
  // until it has, or after a failed load, there is nothing safe to write
  // over, so the switch refuses rather than rewriting the entry from nothing.
  property var selfEntry: ({})
  property bool selfEntryLoaded: false
  property var selfSettings: ({})
  readonly property bool allowUnverifiedUpdates: Model.allowUnverifiedUpdates(selfSettings)
  onAllowUnverifiedUpdatesChanged: rows = Model.applyPinnedUpdates(rows, catalog, allowUnverifiedUpdates)

  // Active-transaction history capacity. The helper reads the same shell.json
  // entry and enforces the same bounds, so this only moves the threshold at
  // which archival and refusal happen, never what counts as proven success.
  readonly property int transactionLimit: Model.transactionLimit(selfSettings)

  // Lowest settable capacity right now: the live active count, so lowering
  // the limit can never wedge updates. Falls back to the static minimum
  // until a fresh status arrives.
  readonly property int transactionLimitFloor: Model.transactionLimitFloor(updateDataStatus)

  // Persist one setting through the host, merged over the entry as it was
  // loaded. The local copies move only when the host accepted the write; the
  // watcher reload then confirms it on every surface. `current` is the value
  // in force, so asking for what is already set is a no-op rather than a write.
  function writeSelfSetting(key, value, current) {
    if (busy) return false
    var want = value === true
    if (want === current) return true
    if (!selfEntryLoaded || !selfEntry) {
      setStatus("Settings unavailable until the plugin list loads", true)
      return false
    }
    if (!shell || typeof shell.updateEntryInline !== "function" || selfId === "") {
      setStatus("Could not save the setting: no shell connection", true)
      return false
    }
    var next = Model.withSelfSetting(selfEntry, key, want)
    if (shell.updateEntryInline(selfId, next) !== true) {
      setStatus("Could not save the setting", true)
      return false
    }
    selfEntry = next
    selfSettings = Model.parseSelfSettings(JSON.stringify(next))
    return true
  }

  function setAllowUnverifiedUpdates(value) {
    return writeSelfSetting("allowUnverifiedUpdates", value, allowUnverifiedUpdates)
  }

  // Persist a bounded integer setting through the host, merged over the entry
  // as it was loaded. Same guards as the boolean write: no rewrite from an
  // unread entry, no write without a shell connection, no-op when unchanged.
  function writeSelfIntSetting(key, value, current, min, max, fallback) {
    var number = typeof value === "number" && isFinite(value) ? Math.floor(value) : fallback
    if (number < min) number = min
    if (number > max) number = max
    if (number === current) return true
    if (!selfEntryLoaded || !selfEntry) {
      setStatus("Settings unavailable until the plugin list loads", true)
      return false
    }
    if (!shell || typeof shell.updateEntryInline !== "function" || selfId === "") {
      setStatus("Could not save the setting: no shell connection", true)
      return false
    }
    var next = Model.withSelfIntSetting(selfEntry, key, number, min, max, fallback)
    if (shell.updateEntryInline(selfId, next) !== true) {
      setStatus("Could not save the setting", true)
      return false
    }
    selfEntry = next
    selfSettings = Model.parseSelfSettings(JSON.stringify(next))
    return true
  }

  function setTransactionLimit(value) {
    if (!writeSelfIntSetting("transactionLimit", value, transactionLimit,
      transactionLimitFloor, Model.TRANSACTION_LIMIT_MAX, Model.TRANSACTION_LIMIT_DEFAULT)) return false
    // The count caption comes from the last status read under the old limit.
    // Re-read so Settings shows the new threshold against a fresh count.
    refreshUpdateData()
    return true
  }

  function adjustTransactionLimit(step) {
    return setTransactionLimit(transactionLimit + step)
  }

  property string pendingKind: ""
  property string pendingId: ""
  property string pendingLabel: ""
  readonly property bool confirming: pendingKind !== "" && pendingKind !== "place" && pendingKind !== "move"

  // Enabling a bar widget is a different question from the yes/no ones above:
  // not "are you sure" but "where". It gets its own dialog rather than a
  // default section, because a widget dropped into a section the user did not
  // choose is a widget they have to go hunting for.
  readonly property bool placing: pendingKind === "place" || pendingKind === "move"

  // The section a widget being moved sits in now, so the question can leave
  // that one out. Held with the rest of the pending state.
  property string pendingSection: ""

  readonly property var placementChoices: pendingKind === "move"
    ? Model.moveOptions(pendingSection) : Model.placementOptions()
  readonly property string placementMessage: pendingKind === "move"
    ? "Move " + pendingLabel + " to which section of the bar?"
    : "Where in the bar should " + pendingLabel + " go?"

  // Only an unreviewed update enters a dialog, and it offers the exact diff.
  readonly property string confirmCompareUrl: pendingKind === "update"
    ? Model.updateCompareUrl(Model.findRow(rows, pendingId)) : ""

  readonly property string confirmMessage: {
    if (pendingKind === "cleanup")
      return "Delete completed journals and rollback backups from both active and archive update data?\n\n"
        + "This deletion is irreversible: deleted rollback backups cannot be recovered. "
        + "Failed and unresolved histories are preserved, as are installed plugins. "
        + "Unsafe or interrupted entries are preserved. The active count excludes the archive."
    if (pendingKind === "remove")
      return "Remove " + pendingLabel + "?\n\nIts folder under ~/.config/omarchy/plugins is deleted."
    if (pendingKind === "update")
      return Model.updateUnverifiedConfirmMessage(pendingLabel, Model.findRow(rows, pendingId))
    if (pendingKind === "bulk-update")
      return Model.bulkUpdateConfirmMessage(bulkQueue)
    if (pendingKind === "disable")
      return "Disable " + pendingLabel + "?\n\n"
        + "This is the panel you are looking at. It leaves the bar and this window closes with it — "
        + "nothing is uninstalled, but you will need a terminal to put it back:\n\n"
        + "omarchy plugin enable " + selfId + " right"
    return ""
  }

  // ---- What a surface may want to know ------------------------------------

  // A load is starting, whoever asked for it — a surface that has something
  // in flight of its own (a release probe, say) can retire it here.
  signal reloadStarted()
  // The rows were replaced by a successful read; a selection index may now
  // point past the end.
  signal rowsLoaded()
  signal actionFinished(string kind, string label, int exitCode)

  onCatalogChanged: rows = Model.applyPinnedUpdates(rows, catalog, allowUnverifiedUpdates)

  // ---- Loading ------------------------------------------------------------

  function loadProcessSettled() {
    return !loadProc.running && root.loadProcessExited && root.loadOutputFinished
  }

  function updateProcessSettled() {
    return !updateProc.running && root.updateProcessExited && root.updateOutputFinished
  }

  function loadOnOpen() {
    openLoadPending = true
    reload()
  }

  function finishOpenLoad() {
    if (!openLoadPending) return
    openLoadPending = false
    checkUpdates()
    if (!catalogLoaded && !catalogLoading) loadCatalog(false)
  }

  function reload() {
    if (!root.loadProcessSettled()) return false
    root.loadProcessExited = false
    root.loadOutputFinished = false
    root.loading = true
    root.reloadStarted()
    loadProc.running = true
    return true
  }

  function applyLoad(raw) {
    loading = false

    var sections = Model.splitSections(raw)
    var listEntries = sections ? Model.parseArray(sections.list) : null
    if (!sections || !listEntries) {
      // `omarchy plugin list` asks the shell itself over IPC, and a shell that
      // is busy — starting up — answers
      // with nothing. One bounded retry turns that into a slightly later
      // success instead of a spurious error.
      if (!loadRetried) {
        loadRetried = true
        loading = true
        loadRetry.start()
        return
      }
      // Deliberately keep the rows we already have. An empty list would read
      // as "no plugins installed", which is a different and much scarier
      // claim than "could not read".
      loadError = "Could not read the plugin list"
      // The entry may have changed under a load that failed; do not write
      // over it from a stale copy.
      selfEntryLoaded = false
      finishOpenLoad()
      return
    }

    loadError = ""
    loadRetried = false
    // A null entry is one the loader printed but this code could not read
    // (oversized or not one JSON object): the setting stays off and the
    // switch refuses to write until a later load reads it whole.
    selfEntry = Model.parseSelfEntry(sections.settings)
    selfEntryLoaded = selfEntry !== null
    selfSettings = Model.parseSelfSettings(sections.settings)
    var merged = Model.mergePlugins(
      listEntries,
      Model.parseArray(sections.catalog) || [],
      Model.parseGitMap(sections.git),
      Model.parseManifestMeta(sections.manifest),
      Model.parseLayoutSections(sections.layout))
    // The last report is replayed onto the fresh rows before they are
    // assigned, not after: every assignment rebuilds every row on every
    // surface, and the replay is the same rows with badges. It binds to the
    // freshly loaded HEAD as before, so a stale report still says nothing.
    if (pendingUpdateReport !== "")
      merged = Model.applyUpdateReport(merged, Model.parseUpdateReport(pendingUpdateReport))
    rows = Model.applyPinnedUpdates(merged, catalog, allowUnverifiedUpdates)
    rowsLoaded()
    finishOpenLoad()
    // A batch may have finished while no store was alive to hear it; a fresh
    // load picks up its recorded summary. Skipped while busy so a summary
    // never retires an action still running.
    if (!busy && !bulkActive) consumeBulkSummary()
  }

  // ---- Update checks ------------------------------------------------------

  function checkUpdates() {
    if (!root.updateProcessSettled()) return false
    root.updateProcessExited = false
    root.updateOutputFinished = false
    root.checkingUpdates = true
    updateProc.running = true
    return true
  }

  // A successful pull invalidates both snapshots. One bounded bit remembers
  // that debt while either old process settles; repeated requests coalesce.
  // The replacement load/check pair starts together only when both reusable
  // Process objects have completed both lifecycle callbacks.
  function requestFreshUpdateCycle() {
    root.freshUpdateCycleQueued = true
    root.drainFreshUpdateCycle()
  }

  function drainFreshUpdateCycle() {
    if (!root.freshUpdateCycleQueued
        || !root.loadProcessSettled() || !root.updateProcessSettled()) return false
    root.freshUpdateCycleQueued = false
    root.reload()
    root.checkUpdates()
    return true
  }

  function applyUpdateReport(raw) {
    checkingUpdates = false
    pendingUpdateReport = raw
    if (rows.length === 0) return
    rows = Model.applyPinnedUpdates(Model.applyUpdateReport(rows, Model.parseUpdateReport(raw)), catalog, allowUnverifiedUpdates)
  }

  // ---- Catalog ------------------------------------------------------------

  // The helper owns the cache: it opens ~/.cache/omarchy-plugin-manager by
  // owner-checked no-follow descriptors, reads the projection through them
  // and publishes a fresh one with a descriptor-relative rename, so nothing
  // here names a cache path a symlink could redirect. Same scrubbed
  // environment as the transactions; the helper takes its home from passwd.
  property int catalogExitCode: 0
  property bool catalogOutputFinished: true
  property bool catalogErrorFinished: true

  function loadCatalog(force) {
    if (catalogProc.running || catalogExitCode === -1
        || !catalogOutputFinished || !catalogErrorFinished) return
    catalogGeneration += 1
    catalogExitCode = -1
    catalogOutputFinished = false
    catalogErrorFinished = false
    catalogLoading = true
    catalogError = ""
    catalogProc.command = ["/usr/bin/env", "-i", "--", "PATH=/usr/bin:/bin",
      "/usr/bin/python3", "-I", "-S", pinnedHelperPath,
      JSON.stringify({ schemaVersion: 1, catalog: { force: force === true } })]
    catalogProc.running = true
  }

  // Exit and pipe completion may arrive in either order. Only successful
  // output reaches the builder; a failed refresh keeps the displayed catalog.
  function finishCatalogFetch() {
    if (catalogExitCode === -1 || !catalogOutputFinished || !catalogErrorFinished) return
    if (catalogExitCode !== 0) {
      catalogLoading = false
      var reason = Model.plainText(catalogErrors.text.slice(0, 200)).trim()
      catalogError = "Catalog refresh failed. " + (reason ? reason + ". " : "") + "Try Refresh again."
      return
    }
    applyCatalog(catalogOutput.text)
  }

  property int catalogGeneration: 0

  // The cached projection is small (the helper keeps only the fields read
  // here), so it is built in-process, one event-loop turn after the fetch.
  function applyCatalog(raw) {
    catalogGeneration += 1
    var generation = catalogGeneration
    if (raw.length > 16 * 1024 * 1024) {
      applyCatalogResult({ generation: generation, error: "Catalog exceeds input limit" })
      return
    }
    Qt.callLater(function() {
      if (generation !== root.catalogGeneration) return
      var built = Model.buildCatalog(raw)
      root.applyCatalogResult({ generation: generation, entries: built.entries, error: built.error })
    })
  }

  function applyCatalogResult(message) {
    if (!message || message.generation !== catalogGeneration) return
    catalogLoading = false
    if (!message.entries) {
      // Keep whatever was already on screen. An empty grid would claim the
      // marketplace has nothing in it.
      catalogError = message.error || "Could not read the plugin catalog"
      return
    }
    catalog = message.entries
    catalogLoaded = true
    catalogError = ""
  }

  // ---- Actions ------------------------------------------------------------

  function setStatus(text, isError, source) {
    status = text
    statusIsError = isError === true
    statusSource = source || ""
  }

  function startDisable(row) {
    runDetached(Model.successMessage("disable", row.name),
                Model.disableNote(),
                Model.disableCommand(row))
  }

  // Detached, and announced through a notification rather than the status
  // line — for the same reason installing is. Switching a bar widget on or off
  // rewrites `bar.layout`; the bar rebuilds its widgets, and the popup is one
  // of them. It is gone before `onExited` could fire, so a status message here
  // is written to something nobody can read, and a Process owned by a
  // destroyed surface is not a safe place for the command itself either.
  function runDetached(summary, detail, command, source) {
    if (busy || command.length === 0) return
    Quickshell.execDetached(["bash", "-c", noticeScript, "notice", summary, detail].concat(command))
    setStatus(summary, false, source)
  }

  function startEnable(row, section) {
    runDetached(Model.successMessage("enable", row.name),
                Model.enableNote(section),
                Model.enableCommand(row, section))
  }

  // The shell is the process every surface of this plugin lives in, so a
  // restart is the one action that is certain to outlive its own status
  // line: detached, like enable, with the notification landing on the new
  // shell once the host reports it ready. Nothing in flight is interrupted —
  // an install or update already runs in its own worker — but a plain host
  // action would die with the shell, so the button waits for it.
  function restartShell() {
    if (busy || actionProc.running) return
    runDetached("Shell restart",
                "The QML cache was cleared and every plugin reloaded.",
                Model.restartShellCommand())
  }

  // Run a command, then say what happened where the answer will still exist:
  // $1 summary, $2 detail, and everything after that is the command itself,
  // passed as separate arguments so none of it is ever parsed as shell.
  readonly property string noticeScript: ""
    + "set -u -o pipefail; "
    + "summary=\"$1\"; detail=\"$2\"; shift 2; "
    + "if ! err=$(\"$@\" 2>&1 >/dev/null | tail -1); then "
    + "  notify-send -a 'Plugin Manager' \"$summary failed\" \"$err\"; exit 1; "
    + "fi; "
    + "notify-send -a 'Plugin Manager' \"$summary\" \"$detail\""

  // ---- GitHub stars ---------------------------------------------------------
  property bool starBusy: false
  property var pendingStarRequest: null
  property bool starExited: false
  property bool starOutputDone: false
  property int starCode: -1
  property string starOutput: ""
  property bool starStarted: false
  property bool starStartSettled: false

  // A surface opens this web page: the signed-out star fallback.
  signal externalUrlRequested(string url)
  signal starToggleFinished()

  // Star notices clear themselves after a few seconds. Update
  // messages stay until replaced.
  property string flashedText: ""
  function flashStatus(text, isError) {
    flashedText = text
    setStatus(text, isError === true)
    flashTimer.restart()
  }
  Timer {
    id: flashTimer
    interval: 4000
    repeat: false
    onTriggered: {
      if (root.status !== "" && root.status === root.flashedText) root.setStatus("", false)
    }
  }

  function toggleStar(entry) {
    if (starBusy || !entry) return false
    var slug = Model.starSlugFor(entry)
    if (slug === "") return false
    var helperPath = decodeURIComponent(Qt.resolvedUrl("helpers/github_star.py").toString().replace(/^file:\/\//, ""))
    var command = Model.starToggleCommand(helperPath, slug)
    if (command.length === 0) return false
    pendingStarRequest = { id: entry.id, name: entry.name, slug: slug }
    starExited = false
    starOutputDone = false
    starCode = -1
    starOutput = ""
    starStarted = false
    starStartSettled = false
    starBusy = true
    flashStatus("Checking the star for " + entry.name, false)
    starProc.command = command
    starProc.running = true
    return true
  }

  function settleStarStart() {
    if (!starBusy || starProc.running) return
    starStartSettled = true
    if (!starStarted) {
      starExited = true
      starOutputDone = true
    }
    finishStar()
  }

  function finishStar() {
    if (!starBusy || starProc.running || !starExited || !starOutputDone || !starStartSettled) return
    var request = pendingStarRequest
    pendingStarRequest = null
    starBusy = false
    if (!request) {
      starToggleFinished()
      return
    }
    var result = starStarted ? Model.parseStarResult(starOutput, starCode) : { kind: "fallback" }
    if (result.kind === "fallback") {
      starToggleFinished()
      externalUrlRequested("https://github.com/" + request.slug)
      return
    }
    if (result.kind === "failed") {
      starToggleFinished()
      flashStatus("Could not change the star for " + request.name, true)
      return
    }
    bumpCatalogCount(request.id, result.starred ? 1 : -1)
    starToggleFinished()
    flashStatus(result.starred ? "Starred " + request.name
      : "Removed the star from " + request.name, false)
  }

  function bumpCatalogCount(id, delta) {
    var key = String(id)
    var out = []
    var touched = false
    for (var i = 0; i < catalog.length; i++) {
      var entry = catalog[i]
      if (entry && String(entry.id) === key) {
        var copy = {}
        for (var name in entry) copy[name] = entry[name]
        copy.stars = Model.bumpCount(entry.stars, delta)
        out.push(copy)
        touched = true
      } else {
        out.push(entry)
      }
    }
    // A fresh array so bindings on the catalog (star counts) re-evaluate.
    if (touched) catalog = out
  }

  Process {
    id: starProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.starOutput = text
        root.starOutputDone = true
        root.finishStar()
      }
    }
    onStarted: {
      root.starStarted = true
      root.starStartSettled = true
      root.finishStar()
    }
    onExited: function(exitCode) {
      root.starCode = exitCode
      root.starExited = true
      root.finishStar()
    }
    onRunningChanged: if (!running) Qt.callLater(root.settleStarStart)
  }

  // ---- Asking -------------------------------------------------------------
  //
  // Each ask returns whether the request was taken. A surface uses that to do
  // only its own bookkeeping — close a details view, retire a link probe —
  // and only for a request that was real, so a click on a greyed button never
  // costs anything.

  function askRemove(row) {
    if (!row || !row.removable || busy) return false
    pendingId = row.id
    pendingLabel = row.name
    pendingKind = "remove"
    return true
  }

  // Enabling is not destructive and needs no "are you sure" — but a bar widget
  // has to be told where it goes, and only the user knows that.
  function askEnable(row) {
    if (!Model.canEnable(row) || busy) return false

    if (!Model.needsPlacement(row)) {
      // A service, an overlay, or a whole-bar plugin: nothing to place, so the
      // question would have exactly one answer.
      startEnable(row, "")
      return true
    }

    pendingId = row.id
    pendingLabel = row.name
    pendingKind = "place"
    return true
  }

  // Disabling takes a widget out of the bar and leaves it on disk, so it is
  // reversible from the row it just greyed out — no confirmation needed. With
  // one exception: the surface's own row, whose Enable button leaves with it.
  function askDisable(row) {
    if (!Model.canDisable(row) || busy) return false

    if (row.id === selfId) {
      pendingId = row.id
      pendingLabel = row.name
      pendingKind = "disable"
      return true
    }

    startDisable(row)
    return true
  }

  // A widget already in the bar can change section. It asks the same
  // "where" question the enable switch does, minus the section it is in, and
  // the move itself is the enable command with a section: the shell moves a
  // placed widget rather than adding it twice (PluginRegistry.setEnabled).
  function askMove(row) {
    if (!Model.canMove(row) || busy) return false
    pendingId = row.id
    pendingLabel = row.name
    pendingSection = String(row.barSection || "")
    pendingKind = "move"
    return true
  }

  // The direct form, for a control that already names the target section.
  // Detached like enable and disable: the layout rewrite rebuilds the bar's
  // widgets, the popup among them, so the answer goes to a notification.
  function startMoveTo(row, section) {
    if (busy) return false
    var command = Model.moveCommand(row, section)
    if (command.length === 0) return false
    runDetached(Model.successMessage("move", row.name), Model.moveNote(section), command, "layout")
    return true
  }

  function confirmPlacement(section) {
    if (busy) return
    // Two questions share this dialog: where to put a plugin already sitting
    // in the list switched off, and where to move one that is already in the
    // bar.
    if (pendingKind === "move") {
      var moving = Model.findRow(rows, pendingId)
      var movingLabel = pendingLabel
      cancelPending()
      if (!moving) {
        setStatus("Could not move " + movingLabel + ": it is no longer in the list", true, "layout")
        return
      }
      startMoveTo(moving, section)
      return
    }

    var row = Model.findRow(rows, pendingId)
    var label = pendingLabel
    cancelPending()
    if (!row) {
      // The list was reloaded out from under the question — enabling a row
      // that is no longer there would either fail or, worse, hit whatever now
      // carries that id.
      setStatus("Could not enable " + label + ": it is no longer in the list", true)
      return
    }
    startEnable(row, section)
  }

  function cancelPending() {
    pendingKind = ""
    pendingUnverifiedSha = ""
    pendingSection = ""
    pendingId = ""
    pendingLabel = ""
    // A dismissed bulk question drops its queue; a run in flight keeps it.
    if (!bulkActive) bulkQueue = []
  }

  // Confirmation answered.
  function confirmPending() {
    if (pendingKind === "cleanup") {
      var allowed = canCleanupUpdateData()
      cancelPending()
      if (allowed) startCleanupUpdateData()
      return
    }
    if (busy) return
    if (pendingKind === "disable") {
      var row = Model.findRow(rows, pendingId)
      cancelPending()
      if (row) startDisable(row)
      return
    }
    if (pendingKind === "update") {
      // Re-gated on the live row: the list may have reloaded, the check may
      // have moved the tip, or the setting may have been switched off while
      // the question was on screen. Only the exact commit the dialog named
      // is ever installed; anything else is a no-op, never a substitute.
      var target = Model.findRow(rows, pendingId)
      var expected = pendingUnverifiedSha
      cancelPending()
      if (!target || target.unverifiedEligible !== true || target.remoteSha !== expected
          || !canStartUpdate(target)) return
      runUpdate(target)
      return
    }
    if (pendingKind === "bulk-update") {
      // The queue carries the exact commits the dialog named. Each step
      // re-gates at run time; a moved tip or flipped setting skips that row
      // with a reason instead of installing something else.
      var queue = bulkQueue.slice()
      cancelPending()
      if (busy) return
      bulkQueue = queue
      bulkResults = []
      bulkActive = true
      startNextBulk()
      return
    }
    if (pendingKind === "remove") {
      runAction("remove", pendingLabel, ["omarchy", "plugin", "remove", pendingId, "--yes"])
      cancelPending()
    }
  }

  // The commit an open unreviewed-update question names, so the answer can
  // be held to exactly that commit.
  property string pendingUnverifiedSha: ""

  property var bulkQueue: []
  property var bulkResults: []
  property var bulkPendingRequests: []
  property bool bulkActive: false
  // The last reported bulk batch: a reloaded store skips a summary it
  // already showed instead of announcing it twice.
  property string lastBulkSummaryNonce: ""
  property string summaryOutput: ""
  property bool summaryOverflow: false
  property bool summaryDrainOnly: false
  readonly property int bulkUpdatableCount: Model.bulkUpdateCandidates(rows).length

  // The request a row's Update would send: the verified snapshot when one is
  // installable, otherwise the observed unreviewed tip if the user's setting
  // allows it, otherwise nothing. Cached catalog data chooses the request,
  // never authorizes publication; the helper rechecks a verified one.
  function updateRequest(row) {
    if (!row) return null
    if (row.pinnedEligible === true) return Model.pinnedRequest(row, catalogLoaded ? catalog : null)
    if (row.unverifiedEligible === true && allowUnverifiedUpdates) return Model.unverifiedRequest(row)
    return null
  }

  // All entry points bind the displayed tuple, even programmatic callers.
  function canStartUpdate(row) {
    if (!row || busy || pinnedProc.running
        || !root.loadProcessSettled() || !root.updateProcessSettled()) return false
    var current = Model.findRow(rows, row.id)
    var request = updateRequest(row)
    if (!current || !request || current.headSha !== row.headSha
        || current.updateOrigin !== row.updateOrigin) return false
    if (row.pinnedEligible === true)
      return row.verifiedTargetSha === request.verifiedCommit && current.pinnedEligible === true
    return current.unverifiedEligible === true && current.remoteSha === request.unverifiedCommit
  }

  // A verified snapshot installs on the click. An unreviewed commit asks
  // first, naming the exact commit, with the diff one click away.
  function startUpdate(row) {
    if (!canStartUpdate(row)) return
    if (row.pinnedEligible === true) {
      runUpdate(row)
      return
    }
    pendingId = row.id
    pendingLabel = row.name
    pendingUnverifiedSha = row.remoteSha
    pendingKind = "update"
  }

  // The rows one "Update all" would install, re-gated on the live rows: only
  // candidates whose request still builds and whose bound target still holds.
  function bulkUpdatables() {
    if (!root.loadProcessSettled() || !root.updateProcessSettled()) return []
    var out = []
    var candidates = Model.bulkUpdateCandidates(rows)
    for (var i = 0; i < candidates.length; i++) {
      var row = Model.findRow(rows, candidates[i].id)
      if (!row || !updateRequest(row)) continue
      if (candidates[i].kind === "verified") {
        if (row.pinnedEligible !== true || row.verifiedTargetSha !== candidates[i].targetSha) continue
      } else if (row.unverifiedEligible !== true || row.remoteSha !== candidates[i].targetSha) continue
      out.push(candidates[i])
    }
    return out
  }

  function askBulkUpdate() {
    if (busy || !root.loadProcessSettled() || !root.updateProcessSettled()) return false
    var candidates = bulkUpdatables()
    if (candidates.length === 0) return false
    bulkQueue = candidates
    bulkResults = []
    pendingKind = "bulk-update"
    return true
  }

  function startNextBulk() {
    if (!bulkActive) return
    var requests = []
    for (var i = 0; i < bulkQueue.length; i++) {
      if (busy || pinnedProc.running || actionProc.running
          || !root.loadProcessSettled() || !root.updateProcessSettled()) {
        for (var j = i; j < bulkQueue.length; j++)
          bulkResults.push({ id: bulkQueue[j].id, name: bulkQueue[j].name, ok: false, reason: "interrupted" })
        break
      }
      var step = bulkQueue[i]
      var row = Model.findRow(rows, step.id)
      var request = row ? updateRequest(row) : null
      var bound = !!row && !!request
        && (step.kind === "verified"
          ? row.pinnedEligible === true && row.verifiedTargetSha === step.targetSha
          : row.unverifiedEligible === true && row.remoteSha === step.targetSha)
      if (!bound) {
        bulkResults.push({ id: step.id, name: step.name, ok: false,
          reason: !row ? "no longer in the list" : (!request ? "no installable update"
            : (step.kind === "verified" ? "the verified snapshot moved" : "the upstream tip moved")) })
        continue
      }
      requests.push(request)
    }
    if (requests.length > 0) runBulkUpdates(requests)
    else finishBulk()
  }

  function runBulkUpdates(requests) {
    bulkPendingRequests = requests
    bulkRescanFailed = false
    if (busy || pinnedProc.running || actionProc.running) {
      for (var i = 0; i < requests.length; i++) {
        var row = Model.findRow(rows, requests[i].id)
        bulkResults.push({ id: requests[i].id, name: row ? row.name : requests[i].id,
          ok: false, reason: "interrupted" })
      }
      finishBulk()
      return
    }
    busyRowId = ""
    busyId = "Update all"
    busyKind = "bulk-update"
    pinnedOutput = ""
    pinnedExited = false
    pinnedOverflow = false
    setStatus("Updating " + requests.length + " plugins; stopping finishes the current preparation and checked updates still apply; closing this window does not cancel it", false)
    pinnedProc.command = ["/usr/bin/env", "-i", "--", "PATH=/usr/bin:/bin",
      "WAYLAND_DISPLAY=" + String(Quickshell.env("WAYLAND_DISPLAY") || ""),
      "/usr/bin/python3", "-I", "-S", pinnedHelperPath,
      JSON.stringify({ schemaVersion: 1, bulkUpdates: requests })]
    pinnedProc.running = true
  }

  function finishBulk() {
    bulkQueue = []
    bulkPendingRequests = []
    bulkActive = false
    busyKind = ""
    busyId = ""
    busyRowId = ""
    var skipped = 0
    for (var i = 0; i < bulkResults.length; i++) if (bulkResults[i].ok !== true) skipped++
    var rescanFailed = bulkRescanFailed
    setStatus(Model.bulkUpdateSummary(bulkResults)
      + (rescanFailed ? "; shell did not reload the updated plugins" : ""), skipped > 0 || rescanFailed)
    bulkRescanFailed = false
    pendingUpdateReport = ""
    if (rescanFailed) rows = Model.applyPinnedUpdates(rows, null, allowUnverifiedUpdates)
    else rows = Model.applyPinnedUpdates(Model.applyUpdateReport(rows, {}), null, allowUnverifiedUpdates)
    root.actionFinished("bulk-update", "Update all", skipped > 0 || rescanFailed ? 1 : 0)
    if (!rescanFailed) {
      root.requestFreshUpdateCycle()
      root.refreshUpdateData()
    }
  }

  function finishBulkProcess() {
    var outcomes = Object.create(null)
    var resultsById = Object.create(null)
    var stepsById = Object.create(null)
    var processFailure = ""
    var nonce = ""
    for (var i = 0; i < bulkQueue.length; i++) stepsById[bulkQueue[i].id] = bulkQueue[i]
    for (var j = 0; j < bulkResults.length; j++) resultsById[bulkResults[j].id] = bulkResults[j]
    try {
      var result = JSON.parse(pinnedOutput)
      if (!pinnedOverflow && result && result.status === "bulk complete" && Array.isArray(result.updates)) {
        bulkRescanFailed = result.rescan === "failed"
        if (typeof result.nonce === "string") {
          nonce = result.nonce
          lastBulkSummaryNonce = nonce
        }
        for (var j = 0; j < result.updates.length; j++) {
          var update = result.updates[j]
          if (update && typeof update.id === "string" && typeof update.status === "string")
            outcomes[update.id] = update
        }
      } else if (!pinnedOverflow && result && result.status === "unchanged; request refused") {
        processFailure = typeof result.reason === "string"
          ? result.reason.replace(/[^\x20-\x7e]/g, "").slice(0, 200) : result.status
      }
    } catch (error) {}
    for (var k = 0; k < bulkPendingRequests.length; k++) {
      var request = bulkPendingRequests[k]
      var step = stepsById[request.id]
      if (!step) continue
      var outcome = outcomes[request.id]
      var status = outcome ? outcome.status : (processFailure || "outcome unknown; inspect retained transactions")
      var reason = outcome && typeof outcome.reason === "string"
        ? outcome.reason.replace(/[^\x20-\x7e]/g, "").slice(0, 200) : status
      var changed = status.indexOf("updated") === 0
      resultsById[step.id] = { id: step.id, name: step.name, ok: changed,
        reason: changed ? "" : (reason || status) }
    }
    bulkResults = []
    for (var n = 0; n < bulkQueue.length; n++)
      if (resultsById[bulkQueue[n].id]) bulkResults.push(resultsById[bulkQueue[n].id])
    pinnedOutput = ""
    finishBulk()
    return nonce
  }

  // A batch can outlive this store: the shell reloads every plugin when the
  // first exchange lands, destroying the batch state with it. The worker
  // records the summary on disk; a freshly loaded store picks it up here.
  function consumeBulkSummary(nonce) {
    if (summaryProc.running) return
    summaryOutput = ""
    summaryOverflow = false
    summaryDrainOnly = typeof nonce === "string" && nonce !== ""
    summaryProc.command = ["/usr/bin/env", "-i", "--", "PATH=/usr/bin:/bin",
      "/usr/bin/python3", "-I", "-S", pinnedHelperPath].concat(summaryDrainOnly
        ? ["--drain-bulk-summary", nonce] : ["--consume-bulk-summary"])
    summaryProc.running = true
  }

  function finishBulkSummary() {
    var raw = summaryOverflow ? "" : summaryOutput
    summaryOutput = ""
    if (summaryDrainOnly) return
    var payload = null
    try { payload = JSON.parse(raw) } catch (error) {}
    if (!payload || payload.status !== "bulk complete" || !Array.isArray(payload.updates)
        || rows.length === 0 || busy || bulkActive) return
    if (typeof payload.nonce === "string" && payload.nonce !== ""
        && payload.nonce === lastBulkSummaryNonce) return
    bulkQueue = []
    bulkPendingRequests = []
    for (var i = 0; i < payload.updates.length; i++) {
      var update = payload.updates[i]
      if (!update || typeof update.id !== "string") continue
      var row = Model.findRow(rows, update.id)
      if (!row) continue
      bulkQueue.push({ id: row.id, name: row.name })
      bulkPendingRequests.push({ id: row.id })
    }
    if (bulkQueue.length === 0) return
    pinnedOutput = raw
    pinnedOverflow = false
    finishBulkProcess()
  }

  readonly property string pinnedHelperPath:
    decodeURIComponent(Qt.resolvedUrl("helpers/pinned_update.py").toString().replace(/^file:\/\//, ""))
  property string pinnedOutput: ""
  property bool pinnedExited: false
  property bool pinnedOverflow: false
  property bool bulkRescanFailed: false

  function runUpdate(row) {
    if (!canStartUpdate(row) || actionProc.running) return
    var request = updateRequest(row)
    busyRowId = row.id
    busyId = row.name
    busyKind = "update"
    pinnedOutput = ""
    pinnedExited = false
    pinnedOverflow = false
    setStatus((request.verifiedCommit ? "Installing the verified snapshot" : "Installing unreviewed commit " + Model.shortSha(request.unverifiedCommit))
      + "; closing this window does not cancel it", false)
    // Process.command is QStringList; avoid the environment property's
    // QVariantHash binding, which this installed QML toolchain cannot type.
    pinnedProc.command = ["/usr/bin/env", "-i", "--", "PATH=/usr/bin:/bin",
      "WAYLAND_DISPLAY=" + String(Quickshell.env("WAYLAND_DISPLAY") || ""),
      "/usr/bin/python3", "-I", "-S", pinnedHelperPath, JSON.stringify(request)]
    pinnedProc.running = true
  }

  function finishPinnedUpdate() {
    if (!pinnedExited) return
    if (busyKind === "bulk-update") {
      var nonce = finishBulkProcess()
      if (nonce !== "") consumeBulkSummary(nonce)
      return
    }
    if (busyKind !== "update") return
    var done = "updated"
    var outcome = "outcome unknown; inspect retained transactions"
    var reason = ""
    try {
      var result = JSON.parse(pinnedOutput)
      var allowed = ["updated", "updated; reload failed", "updated; finalization failed",
        "unchanged; update refused", "unchanged; request refused"]
      if (!pinnedOverflow && result && allowed.indexOf(result.status) >= 0) {
        outcome = result.status
        // The helper's own static prose; still bounded to printable ASCII here.
        if (typeof result.reason === "string")
          reason = result.reason.replace(/[^\x20-\x7e]/g, "").slice(0, 200)
      }
    } catch (error) {}
    var changed = outcome.indexOf(done) === 0
    var kind = busyKind
    var label = busyId
    busyKind = ""
    busyId = ""
    busyRowId = ""
    pinnedOutput = ""
    setStatus(outcome.indexOf("unchanged") === 0 && reason !== "" ? outcome + ": " + reason : outcome,
              outcome !== done)
    if (changed) {
      pendingUpdateReport = ""
      rows = Model.applyPinnedUpdates(Model.applyUpdateReport(rows, {}), null, allowUnverifiedUpdates)
      root.requestFreshUpdateCycle()
    } else root.reload()
    root.refreshUpdateData()
    root.actionFinished(kind, label, outcome === done ? 0 : 1)
  }

  function runAction(kind, label, command) {
    if (kind === "update" || busy || actionProc.running) return
    busyKind = kind
    busyId = label
    setStatus("", false)
    actionStderr = ""
    actionProc.command = command
    actionProc.running = true
  }

  // ---- Settings update data -----------------------------------------------
  // Each surface has a store; the helper's inode flock, not these UI guards,
  // excludes cooperating workers in other surfaces/processes.
  property var updateDataStatus: null
  readonly property var updateDataPaths: updateDataStatus ? updateDataStatus.paths : null
  property bool updateDataLoading: false
  readonly property string updateDataCount: Model.updateDataCountLabel(updateDataStatus, updateDataLoading)
  readonly property bool cleanupEnabled: canCleanupUpdateData()
  property string cleanupOutcome: ""
  property bool cleanupIsError: false
  property var updateDataProcess: null
  property var cleanupProcess: null
  property int updateDataGeneration: 0
  property bool updateDataRefreshQueued: false
  property bool updateDataDestroying: false

  function canCleanupUpdateData() {
    return !updateDataDestroying && !busy && !actionProc.running && !pinnedProc.running
      && cleanupProcess === null && updateDataProcess === null && !updateDataLoading
      && !updateDataRefreshQueued && updateDataStatus !== null && updateDataStatus.available === true
  }

  function askCleanupUpdateData() {
    if (!canCleanupUpdateData() || pendingKind !== "") return
    pendingKind = "cleanup"
  }

  function invalidateUpdateData() {
    updateDataGeneration++
    updateDataStatus = null
    updateDataLoading = true
    updateDataRefreshQueued = true
    // Do not reuse an in-flight Process or its raw parsers. Let its exit and
    // deferred final chunks settle before draining the coalesced refresh.
    if (updateDataProcess && updateDataProcess.running) updateDataProcess.signal(15)
  }

  function refreshUpdateData() {
    if (updateDataDestroying) return
    invalidateUpdateData()
    drainUpdateDataRefresh()
  }

  function drainUpdateDataRefresh() {
    if (updateDataDestroying || !updateDataRefreshQueued || busy || actionRunning
        || updateDataProcess !== null || cleanupProcess !== null) return
    updateDataRefreshQueued = false
    var proc = updateDataProcessComponent.createObject(root, {
      cleanup: false, requestGeneration: updateDataGeneration
    })
    if (!proc) {
      updateDataLoading = false
      return
    }
    updateDataProcess = proc
    proc.command = Model.updateDataCommand(pinnedHelperPath, false)
    proc.running = true
    // Failed-to-start may have no exited signal. A settled non-running child
    // with no observed exit is unknown, never a fabricated successful exit.
    Qt.callLater(function() { root.finishUpdateDataProcess(proc) })
  }

  function startCleanupUpdateData() {
    if (!canCleanupUpdateData()) return
    invalidateUpdateData()
    cleanupOutcome = "Deleting completed update data…"
    cleanupIsError = false
    var proc = updateDataProcessComponent.createObject(root, {
      cleanup: true, requestGeneration: updateDataGeneration
    })
    if (!proc) {
      cleanupOutcome = Model.cleanupOutcomeText(null)
      cleanupIsError = true
      refreshUpdateData()
      return
    }
    cleanupProcess = proc
    busyKind = "cleanup"
    proc.command = Model.updateDataCommand(pinnedHelperPath, true)
    proc.running = true
    Qt.callLater(function() { root.finishUpdateDataProcess(proc) })
  }

  function readUpdateDataChunk(proc, chunk, stderr) {
    if (updateDataDestroying || !proc || proc.settled || proc.overflow) return
    var limit = proc.cleanup ? 4096 : 8192
    var buffer = Model.boundedUpdateDataChunk(stderr ? "" : proc.output,
      stderr ? proc.errorBytes : proc.outputBytes, chunk, limit)
    if (buffer.overflow) {
      proc.overflow = true
      proc.output = ""
      // TERM reaches the supervisor. Its independent inner timeout owns group
      // KILL escalation even if this component is destroyed in the meantime.
      if (proc.running) proc.signal(15)
    } else if (stderr) proc.errorBytes = buffer.bytes
    else {
      proc.output = buffer.text
      proc.outputBytes = buffer.bytes
    }
  }

  function finishUpdateDataProcess(proc) {
    if (updateDataDestroying || !proc || proc.settled || proc.running) return
    proc.settled = true
    var code = proc.processExited && !proc.overflow ? proc.exitCode : -1
    if (proc.cleanup && cleanupProcess === proc) {
      var result = Model.parseCleanupResult(proc.output, code)
      cleanupOutcome = Model.cleanupOutcomeText(result)
      cleanupIsError = !result || result.status !== "complete"
      cleanupProcess = null
      busyKind = ""
      setStatus(cleanupOutcome, cleanupIsError, "update-data")
      // Required even after failure, overflow, timeout or an unknown result.
      // Never derive the active count from removed, and never retry deletion.
      refreshUpdateData()
    } else if (!proc.cleanup && updateDataProcess === proc) {
      updateDataProcess = null
      if (proc.requestGeneration === updateDataGeneration) {
        updateDataStatus = Model.parseUpdateDataStatus(proc.output, code)
        updateDataLoading = false
      }
    }
    proc.destroy()
    Qt.callLater(drainUpdateDataRefresh)
  }

  function stopUpdateDataProcesses() {
    updateDataDestroying = true
    updateDataGeneration++
    updateDataRefreshQueued = false
    if (updateDataProcess && updateDataProcess.running) updateDataProcess.signal(15)
    if (cleanupProcess && cleanupProcess.running) cleanupProcess.signal(15)
  }

  Component.onDestruction: stopUpdateDataProcesses()

  Component {
    id: updateDataProcessComponent
    Process {
      id: dataProc
      required property bool cleanup
      required property int requestGeneration
      property string output: ""
      property int outputBytes: 0
      property int errorBytes: 0
      property bool overflow: false
      property bool processExited: false
      property int exitCode: -1
      property bool settled: false
      clearEnvironment: true
      stdout: SplitParser {
        splitMarker: ""
        onRead: function(chunk) { root.readUpdateDataChunk(dataProc, chunk, false) }
      }
      stderr: SplitParser {
        splitMarker: ""
        onRead: function(chunk) { root.readUpdateDataChunk(dataProc, chunk, true) }
      }
      onExited: function(code, status) {
        dataProc.exitCode = status === 0 ? code : -1
        dataProc.processExited = true
        Qt.callLater(function() { root.finishUpdateDataProcess(dataProc) })
      }
      onRunningChanged: if (!running)
        Qt.callLater(function() { root.finishUpdateDataProcess(dataProc) })
    }
  }

  // ---- Positional layout moves ----------------------------------------------
  // The retained move owner keeps this lock across popup closes.
  // Stopping an IPC client cannot undo a request the host already received.
  property var barMovePending: null
  property bool barMoveExited: true
  property bool barMoveFailed: false
  property int barMoveBytes: 0

  function startBarMove(snapshot, fromSection, fromIndex, section, gap) {
    if (root.busy || root.actionRunning || root.barMovePending || barMoveProc.running || !root.shell) return false
    var plan = Model.barLayoutMove(snapshot, root.shell.barConfig && root.shell.barConfig.layout,
                                   fromSection, fromIndex, section, gap)
    if (!plan) {
      var before = Model.barLayoutSnapshot(snapshot && snapshot.layout)
      var latest = Model.barLayoutSnapshot(root.shell.barConfig && root.shell.barConfig.layout)
      // A host-valid ID may still be impossible to pass losslessly through
      // Linux argv. Explain that refusal without removing its board entry.
      if (before && latest && before.key === latest.key) {
        var entries = before.layout[fromSection]
        var entry = entries && entries[fromIndex]
        var id = typeof entry === "string" ? entry : entry && entry.id
        var transportable = typeof id === "string"
        try {
          transportable = transportable && id.indexOf("\u0000") < 0
            && encodeURIComponent(id).replace(/%[0-9A-F]{2}/g, "x").length < 131072
        } catch (error) { transportable = false }
        if (entry && !transportable) {
          root.setStatus("Move refused: this entry ID cannot be transported by omarchy-bar. No move was sent.", true, "layout")
          return false
        }
      }
      root.setStatus("Move refused: layout changed or unavailable, destination full, or invalid drop. No move was sent.", true, "layout")
      return false
    }
    if (plan.noOp) return false
    root.barMovePending = plan
    root.barMoveExited = false
    root.barMoveFailed = false
    root.barMoveBytes = 0
    root.setStatus("Moving bar entry; waiting for the host layout", false, "layout")
    // GNU timeout owns the command group, including the CLI's IPC descendants.
    // TERM on overflow also starts timeout's one-second KILL escalation.
    barMoveProc.command = ["/usr/bin/timeout", "-k", "1", "8"].concat(plan.command)
    barMoveProc.running = true
    return true
  }

  function readBarMoveOutput(chunk) {
    if (!root.barMovePending || root.barMoveFailed) return
    // No collection, newline buffering or error text rendering. Count UTF-8
    // bytes; a surrogate pair split across chunks is conservatively overcounted.
    var bytes = 0
    for (var i = 0; i < chunk.length && bytes <= 4096; i++) {
      var code = chunk.charCodeAt(i)
      if (code < 128) bytes += 1
      else if (code < 2048) bytes += 2
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < chunk.length
               && chunk.charCodeAt(i + 1) >= 0xdc00 && chunk.charCodeAt(i + 1) <= 0xdfff) {
        bytes += 4
        i += 1
      } else bytes += 3
    }
    root.barMoveBytes += bytes
    if (root.barMoveBytes > 4096) {
      root.barMoveFailed = true
      barMoveProc.signal(15)
    }
  }

  function finishBarMove(exitCode) {
    if (!root.barMovePending) return
    root.barMoveExited = true
    root.barMoveFailed = root.barMoveFailed || exitCode !== 0
    root.setStatus(root.barMoveFailed
      ? "Move outcome unknown; reconcile the current bar before continuing"
      : "Move sent; waiting for the host layout", root.barMoveFailed, "layout")
    root.reconcileBarMove(false)
  }

  // Call on host barConfig changes AND after exit. true is an explicit user
  // acknowledgement of the CURRENT board after an ambiguous/mismatched result;
  // never pass it automatically or retry the original drag after a failure.
  function reconcileBarMove(acceptCurrent) {
    if (!root.barMovePending || !root.barMoveExited || barMoveProc.running) return false
    var current = Model.barLayoutSnapshot(root.shell && root.shell.barConfig && root.shell.barConfig.layout)
    if (!current || (current.key !== root.barMovePending.expected.key && acceptCurrent !== true)) return false
    var matched = current.key === root.barMovePending.expected.key
    root.barMovePending = null
    root.setStatus(matched ? "Bar layout updated" : "Current layout accepted", false, "layout")
    return true
  }

  Process {
    id: barMoveProc
    stdout: SplitParser { splitMarker: ""; onRead: function(chunk) { root.readBarMoveOutput(chunk) } }
    stderr: SplitParser { splitMarker: ""; onRead: function(chunk) { root.readBarMoveOutput(chunk) } }
    onExited: function(exitCode) { Qt.callLater(function() { root.finishBarMove(exitCode) }) }
  }

  // Covers failure to start as well as an unexpectedly stalled client. The
  // process group deadline above stays responsible for descendant cleanup.
  Timer {
    interval: 10000
    running: root.barMovePending !== null && !root.barMoveExited
    onTriggered: {
      root.barMoveFailed = true
      if (barMoveProc.running) barMoveProc.signal(15)
      else root.finishBarMove(-1)
    }
  }

  // ---- Processes ----------------------------------------------------------

  // One round trip for the whole picture: enabled state from `plugin list`,
  // source directories and descriptions from `plugin catalog`, which checkouts
  // a pull can reach from the filesystem, any exact manifest-version tag proven
  // at each checkout's HEAD, and the author and version each manifest declares.
  // The section markers print unconditionally so a failed command shows up as
  // unparseable output rather than as a silently short list.
  //
  // The catalog is fetched once and reused: it is also the only list of every
  // manifest path on the system, built-ins included, and running the command
  // twice would double the slowest step of the load.
  // Enable and
  // disable are detached commands that rewrite shell.json. The bar rebuilds
  // the popup with its new state; a store that is not part of the bar can opt
  // in to watching the file the way the shell itself does and reload once the
  // write has settled and the shell has read it too. Opt-in, because the popup
  // exists once per monitor and three copies reloading at once for a change
  // the bar already handles is pure waste.
  property bool watchConfig: false
  onWatchConfigChanged: if (!watchConfig) configReload.stop()

  FileView {
    id: shellConfig
    path: root.watchConfig ? Quickshell.env("HOME") + "/.config/omarchy/shell.json" : ""
    preload: false
    blockAllReads: true
    watchChanges: root.watchConfig
    printErrors: false
    onFileChanged: if (root.watchConfig) configReload.restart()
  }

  Timer {
    id: configReload
    interval: 1000
    repeat: false
    onTriggered: if (root.watchConfig) root.reload()
  }

  Timer {
    id: loadRetry
    interval: 1500
    repeat: false
    onTriggered: root.reload()
  }

  Process {
    id: loadProc
    command: ["bash", "-c",
      "catalog=$(omarchy plugin catalog); "
      // This plugin's own inline entry, wherever shell.json keeps it. Bounded
      // read, one object or nothing; the id is this plugin's fixed manifest id.
      + "printf '===settings===\\n'; "
      + "head -c 1048577 -- \"$HOME/.config/omarchy/shell.json\" 2>/dev/null "
      + "  | jq -c --arg id io.github.juancasanueva.plugin-manager "
      + "    '[(.bar.layout // {} | .[]? | .[]?), (.plugins // [] | .[]?)] "
      + "     | map(select(type == \"object\" and (.id | tostring) == $id)) | first // empty' 2>/dev/null; "
      // Which section every bar widget sits in, as one array on one line, so
      // a row can say where it is and the move control can leave that out.
      // Same bounded read; a layout jq cannot print is simply no layout.
      + "printf '===layout===\\n'; "
      + "head -c 1048577 -- \"$HOME/.config/omarchy/shell.json\" 2>/dev/null "
      + "  | jq -c '[(.bar.layout // {}) | to_entries[] | .key as $section "
      + "     | (.value | if type == \"array\" then .[] else empty end) "
      + "     | {id: ((if type == \"object\" then .id else . end) | tostring), section: $section}]' 2>/dev/null; "
      + "printf '===list===\\n'; "
      + "omarchy plugin list --json; "
      + "printf '\\n===catalog===\\n'; "
      + "printf '%s' \"$catalog\"; "
      + "printf '\\n===git===\\n'; "
      + "for dir in \"$HOME\"/.config/omarchy/plugins/*/; do "
      + "  [ -d \"$dir/.git\" ] || continue; "
      + "  path=\"${dir%/}\"; "
      + "  version=$(jq -r '.version // \"\"' \"$path/manifest.json\" 2>/dev/null); "
      + "  head=$(git -C \"$path\" rev-parse HEAD 2>/dev/null); exact_tag=; "
      // Prefer the v-prefixed convention when both exact refs point at HEAD.
      // show-ref proves the literal ref exists before rev-list peels annotated
      // tags to the commit they name; neither command contacts the network.
      + "  if [ -n \"$version\" ] && [ -n \"$head\" ]; then "
      + "    for tag in \"v$version\" \"$version\"; do "
      + "      ref=\"refs/tags/$tag\"; "
      + "      git -C \"$path\" show-ref --verify --quiet \"$ref\" || continue; "
      + "      tag_commit=$(git -C \"$path\" rev-list -n 1 \"$ref\" 2>/dev/null); "
      + "      if [ -n \"$tag_commit\" ] && [ \"$tag_commit\" = \"$head\" ]; then exact_tag=$tag; break; fi; "
      + "    done; "
      + "  fi; "
      // JSON escaping keeps hostile path/remote bytes inside this one record;
      // they cannot forge another checkout or exact-tag field.
      + "  remote=$(git -C \"$path\" remote get-url origin 2>/dev/null); "
      // The newest commits reachable from HEAD, so the panel can tell a
      // verified snapshot the checkout already contains from one it lacks.
      + "  ancestors=$(git -C \"$path\" rev-list --max-count=128 HEAD 2>/dev/null); "
      + "  jq -cn --arg path \"$path\" --arg remote \"$remote\" --arg exactTag \"$exact_tag\" --arg headSha \"$head\" --arg ancestors \"$ancestors\" "
      + "    '{path: $path, remote: $remote, exactTag: $exactTag, headSha: $headSha, ancestors: $ancestors}'; "
      + "done; "
      + "printf '\\n===manifest===\\n'; "
      // One jq over every manifest at once rather than one process per plugin.
      // Fields the manifest omits print as empty columns, which is what the
      // parser expects; a manifest that will not parse simply contributes no
      // line and its row falls back to the id namespace.
      + "printf '%s' \"$catalog\" | jq -r '.[].manifestPath // empty' "
      + "  | tr '\\n' '\\0' "
      + "  | xargs -0 -r jq -r '[.id, (.author // \"\"), (.version // \"\")] | @tsv' 2>/dev/null"
    ]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.applyLoad(text)
        root.loadOutputFinished = true
        root.drainFreshUpdateCycle()
      }
    }
    onExited: function(exitCode) {
      root.loadProcessExited = true
      root.drainFreshUpdateCycle()
    }
    onRunningChanged: if (!running) root.drainFreshUpdateCycle()
  }

  // No fetch and no clone: ls-remote asks the remote for one sha and downloads
  // nothing, so eleven checkouts resolve in about a second. The manifest is
  // read only for the ones actually behind, pinned to the exact remote commit.
  readonly property string updateScript: ""
    + "set -u; export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true; "
    + "tmpdir=; temp_root=; owner_prefix=; output_revoked=0; worker_sessions=(); "
    // Every worker is a session leader, so its trusted PID is also the exact
    // boundary containing git, timeout, curl, and any network descendants.
    // No caller or unrelated process can share that newly created session.
    + "terminate_workers() { output_revoked=1; "
    + "  for sid in \"${worker_sessions[@]}\"; do /usr/bin/pkill -TERM -s \"$sid\" 2>/dev/null || :; done; "
    + "  for sid in \"${worker_sessions[@]}\"; do /usr/bin/pkill -KILL -s \"$sid\" 2>/dev/null || :; done; "
    + "  for pid in \"${worker_sessions[@]}\"; do wait \"$pid\" 2>/dev/null || :; done; "
    + "  worker_sessions=(); }; "
    + "cleanup() { status=$?; trap - EXIT HUP INT TERM; "
    + "  if [ \"${#worker_sessions[@]}\" -gt 0 ]; then terminate_workers; fi; "
    + "  if [ -n \"$tmpdir\" ] && [ -n \"$temp_root\" ] && [ -n \"$owner_prefix\" ] "
    + "     && [ \"$temp_root\" != / ] && [ \"$tmpdir\" != \"$temp_root\" ]; then "
    + "    case \"$tmpdir\" in \"$temp_root\"/\"$owner_prefix\".*) rm -rf -- \"$tmpdir\" ;; esac; "
    + "  fi; exit \"$status\"; }; "
    + "signal_exit() { status=\"$1\"; trap - HUP INT TERM; terminate_workers; exit \"$status\"; }; "
    + "arm_signal_traps() { trap 'signal_exit 129' HUP; trap 'signal_exit 130' INT; trap 'signal_exit 143' TERM; }; "
    // Bash delivers traps between commands. During the two-command spawn/PID
    // append boundary, defer the exit until the new trusted session is stored.
    + "launch_worker() { pending_signal=0; "
    + "  trap 'pending_signal=129' HUP; trap 'pending_signal=130' INT; trap 'pending_signal=143' TERM; "
    + "  /usr/bin/setsid /usr/bin/bash -c 'set -u; update_worker \"$1\" \"$2\"' worker \"$1\" \"$2\" & "
    + "  worker_sessions+=(\"$!\"); arm_signal_traps; "
    + "  if [ \"$pending_signal\" -ne 0 ]; then signal_exit \"$pending_signal\"; fi; }; "
    + "trap 'cleanup' EXIT; arm_signal_traps; "
    + "umask 077; owner_token=; IFS= read -r owner_token < /proc/sys/kernel/random/uuid 2>/dev/null || owner_token=; "
    + "case \"$owner_token\" in ''|*[!0-9a-f-]*) owner_token=\"${RANDOM}${RANDOM}${RANDOM}${RANDOM}\" ;; esac; "
    + "owner_prefix=\"omarchy-plugin-manager-updates.$$.$owner_token\"; "
    + "make_tmpdir() { temp_root=\"$1\"; attempt=0; "
    + "  while [ \"$attempt\" -lt 8 ]; do tmpdir=\"$temp_root/$owner_prefix.$attempt\"; "
    + "    if mkdir -m 700 -- \"$tmpdir\" 2>/dev/null; then return 0; fi; "
    + "    tmpdir=; attempt=$((attempt + 1)); "
    + "  done; temp_root=; return 1; }; "
    + "xdg_root=\"${XDG_RUNTIME_DIR:-}\"; xdg_mode=; "
    + "if [ -n \"$xdg_root\" ]; then xdg_mode=$(stat -c %a -- \"$xdg_root\" 2>/dev/null); fi; "
    + "if [ -n \"$xdg_root\" ] && [ \"${xdg_root#/}\" != \"$xdg_root\" ] && [ \"$xdg_root\" != / ] "
    + "   && [ -d \"$xdg_root\" ] && [ -w \"$xdg_root\" ] && [ -x \"$xdg_root\" ] "
    + "   && [ -O \"$xdg_root\" ] && [ ! -L \"$xdg_root\" ] && [ \"$xdg_mode\" = 700 ] "
    + "   && make_tmpdir \"$xdg_root\"; then :; "
    + "elif [ -d /tmp ] && [ -w /tmp ] && [ -x /tmp ] && make_tmpdir /tmp; then :; "
    + "else exit 1; fi; "
    + "update_worker() { path=\"$1\"; outfile=\"$2\"; "
    + "  branch=$(git -C \"$path\" rev-parse --abbrev-ref HEAD 2>/dev/null); "
    + "  local_sha=$(git -C \"$path\" rev-parse HEAD 2>/dev/null); "
    // A pinned update leaves the checkout detached, and a branch named HEAD
    // exists on no remote; compare a detached checkout against the remote's
    // default branch instead, which is what the marketplace verifies.
    + "  if [ \"$branch\" = HEAD ]; then ref=HEAD; else ref=\"refs/heads/$branch\"; fi; "
    + "  remote_sha=$(timeout 12 git -C \"$path\" ls-remote origin \"$ref\" 2>/dev/null | head -n 1 | cut -f1); "
    + "  local_version=$(jq -r '.version // \"\"' \"$path/manifest.json\" 2>/dev/null); "
    + "  remote_version=\"\"; "
    + "  if [ -n \"$remote_sha\" ] && [ \"$remote_sha\" != \"$local_sha\" ]; then "
    + "    origin=$(git -C \"$path\" remote get-url origin 2>/dev/null); "
    + "    case \"$origin\" in https://github.com/*) "
    + "      slug=${origin#https://github.com/}; slug=${slug%.git}; "
    + "      remote_version=$(curl -fsSL --max-time 8 \"https://raw.githubusercontent.com/$slug/$remote_sha/manifest.json\" 2>/dev/null | jq -r '.version // \"\"' 2>/dev/null); "
    + "    ;; esac; "
    + "  fi; "
    + "  jq -cn --arg path \"$path\" --arg localSha \"$local_sha\" --arg remoteSha \"$remote_sha\" "
    + "    --arg localVersion \"$local_version\" --arg remoteVersion \"$remote_version\" "
    + "    '{path: $path, localSha: $localSha, remoteSha: $remoteSha, localVersion: $localVersion, remoteVersion: $remoteVersion}' "
    + "    > \"$outfile.tmp\" && mv -- \"$outfile.tmp\" \"$outfile.json\"; "
    + "}; export -f update_worker; "
    + "index=0; "
    + "for dir in \"$HOME\"/.config/omarchy/plugins/*/; do "
    + "  [ -d \"$dir/.git\" ] || continue; "
    // A numeric producer-owned filename keeps untrusted paths out of the
    // filesystem protocol. Workers publish by atomic rename only after jq has
    // completed one record; the parent emits those records after every remote
    // check has finished, so even versions far above pipe atomicity cannot
    // interleave.
    + "  outfile=\"$tmpdir/$index\"; index=$((index + 1)); "
    + "  launch_worker \"${dir%/}\" \"$outfile\"; "
    + "done; "
    + "while [ \"${#worker_sessions[@]}\" -gt 0 ]; do "
    + "  pid=\"${worker_sessions[0]}\"; wait \"$pid\" || :; worker_sessions=(\"${worker_sessions[@]:1}\"); "
    + "done; [ \"$output_revoked\" -eq 0 ] || exit 1; "
    + "payload=; i=0; while [ \"$i\" -lt \"$index\" ]; do "
    + "  file=\"$tmpdir/$i.json\"; if [ -s \"$file\" ]; then "
    + "    record=$(cat -- \"$file\"); payload+=\"$record\"$'\\n'; "
    + "  fi; i=$((i + 1)); "
    + "done; [ \"$output_revoked\" -eq 0 ] || exit 1; "
    // Once committed, publish through one shell builtin. Bash defers traps
    // until the builtin returns, so cancellation observes either no batch or
    // the complete batch, never an interruptible sequence of external cats.
    + "trap '' HUP INT TERM; printf '%s' \"$payload\""

  Process {
    id: updateProc
    command: ["bash", "-c", root.updateScript]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.applyUpdateReport(text)
        root.updateOutputFinished = true
        root.drainFreshUpdateCycle()
      }
    }
    onExited: function(exitCode) {
      root.checkingUpdates = false
      root.updateProcessExited = true
      root.drainFreshUpdateCycle()
    }
    onRunningChanged: if (!running) root.drainFreshUpdateCycle()
  }

  Process {
    id: catalogProc
    clearEnvironment: true
    stdout: StdioCollector {
      id: catalogOutput
      waitForEnd: true
      onStreamFinished: {
        root.catalogOutputFinished = true
        root.finishCatalogFetch()
      }
    }
    // The helper emits one reason_text error (at most 200 ASCII bytes).
    stderr: StdioCollector {
      id: catalogErrors
      waitForEnd: true
      onStreamFinished: {
        root.catalogErrorFinished = true
        root.finishCatalogFetch()
      }
    }
    onExited: function(exitCode) {
      root.catalogExitCode = exitCode
      root.finishCatalogFetch()
    }
  }

  // The Python worker is independent of this observer's lifecycle. Destruction
  // may kill the observer; the bounded worker keeps its journal and finalizes.
  Process {
    id: pinnedProc
    clearEnvironment: true
    stdout: SplitParser {
      splitMarker: ""
      onRead: function(chunk) {
        // Bulk results carry every item; single updates keep the small cap.
        var cap = root.busyKind === "bulk-update" ? 65536 : 4096
        if (root.pinnedOutput.length + chunk.length > cap) {
          root.pinnedOverflow = true
          root.pinnedOutput = ""
        } else if (!root.pinnedOverflow) root.pinnedOutput += chunk
      }
    }
    stderr: SplitParser { splitMarker: ""; onRead: function(chunk) {} }
    onExited: function(exitCode) {
      root.pinnedExited = true
      // Drain final raw chunks before interpreting the one bounded result.
      Qt.callLater(root.finishPinnedUpdate)
    }
  }

  Process {
    id: summaryProc
    clearEnvironment: true
    stdout: SplitParser {
      splitMarker: ""
      onRead: function(chunk) {
        if (root.summaryOutput.length + chunk.length > 65536) {
          root.summaryOverflow = true
          root.summaryOutput = ""
        } else if (!root.summaryOverflow) root.summaryOutput += chunk
      }
    }
    stderr: SplitParser { splitMarker: ""; onRead: function(chunk) {} }
    onExited: function(exitCode) {
      // Drain final raw chunks before interpreting the one bounded result.
      Qt.callLater(root.finishBulkSummary)
    }
  }

  Process {
    id: actionProc
    stdout: StdioCollector { waitForEnd: true }

    // Exit and stream-finished have no guaranteed order. When a failed exit
    // beats the collector it publishes the exit-code message; the specific
    // one replaces it once stderr lands.
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.actionStderr = String(text || "").trim()
        if (root.statusIsError && root.actionStderr !== "")
          root.setStatus(Model.failureMessage(root.lastActionKind, root.actionStderr, root.lastExitCode), true)
      }
    }

    onExited: function(exitCode) {
      var kind = root.busyKind
      var label = root.busyId

      root.lastActionKind = kind
      root.lastExitCode = exitCode
      root.busyKind = ""
      root.busyId = ""
      root.busyRowId = ""

      if (exitCode === 0) {
        root.setStatus(Model.successMessage(kind, label), false)
      } else {
        root.setStatus(Model.failureMessage(kind, root.actionStderr, exitCode), true)
      }

      root.reload()
      root.refreshUpdateData()
      root.actionFinished(kind, label, exitCode)
    }
  }

}
