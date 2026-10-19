import QtQuick
import qs.Commons
import "Model.js" as Model

// The panel's look: spacing, text size and highlight colour, from the
// density, fontSize and accent settings. Normal/normal/theme is the stock look.
Item {
  id: root

  // The plugin's shell.json entry (store.selfSettings).
  property var settings: ({})

  readonly property string density: Model.choiceSetting(settings, "density", ["compact", "normal", "comfortable"], "normal")
  readonly property string fontSizeChoice: Model.choiceSetting(settings, "fontSize", ["small", "normal", "large"], "normal")
  readonly property string accentChoice: settings && typeof settings.accent === "string" ? settings.accent : "theme"
  readonly property bool showDescriptions: Model.settingBool(settings && settings.showDescriptions, true)
  readonly property bool showMeta: Model.settingBool(settings && settings.showMeta, true)
  readonly property bool showSummary: Model.settingBool(settings && settings.showSummary, true)
  readonly property bool showKeyHints: Model.settingBool(settings && settings.showKeyHints, true)
  readonly property bool showSearch: Model.settingBool(settings && settings.showSearch, true)
  readonly property bool accentToggles: Model.settingBool(settings && settings.accentToggles, true)

  readonly property real densityScale: Model.densityScale(density)
  readonly property real fontScale: (0.5 + 0.5 * densityScale) * Model.fontSizeScale(fontSizeChoice)

  AccentSource {
    id: accentSource
    choice: root.accentChoice
  }
  readonly property color accent: accentSource.value
  // "theme" first, then the palette names the current theme defines.
  readonly property var accentChoices: accentSource.available

  // The colour a palette name stands for, for the swatch in the settings page.
  function accentSwatch(name) {
    return accentSource.colorOf(name)
  }

  function sp(px) { return Style.space(px * densityScale) }

  function scaled(px) { return Math.round(px * fontScale) }

  readonly property var font: ({
    family: Style.font.family,
    body: scaled(Style.font.body),
    bodySmall: scaled(Style.font.bodySmall),
    caption: Math.max(Math.min(9, Style.font.caption), scaled(Style.font.caption)),
    display: scaled(Style.font.display),
    displayLarge: scaled(Style.font.displayLarge),
    icon: scaled(Style.font.icon),
    iconLarge: scaled(Style.font.iconLarge),
    subtitle: scaled(Style.font.subtitle),
    title: scaled(Style.font.title)
  })
}
