import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The plugin manager's popup: every plugin the shell discovered, split into
// what you installed and what ships with Omarchy, with the three lifecycle
// actions the CLI already exposes — add a repo, update a checkout, remove an
// install.
//
// The split is not cosmetic. Built-ins live in /usr/share and can be neither
// pulled nor deleted, so mixing them into one list means half the rows carry
// controls that do nothing. Two sections make the available actions constant
// within each one.
//
// The list is read from `omarchy plugin list` rather than from shell.json, so it shows what the shell actually found, not
// what the config claims. Actions shell out to the same `omarchy plugin`
// commands a terminal would run; nothing here touches the plugin directory
// itself. Every command runs as an argv array, never through a shell, so a
// repository url can never become a command.
//
// Update, remove, enable and disable all confirm first: removing deletes a
// directory and updating runs new code inside the shell process — neither is
// a thing to do on a mis-click. Nothing here installs new plugins.
//
// BarWidget.qml owns the bar icon and hands this panel the button to anchor
// against.
Panel {
  id: root
  moduleName: "io.github.juancasanueva.plugin-manager"
  ipcTarget: "io.github.juancasanueva.plugin-manager"
  manageIpc: false

  property var anchorItem: null

  // The bar tracks the widget mounted in its slot — BarWidget.qml — not this
  // nested panel, so everything the bar identifies a panel by has to be that
  // widget.
  property var hostWidget: null
  property var popupMoveOwner: null
  readonly property var barIdentity: hostWidget || root

  // Guarded so the panel renders before the bar is injected (the bar-widget
  // contract instantiates it bare).
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  // Secondary copy follows the panel's own text role instead of the palette's
  // much darker generic muted swatch. At 54% over the current popup surface it
  // remains subordinate to descriptions while staying well above that swatch.
  readonly property color secondaryForeground: Util.alpha(contentForeground, 0.54)

  // ---- Data ---------------------------------------------------------------
  //
  // Everything the panel knows about plugins — rows and the commands that
  // change them — lives in the store. The aliases let this surface keep
  // reading `root.rows` and friends; only what it binds to or writes is
  // aliased.

  PluginStore {
    id: store
    externalBusy: !!root.popupMoveOwner && root.popupMoveOwner.busy
    selfId: root.moduleName
    // The sanctioned way to write this plugin's shell.json entry (settings).
    // The trusted built-in bar hands each third-party widget a PluginBarApi
    // whose `shell` is a scoped shell facade
    // (Bar.pluginBarApiFor -> shell.pluginShellForId -> pluginShellFor), and
    // its updateEntryInline accepts this plugin's own id. `bar` arrives after
    // construction through injectPanel, so this stays a binding.
    shell: root.bar ? root.bar.shell : null
  }

  Connections {
    target: store
    // Any load — including one the store starts on its own after an update —
    // retires a release probe, exactly as an explicit refresh does.
    function onReloadStarted() { root.revokeReleaseNavigation() }
    function onRowsLoaded() {
      root.clampSelection()
      if (root.placementRefreshStarted) root.placementRowsReady = true
    }
  }

  property alias rows: store.rows
  property alias loading: store.loading
  property alias loadError: store.loadError
  property int selectedIndex: -1
  property string groupFilter: "all"
  readonly property var groupOptions: Model.groupOptions()
  property string kindFilter: "all"
  readonly property var kindOptions: Model.kindOptions(rows)
  property string statusFilter: "all"
  readonly property var statusOptions: Model.statusOptions()
  // What the lists filter on. It follows the search box after a short pause
  // rather than on every keystroke: each change rebuilds every visible row or
  // card, and a word typed at speed would rebuild them once per letter.
  // Clearing applies at once, so Escape and the clear button feel immediate.
  property string searchQuery: ""
  // What the search box shows, owned here rather than by the box. The box only
  // exists while the popup is open (see searchFieldLoader), so the term has to
  // outlive it: closing keeps it, and the next open shows it again.
  property string searchText: ""
  // The box itself is null while the popup is closed, so a focus question has
  // to be one that answers false then rather than one that throws.
  readonly property bool searchFieldFocused: searchFieldLoader.item !== null && searchFieldLoader.item.activeFocus

  onSearchTextChanged: {
    if (searchText === "") flushSearch()
    else searchDebounce.restart()
  }

  Timer {
    id: searchDebounce
    interval: 150
    repeat: false
    onTriggered: root.searchQuery = root.searchText
  }

  function flushSearch() {
    searchDebounce.stop()
    searchQuery = searchText
  }

  // A reload can remove the last plugin of a kind. Falling back immediately
  // keeps the filter visible and truthful instead of retaining a hidden value.
  onKindOptionsChanged: {
    for (var i = 0; i < kindOptions.length; i++)
      if (kindOptions[i].value === kindFilter) return
    setKindFilter("all")
  }
  // Dropdown selection assigns its own value, which breaks the binding, so
  // every filter a key can cycle replays later changes into its dropdown.
  onKindFilterChanged: if (kindDropdown && kindDropdown.value !== kindFilter)
    kindDropdown.value = kindFilter
  onGroupFilterChanged: if (groupDropdown && groupDropdown.value !== groupFilter)
    groupDropdown.value = groupFilter
  onStatusFilterChanged: if (statusDropdown && statusDropdown.value !== statusFilter)
    statusDropdown.value = statusFilter

  // One flat filtered list drives selection; the two section slices below are
  // views onto it, in the same order, so a single index addresses both.
  readonly property var visibleRows: Model.filterRows(rows, kindFilter, statusFilter, searchQuery, groupFilter)
  readonly property var installedRows: Model.rowsInGroup(visibleRows, "installed")
  readonly property var builtinRows: Model.rowsInGroup(visibleRows, "built-in")

  property alias checkingUpdates: store.checkingUpdates
  // What the header's refresh button is waiting on: the re-read, which
  // includes its update check.
  readonly property bool refreshing: loading || checkingUpdates
  readonly property alias behindCount: store.behindCount
  readonly property alias bulkUpdatableCount: store.bulkUpdatableCount
  readonly property alias updateActionsEnabled: store.updateActionsEnabled

  // One click-time release probe for the whole panel. Every explicit
  // navigation or action advances this generation state, so callbacks from an
  // older process can settle it but never recover superseded URLs.
  ReleaseNavigator { id: releaseNavigator }
  readonly property alias releaseProbeBusy: releaseNavigator.busy

  readonly property alias installedTotal: store.installedTotal
  readonly property bool filtered: Model.isFiltering(kindFilter, statusFilter, searchQuery, groupFilter)
  readonly property var installedFilterHints: Model.installedFilterHints(
    { group: groupFilter, kind: kindFilter, status: statusFilter },
    { group: groupOptions, kind: kindOptions, status: statusOptions })

  // The verified set the Installed rows are stamped against; the store reads
  // it from the disk cache when the panel opens.
  readonly property alias verifiedIds: store.verifiedIds

  // The settings and arrange panes are overlays over the list.
  property bool settingsOpen: false
  property bool arrangeOpen: false
  readonly property var barSnapshot: popupMoveOwner ? popupMoveOwner.snapshot : null
  readonly property bool barMovePending: !!popupMoveOwner && popupMoveOwner.pending
  readonly property bool arrangeBusy: !popupMoveOwner || popupMoveOwner.busy || barMovePending
    || busy || store.actionRunning || !opened || !arrangeOpen

  property bool placementRefreshStarted: false
  property bool placementRowsReady: false
  property string placementNotice: ""

  // Called only by the retained, bounded continuation. Inventory arrives on
  // this live panel; the bridge never holds a callback into the destroyed one.
  function openPlacementView(origin, finalAttempt) {
    if (!bar || !anchorItem || confirming || placing) return false
    if (!opened) open()
    if (!opened) return false
    if (!placementRefreshStarted) {
      placementRowsReady = false
      // An older read may still be exiting. Only our accepted refresh can
      // authorize restoring a selection; the final attempt falls back safely.
      if (!store.reload() && !finalAttempt) return false
      placementRefreshStarted = true
    }
    if (!placementRowsReady && !finalAttempt && (loading || loadError === "")) return false
    settingsOpen = false
    arrangeOpen = false
    groupFilter = origin.group
    var kindAvailable = kindOptions.some(function(option) { return option.value === origin.kind })
    kindFilter = kindAvailable ? origin.kind : "all"
    statusFilter = origin.status
    searchText = origin.query
    flushSearch()
    selectedIndex = -1
    if (placementRowsReady) {
      for (var i = 0; i < visibleRows.length; i++) {
        if (visibleRows[i].id === origin.selectedId) { selectedIndex = i; break }
      }
    }
    listColumn.forceLayout()
    listScroll.contentY = Math.min(origin.scroll, Math.max(0, listScroll.contentHeight - listScroll.height))
    var note = !placementRowsReady ? " Inventory could not refresh; refresh the list before choosing another plugin."
      : selectedIndex < 0 && origin.selectedId !== "" ? " The selected plugin is no longer in the visible list." : ""
    if (!kindAvailable) note += " The previous kind filter is no longer available."
    placementNotice = note
    setStatus((popupMoveOwner ? popupMoveOwner.status : "Move outcome unavailable.") + note,
      !placementRowsReady || !popupMoveOwner || popupMoveOwner.statusIsError, "layout")
    placementRefreshStarted = false
    returnFocusToList()
    return true
  }

  function openArrange() {
    if (!bar || !anchorItem || confirming || placing) return false
    placementRefreshStarted = false
    if (!opened) open()
    if (!opened) return false
    revokeReleaseNavigation()
    settingsOpen = false
    arrangeOpen = true
    barBoard.cancelDrag()
    settingsPane.forceActiveFocus()
    if (!settingsPane.visible) return false
    if (hostWidget) hostWidget.cancelPopupArrange()
    return true
  }

  // Explicit choices revoke reopening; automatic close/destruction must not.
  function closeArrange() {
    placementRefreshStarted = false
    arrangeOpen = false
    barBoard.cancelDrag()
    if (hostWidget) hostWidget.cancelPopupArrange()
  }

  function requestBarMove(snapshot, fromSection, fromIndex, section, gap) {
    if (!opened || !arrangeOpen || busy || store.actionRunning || !popupMoveOwner
        || popupMoveOwner.busy || popupMoveOwner.pending || !hostWidget) return false
    return hostWidget.requestPopupMove(snapshot, fromSection, fromIndex, section, gap)
  }

  function useCurrentLayout() {
    if (!opened || !arrangeOpen || !popupMoveOwner || !popupMoveOwner.pending
        || !popupMoveOwner.exited || !popupMoveOwner.snapshot) return false
    return popupMoveOwner.recover()
  }

  function handleArrangeKey(event) {
    if (!arrangeOpen || (event.key !== Qt.Key_Escape && event.key !== Qt.Key_Backspace)) return false
    if (event.key === Qt.Key_Escape && barBoard.heldSnapshot !== null) barBoard.cancelDrag()
    else closeArrange()
    return true
  }

  function openSettings() {
    closeArrange()
    if (settingsOpen) return
    revokeReleaseNavigation()
    settingsOpen = true
    store.refreshUpdateData()
  }

  function closeSettings() {
    if (!settingsOpen) return
    revokeReleaseNavigation()
    settingsOpen = false
  }

  // A click on the bar toggles the popup.
  function openFromBar() {
    if (opened) close()
    else open()
  }

  // Any narrowing rebuilds the list under the selection, so the index is
  // dropped rather than left pointing at whatever now sits in that slot —
  // that is how a Delete keypress lands on the wrong plugin.
  onSearchQueryChanged: resetSelection()

  readonly property var selectedRow: selectedIndex >= 0 && selectedIndex < visibleRows.length
    ? visibleRows[selectedIndex]
    : null

  readonly property int selectableCount: visibleRows.length

  // ---- In-flight action ---------------------------------------------------

  property alias busyKind: store.busyKind
  property alias busyRowId: store.busyRowId
  property alias busyId: store.busyId
  readonly property alias busy: store.busy
  property alias status: store.status
  property alias statusIsError: store.statusIsError
  property alias statusSource: store.statusSource

  // ---- Pending confirmation -----------------------------------------------
  //
  // The questions live in the store, shared with the store; this
  // popup only owns the dialogs that put them on screen.

  property alias pendingKind: store.pendingKind
  property alias pendingId: store.pendingId
  property alias pendingLabel: store.pendingLabel
  property alias pendingUrl: store.pendingUrl
  property alias pendingVerifiedCommit: store.pendingVerifiedCommit
  property alias pendingPlacementNeeded: store.pendingPlacementNeeded
  property alias pendingPlacement: store.pendingPlacement
  readonly property alias confirming: store.confirming
  readonly property alias placing: store.placing
  readonly property alias placementChoices: store.placementChoices
  readonly property alias placementMessage: store.placementMessage
  readonly property alias confirmMessage: store.confirmMessage

  // ---- Loading ------------------------------------------------------------
  //
  // Thin wrappers over the store: the keyboard handler and the buttons keep
  // calling the panel, and release navigation — a panel concern the store
  // knows nothing about — is revoked where it always was.

  function reload() {
    revokeReleaseNavigation()
    return store.reload()
  }

  function checkUpdates() {
    return store.checkUpdates()
  }

  // Release navigation lives in ReleaseNavigator; these keep the names the
  // rest of this file and its tests know.
  function requestGithubNavigation(candidates, fallbackUrl) {
    releaseNavigator.request(candidates, fallbackUrl)
  }

  function navigateExternalUrl(url) {
    releaseNavigator.navigate(url)
  }

  function revokeReleaseNavigation() {
    releaseNavigator.revoke()
  }

  // ---- Filtering ----------------------------------------------------------

  function setGroupFilter(group) {
    if (groupFilter === group) return
    groupFilter = group
    resetSelection()
  }

  function setKindFilter(kind) {
    if (kindFilter === kind) return
    kindFilter = kind
    resetSelection()
  }

  function setStatusFilter(status) {
    if (statusFilter === status) return
    statusFilter = status
    resetSelection()
  }

  function resetSelection() {
    selectedIndex = -1
    listScroll.contentY = 0
  }

  function clearSearch() {
    closeArrange()
    searchText = ""
  }

  function cycleGroupFilter() {
    closeArrange()
    setGroupFilter(Model.nextOption(groupOptions, groupFilter))
  }

  function cycleKindFilter() {
    closeArrange()
    setKindFilter(Model.nextOption(kindOptions, kindFilter))
  }

  function cycleStatusFilter() {
    closeArrange()
    setStatusFilter(Model.nextOption(statusOptions, statusFilter))
  }

  function clampSelection() {
    if (selectedIndex >= visibleRows.length) selectedIndex = visibleRows.length - 1
  }

  // ---- Actions ------------------------------------------------------------

  function setStatus(text, isError, source) {
    store.setStatus(text, isError, source)
  }

  // The asks belong to the store; the popup only retires its link probe when
  // a request was actually taken.
  function askRemove(row) {
    if (!store.askRemove(row)) return
    revokeReleaseNavigation()
  }

  function askEnable(row) {
    if (!store.askEnable(row)) return
    revokeReleaseNavigation()
  }

  function askDisable(row) {
    if (!store.askDisable(row)) return
    revokeReleaseNavigation()
  }

  function confirmPlacement(section) {
    if (pendingKind !== "move" || pendingPlacementNeeded) {
      store.confirmPlacement(section)
      return
    }
    if (!opened || busy || store.actionRunning || !popupMoveOwner
        || popupMoveOwner.busy || popupMoveOwner.pending || !hostWidget) {
      setStatus("Placement is not ready or another action is unresolved; no move was sent.", true, "layout")
      return
    }
    var row = Model.findRow(rows, pendingId)
    var raw = bar && bar.shell && bar.shell.barConfig ? bar.shell.barConfig.layout : null
    var plan = Model.barSectionMovePlan(row, raw, section)
    if (!plan) {
      setStatus("Placement changed or is unavailable; cancel and refresh before choosing again.", true, "layout")
      return
    }
    var origin = { tab: "installed", selectedId: selectedRow ? selectedRow.id : pendingId,
      query: searchText, group: groupFilter, kind: kindFilter, status: statusFilter,
      scroll: Math.max(0, listScroll.contentY) }
    if (!hostWidget.requestPopupMove(plan.snapshot, plan.fromSection, plan.fromIndex, plan.section, plan.gap, origin)) {
      setStatus("Placement was refused; no move was sent. Cancel and refresh before choosing again.", true, "layout")
      return
    }
    placementNotice = ""
    store.cancelPending()
    revokeReleaseNavigation()
  }

  function cancelPending() {
    store.cancelPending()
  }

  function confirmPending() {
    store.confirmPending()
  }

  // The store owns the gate; asking it first keeps a click on a disabled
  // button from retiring a release probe it never had a right to.
  function startUpdate(row) {
    if (!store.canStartUpdate(row)) return
    revokeReleaseNavigation()
    store.startUpdate(row)
  }

  function askBulkUpdate() {
    if (!store.askBulkUpdate()) return
    revokeReleaseNavigation()
  }

  // ---- Keyboard -----------------------------------------------------------

  // The list has one column, so only the vertical step moves the selection.
  function moveSelection(dx, dy) {
    closeArrange()
    if (selectableCount === 0) return
    var step = dy
    if (step === 0) return

    var next = selectedIndex < 0 ? 0 : selectedIndex + step
    selectedIndex = Math.max(0, Math.min(selectableCount - 1, next))
  }

  // Called by whichever row just became selected. Asking the item where it
  // ended up beats computing its offset from row heights and header heights,
  // which silently goes wrong the moment either changes.
  function ensureVisible(item) {
    if (!item) return
    var top = item.mapToItem(listColumn, 0, 0).y
    var bottom = top + item.height
    if (top < listScroll.contentY) listScroll.contentY = top
    else if (bottom > listScroll.contentY + listScroll.height) listScroll.contentY = bottom - listScroll.height
  }

  function focusSearchField() {
    var field = searchFieldLoader.item
    if (!field) return
    field.forceActiveFocus()
    field.selectAll()
  }

  function returnFocusToList() {
    Qt.callLater(function() {
      if (root.opened
          && !root.confirming && !root.placing
          && !root.settingsOpen && !root.arrangeOpen
          && keyCatcher) keyCatcher.forceActiveFocus()
    })
  }

  property bool titleIconIntroArmed: false

  onOpenedChanged: {
    if (!opened) { placementRefreshStarted = false; settingsOpen = false; arrangeOpen = false; barBoard.cancelDrag(); revokeReleaseNavigation(); return }
    titleIconIntro.stop()
    titleIcon.opacity = 0
    titleIconIntroArmed = true
    setStatus("", false)
    revokeReleaseNavigation()
    store.loadOnOpen()
  }


  // ---- Surface ------------------------------------------------------------

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: root.arrangeOpen ? settingsPane : keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(620))

    // Fill the available height while preserving the host's bar gap and screen margins.
    contentHeight: panel.cappedContentHeight(panel.availableCardHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.confirming || root.placing || root.settingsOpen || root.arrangeOpen
        || root.searchFieldFocused
        || groupDropdown.popupOpen || kindDropdown.popupOpen || statusDropdown.popupOpen

      onMoveRequested: function(dx, dy) { root.moveSelection(dx, dy) }
      onActivateRequested: root.startUpdate(root.selectedRow)
      onDeleteRequested: root.askRemove(root.selectedRow)
      onCloseRequested: { root.closeArrange(); root.revokeReleaseNavigation(); root.close() }
      onTabRequested: function(direction) { root.closeArrange(); root.revokeReleaseNavigation(); root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "/") root.focusSearchField()
        else if (t === "r" || t === "R") { root.reload(); root.checkUpdates() }
        else if (t === "f" || t === "F") root.cycleKindFilter()
        else if (t === "s" || t === "S") root.cycleGroupFilter()
        else if (t === "t" || t === "T") root.cycleStatusFilter()
        else if (t === "u" || t === "U") root.askBulkUpdate()
        else if (t === "j") root.moveSelection(0, 1)
        else if (t === "k") root.moveSelection(0, -1)
      }

      // ---- Fixed chrome, pinned to the top.
      Column {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(10)

        // What this is, how much of it there is, and a way to re-read without
        // closing the panel.
        Item {
          width: parent.width
          height: Math.max(title.implicitHeight, refreshButton.height)

          Text {
            id: titleIcon
            // Same puzzle-piece glyph as the plugin manager's bar button.
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.baseline: title.baseline
            text: "󰐱"
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: title.font.pixelSize
            transformOrigin: Item.Center

            // A puzzle piece should arrive like one: oversized and tilted, it
            // travels into its slot and lands with a small "click" — a dip, a
            // bounce and a wiggle. Anchors are untouched by scale and rotation,
            // so the title beside it never moves.
            //
            // The travel is a smooth in-out rather than a back easing: a back
            // easing does nearly all its motion in the first quarter and spends
            // the rest on an invisible overshoot, which is how a one-second
            // animation came to look like a 200ms flash.
            SequentialAnimation {
              id: titleIconIntro

              PauseAnimation { duration: 120 }

              ParallelAnimation {
                NumberAnimation {
                  target: titleIcon
                  property: "scale"
                  from: 3
                  to: 1
                  duration: 700
                  easing.type: Easing.InOutCubic
                }
                NumberAnimation {
                  target: titleIcon
                  property: "rotation"
                  from: -150
                  to: 0
                  duration: 700
                  easing.type: Easing.InOutCubic
                }
                NumberAnimation {
                  target: titleIcon
                  property: "opacity"
                  from: 0
                  to: 1
                  duration: 250
                }
              }

              // The click: the piece compresses into the slot, springs back a
              // touch past size, and settles; a wiggle rides along with it.
              ParallelAnimation {
                id: titleIconSettle
                SequentialAnimation {
                  NumberAnimation { target: titleIcon; property: "scale"; to: 0.88; duration: 90; easing.type: Easing.OutQuad }
                  NumberAnimation { target: titleIcon; property: "scale"; to: 1.08; duration: 110; easing.type: Easing.InOutQuad }
                  NumberAnimation { target: titleIcon; property: "scale"; to: 1; duration: 120; easing.type: Easing.OutQuad }
                }
                SequentialAnimation {
                  NumberAnimation { target: titleIcon; property: "rotation"; to: 8; duration: 110; easing.type: Easing.InOutQuad }
                  NumberAnimation { target: titleIcon; property: "rotation"; to: -5; duration: 110; easing.type: Easing.InOutQuad }
                  NumberAnimation { target: titleIcon; property: "rotation"; to: 0; duration: 100; easing.type: Easing.OutQuad }
                }
              }
            }

            // The intro is clocked from the window's first rendered frame, not
            // from `opened`: the first frame is drawn noticeably later, and an
            // animation started at `opened` could finish before that frame
            // ever reached the screen. The piece is
            // hidden at open so that first frame shows an empty slot.
            Connections {
              id: titleIconIntroTrigger
              target: titleIcon.Window.window
              enabled: root.titleIconIntroArmed
              function onFrameSwapped() {
                root.titleIconIntroArmed = false
                titleIconIntro.restart()
              }
            }
          }

          Text {
            id: title
            // Never rich text: AutoText would fetch what a crafted string points at.
            textFormat: Text.PlainText
            anchors.left: titleIcon.right
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: "Plugins"
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.display
            font.bold: true
          }


          PanelActionButton {
            id: arrangeButton
            anchors.right: settingsButton.left
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            iconText: "󰕮"
            fontSize: Style.font.display
            tooltipText: "Arrange"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            enabled: !root.busy
            opacity: enabled ? 1 : 0.4
            onClicked: root.arrangeOpen ? root.closeArrange() : root.openArrange()
          }

          // The gear opens the settings pane and back.
          PanelActionButton {
            id: settingsButton
            anchors.right: updateAllButton.left
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            iconText: "󰒓"
            fontSize: Style.font.display
            tooltipText: root.settingsOpen ? "Back to the list" : "Settings"
            foreground: root.settingsOpen ? Color.accent : root.contentForeground
            fontFamily: root.contentFontFamily
            enabled: !root.busy
            opacity: enabled ? 1 : 0.4
            onClicked: root.settingsOpen ? root.closeSettings() : root.openSettings()
          }

          PanelActionButton {
            id: updateAllButton
            anchors.right: refreshButton.left
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            iconText: "󰑐"
            fontSize: Style.font.display
            tooltipText: "Update all"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            enabled: root.updateActionsEnabled
            opacity: root.bulkUpdatableCount > 0 && enabled ? 1 : 0.4
            onClicked: root.askBulkUpdate()
          }

          PanelActionButton {
            id: refreshButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            // The button's own glyph steps aside while a refresh runs and the
            // spinner below takes its place: a turning arrow says "working"
            // where a greyed one only said "not now".
            iconText: root.refreshing ? "" : "󰉹"
            // The one icon in the header, next to two text buttons: at the
            // default size it read as an afterthought beside them. Display
            // size puts it on the same scale as the title at the other end.
            fontSize: Style.font.display
            tooltipText: "Refresh plugin list"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            enabled: !root.loading && !root.busy
            // Dimmed only while an action owns the panel; a refresh in flight
            // is shown by the spin, not by fading.
            opacity: root.busy ? 0.4 : 1
            // Forced past the cache: the refresh button exists precisely for
            // when you believe what is on screen is out of date.
            onClicked: {
              root.reload()
              root.checkUpdates()
            }

            Text {
              textFormat: Text.PlainText
              anchors.right: parent.right
              anchors.bottom: parent.bottom
              anchors.rightMargin: Style.space(2)
              anchors.bottomMargin: Style.space(2)
              visible: !root.refreshing
              text: "󰑐"
              color: refreshButton.foreground
              font.family: refreshButton.fontFamily
              font.pixelSize: Math.round(refreshButton.fontSize * 0.55)
            }

            Text {
              id: refreshSpinner
              // Never rich text: AutoText would fetch what a crafted string points at.
              textFormat: Text.PlainText
              anchors.centerIn: parent
              visible: root.refreshing
              text: "󰑓"
              color: refreshButton.foreground
              font.family: refreshButton.fontFamily
              font.pixelSize: refreshButton.fontSize

              RotationAnimation on rotation {
                running: root.refreshing
                from: 0
                to: 360
                direction: RotationAnimation.Clockwise
                duration: 900
                loops: Animation.Infinite
              }
            }
          }
        }

        Item {
          x: title.x
          width: parent.width - x
          height: subtitle.implicitHeight

          Text {
            id: subtitle
            // Never rich text: AutoText would fetch what a crafted string points at.
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            visible: text !== ""
            elide: Text.ElideRight
            text: {
              if (root.loading && root.rows.length === 0) return "reading…"
              if (root.filtered) return "showing " + root.visibleRows.length + " of " + root.rows.length
              // Tight separators keep the line short even on its own row.
              var summary = root.installedTotal + " installed · " + root.rows.length + " total"
              if (root.behindCount > 0) return summary + " · " + root.behindCount + " to update"
              return summary
            }
            color: root.secondaryForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

        }

        PanelSeparator { foreground: root.contentForeground }

        // ---- A labelled filter row above Search: the caption names the
        //      control and the dropdown shows its value, so several
        //      independent controls stay readable at a glance.
        Item {
          id: filterControls

          readonly property real controlHeight: kindDropdown.implicitHeight
          readonly property real filterRowHeight: filterLabelMetrics.height
            + Style.space(4) + controlHeight

          FontMetrics {
            id: filterLabelMetrics
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          width: parent.width
          height: filterRowHeight + Style.space(8) + controlHeight

          Item {
            id: installedFilters
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            height: filterControls.filterRowHeight

            readonly property real gap: Style.space(6)
            readonly property real optionWidth: Math.floor((width - gap * 2) / 3)

            Item {
              id: groupFilterControl
              anchors.left: parent.left
              width: installedFilters.optionWidth
              height: parent.height

              Text {
                textFormat: Text.PlainText
                anchors.left: parent.left
                anchors.top: parent.top
                text: "Source"
                color: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Dropdown {
                id: groupDropdown
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: filterControls.controlHeight
                showLabel: false
                options: root.groupOptions
                value: root.groupFilter
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onChanged: function(value) { root.closeArrange(); root.setGroupFilter(value) }
              }
            }

            Item {
              id: kindFilterControl
              anchors.left: groupFilterControl.right
              anchors.leftMargin: installedFilters.gap
              width: installedFilters.optionWidth
              height: parent.height

              Text {
                textFormat: Text.PlainText
                anchors.left: parent.left
                anchors.top: parent.top
                text: "Kind"
                color: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Dropdown {
                id: kindDropdown
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: filterControls.controlHeight
                showLabel: false
                options: root.kindOptions
                value: root.kindFilter
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onChanged: function(value) { root.closeArrange(); root.setKindFilter(value) }
              }
            }

            Item {
              id: statusFilterControl
              anchors.left: kindFilterControl.right
              anchors.leftMargin: installedFilters.gap
              anchors.right: parent.right
              height: parent.height

              Text {
                textFormat: Text.PlainText
                anchors.left: parent.left
                anchors.top: parent.top
                text: "Status"
                color: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Dropdown {
                id: statusDropdown
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: filterControls.controlHeight
                showLabel: false
                options: root.statusOptions
                value: root.statusFilter
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                onChanged: function(value) { root.closeArrange(); root.setStatusFilter(value) }
              }
            }
          }

          // The box exists only while the popup is open. A Qt Quick text
          // input subscribes to the system clipboard for as long as it lives,
          // and the popup itself stays loaded for the shell's lifetime, so a
          // box kept around while hidden would make the shell read every
          // clipboard offer another program makes. The loader holds the box's
          // place in the layout; the term lives on root.searchText.
          Loader {
            id: searchFieldLoader
            anchors.left: parent.left
            anchors.right: clearFiltersButton.visible ? clearFiltersButton.left : parent.right
            anchors.rightMargin: clearFiltersButton.visible ? Style.space(4) : 0
            y: filterControls.filterRowHeight + Style.space(8)
            height: filterControls.controlHeight
            active: root.opened
            sourceComponent: Component {
              TextField {
                id: searchField
                text: root.searchText
                // A search term never needs more, and the cap holds for pasted text too.
                maximumLength: 256
                // The glyph rides in the placeholder rather than sitting in its
                // own column: the row is the search box and nothing else.
                placeholderText: "󰍉  Search by name…"
                foreground: root.contentForeground
                placeholderTextColor: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                verticalPadding: Style.spacing.xs

                // Enter hands the list back the keyboard with the results in
                // place, so you can type a name and arrow straight into it.
                onTextEdited: root.closeArrange()
                onTextChanged: root.searchText = text
                onAccepted: {
                  root.flushSearch()
                  root.returnFocusToList()
                }
                Keys.onPressed: function(event) {
                  if (event.key !== Qt.Key_Escape) return
                  // Escape clears before it leaves: a search box that keeps a
                  // stale term after you back out of it silently hides plugins.
                  if (root.searchText !== "") root.clearSearch()
                  else root.returnFocusToList()
                  event.accepted = true
                }
              }
            }
          }

          PanelActionButton {
            id: clearFiltersButton
            anchors.right: parent.right
            y: filterControls.filterRowHeight + Style.space(8)
            visible: root.searchText !== ""
            iconText: "󰅙"
            tooltipText: "Clear the search"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onClicked: {
              root.clearSearch()
              root.returnFocusToList()
            }
          }
        }

        // ---- Status: the last thing that happened, good or bad. Only takes
        //      up room when there is something to say.
        Text {
          // Never rich text: AutoText would fetch what a crafted string points at.
          textFormat: Text.PlainText
          width: parent.width
          visible: text !== ""
          text: {
            if (root.settingsOpen) return root.statusSource === "layout" ? "" : root.status
            if (root.barMovePending) return root.popupMoveOwner.status + root.placementNotice
            if (root.busy) return root.busyKind === "bulk-update" ? root.status
              : Model.actionGerund(root.busyKind) + " " + root.busyId + "…"
            if (root.loadError !== "") return root.loadError
            return root.status
          }
          color: root.statusIsError || (root.barMovePending && root.popupMoveOwner.statusIsError)
            || root.loadError !== "" ? Color.urgent : root.secondaryForeground
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
        WidgetButton {
          visible: root.barMovePending && !root.arrangeOpen
          text: "Review layout"
          tooltipText: "Inspect the current layout before explicitly accepting it; never retries the move"
          foreground: root.contentForeground
          fontFamily: root.contentFontFamily
          onPressed: function(button) { if (button === Qt.LeftButton) root.openArrange() }
        }
      }

      // ---- Key hints, pinned to the bottom so the list above can never push
      //      them off the card. One bar: the filters of the active tab on
      //      the left, each "[key] value", and the row actions on the right.
      Column {
        id: hintBar
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        spacing: Style.space(8)

        PanelSeparator { foreground: root.contentForeground }

        Item {
          width: parent.width
          height: Math.max(filterHints.implicitHeight, actionHints.implicitHeight)

          Row {
            id: filterHints
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(10)

            Repeater {
              model: root.installedFilterHints
              delegate: hintDelegate
            }
          }

          Row {
            id: actionHints
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(10)

            Repeater {
              model: Model.actionHints(false, root.bulkUpdatableCount > 0)
              delegate: hintDelegate
            }
          }
        }

        Component {
          id: hintDelegate

          Row {
            id: hint
            required property var modelData
            spacing: Style.space(4)

            Text {
              // Never rich text: AutoText would fetch what a crafted string points at.
              textFormat: Text.PlainText
              text: "[" + hint.modelData.key.toUpperCase() + "]"
              color: Color.accent
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            Text {
              // Never rich text: AutoText would fetch what a crafted string points at.
              textFormat: Text.PlainText
              text: hint.modelData.text
              color: hint.modelData.active ? root.contentForeground : root.secondaryForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }
      }

      // ---- The two lists, in one scroll region so the sections read as
      //      parts of a single inventory rather than two separate panes.
      //      Anchored between the chrome above and below: whatever height is
      //      left over is exactly what it gets.
      Flickable {
        id: listScroll
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.topMargin: Style.space(10)
        anchors.bottom: hintBar.top
        anchors.bottomMargin: Style.space(10)
        contentWidth: width
        contentHeight: listColumn.implicitHeight
        onMovementStarted: root.closeArrange()
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: listColumn
          width: listScroll.width
          spacing: Style.space(2)

          Text {
            // Never rich text: AutoText would fetch what a crafted string points at.
            textFormat: Text.PlainText
            width: parent.width
            visible: root.visibleRows.length === 0 && root.rows.length > 0
            text: Model.emptyMessage(root.kindFilter, root.statusFilter, root.searchQuery, root.groupFilter)
            color: root.secondaryForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
            topPadding: Style.space(12)
            bottomPadding: Style.space(12)
            horizontalAlignment: Text.AlignHCenter
          }

          PanelSectionHeader {
            visible: root.installedRows.length > 0
            text: Model.sectionHeading(root.visibleRows, "installed")
            foreground: root.contentForeground
            color: root.secondaryForeground
            fontFamily: root.contentFontFamily
            bottomPadding: Style.space(4)
          }

          Repeater {
            model: root.installedRows

            PluginRow {
              required property int index
              required property var modelData

              width: listColumn.width
              row: modelData
              verified: Model.isVerified(modelData, root.verifiedIds)
              selected: root.selectedIndex === index
              actionsEnabled: !root.busy
              updateEnabled: root.updateActionsEnabled
              updating: root.busyKind === "update" && root.busyRowId === modelData.id
              showSeparator: index < root.installedRows.length - 1 // qmllint disable unqualified
              foreground: root.contentForeground
              secondaryForeground: root.secondaryForeground
              fontFamily: root.contentFontFamily

              onSelectedChanged: if (selected) root.ensureVisible(this)
              onClicked: { root.closeArrange(); root.selectedIndex = index }
              onGithubNavigationRequested: function(candidates, fallbackUrl) {
                root.requestGithubNavigation(candidates, fallbackUrl)
              }
              onRepositoryNavigationRequested: function(url) { root.navigateExternalUrl(url) }
              onUpdateRequested: {
                root.selectedIndex = index
                root.startUpdate(modelData)
              }
              onRemoveRequested: {
                root.selectedIndex = index
                root.askRemove(modelData)
              }
              onEnableRequested: {
                root.selectedIndex = index
                root.askEnable(modelData)
              }
              onDisableRequested: {
                root.selectedIndex = index
                root.askDisable(modelData)
              }
            }
          }

          PanelSectionHeader {
            visible: root.builtinRows.length > 0
            text: Model.sectionHeading(root.visibleRows, "built-in")
            foreground: root.contentForeground
            color: root.secondaryForeground
            fontFamily: root.contentFontFamily
            topPadding: Style.space(12)
            bottomPadding: Style.space(4)
          }

          Repeater {
            model: root.builtinRows

            PluginRow {
              required property int index
              required property var modelData

              // Built-ins follow the installed list in the same flat order,
              // so their global index is offset by however many came first.
              readonly property int globalIndex: root.installedRows.length + index

              width: listColumn.width
              row: modelData
              verified: Model.isVerified(modelData, root.verifiedIds)
              selected: root.selectedIndex === globalIndex
              actionsEnabled: !root.busy
              showSeparator: index < root.builtinRows.length - 1 // qmllint disable unqualified
              foreground: root.contentForeground
              secondaryForeground: root.secondaryForeground
              fontFamily: root.contentFontFamily

              onSelectedChanged: if (selected) root.ensureVisible(this)
              onClicked: { root.closeArrange(); root.selectedIndex = globalIndex }
              onRepositoryNavigationRequested: function(url) { root.navigateExternalUrl(url) }
              // A built-in cannot be pulled or deleted, but it can certainly
              // be sitting there switched off — same problem, same answer.
              onEnableRequested: {
                root.selectedIndex = globalIndex
                root.askEnable(modelData)
              }
              onDisableRequested: {
                root.selectedIndex = globalIndex
                root.askDisable(modelData)
              }
            }
          }
        }
      }

      // ---- Settings: an overlay over the list, the way back at the top and
      //      the switches below it.
      Rectangle {
        id: settingsPane
        anchors.fill: parent
        z: 10
        visible: root.settingsOpen || root.arrangeOpen
        color: Color.popups.background

        // Nothing underneath reacts to a click while the pane is up.
        MouseArea { anchors.fill: parent }

        onVisibleChanged: {
          if (visible) forceActiveFocus()
          else root.returnFocusToList()
        }

        // Escape and Backspace both leave the pane; the key catcher is
        // blocked while it is up, so neither closes the popup instead.
        Keys.onPressed: function(event) {
          if (root.handleArrangeKey(event)) { event.accepted = true; return }
          if (event.key !== Qt.Key_Escape && event.key !== Qt.Key_Backspace) return
          root.closeSettings()
          event.accepted = true
        }

        Button {
          id: settingsBackButton
          anchors.left: parent.left
          anchors.top: parent.top
          iconText: "󰁍"
          text: "Back"
          tooltipText: "Back to the list"
          bordered: true
          foreground: root.contentForeground
          fontFamily: root.contentFontFamily
          fontSize: Style.font.caption
          onClicked: root.arrangeOpen ? root.closeArrange() : root.closeSettings()
        }

        Column {
          id: arrangeStatus
          visible: root.arrangeOpen
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: settingsBackButton.bottom
          anchors.topMargin: Style.space(12)
          spacing: Style.space(8)

          Text {
            width: parent.width
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            text: !root.popupMoveOwner ? "Arrange is not ready; waiting for the retained host."
              : root.barMovePending ? root.popupMoveOwner.status
              : !root.barSnapshot ? "Bar layout unavailable; waiting for host configuration."
              : root.popupMoveOwner.status
            color: root.popupMoveOwner && root.popupMoveOwner.statusIsError ? Color.urgent : root.secondaryForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }
          Text {
            width: parent.width
            visible: root.barMovePending
            height: visible ? implicitHeight : 0
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            text: root.popupMoveOwner && !root.popupMoveOwner.exited
              ? "Saving. Arrange returns here after the bar rebuilds."
              : "Review the layout below. Accept it without retrying, or hide the popup; moves stay locked."
            color: root.secondaryForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }
          Row {
            visible: root.barMovePending
            height: visible ? implicitHeight : 0
            spacing: Style.space(8)
            Button {
              text: "Use current layout"
              enabled: root.popupMoveOwner && root.popupMoveOwner.exited && root.barSnapshot !== null
              bordered: true
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              fontSize: Style.font.caption
              onClicked: root.useCurrentLayout()
            }
            Button {
              text: "Hide popup"
              bordered: true
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              fontSize: Style.font.caption
              onClicked: { root.closeArrange(); root.close() }
            }
          }
        }

        BarLayoutPane {
          id: barBoard
          visible: root.arrangeOpen
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: arrangeStatus.bottom
          anchors.topMargin: Style.space(12)
          anchors.bottom: parent.bottom
          snapshot: root.barSnapshot
          busy: root.arrangeBusy
          labels: {
            var labels = Object.create(null)
            for (var row of root.rows) labels[row.id] = row.name
            return labels
          }
          onMoveRequested: function(snapshot, fromSection, rawIndex, targetSection, preRemovalGap) {
            root.requestBarMove(snapshot, fromSection, rawIndex, targetSection, preRemovalGap)
          }
          fill: Color.menu.background
          rowFill: Style.normalFill
          foreground: root.contentForeground
          mutedForeground: root.secondaryForeground
          borderColor: Color.menu.border
          accent: Color.accent
          fontFamily: root.contentFontFamily
          fontPixelSize: Style.font.caption
          spacing: Style.space(8)
          radius: Style.cornerRadius
          rowHeight: Style.space(40)
        }

        Flickable {
          id: settingsScroll
          visible: root.settingsOpen
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: settingsBackButton.bottom
          anchors.topMargin: Style.space(16)
          anchors.bottom: parent.bottom
          contentHeight: settingsContent.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
        }

        Column {
          id: settingsContent
          parent: settingsScroll.contentItem
          width: settingsScroll.width
          spacing: Style.space(14)

          Text {
            // Never rich text: AutoText would fetch what a crafted string points at.
            textFormat: Text.PlainText
            text: "Settings"
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.title
            font.bold: true
          }

          // Off is the verified-snapshot promise; on is the user's own call, and
          // the caption says so in the same words the confirmation will.
          Rectangle {
            width: parent.width
            height: Math.max(unverifiedText.implicitHeight, unverifiedSwitch.implicitHeight) + Style.space(12) * 2
            radius: Style.cornerRadius
            color: Style.normalFill
            border.width: 1
            border.color: Qt.alpha(root.secondaryForeground, 0.35)

            Column {
              id: unverifiedText
              anchors.left: parent.left
              anchors.leftMargin: Style.space(12)
              anchors.right: unverifiedSwitch.left
              anchors.rightMargin: Style.space(16)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(4)

              Text {
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                width: parent.width
                text: "Allow updating unverified plugins"
                color: root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.body
                wrapMode: Text.WordWrap
              }

              Text {
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                width: parent.width
                text: "Off: only verified snapshots are offered. "
                  + "On: upstream commits nobody has reviewed can be installed, pinned to the exact commit the check observed, after a confirmation."
                color: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }
            }

            ToggleSwitch {
              id: unverifiedSwitch
              anchors.right: parent.right
              anchors.rightMargin: Style.space(12)
              anchors.verticalCenter: parent.verticalCenter
              checked: store.allowUnverifiedUpdates
              interactive: true
              busy: root.busy
              foreground: root.contentForeground
              onToggled: store.setAllowUnverifiedUpdates(!store.allowUnverifiedUpdates)

              PanelToolTip {
                visible: unverifiedSwitch.containsMouse
                text: store.allowUnverifiedUpdates ? "Unreviewed commits can be installed" : "Only verified snapshots are offered"
                fontFamily: root.contentFontFamily
              }
            }
          }

          // How much history the helper keeps before proven successes must
          // archive: a bounded threshold, never a weaker proof.
          Rectangle {
            width: parent.width
            height: Math.max(transactionLimitText.implicitHeight, limitStepRow.implicitHeight) + Style.space(12) * 2
            radius: Style.cornerRadius
            color: Style.normalFill
            border.width: 1
            border.color: Qt.alpha(root.secondaryForeground, 0.35)

            Column {
              id: transactionLimitText
              anchors.left: parent.left
              anchors.leftMargin: Style.space(12)
              anchors.right: limitStepRow.left
              anchors.rightMargin: Style.space(16)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(4)

              Text {
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                width: parent.width
                text: "Transaction history limit"
                color: root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.body
                wrapMode: Text.WordWrap
              }

              Text {
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                width: parent.width
                text: "Keeps " + store.transactionLimit + " entries (8–128, default 32). History now: " + store.updateDataCount + "."
                color: root.secondaryForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }

              Text {
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                visible: Model.updateDataNearLimit(store.updateDataStatus)
                height: visible ? implicitHeight : 0
                width: parent.width
                text: "Nearly full: run Delete update data in Info below, or raise the limit."
                color: root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }

              Text {
                // Never rich text: AutoText would fetch what a crafted string points at.
                textFormat: Text.PlainText
                visible: Model.transactionLimitFallback(store.updateDataStatus, store.transactionLimit)
                height: visible ? implicitHeight : 0
                width: parent.width
                text: "The helper is using " + (store.updateDataStatus ? store.updateDataStatus.limit : "") + ": the saved value was unreadable, so the default applies."
                color: root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }
            }

            Row {
              id: limitStepRow
              anchors.right: parent.right
              anchors.rightMargin: Style.space(12)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(8)

              Button {
                id: limitDecreaseButton
                text: "-"
                tooltipText: "Keep fewer entries"
                bordered: true
                enabled: !root.busy && store.transactionLimit > store.transactionLimitFloor
                opacity: enabled ? 1 : 0.4
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                fontSize: Style.font.caption
                onClicked: store.adjustTransactionLimit(-Model.TRANSACTION_LIMIT_STEP)
              }

              Button {
                id: limitIncreaseButton
                text: "+"
                tooltipText: "Keep more entries"
                bordered: true
                enabled: !root.busy && store.transactionLimit < Model.TRANSACTION_LIMIT_MAX
                opacity: enabled ? 1 : 0.4
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
                fontSize: Style.font.caption
                onClicked: store.adjustTransactionLimit(Model.TRANSACTION_LIMIT_STEP)
              }
            }
          }

          // Restarting the shell is how every plugin, this one included, is
          // read again from disk: Quickshell keeps compiled QML in a cache
          // that a restart alone can go on serving.
          Rectangle {
            width: parent.width
            height: restartShellButton.implicitHeight + Style.space(12) * 2
            radius: Style.cornerRadius
            color: Style.normalFill
            border.width: 1
            border.color: Qt.alpha(root.secondaryForeground, 0.35)

            Button {
              id: restartShellButton
              anchors.right: parent.right
              anchors.rightMargin: Style.space(12)
              anchors.verticalCenter: parent.verticalCenter
              iconText: "󰜉"
              text: "Restart Shell"
              tooltipText: "Clear the QML cache and restart the shell so every plugin reloads"
              bordered: true
              enabled: !root.busy
              opacity: enabled ? 1 : 0.4
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              fontSize: Style.font.caption
              onClicked: store.restartShell()
            }
          }

          SettingsInfo {
            width: parent.width
            pluginsBasePath: store.updateDataPaths ? store.updateDataPaths.plugins : ""
            updateDataPath: store.updateDataPaths ? store.updateDataPaths.active : ""
            updateDataArchivePath: store.updateDataPaths ? store.updateDataPaths.archive : ""
            updateDataLoading: store.updateDataLoading
            cleanupEnabled: store.cleanupEnabled
            cleanupOutcome: store.cleanupOutcome
            onCleanupRequested: store.askCleanupUpdateData()
            readonly property var selfRow: Model.findRow(store.rows, store.selfId)
            installedVersion: selfRow ? selfRow.localVersion : ""
            foreground: root.contentForeground
            secondaryForeground: root.secondaryForeground
            fontFamily: root.contentFontFamily
            onRepositoryNavigationRequested: function(url) { root.navigateExternalUrl(url) }
            onGithubNavigationRequested: function(candidates, fallbackUrl) { root.requestGithubNavigation(candidates, fallbackUrl) }
          }
        }
      }

      ActionConfirmDialog {
        id: confirm
        anchors.fill: parent
        z: 10
        opened: root.confirming
        message: root.confirmMessage
        actionText: "View changes"
        actionVisible: store.confirmCompareUrl !== ""
        onActionRequested: root.requestGithubNavigation([], store.confirmCompareUrl)
        confirmText: root.pendingKind === "cleanup" ? "Delete" : Model.actionVerb(root.pendingKind) === "Action"
          ? "Confirm"
          : Model.actionVerb(root.pendingKind)
        background: Color.popups.background
        foreground: root.contentForeground
        fontFamily: root.contentFontFamily

        onOpenedChanged: {
          if (opened) forceActiveFocus()
          else root.returnFocusToList()
        }

        Keys.onPressed: function(event) {
          if (confirm.handleKey(event)) event.accepted = true
        }

        onCanceled: root.cancelPending()
        onConfirmed: root.confirmPending()
      }

      ChoiceDialog {
        id: placement
        anchors.fill: parent
        z: 10
        opened: root.placing
        message: root.placementMessage
        choices: root.placementChoices
        background: Color.popups.background
        foreground: root.contentForeground
        fontFamily: root.contentFontFamily

        onOpenedChanged: {
          if (opened) forceActiveFocus()
          else root.returnFocusToList()
        }

        Keys.onPressed: function(event) {
          if (placement.handleKey(event)) event.accepted = true
        }

        onCanceled: root.cancelPending()
        onChosen: function(value) { root.confirmPlacement(value) }
      }
    }
  }
}
