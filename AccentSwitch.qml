import QtQuick
import qs.Commons

// On/off switch in the accent colour: accent track, border and knob when on, a
// dim neutral track when off (the look omaudiopanel uses). With useAccent off
// the checked parts take the foreground colour instead, so on still reads as
// on by fill and knob position. busy and non-interactive dim it and ignore
// clicks.
Item {
  id: root
  required property var look
  property color foreground: Color.foreground
  property bool checked: false
  property bool interactive: true
  property bool busy: false
  property bool useAccent: true
  readonly property bool containsMouse: swMouse.containsMouse
  // What a checked switch is drawn in.
  readonly property color tint: useAccent ? root.look.accent : root.foreground
  signal toggled()

  implicitWidth: root.look.sp(34)
  implicitHeight: root.look.sp(18)
  opacity: root.busy || !root.interactive ? 0.5 : 1.0

  Rectangle {
    anchors.fill: parent
    radius: height / 2
    color: root.checked ? Qt.alpha(root.tint, 0.3) : Qt.alpha(root.foreground, 0.1)
    border.width: 1
    border.color: root.checked ? root.tint : Qt.alpha(root.foreground, 0.25)
    Behavior on color { ColorAnimation { duration: 120 } }

    Rectangle {
      width: parent.height - root.look.sp(6)
      height: width
      radius: width / 2
      anchors.verticalCenter: parent.verticalCenter
      x: root.checked ? parent.width - width - (parent.height - height) / 2 : (parent.height - height) / 2
      color: root.checked ? root.tint : Qt.darker(root.foreground, 1.4)
      Behavior on x { NumberAnimation { duration: 120 } }
      Behavior on color { ColorAnimation { duration: 120 } }
    }
  }

  MouseArea {
    id: swMouse
    anchors.fill: parent
    anchors.margins: -root.look.sp(3)
    hoverEnabled: true
    enabled: root.interactive && !root.busy
    cursorShape: Qt.PointingHandCursor
    onClicked: root.toggled()
  }
}
