import QtQuick
import "Model.js" as Model
import "PopupBridge.js" as PopupBridge

// The retained owner of popup bar moves. Headless: no window, nothing drawn.
//
// This is the plugin's `panel` entry point only so the shell retains it. With
// manifest.keepLoaded the shell's panel Loader builds it once per session and
// keeps it across the bar rebuild an `omarchy-bar move` causes, which destroys
// and recreates every BarWidget and popup Panel. The popup dispatches its
// Arrange drops through this owner (via PopupBridge) and the owner reopens
// Arrange on the original output once the rebuilt popup is ready.
//
// Panel contract, as shell.qml's panel Loader uses it: on load it assigns
// `shell` and `manifest` when the root declares them; summon calls
// `open(payloadJson)`, hide calls `close()`, and isPluginOpen reads `opened`.
// Nothing here is shown: a summon is forwarded to the popup on the named
// output, and `opened` mirrors whether any popup is open. Explicit plugin reload, disable/removal or
// shell shutdown destroys the owner and ends its ownership.
Item {
  id: root
  visible: false
  width: 0
  height: 0

  property var shell: null
  property var manifest: null
  // True while any popup is open; PopupBridge pushes it (see popupOpen), so
  // the shell's toggle closes what its summon opened.
  readonly property bool opened: popupMoves.popupOpen

  readonly property string pluginId: manifest && manifest.id
    ? String(manifest.id) : "io.github.juancasanueva.plugin-manager"

  // The store's bar-move lock and process. Construction reads nothing: no
  // load, no shell.json watch; only the move API is ever used here.
  PluginStore {
    id: store
    selfId: root.pluginId
    // The sanctioned way to read the host bar layout and write settings.
    shell: root.shell
  }

  // ---- Lifecycle (called by the shell) --------------------------------------

  // `omarchy-shell summon <id> [{"screen": "<output>"}]` lands here, because
  // the panel kind wins the shell's routing over the bar widget. Open the
  // popup instead; a pending move keeps its lock either way.
  function open(payloadJson) {
    var screen = ""
    var payload = null
    try {
      payload = JSON.parse(payloadJson || "{}")
      if (payload && typeof payload.screen === "string" && payload.screen.length <= 128)
        screen = payload.screen
    } catch (error) {}
    PopupBridge.openPopup(screen)
  }

  // Shell hide closes every popup. Hiding is never cancellation: keepLoaded
  // retains this owner and its Process, and the store keeps the move lock.
  function close() {
    PopupBridge.closePopups()
  }

  // ---- Retained moves --------------------------------------------------------

  readonly property bool barMovePending: store.barMovePending !== null
  property var barSnapshot: null

  // This narrow live object is injected into popup panels, not the store.
  // Every popup dispatches through the same store lock and raw indices.
  QtObject {
    id: popupMoves
    property bool continuationActive: false
    property int generation: 0
    property bool popupOpen: false
    readonly property bool pending: root.barMovePending
    readonly property bool exited: store.barMoveExited
    readonly property bool busy: store.busy
    readonly property var snapshot: root.barSnapshot
    readonly property string status: store.status
    readonly property bool statusIsError: store.statusIsError
    function start(snapshot, fromSection, fromIndex, section, gap) {
      return root.startPopupMove(snapshot, fromSection, fromIndex, section, gap)
    }
    function recover() { return root.recoverPopupMove() }
  }

  // Register after construction without summoning or reading configuration.
  Timer {
    interval: 0
    running: true
    onTriggered: PopupBridge.registerOwner(popupMoves)
  }
  Component.onDestruction: PopupBridge.unregisterOwner(popupMoves)
  Timer {
    interval: 100
    repeat: true
    running: popupMoves.continuationActive
    onTriggered: PopupBridge.continueArrange(popupMoves)
  }
  Connections {
    target: store
    function onBarMovePendingChanged() { if (root.barMovePending) popupMoves.generation++ }
  }

  function startPopupMove(snapshot, fromSection, fromIndex, section, gap) {
    return store.startBarMove(snapshot, fromSection, fromIndex, section, gap)
  }

  function recoverPopupMove() {
    return store.reconcileBarMove(true)
  }

  function refreshBarLayout() {
    barSnapshot = Model.barLayoutSnapshot(root.shell && root.shell.barConfig ? root.shell.barConfig.layout : null)
    store.reconcileBarMove(false)
  }

  onShellChanged: refreshBarLayout()
  Connections {
    target: root.shell
    function onBarConfigChanged() { root.refreshBarLayout() }
  }
}
