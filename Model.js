// Pure data helpers for the plugin manager.
//
// Everything that turns CLI output into rows lives here rather than in the
// QML, so the parsing rules can be read on their own — and so a partial or
// broken read is distinguishable from an honestly empty one. `null` means
// "could not read"; an empty array means "read fine, nothing there". A panel
// that renders those two the same way lies to the user.

var SECTION_LIST = "===list==="
var SECTION_CATALOG = "===catalog==="
var SECTION_GIT = "===git==="
var SECTION_MANIFEST = "===manifest==="
var SECTION_SETTINGS = "===settings===\n"
var SECTION_LAYOUT = "===layout===\n"

// The two lists the panel draws. What you installed is what you can act on;
// the built-ins are the backdrop. Splitting them means the buttons in a
// section are the same buttons all the way down, instead of half the rows
// having greyed-out controls for reasons you have to infer.
var GROUP_INSTALLED = "installed"
var GROUP_BUILT_IN = "built-in"

var ALL_GROUPS = "all"
var ALL_KINDS = "all"
var ALL_STATUSES = "all"
var STATUS_ENABLED = "enabled"
var STATUS_DISABLED = "disabled"
var STATUS_UPDATE = "update"

// The loader emits four fixed sections in order. Anything else — a truncated
// stream, a section that never printed — is a failed read, not empty data.
// Two optional one-line sections travel ahead of them, so an older loader
// still splits: this plugin's own shell.json entry, then the bar layout.
//
// Both are user-written text (printed by `jq -c` as exactly one line each),
// so the fixed markers are searched only after those lines: a value that
// happens to contain "===list===" stays inside its own slice, where the worst
// it can do is fail to parse, and cannot shift the list, catalog, git or
// manifest slices.
//
// One leading line: `marker`, then either one line of jq output or nothing at
// all (the loader had nothing to print, so one of `next` follows at once).
// Null is a line that never ends — a truncated stream.
function takeLeadingLine(text, from, marker, next) {
  if (text.indexOf(marker, from) !== from) return { value: "", from: from }
  var start = from + marker.length
  for (var i = 0; i < next.length; i++) {
    if (text.indexOf(next[i], start) === start) return { value: "", from: start }
  }
  var lineEnd = text.indexOf("\n", start)
  if (lineEnd < 0) return null
  return { value: text.slice(start, lineEnd), from: lineEnd + 1 }
}

function splitSections(raw) {
  var text = String(raw || "")
  var settings = takeLeadingLine(text, 0, SECTION_SETTINGS, [SECTION_LAYOUT, SECTION_LIST])
  if (!settings) return null
  var layout = takeLeadingLine(text, settings.from, SECTION_LAYOUT, [SECTION_LIST])
  if (!layout) return null
  var from = layout.from
  var atList = text.indexOf(SECTION_LIST, from)
  var atCatalog = text.indexOf(SECTION_CATALOG, from)
  var atGit = text.indexOf(SECTION_GIT, from)
  var atManifest = text.indexOf(SECTION_MANIFEST, from)
  if (atList < 0 || atCatalog < 0 || atGit < 0 || atManifest < 0) return null
  if (!(atList < atCatalog && atCatalog < atGit && atGit < atManifest)) return null
  // Optional, but if they are there they lead: either marker anywhere after
  // its own line is a corrupted stream, not a section.
  if (text.indexOf(SECTION_SETTINGS, from) >= 0 || text.indexOf(SECTION_LAYOUT, from) >= 0) return null

  return {
    settings: settings.value,
    layout: layout.value,
    list: text.slice(atList + SECTION_LIST.length, atCatalog),
    catalog: text.slice(atCatalog + SECTION_CATALOG.length, atGit),
    git: text.slice(atGit + SECTION_GIT.length, atManifest),
    manifest: text.slice(atManifest + SECTION_MANIFEST.length)
  }
}

// Returns null rather than [] when the payload is not a JSON array, so the
// caller can tell a failed command from a genuinely empty result.
function parseArray(raw) {
  try {
    var value = JSON.parse(String(raw || "").trim())
    return Array.isArray(value) ? value : null
  } catch (error) {
    return null
  }
}

// This plugin's own inline shell.json entry, as the loader printed it: one
// JSON object, or nothing when the entry is absent. Two views of it:
//
// parseSelfEntry keeps the entry whole (every own key except the id, values
// untouched) so a write can hand the host back everything the entry held;
// the host replaces the entry rather than merging into it. It is null, not
// {}, when the text is not one bounded JSON object, so the store can refuse
// to write over an entry it could not read.
//
// parseSelfSettings is the strict view the panel reads from: only bounded,
// plain-typed values, and the settings it acts on are then decided one key
// at a time (see allowUnverifiedUpdates). A hostile or malformed entry can
// at most switch a feature off, and (see splitSections) cannot touch the rows.
var MAX_SETTINGS_BYTES = 4096

function parseSelfEntry(raw) {
  var text = String(raw || "").trim()
  if (text === "") return {}
  if (text.length > MAX_SETTINGS_BYTES) return null
  var value
  try {
    value = JSON.parse(text)
  } catch (error) {
    return null
  }
  if (!value || Array.isArray(value) || typeof value !== "object") return null
  var out = {}
  for (var key in value) {
    if (!hasOwnKey(value, key) || key === "id" || key === "__proto__") continue
    out[key] = value[key]
  }
  return out
}

// The bar layout as the loader printed it: one JSON array of {id, section}
// for every entry of bar.layout, or nothing when shell.json could not be
// read. Display data only — it says which section each widget sits in, so the
// move control can name where a widget is — so a malformed array degrades to
// "section unknown" for every row, never to a failed load.
var MAX_LAYOUT_BYTES = 65536
var MAX_LAYOUT_ENTRIES = 512
var LAYOUT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function parseLayoutSections(raw) {
  var out = Object.create(null)
  var text = String(raw || "").trim()
  if (text === "" || text.length > MAX_LAYOUT_BYTES) return out
  var value
  try {
    value = JSON.parse(text)
  } catch (error) {
    return out
  }
  if (!Array.isArray(value)) return out
  for (var i = 0; i < value.length && i < MAX_LAYOUT_ENTRIES; i++) {
    var item = value[i]
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    var id = typeof item.id === "string" ? item.id : ""
    var section = typeof item.section === "string" ? item.section : ""
    if (!LAYOUT_ID_PATTERN.test(id) || id.indexOf("..") >= 0) continue
    if (BAR_SECTIONS.indexOf(section) < 0) continue
    // The first placement wins: one widget, one section.
    if (!(id in out)) out[id] = section
  }
  return out
}

function parseSelfSettings(raw) {
  var entry = parseSelfEntry(raw)
  var out = {}
  for (var key in entry || {}) {
    var item = entry[key]
    var type = typeof item
    if (type === "boolean" || (type === "number" && isFinite(item))) out[key] = item
    else if (type === "string" && item.length <= 256) out[key] = item
  }
  return out
}

// The entry to write back: a fresh copy of everything the entry held, with
// the one setting set (only the boolean true is ever stored) or removed.
function withSelfSetting(entry, key, value) {
  var out = {}
  for (var name in entry || {}) {
    if (!hasOwnKey(entry, name) || name === "id" || name === "__proto__") continue
    out[name] = entry[name]
  }
  if (value === true) out[key] = true
  else delete out[key]
  return out
}

// The entry to write back for an integer-valued setting: the clamped value is
// stored, or the key is removed when it equals the default so the entry does
// not carry what the reader would assume anyway.
function withSelfIntSetting(entry, key, value, min, max, fallback) {
  var out = {}
  for (var name in entry || {}) {
    if (!hasOwnKey(entry, name) || name === "id" || name === "__proto__") continue
    out[name] = entry[name]
  }
  var number = typeof value === "number" && isFinite(value) ? Math.floor(value) : fallback
  if (number < min) number = min
  if (number > max) number = max
  if (number === fallback) delete out[key]
  else out[key] = number
  return out
}

// The settings the panel acts on, one key at a time. Strictly the boolean
// true: a string "true", 1, or anything else a hand edit might produce leaves
// a setting off. Installing unreviewed code and updating to it are separate
// decisions, so neither key ever stands in for the other.
function allowUnverifiedUpdates(settings) {
  return !!settings && hasOwnKey(settings, "allowUnverifiedUpdates")
    && settings.allowUnverifiedUpdates === true
}

// Active-transaction capacity bounds. The helper enforces the same range read
// from the same shell.json entry, so the panel and the helper agree without a
// new command-line or request shape: only the threshold moves, never proof.
var TRANSACTION_LIMIT_DEFAULT = 32
var TRANSACTION_LIMIT_MIN = 8
var TRANSACTION_LIMIT_MAX = 128
var TRANSACTION_LIMIT_STEP = 8
var TRANSACTION_LIMIT_NEAR = 4

// The configured history capacity: a bounded integer override, or the default
// when the key is missing or hostile. A hand edit outside the range keeps the
// default rather than refusing updates.
function transactionLimit(settings) {
  var value = !!settings && hasOwnKey(settings, "transactionLimit")
    ? settings.transactionLimit : TRANSACTION_LIMIT_DEFAULT
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value
    && value >= TRANSACTION_LIMIT_MIN && value <= TRANSACTION_LIMIT_MAX
    ? value : TRANSACTION_LIMIT_DEFAULT
}

// Lowest settable capacity: never below the live active count, so lowering
// the limit can never wedge updates behind history that cannot archive down.
// Without a fresh status the static minimum applies.
function transactionLimitFloor(status) {
  if (!status || status.available !== true || typeof status.activeCount !== "number"
      || !isFinite(status.activeCount)) return TRANSACTION_LIMIT_MIN
  var count = Math.floor(status.activeCount)
  if (count < TRANSACTION_LIMIT_MIN) count = TRANSACTION_LIMIT_MIN
  if (count > TRANSACTION_LIMIT_MAX) count = TRANSACTION_LIMIT_MAX
  return count
}

// True when the helper enforces a different limit than Settings saved: the
// shell.json entry was missing, unreadable, or hostile, so the helper fell
// back while Settings still shows the saved value.
function transactionLimitFallback(status, configured) {
  return !!status && status.available === true && status.limit !== configured
}

// One compact JSON object per line, with path, remote, exactTag and the
// checkout HEAD that proved that tag. The HEAD also binds later update reports
// to the exact checkout generation they inspected.
// JSON framing matters here: git config and filesystem names are untrusted,
// and tabs or newlines in either must stay data rather than becoming another
// checkout record. There is deliberately no legacy TSV fallback.
function parseGitMap(raw) {
  var map = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, "")
    if (line === "") continue
    var record
    try {
      record = JSON.parse(line)
    } catch (error) {
      continue
    }
    if (!record || Array.isArray(record) || typeof record !== "object") continue
    var keys = Object.keys(record).sort()
    if (keys.join(",") !== "ancestors,exactTag,headSha,path,remote") continue
    if (typeof record.path !== "string" || record.path === ""
        || typeof record.remote !== "string" || typeof record.exactTag !== "string"
        || typeof record.headSha !== "string" || typeof record.ancestors !== "string") continue
    var headSha = record.headSha === "" ? "" : normalizeGitObjectId(record.headSha)
    if (record.headSha !== "" && headSha === "") continue
    // Git ref names cannot contain controls. An impossible tag makes the
    // producer record malformed; it must not contribute provenance.
    if (/[\u0000-\u001f\u007f]/.test(record.exactTag)) continue
    // The most recent commits reachable from HEAD, newest first. One bad id
    // or an oversized list rejects the whole record: a partial ancestry could
    // hide a superseded snapshot for the wrong reason.
    var ancestors = parseAncestorList(record.ancestors)
    if (ancestors === null) continue
    map[record.path] = { remote: record.remote, exactTag: record.exactTag, headSha: headSha, ancestors: ancestors }
  }
  return map
}

var MAX_ANCESTORS = 128

// Newline-separated full object ids from `git rev-list --max-count`. Returns
// null for anything the producer could not have emitted.
function parseAncestorList(raw) {
  if (typeof raw !== "string") return null
  var lines = raw.split("\n")
  var out = []
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, "")
    if (line === "") continue
    var id = normalizeGitObjectId(line)
    if (id === "") return null
    out.push(id)
    if (out.length > MAX_ANCESTORS) return null
  }
  return out
}

// "<id>\t<author>\t<version>" per line, straight out of each manifest.json.
// Both trailing fields are routinely empty — a manifest is allowed to name
// neither — so, as with the git map, only the line ending may be trimmed.
function parseManifestMeta(raw) {
  var map = {}
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].replace(/\r$/, "").split("\t")
    if (parts.length < 2 || parts[0] === "") continue
    map[parts[0]] = {
      author: String(parts[1] || "").trim(),
      version: String(parts[2] || "").trim()
    }
  }
  return map
}

// Text that came from somewhere else — a public registry, a stranger's
// manifest, a checkout's git config — on its way to a Text item.
//
// Qt's Text defaults to `Text.AutoText`, which inspects the string and renders
// anything tag-shaped as rich text. `<img src="https://…">` in a plugin name
// is therefore a fetch, made by the long-lived shell process, chosen by
// whoever wrote the listing. The shell's own Ui components set no textFormat
// either, so this cannot be fixed only at the components this plugin owns:
// untrusted text is cleaned as it enters the model, once, and every sink
// downstream is safe by construction.
//
// Angle brackets go rather than get escaped: an escaped entity still trips
// AutoText's sniffing, and nothing legitimate in a plugin name or blurb needs
// them. Newlines go too — a one-line label is a place to hide the rest of a
// confirmation prompt.
function plainText(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
}

function indexById(entries) {
  var byId = {}
  for (var i = 0; i < (entries || []).length; i++) {
    var entry = entries[i]
    if (entry && entry.id) byId[String(entry.id)] = entry
  }
  return byId
}

function toStringList(value) {
  var out = []
  for (var i = 0; i < (value || []).length; i++) out.push(plainText(value[i]))
  return out
}

// `list` carries enabled/first-party state, `catalog` carries the source
// directory and description, `gitMap` says which checkouts a pull can reach
// and which exact version tag (if any) is proven at HEAD, and `manifestMeta`
// carries what only the manifest knows — who wrote it and what version is on
// disk. One row per plugin, joined on id.
function mergePlugins(listEntries, catalogEntries, gitMap, manifestMeta, layoutSections) {
  var catalog = indexById(catalogEntries)
  var git = gitMap || {}
  var manifests = manifestMeta || {}
  var layout = layoutSections || {}
  var rows = []

  for (var i = 0; i < (listEntries || []).length; i++) {
    var item = listEntries[i]
    if (!item || !item.id) continue

    var id = String(item.id)
    var meta = catalog[id] || {}
    var sourceDir = String(meta.sourceDir || "")
    var gitManaged = sourceDir !== "" && git.hasOwnProperty(sourceDir)
    var gitInfo = gitManaged ? (git[sourceDir] || {}) : {}
    var firstParty = item.firstParty === true
    var manifest = manifests[id] || {}

    rows.push({
      id: id,
      name: plainText(item.name || id),
      author: plainText(manifest.author),
      // Read at load time so every row can state its version, not just the
      // git-managed ones an update check happens to reach.
      localVersion: plainText(manifest.version),
      description: plainText(meta.description),
      kinds: toStringList(item.kinds && item.kinds.length ? item.kinds : meta.kinds),
      enabled: item.enabled === true,
      // Which section of the bar the widget sits in, as shell.json says, or
      // "" when it is not in the layout or the layout could not be read.
      barSection: typeof layout[id] === "string" && BAR_SECTIONS.indexOf(layout[id]) >= 0 ? layout[id] : "",
      // A bar has no off, only a successor — the shell says so per plugin
      // rather than making every caller work it out from kinds again.
      canDisable: item.canDisable === true,
      firstParty: firstParty,
      group: firstParty ? GROUP_BUILT_IN : GROUP_INSTALLED,
      clonedFrom: plainText(item.clonedFrom),
      sourceDir: sourceDir,
      remote: gitManaged ? plainText(gitInfo.remote) : "",
      // Authorization never reconstructs an origin from display sanitization.
      updateOrigin: gitManaged ? String(gitInfo.remote || "") : "",
      exactTag: gitManaged ? plainText(gitInfo.exactTag) : "",
      headSha: gitManaged ? normalizeGitObjectId(gitInfo.headSha) : "",
      ancestors: gitManaged && Array.isArray(gitInfo.ancestors) ? gitInfo.ancestors : [],
      gitManaged: gitManaged,
      // Built-ins live in /usr/share and are not ours to delete. Everything
      // under the user plugin directory — installed or cloned — is.
      removable: !firstParty && sourceDir !== "",
      // A checkout with no origin has nothing to fast-forward from, so it
      // gets the git badge but no update button — offering one that can only
      // fail is worse than offering none.
      updatable: gitManaged && String(gitInfo.remote || "") !== ""
    })
  }

  rows.sort(compareRows)
  return rows
}

// What you installed comes first: this panel exists to manage those, and the
// built-ins are the backdrop they sit against.
function compareRows(a, b) {
  if (a.firstParty !== b.firstParty) return a.firstParty ? 1 : -1
  var left = a.name.toLowerCase()
  var right = b.name.toLowerCase()
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function countRemovable(rows) {
  var total = 0
  for (var i = 0; i < (rows || []).length; i++) if (rows[i].removable) total++
  return total
}

// ---- Grouping -------------------------------------------------------------

// mergePlugins already sorts installed ahead of built-in, so each group is a
// contiguous run and these two slices reassemble into the original order —
// which is what lets one flat selection index address both lists.
function rowsInGroup(rows, group) {
  var out = []
  for (var i = 0; i < (rows || []).length; i++) if (rows[i].group === group) out.push(rows[i])
  return out
}

function groupLabel(group) {
  return group === GROUP_BUILT_IN ? "Built-in" : "Installed"
}

function sectionHeading(rows, group) {
  var count = rowsInGroup(rows, group).length
  return groupLabel(group).toUpperCase() + "  ·  " + count
}

// The two sections are a fixed pair, so unlike kinds the options need no
// deriving from the rows — and an empty section is still worth naming, since
// picking it is how you learn that it is empty.
function groupOptions() {
  return [
    { value: ALL_GROUPS, label: "All" },
    { value: GROUP_INSTALLED, label: groupLabel(GROUP_INSTALLED) },
    { value: GROUP_BUILT_IN, label: groupLabel(GROUP_BUILT_IN) }
  ]
}

function filterByGroup(rows, group) {
  if (!group || group === ALL_GROUPS) return rows || []
  if (group !== GROUP_INSTALLED && group !== GROUP_BUILT_IN) return []
  return rowsInGroup(rows, group)
}

// ---- Kinds ----------------------------------------------------------------

// Compact filter labels. "bar-widget" is the id the manifest uses, but full
// kind names waste the limited width of the filter row.
var KIND_LABELS = {
  "bar-widget": "Widget",
  "panel": "Panel",
  "overlay": "Overlay",
  "menu": "Menu",
  "service": "Service",
  "bar": "Bar"
}

function kindLabel(kind) {
  var name = String(kind)
  return KIND_LABELS.hasOwnProperty(name) ? KIND_LABELS[name] : name
}

// A plugin that replaces the whole bar and one that mounts inside it both
// answer "what is in my bar?", so two options asked the same question twice.
// They fold into one for filtering only — a row still names its own kind.
var FILTER_KIND_ALIASES = {
  "bar": "bar-widget"
}

function filterKind(kind) {
  var name = String(kind)
  return FILTER_KIND_ALIASES.hasOwnProperty(name) ? FILTER_KIND_ALIASES[name] : name
}

// The merged option covers two kinds, so it cannot borrow either one's row
// label without claiming to be narrower than it is.
var FILTER_KIND_LABELS = {
  "bar-widget": "Bar-widget"
}

function filterKindLabel(kind) {
  var name = filterKind(kind)
  return FILTER_KIND_LABELS.hasOwnProperty(name) ? FILTER_KIND_LABELS[name] : kindLabel(name)
}

function kindsLabel(kinds) {
  var parts = []
  for (var i = 0; i < (kinds || []).length; i++) parts.push(kindLabel(kinds[i]))
  return parts.length ? parts.join(" · ") : "no kind"
}

// Derived from what is actually installed rather than from a fixed list, so a
// kind this build has never heard of still gets an option instead of being
// quietly unfilterable.
function kindOptions(rows) {
  var seen = {}
  for (var i = 0; i < (rows || []).length; i++) {
    var kinds = rows[i].kinds || []
    for (var j = 0; j < kinds.length; j++) seen[filterKind(kinds[j])] = true
  }

  var names = Object.keys(seen).sort()
  var options = [{ value: ALL_KINDS, label: "All" }]
  for (var k = 0; k < names.length; k++) options.push({ value: names[k], label: filterKindLabel(names[k]) })
  return options
}

function hasFilterKind(row, wanted) {
  var kinds = (row && row.kinds) || []
  for (var i = 0; i < kinds.length; i++) {
    if (filterKind(kinds[i]) === wanted) return true
  }
  return false
}

function filterByKind(rows, kind) {
  if (!kind || kind === ALL_KINDS) return rows || []
  var wanted = filterKind(kind)
  var out = []
  for (var i = 0; i < (rows || []).length; i++) {
    if (hasFilterKind(rows[i], wanted)) out.push(rows[i])
  }
  return out
}

// Enabled state and update availability are already authoritative row facts.
// Filtering projects those booleans; it does not maintain another status.
function statusOptions() {
  return [
    { value: ALL_STATUSES, label: "All" },
    { value: STATUS_ENABLED, label: "Enabled" },
    { value: STATUS_DISABLED, label: "Disabled" },
    { value: STATUS_UPDATE, label: "Update" }
  ]
}

function filterByStatus(rows, status) {
  if (!status || status === ALL_STATUSES) return rows || []
  if (status !== STATUS_ENABLED && status !== STATUS_DISABLED && status !== STATUS_UPDATE) return []

  var out = []
  for (var i = 0; i < (rows || []).length; i++) {
    if (status === STATUS_UPDATE) {
      if (rows[i].behind === true) out.push(rows[i])
    } else if (rows[i].enabled === (status === STATUS_ENABLED)) {
      out.push(rows[i])
    }
  }
  return out
}

// ---- Search ---------------------------------------------------------------

// Name and id both, because the id is the namespaced form of the name and
// typing "hyprmoncfg" should find `crmne.hyprmoncfg`. Descriptions are
// deliberately excluded: a search that matched prose would surface plugins
// whose names look nothing like what was typed, which reads as a bug.
function matchesQuery(row, query) {
  var needle = String(query || "").trim().toLowerCase()
  if (needle === "") return true
  if (!row) return false
  return String(row.name || "").toLowerCase().indexOf(needle) >= 0
    || String(row.id || "").toLowerCase().indexOf(needle) >= 0
}

function filterRows(rows, kind, status, query, group) {
  var byGroup = filterByGroup(rows, group)
  var byKind = filterByKind(byGroup, kind)
  var byStatus = filterByStatus(byKind, status)
  if (String(query || "").trim() === "") return byStatus

  var out = []
  for (var i = 0; i < byStatus.length; i++) {
    if (matchesQuery(byStatus[i], query)) out.push(byStatus[i])
  }
  return out
}

function isFiltering(kind, status, query, group) {
  return (kind !== undefined && kind !== null && kind !== ALL_KINDS)
    || (status !== undefined && status !== null && status !== ALL_STATUSES)
    || (group !== undefined && group !== null && group !== ALL_GROUPS)
    || String(query || "").trim() !== ""
}

// Naming what actually excluded everything, so an empty list is never a
// mystery — one active dropdown behind another is easy to forget about.
function emptyMessage(kind, status, query, group) {
  var needle = String(query || "").trim()
  var updateNarrowed = status === STATUS_UPDATE
  var statusNarrowed = status === STATUS_ENABLED || status === STATUS_DISABLED
  // Each narrowing control contributes one word, in the order they read
  // naturally: "disabled built-in service plugins".
  var groupWord = group && group !== ALL_GROUPS ? groupLabel(group).toLowerCase() + " " : ""
  var kindWord = kind && kind !== ALL_KINDS ? filterKindLabel(kind).toLowerCase() + " " : ""
  var subject = groupWord + kindWord

  if (updateNarrowed) {
    if (needle !== "") return "No confirmed " + subject + "plugin updates match “" + needle + "”."
    if (subject !== "") return "No confirmed " + subject + "plugin updates found."
    return "No confirmed updates found."
  }
  var scope = (statusNarrowed ? status + " " : "") + subject
  if (needle !== "") return "No " + scope + "plugins match “" + needle + "”."
  return "No " + scope + "plugins found."
}

// Wraps around, so a cycle key never dead-ends on the last option. Any
// {value, label} list will do — every dropdown in the panel is one.
function nextOption(options, current) {
  var list = options || []
  if (list.length === 0) return ALL_KINDS
  for (var i = 0; i < list.length; i++) {
    if (list[i].value === current) return list[(i + 1) % list.length].value
  }
  return list[0].value
}

function nextKind(options, current) {
  return nextOption(options, current)
}

// ---- Row text -------------------------------------------------------------

// Who published this. The manifest is the honest source, but plenty of them
// leave `author` out — and an Omarchy id is namespaced by its publisher, so
// the prefix says the same thing. An id with no namespace says nothing, and
// echoing it back as an author would be a guess dressed up as a fact.
function authorLabel(row) {
  if (!row) return ""
  var author = String(row.author || "").trim()
  if (author !== "") return author
  var id = String(row.id || "")
  var dot = id.indexOf(".")
  return dot > 0 ? id.slice(0, dot) : ""
}

// The line under the name: who made it and what it plugs into. The id is not
// here — the name above says which plugin this is, and the namespace already
// surfaces as the author.
function metaLine(row) {
  if (!row) return ""
  var author = authorLabel(row)
  var kinds = kindsLabel(row.kinds)
  return author === "" ? kinds : author + "  ·  " + kinds
}

// A plugin with no description is a fact worth stating: it means the author
// left it out of the manifest, not that the panel failed to read it.
function descriptionLine(row) {
  if (!row) return ""
  var text = String(row.description || "").trim()
  return text !== "" ? text : "No description in this plugin's manifest."
}

function hasDescription(row) {
  return !!row && String(row.description || "").trim() !== ""
}

// Built-ins live in /usr/share and are never removed or pulled, so the badge
// would only ever repeat what their section header already said.
function sourceBadge(row) {
  if (!row || row.firstParty) return ""
  return row.gitManaged ? "git" : "local"
}

function normalizeGitUrl(raw) {
  return String(raw || "").trim()
}

function lastLine(text) {
  var lines = String(text || "").split("\n")
  for (var i = lines.length - 1; i >= 0; i--) {
    var line = lines[i].trim()
    if (line !== "") return line
  }
  return ""
}

// ---- Enabling -------------------------------------------------------------
//
// Installing a plugin and running it are two different things. `omarchy plugin
// add` clones the folder and registers the manifest; a bar widget still has no
// place in the bar until someone says which section it goes in. That is why a
// freshly installed widget sits in the list greyed out — it is not broken, it
// is unplaced — and why the section has to be asked for rather than guessed.

var BAR_SECTIONS = ["left", "center", "right"]

// By id, never by index: a background reload can rebuild the list while a
// question about one of its rows is still on screen.
function findRow(rows, id) {
  var wanted = String(id || "")
  if (wanted === "") return null
  for (var i = 0; i < (rows || []).length; i++) {
    if (rows[i] && String(rows[i].id) === wanted) return rows[i]
  }
  return null
}

function canEnable(row) {
  return !!row && String(row.id || "") !== "" && row.enabled !== true
}

// A bar widget takes a place in a section. A plugin whose kind is `bar` IS the
// bar — it replaces the one in use rather than sitting inside it — and
// `omarchy plugin enable` fails outright if handed a placement for one.
// The exact inverse of enable: it takes a widget out of the bar layout and
// leaves the plugin on disk, so it is not destructive and asks nothing.
function canDisable(row) {
  return !!row && String(row.id || "") !== "" && row.enabled === true && row.canDisable === true
}

// Both of these end up in a desktop notification rather than the panel's own
// status line: switching a bar widget on or off rewrites `bar.layout`, the bar
// rebuilds its widgets, and this panel is torn down with them before it could
// show anything.
function enableNote(section) {
  if (BAR_SECTIONS.indexOf(String(section || "")) < 0) return "It is switched on now."
  return "It has a place in the " + section + " section of the bar now."
}

function disableNote() {
  return "It is off the bar, but still installed."
}

function disableCommand(row) {
  if (!row || String(row.id || "") === "") return []
  return ["omarchy", "plugin", "disable", String(row.id)]
}

function needsPlacement(row) {
  if (!row) return false
  var kinds = row.kinds || []
  if (kinds.indexOf("bar") >= 0) return false
  return kinds.indexOf("bar-widget") >= 0
}

function placementOptions() {
  return [
    { value: "left", label: "Left" },
    { value: "center", label: "Center" },
    { value: "right", label: "Right" }
  ]
}

// The section reaches a CLI as an argv element. It comes from a fixed set of
// buttons today, but it is checked against the same fixed set here anyway —
// the guarantee should live with the command, not with whichever UI happens to
// be calling it.
function enableCommand(row, section) {
  if (!row || String(row.id || "") === "") return []
  var command = ["omarchy", "plugin", "enable", String(row.id)]
  if (BAR_SECTIONS.indexOf(String(section || "")) >= 0) command.push(String(section))
  return command
}

// Restarting the shell restarts the process this panel lives in, so the
// command runs detached (PluginStore.runDetached) and carries no data at all:
// one constant script, in one argv, that drops Quickshell's compiled-QML
// cache and then hands the restart to the host's own command. The cache is
// wherever Qt keeps it, `quickshell/qmlcache` under $XDG_CACHE_HOME, and a
// real directory there is the only thing removed: a symlink planted on that
// name is left where it is rather than followed. A cache that is not there
// yet is nothing to remove, not a reason to skip the restart.
var RESTART_SHELL_SCRIPT = ""
  + "set -u; "
  + "cache=\"${XDG_CACHE_HOME:-$HOME/.cache}/quickshell/qmlcache\"; "
  + "if [ -d \"$cache\" ] && [ ! -L \"$cache\" ]; then rm -rf -- \"$cache\" || exit 1; fi; "
  + "exec omarchy restart shell"

function restartShellCommand() {
  return ["bash", "-c", RESTART_SHELL_SCRIPT, "restart-shell"]
}

// Moving is enabling with a section: `omarchy plugin enable <id> <section>`
// hands the placement to the shell, which moves a widget that is already in
// the bar rather than adding it a second time. Only a widget that takes a
// place in a section can move, and only one whose current section the loader
// could read: the control names where it is, so it has to know.
function canMove(row) {
  return !!row && String(row.id || "") !== "" && row.enabled === true
    && needsPlacement(row) && BAR_SECTIONS.indexOf(String(row.barSection || "")) >= 0
}

// The choices for a widget already in the bar: everywhere but where it is.
function moveOptions(currentSection) {
  var options = placementOptions()
  var out = []
  for (var i = 0; i < options.length; i++) {
    if (options[i].value !== String(currentSection || "")) out.push(options[i])
  }
  return out
}

// Checked against the fixed set here, like enableCommand, and against the
// section the row is in: moving a widget to where it already sits is not a
// command worth running.
function moveCommand(row, section) {
  if (!canMove(row)) return []
  var target = String(section || "")
  if (BAR_SECTIONS.indexOf(target) < 0 || target === row.barSection) return []
  return ["omarchy", "plugin", "enable", String(row.id), target]
}

function moveNote(section) {
  return "It is in the " + section + " section of the bar now."
}

// Arranger snapshots use the raw host layout, never the ID-collapsed plugin list.
// Reject rather than compact: every index must still identify the host entry.
function barLayoutSnapshot(raw) {
  var nodes = 8192, units = 65536
  function copy(value, depth) {
    if (--nodes < 0 || depth > 12) throw new Error("Layout exceeds limits")
    if (typeof value === "string") {
      units -= value.length
      if (units < 0) throw new Error("Layout exceeds limits")
      return value
    }
    if (value === null || typeof value === "boolean") return value
    if (typeof value === "number" && isFinite(value)) return value
    if (!value || typeof value !== "object") throw new Error("Invalid layout value")
    var array = Array.isArray(value)
    if (!array && Object.getPrototypeOf(value) !== Object.prototype
        && Object.getPrototypeOf(value) !== null) throw new Error("Invalid layout object")
    var keys = Object.keys(value)
    if (keys.length > nodes || (array && keys.length !== value.length))
      throw new Error("Invalid layout size")
    if (!array) keys.sort()
    var result = array ? [] : Object.create(null)
    for (var i = 0; i < keys.length; i++) {
      var key = array ? String(i) : keys[i]
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error("Sparse layout")
      units -= key.length
      if (units < 0) throw new Error("Layout exceeds limits")
      result[key] = copy(value[key], depth + 1)
    }
    return Object.freeze(result)
  }
  try {
    if (!raw || Array.isArray(raw) || Object.keys(raw).length !== 3) return null
    for (var s = 0; s < BAR_SECTIONS.length; s++) {
      if (!Array.isArray(raw[BAR_SECTIONS[s]]) || raw[BAR_SECTIONS[s]].length > 128) return null
    }
    var layout = copy(raw, 0), rows = []
    for (var sectionIndex = 0; sectionIndex < BAR_SECTIONS.length; sectionIndex++) {
      var section = BAR_SECTIONS[sectionIndex]
      for (var index = 0; index < layout[section].length; index++) {
        var entry = layout[section][index]
        var id = typeof entry === "string" ? entry : entry && !Array.isArray(entry) ? entry.id : null
        // Match PluginRegistry's ID rules; size is bounded across the snapshot.
        if (typeof id !== "string" || id.length === 0 || id.indexOf("/") >= 0 || id.indexOf("..") >= 0) return null
        rows.push(Object.freeze({ id: id, section: section, index: index, entry: entry }))
      }
    }
    return Object.freeze({ layout: layout, rows: Object.freeze(rows), key: JSON.stringify(layout) })
  } catch (error) { return null }
}

// gap is an insertion slot in the displayed, PRE-removal destination (0..length).
// Check the entire latest layout immediately before dispatch; this is not host CAS.
function barLayoutMove(snapshot, latest, fromSection, fromIndex, section, gap) {
  var before = barLayoutSnapshot(snapshot && snapshot.layout)
  var current = barLayoutSnapshot(latest)
  if (!before || !current || before.key !== current.key
      || BAR_SECTIONS.indexOf(fromSection) < 0 || BAR_SECTIONS.indexOf(section) < 0
      || typeof fromIndex !== "number" || !isFinite(fromIndex) || Math.floor(fromIndex) !== fromIndex
      || typeof gap !== "number" || !isFinite(gap) || Math.floor(gap) !== gap
      || fromIndex < 0 || fromIndex >= before.layout[fromSection].length
      || gap < 0 || gap > before.layout[section].length) return null
  var target = gap - (fromSection === section && gap > fromIndex ? 1 : 0)
  var noOp = fromSection === section && target === fromIndex
  var next = JSON.parse(before.key)
  var entry = next[fromSection].splice(fromIndex, 1)[0]
  next[section].splice(target, 0, entry)
  var id = typeof entry === "string" ? entry : entry.id
  // Host-valid does not always mean argv-representable: NUL, unpaired UTF-16,
  // and >=128 KiB UTF-8 arguments cannot safely traverse this Linux CLI path.
  // Keep those entries in the snapshot, but never dispatch a lossy/truncated ID.
  try {
    if (id.indexOf("\u0000") >= 0 || encodeURIComponent(id).replace(/%[0-9A-F]{2}/g, "x").length >= 131072) return null
  } catch (error) { return null }
  var expected = barLayoutSnapshot(next)
  if (!expected) return null
  return Object.freeze({ noOp: noOp, expected: expected,
    // Bypass the generic dispatcher, which intercepts --help/-h even as IDs.
    command: Object.freeze(noOp ? [] : ["omarchy-bar", "move", id,
      "--from-section", fromSection, "--from-index", String(fromIndex),
      "--section", section, "--index", String(target)]) })
}

// Popup section choices use the retained positional mover; moveCommand stays for the direct form.
// Return its arguments, not a dispatch: startBarMove must recheck the latest layout.
function barSectionMovePlan(row, raw, section) {
  if (!canMove(row)) return null
  var target = String(section || "")
  if (BAR_SECTIONS.indexOf(target) < 0 || target === row.barSection) return null
  var snapshot = barLayoutSnapshot(raw)
  if (!snapshot) return null
  var source = null
  for (var i = 0; i < snapshot.rows.length; i++) {
    if (snapshot.rows[i].id === String(row.id)) { source = snapshot.rows[i]; break }
  }
  // Legacy ID moves select the first occurrence across left/center/right.
  // A stale row must not silently move a different section's duplicate.
  if (!source || source.section !== row.barSection) return null
  var anchors = { left: "omarchy.workspaces", center: "omarchy.weather", right: "omarchy.tray" }
  var gap = snapshot.layout[target].length
  for (var j = 0; j < snapshot.rows.length; j++) {
    var candidate = snapshot.rows[j]
    if (candidate.section === target && candidate.id === anchors[target]) {
      gap = candidate.index + 1
      break
    }
  }
  // Current-section choices were rejected: source removal cannot shift this
  // destination, so the host's post-removal index is also our pre-removal gap.
  if (!barLayoutMove(snapshot, raw, source.section, source.index, target, gap)) return null
  return Object.freeze({ snapshot: snapshot, fromSection: source.section,
    fromIndex: source.index, section: target, gap: gap })
}

function actionVerb(kind) {
  if (kind === "update") return "Update"
  if (kind === "bulk-update") return "Update"
  if (kind === "remove") return "Remove"
  if (kind === "enable") return "Enable"
  if (kind === "disable") return "Disable"
  if (kind === "move") return "Move"
  return "Action"
}

function successMessage(kind, label) {
  if (kind === "update") return "Updated " + label
  if (kind === "remove") return "Removed " + label
  if (kind === "enable") return "Enabled " + label
  if (kind === "disable") return "Disabled " + label
  if (kind === "move") return "Moved " + label
  return "Done"
}

// The CLI's own last line of stderr is almost always the useful sentence.
// When it says nothing, the exit code is at least honest about the failure.
function failureMessage(kind, stderrText, exitCode) {
  var detail = lastLine(stderrText)
  if (detail !== "") return actionVerb(kind) + " failed: " + detail
  return actionVerb(kind) + " failed (exit " + String(exitCode) + ")"
}

// "Updateing" is what naive suffixing gets you; the in-flight line reads too
// often to leave it broken.
function actionGerund(kind) {
  if (kind === "update") return "Updating"
  if (kind === "remove") return "Removing"
  if (kind === "enable") return "Enabling"
  if (kind === "disable") return "Disabling"
  if (kind === "move") return "Moving"
  return "Working"
}

// ---- Marketplace catalog --------------------------------------------------
//
// omarchyplugins.com publishes a resolved catalog. This panel reads only what
// it needs to manage installed plugins: who is verified, GitHub star counts,
// and the one commit the marketplace reviewed for each listing (the only
// snapshot a verified update may install).

var ALL_CATEGORIES = "all"

function parseCatalog(raw) {
  try {
    var doc = JSON.parse(String(raw || "").trim())
    if (!doc || !Array.isArray(doc.plugins)) return null
    return doc
  } catch (error) {
    return null
  }
}

// Raw catalog text in, stamped entries out — everything the worker thread
// needs in one pure call, so the main thread never parses 2MB of JSON or
// sanitises thirty thousand fields while the shell should be answering IPC.
function buildCatalog(raw) {
  var doc = parseCatalog(raw)
  if (!doc) return { entries: null, error: "Could not read the plugin catalog" }
  // A hostile field (an object whose toString is not callable) makes the
  // sanitizers throw; that is an unreadable catalog, not a crash.
  try {
    return { entries: catalogEntries(doc), error: "" }
  } catch (error) {
    return { entries: null, error: "Could not read the plugin catalog" }
  }
}

// The marketplace is the only party that says who passed its security
// baseline, so the Installed rows learn it by id from the same catalog the
// panel's star counts come from. Null prototype so hostile ids stay data.
function verifiedIdSet(entries) {
  var set = Object.create(null)
  for (var i = 0; i < (entries || []).length; i++) {
    var entry = entries[i]
    if (entry && entry.id && entry.verified === true) set[String(entry.id)] = true
  }
  return set
}

// One catalog count per plugin id, from the marketplace catalog, so an
// installed row can wear the counts its listing has. Same null-prototype set
// discipline as verifiedIdSet: ids are untrusted property names. Unknown
// counts are left out; a real zero is kept.
function catalogCountById(entries, field) {
  var counts = Object.create(null)
  for (var i = 0; i < (entries || []).length; i++) {
    var entry = entries[i]
    if (!entry || !entry.id) continue
    var count = catalogCount(entry[field])
    if (count !== null) counts[String(entry.id)] = count
  }
  return counts
}

function rowCountLabel(row, countsById) {
  if (!row || !row.id || !hasOwnKey(countsById, row.id)) return ""
  return starLabel(countsById[String(row.id)])
}

// GitHub stars per plugin id.
function catalogStarsById(entries) {
  return catalogCountById(entries, "stars")
}

function rowStarLabel(row, starsById) {
  return rowCountLabel(row, starsById)
}

function isVerified(row, verifiedIds) {
  return !!(row && row.id) && hasOwnKey(verifiedIds, row.id)
}

function hasOwnKey(object, key) {
  return object !== null && object !== undefined
    && Object.prototype.hasOwnProperty.call(object, String(key))
}

// Counts are remote facts, so malformed and absent values remain unknown. In
// particular, coercing either to zero would display a number the source never
// supplied. A real zero is preserved and may be shown.
function catalogCount(value) {
  if (typeof value !== "number" || !isFinite(value)) return null
  if (value < 0 || Math.floor(value) !== value || value > 9007199254740991) return null
  return value
}

function catalogEntries(doc) {
  if (!doc || !Array.isArray(doc.plugins)) return []
  var out = []
  var ids = Object.create(null)
  for (var n = 0; n < doc.plugins.length; n++) {
    var rawId = doc.plugins[n] && doc.plugins[n].id
    if (typeof rawId === "string") ids[rawId] = (ids[rawId] || 0) + 1
  }

  for (var i = 0; i < doc.plugins.length; i++) {
    var p = doc.plugins[i]
    if (!p || !p.id) continue
    // Built-ins ship with Omarchy and have no listing to verify against.
    if (p.sourceType === "builtin") continue

    out.push({
      id: plainText(p.id),
      name: plainText(p.name || p.id),
      repo: plainText(p.repo),
      verified: p.verificationStatus === "verified",
      stars: catalogCount(p.stars),
      // The one commit the marketplace actually reviewed. Verification is a
      // statement about this snapshot, not about the branch it came from.
      updateSnapshot: ids[p.id] === 1 ? catalogUpdateSnapshot(p) : null
    })
  }

  return out
}

// ---- Key hints --------------------------------------------------------------

function optionLabel(options, value) {
  for (var i = 0; i < (options || []).length; i++) {
    if (options[i].value === value) return String(options[i].label)
  }
  return String(value || "")
}

// The Installed list's filter row: three dropdowns.
function installedFilterHints(filters, options) {
  var f = filters || {}
  var o = options || {}
  var groupNeutral = !f.group || f.group === ALL_GROUPS
  var kindNeutral = !f.kind || f.kind === ALL_KINDS
  var statusNeutral = !f.status || f.status === ALL_STATUSES
  return [
    { key: "s", active: !groupNeutral,
      text: groupNeutral ? "SOURCE" : optionLabel(o.group, f.group).toUpperCase() },
    { key: "f", active: !kindNeutral,
      text: kindNeutral ? "KIND" : optionLabel(o.kind, f.kind).toUpperCase() },
    { key: "t", active: !statusNeutral,
      text: statusNeutral ? "STATUS" : optionLabel(o.status, f.status).toUpperCase() }
  ]
}

// The other end of the same bar: what Enter, Delete, and / do on this tab.
// Refresh and the tab switch have buttons in the header and Escape closes
// every panel, so none of those earn a column here.
function actionHints(bulkUpdateAvailable) {
  return [
    { key: "u", text: "UPDATE ALL", active: bulkUpdateAvailable === true },
    { key: "↵", text: "UPDATE", active: false },
    { key: "⌦", text: "REMOVE", active: false },
    { key: "/", text: "SEARCH", active: false }
  ]
}

function starLabel(count) {
  var stars = catalogCount(count)
  if (stars === null) return ""
  if (stars >= 1000) return (Math.round(stars / 100) / 10) + "k"
  return String(stars)
}

// ---- Star actions -----------------------------------------------------------
//
// The repository a star would act on: an exact GitHub slug, or "" when the
// listing names nothing starrable. githubRepoSlug already narrows to an exact
// owner/repo, so the slug stays a path segment and can never become an option.
function starSlugFor(entry) {
  if (!entry) return ""
  return githubRepoSlug(entry.repo)
}

function starToggleCommand(helperPath, slug) {
  if (typeof helperPath !== "string" || helperPath === ""
      || typeof slug !== "string" || slug === ""
      || githubRepoSlug("https://github.com/" + slug) !== slug) return []
  return ["/usr/bin/python3", "-I", "-S", helperPath, slug]
}

function parseStarResult(text, exitCode) {
  var failed = { kind: "failed" }
  if (exitCode !== 0 || typeof text !== "string" || text.length > 256) return failed
  var result = null
  try {
    result = JSON.parse(text)
  } catch (error) {
    return failed
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) return failed
  var keys = Object.keys(result)
  if (result.kind === "changed" && keys.length === 2 && typeof result.starred === "boolean")
    return { kind: "changed", starred: result.starred }
  if (keys.length === 1 && (result.kind === "fallback" || result.kind === "failed"))
    return { kind: result.kind }
  return failed
}

// Optimistic count moves after a successful toggle. Unknown stays unknown:
// a missing count is not a zero, and bumping it would invent a number the
// source never supplied.
function bumpCount(count, delta) {
  var base = catalogCount(count)
  if (base === null) return null
  return Math.max(0, base + delta)
}

// "https://github.com/acme/omarchy-weather" -> "acme/omarchy-weather". The
// host is the same for effectively every listing, so printing it on each card
// spends width on the one part that carries no information.
function repoShortLabel(url) {
  var text = normalizeGitUrl(url).replace(/\.git$/, "").replace(/\/+$/, "")
  var match = text.match(/^https?:\/\/[^\/]+\/(.+)$/)
  if (match) return match[1]
  var scp = text.match(/^git@[^:]+:(.+)$/)
  if (scp) return scp[1]
  return text
}

// Only http(s) is ever handed to a web viewer. The repo field arrives over the
// network, and a url that is not a web page has no business being opened as
// one — javascript:, file:, and anything else are refused rather than passed
// through to the launcher.
function browsableUrl(url) {
  var text = normalizeGitUrl(url)
  if (/\s/.test(text)) return ""
  return /^https:\/\/[^\/\s]+\/.*/.test(text) ? text : ""
}

// Plugin repositories overwhelmingly ship a preview.png at their root — 31 of
// a 40-repo sample — and PNG is a format Qt always reads. The registry's own
// thumbnails are WebP, which needs an optional system package, so the repo's
// own screenshot is tried first and the curated thumbnail is the fallback
// rather than the other way round.
// An installed plugin names its origin the way git does — an scp-style
// `git@host:owner/repo.git`, an ssh:// url, a trailing .git — none of which a
// web viewer opens. This converts what it recognises and then hands the result
// to browsableUrl, so there stays exactly one place that decides whether a
// string is safe to launch.
function repoWebUrl(url) {
  var text = normalizeGitUrl(url)
  if (text === "") return ""

  var scp = text.match(/^[^@\s]+@([^:\s]+):(.+)$/)
  if (scp) text = "https://" + scp[1] + "/" + scp[2]
  else text = text.replace(/^ssh:\/\/(?:[^@\/\s]+@)?/, "https://")

  return browsableUrl(text.replace(/\.git$/, "").replace(/\/+$/, ""))
}

// Where the row's plugin lives on the web. The origin remote first: that is
// where an update actually pulls from. `clonedFrom` is only a record of how
// the plugin first arrived, and a checkout can be repointed since.
function rowRepoUrl(row) {
  if (!row) return ""
  return repoWebUrl(row.remote) || repoWebUrl(row.clonedFrom)
}

// Only an exact two-segment GitHub repository is eligible for URLs that claim
// something about repository contents. Other hosts remain valid row links;
// they simply do not gain GitHub-specific paths by inference.
function githubRepoSlug(url) {
  var web = repoWebUrl(url)
  var match = web.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)$/i)
  if (!match) return ""

  var owner = match[1]
  var repo = match[2]
  // GitHub owner names are at most 39 alphanumeric/hyphen characters and may
  // not start or end with a hyphen. Repository names are at most 100
  // alphanumeric/dot/underscore/hyphen characters; dot path segments are not
  // repositories. The narrow character sets also reject percent escapes,
  // backslashes, queries and fragments before a web viewer can normalize them.
  if (owner.length > 39 || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(owner)) return ""
  if (repo.length > 100 || !/^[A-Za-z0-9._-]+$/.test(repo) || repo === "." || repo === "..") return ""
  return owner + "/" + repo
}

// Manifest versions are display data first and untrusted URL path data second.
// Plain-text normalization matches the row label; the bound prevents a crafted
// manifest from producing unreasonably large probe URLs.
function normalizedManifestVersion(value) {
  var text = plainText(value).trim()
  return text !== "" && text.length <= 100 ? text : ""
}

// Release names conventionally add one `v` to the manifest version. Catalogs
// and manifests are not consistent about whether they already included it, so
// remove every leading v/V before constructing either the display label or the
// ordered release candidates. A value made only of prefixes is not a version.
function normalizedReleaseVersion(value) {
  var text = normalizedManifestVersion(value)
  while (text.length > 0 && text.charAt(0).toLowerCase() === "v") text = text.substr(1)
  return text
}

function releaseVersionLabel(value) {
  var version = normalizedReleaseVersion(value)
  return version === "" ? "" : "v" + version
}

// Local tag proof is no longer link eligibility. It remains the best fallback
// because it names the exact source ref already proven at this checkout's HEAD.
function provenLocalTag(row) {
  if (!row || row.gitManaged !== true) return ""

  var version = normalizedReleaseVersion(row.localVersion)
  var exactTag = String(row.exactTag || "").trim()
  if (version === "" || (exactTag !== version && exactTag !== "v" + version)) return ""
  if (/[\u0000-\u001f\u007f]/.test(exactTag)) return ""
  return exactTag
}

function githubTagUrl(remote, tag, base, path) {
  var slug = githubRepoSlug(remote)
  if (slug === "" || tag === "" || tag.length > 256) return ""
  return base + slug + path + encodeURIComponent(tag)
}

function githubReleaseCandidates(remote, versionValue) {
  var version = normalizedReleaseVersion(versionValue)
  if (version === "" || githubRepoSlug(remote) === "") return []

  var names = ["v" + version, version]
  var seen = {}, out = []
  for (var i = 0; i < names.length; i++) {
    var name = names[i]
    if (seen[name]) continue
    seen[name] = true
    out.push({
      probeUrl: githubTagUrl(remote, name,
        "https://api.github.com/repos/", "/releases/tags/"),
      preferredUrl: githubTagUrl(remote, name,
        "https://github.com/", "/releases/tag/")
    })
  }
  return out
}

function versionReleaseCandidates(row) {
  if (!row || row.gitManaged !== true) return []
  return githubReleaseCandidates(row.remote, row.localVersion)
}

// Release absence never weakens provenance: fall back from a locally proven
// version tag, to the loaded checkout commit, to the validated current origin.
function versionFallbackUrl(row) {
  if (versionReleaseCandidates(row).length === 0) return ""
  var exactTag = provenLocalTag(row)
  if (exactTag !== "") return githubTagUrl(
    row.remote, exactTag, "https://github.com/", "/tree/")
  var headSha = normalizeGitObjectId(row.headSha)
  if (headSha !== "") return githubTagUrl(
    row.remote, headSha, "https://github.com/", "/tree/")
  return githubRepositoryUrl(row.remote)
}

function githubRepositoryUrl(remote) {
  var slug = githubRepoSlug(remote)
  return slug === "" ? "" : "https://github.com/" + slug
}

// ---- Update checks ---------------------------------------------------------
//
// Whether a plugin has an update is decided by commits, not by version
// strings. Authors do not reliably bump the manifest on every change — two of
// the checkouts this was built against were genuinely behind while reporting
// the same version at both ends — so a version comparison would have shown
// nothing for a real update. The local and remote HEAD are the truth; the
// version pair is shown alongside only when it actually says something.

// Remote manifest versions are untrusted input that may become Git ref
// arguments. Keep the accepted shape deliberately narrower than Git itself:
// it covers conventional release versions, caps work sent to git/URLs, and
// rejects every ref metacharacter that has caused ambiguous revisions.
function normalizeGitObjectId(value) {
  var text = String(value || "")
  return /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(text) ? text.toLowerCase() : ""
}

// One compact JSON object per checkout. Filesystem paths and manifest versions
// are untrusted, so JSON escaping — not tabs and newlines — owns the framing.
// There is deliberately no legacy TSV fallback.
function parseUpdateReport(raw) {
  var map = {}
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, "")
    if (line === "") continue
    var record
    try {
      record = JSON.parse(line)
    } catch (error) {
      continue
    }
    if (!record || Array.isArray(record) || typeof record !== "object") continue
    var keys = Object.keys(record).sort()
    if (keys.join(",") !== "localSha,localVersion,path,remoteSha,remoteVersion") continue
    if (typeof record.path !== "string" || record.path === ""
        || typeof record.localSha !== "string" || typeof record.remoteSha !== "string"
        || typeof record.localVersion !== "string" || typeof record.remoteVersion !== "string") continue

    var localSha = record.localSha === "" ? "" : normalizeGitObjectId(record.localSha)
    var remoteSha = record.remoteSha === "" ? "" : normalizeGitObjectId(record.remoteSha)
    if ((record.localSha !== "" && localSha === "")
        || (record.remoteSha !== "" && remoteSha === "")) continue

    map[record.path] = {
      localSha: localSha,
      remoteSha: remoteSha,
      localVersion: plainText(record.localVersion),
      remoteVersion: plainText(record.remoteVersion)
    }
  }
  return map
}

// An unreachable remote reports an empty sha. That is "we could not tell",
// which must not render as "up to date" — being quietly told nothing is how a
// stale plugin sits there for months looking current.
function applyUpdateReport(rows, report) {
  var byDir = report || {}
  var out = []

  for (var i = 0; i < (rows || []).length; i++) {
    var row = rows[i]
    var info = byDir[row.sourceDir]
    var copy = {}
    for (var key in row) copy[key] = row[key]

    // A report describes one checkout generation, not merely one filesystem
    // path. A reload may rebuild the same row after pull or an external
    // checkout change while an older process is still finishing. Only the
    // freshly loaded HEAD can authorize that report to restore update state.
    var loadedHead = normalizeGitObjectId(row.headSha)
    var reportHead = info ? normalizeGitObjectId(info.localSha) : ""
    var usableInfo = loadedHead !== "" && reportHead !== "" && loadedHead === reportHead
      ? info
      : null
    copy.headSha = loadedHead

    // The git pass only reaches checkouts with a remote. Everything else keeps
    // the version the manifest already gave it at load time.
    var reportedLocalVersion = usableInfo ? plainText(usableInfo.localVersion) : ""
    copy.localVersion = reportedLocalVersion !== "" ? reportedLocalVersion : plainText(row.localVersion)
    copy.remoteVersion = usableInfo ? plainText(usableInfo.remoteVersion) : ""
    // Always overwrite these: a later failed or malformed check must not leave
    // an earlier comparison URL attached to a row whose evidence is now gone.
    copy.localSha = usableInfo ? reportHead : ""
    copy.remoteSha = usableInfo ? normalizeGitObjectId(usableInfo.remoteSha) : ""
    copy.updateChecked = copy.localSha !== "" && copy.remoteSha !== ""
    copy.behind = copy.updateChecked && copy.localSha !== copy.remoteSha
    // Only when both ends name a version and they disagree. Equal versions
    // across a real update is the common case, not an error.
    copy.versionChanged = copy.behind
      && copy.localVersion !== ""
      && copy.remoteVersion !== ""
      && copy.localVersion !== copy.remoteVersion
    out.push(copy)
  }
  return out
}

// Pinned updates use raw catalog fields, never install commands or web links.
// This is display/request eligibility only; the helper reauthorizes over HTTPS.
function canonicalUpdateRepository(value) {
  if (typeof value !== "string") return ""
  var match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(value)
  if (!match || match[1].length > 39 || match[2].length > 100
      || match[2] === "." || match[2] === ".." || /\s/.test(value)) return ""
  return "https://github.com/" + match[1].toLowerCase() + "/" + match[2].toLowerCase()
}

function catalogUpdateSnapshot(entry) {
  if (!entry || typeof entry.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.id)
      || entry.id.indexOf("..") >= 0 || entry.id.indexOf("omarchy.") === 0
      || entry.verificationStatus !== "verified" || entry.sourceType !== "community") return null
  var repo = canonicalUpdateRepository(entry.repo)
  var sha = typeof entry.verificationCommit === "string" && entry.verificationCommit.length === 40
    && /^[0-9a-fA-F]{40}$/.test(entry.verificationCommit)
    ? entry.verificationCommit.toLowerCase() : ""
  return repo !== "" && sha !== "" ? { id: entry.id, repository: repo, verifiedCommit: sha } : null
}

function pinnedRequest(row, entries) {
  if (!row || row.firstParty || !row.gitManaged || !/^[0-9a-fA-F]{40}$/.test(String(row.headSha || ""))) return null
  var found = null, count = 0
  for (var i = 0; i < (entries || []).length; i++) {
    if (entries[i].id === row.id) { found = entries[i].updateSnapshot; count++ }
  }
  if (count !== 1 || !found || found.id !== row.id
      || canonicalUpdateRepository(row.updateOrigin) !== found.repository) return null
  return { schemaVersion: 1, id: row.id, repository: found.repository,
    verifiedCommit: found.verifiedCommit, expectedLocalHead: row.headSha.toLowerCase() }
}

// The request for an upstream commit nobody has reviewed. It binds the exact
// commit the background check observed, never a branch name, and it never
// consults the catalog: the plugin may not be listed at all. Only the user's
// explicit setting, checked by applyPinnedUpdates, makes such a row eligible.
function unverifiedRequest(row) {
  if (!row || row.firstParty || !row.gitManaged) return null
  var head = String(row.headSha || ""), tip = String(row.remoteSha || "")
  if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(tip) || head === tip) return null
  var repository = canonicalUpdateRepository(row.updateOrigin)
  if (repository === "") return null
  return { schemaVersion: 1, id: row.id, repository: repository,
    unverifiedCommit: tip, expectedLocalHead: head }
}

// `allowUnverified` is the user's setting (see allowUnverifiedUpdates). With
// it off, an upstream tip the marketplace has not verified is not an update:
// it is not counted, not badged, not filtered and not installable. The
// observed facts (upstreamBehind, remoteSha) stay on the row either way.
function applyPinnedUpdates(rows, entries, allowUnverified) {
  var unverifiedAllowed = allowUnverified === true
  var out = []
  for (var i = 0; i < (rows || []).length; i++) {
    var row = rows[i], copy = {}, request = pinnedRequest(row, entries)
    for (var key in row) copy[key] = row[key]
    // Keep report SHA/version/freshness fields exclusively upstream-owned.
    // `behind` is the compatibility view consumed by existing badges and filters.
    copy.upstreamBehind = row.updateChecked === true && row.localSha !== row.remoteSha
    copy.verifiedTargetSha = request ? request.verifiedCommit : ""
    var differs = !!request && request.expectedLocalHead !== request.verifiedCommit
    // A verified commit already reachable from the installed HEAD is a
    // downgrade the helper refuses; offering it would be a button that can
    // only fail. Ancestry is the checkout's most recent commits (see
    // MAX_ANCESTORS), so an older snapshot beyond that window stays offered
    // and is refused with a reason instead.
    copy.verifiedSuperseded = differs && (row.ancestors || []).indexOf(request.verifiedCommit) >= 0
    copy.pinnedEligible = differs && !copy.verifiedSuperseded
    copy.unverifiedAllowed = unverifiedAllowed
    // A verified snapshot always wins: the unreviewed tip is shown only when
    // nothing reviewed is installable, and never when the tip is the verified
    // commit itself (that case is pinnedEligible or superseded). Shown is not
    // installable: a checkout whose origin the helper cannot bind (not a
    // GitHub repository) still gets the grey arrow and the count, so nothing
    // the setting promises to surface is hidden; only its button stays off.
    copy.unverifiedShown = unverifiedAllowed && copy.upstreamBehind && !copy.pinnedEligible
      && row.remoteSha !== copy.verifiedTargetSha
    copy.unverifiedEligible = copy.unverifiedShown && unverifiedRequest(row) !== null
    copy.behind = copy.pinnedEligible || copy.unverifiedShown
    out.push(copy)
  }
  return out
}

function updateStatus(row) {
  if (!row || !row.updatable) return ""
  if (row.unverifiedAllowed !== true) {
    // Unreviewed upstream changes are not mentioned at all with the setting
    // off: they are not something this panel will install.
    if (row.pinnedEligible) return "Verified snapshot " + shortSha(row.verifiedTargetSha) + " available"
    if (row.verifiedSuperseded) return "Installed is ahead of verified snapshot " + shortSha(row.verifiedTargetSha)
    return row.updateChecked === true ? "No verified update available" : "Update check unavailable"
  }
  var upstream = row.upstreamBehind
    ? "Upstream changes — " + (row.remoteSha === row.verifiedTargetSha ? "verified snapshot" : "not verified")
    : (row.updateChecked === true ? "No upstream changes" : "Upstream check unavailable")
  if (row.pinnedEligible) return upstream + "; Verified snapshot " + shortSha(row.verifiedTargetSha) + " available"
  if (row.verifiedSuperseded) return upstream + "; Installed is ahead of verified snapshot " + shortSha(row.verifiedTargetSha)
  if (row.unverifiedEligible) return upstream + "; Unreviewed commit " + shortSha(row.remoteSha) + " installable"
  if (row.unverifiedShown) return upstream + "; update needs a GitHub origin"
  return upstream
}

function pinnedUpdateTooltip(row) {
  var status = updateStatus(row)
  if (row && row.pinnedEligible) return status + ". Install verified snapshot "
    + shortSha(row.verifiedTargetSha) + " — rechecked before publication"
  if (row && row.unverifiedEligible) return status + ". Install unreviewed commit "
    + shortSha(row.remoteSha) + " — the marketplace has not verified it; asks first"
  if (row && row.verifiedSuperseded) return status + ". Update disabled; the installed commit already contains verified snapshot "
    + shortSha(row.verifiedTargetSha)
  if (row && row.unverifiedShown) return status + ". Update disabled; the helper installs only from a GitHub origin"
  return status + ". Update disabled; no newer matching verified snapshot"
}

// The question before an unreviewed commit is installed. Plain text only; the
// label is the sanitized row name and the commit is seven hex characters.
function updateUnverifiedConfirmMessage(label, row) {
  var tip = row ? shortSha(row.remoteSha) : ""
  return "Update " + label + " to an unreviewed commit?\n\n"
    + "The marketplace has not verified " + tip + ". Nobody has reviewed what it changes; "
    + "installing it runs code only its author has seen. Exactly this commit is installed, nothing newer."
}

// ---- Update presentation ---------------------------------------------------

function shortSha(sha) {
  return normalizeGitObjectId(sha).slice(0, 7)
}

// What the row's badge should say. The version arrow when the numbers differ,
// otherwise a plain word, because "1.0.0 → 1.0.0" reads as a bug.
function updateBadge(row) {
  if (!row || !row.behind) return ""
  if (row.versionChanged) return row.localVersion + " → " + row.remoteVersion
  return "update"
}

// GitHub generates this comparison from the exact commits already used to
// decide `behind`; it is not a release and requires no API or extra request.
function updateCompareUrl(row) {
  if (!row || row.behind !== true) return ""

  // Prefer the detected upstream comparison; with no upstream changes, expose
  // the verified-only candidate without inventing a branch report.
  var verifiedOnly = row.pinnedEligible === true && row.upstreamBehind !== true
  var localSha = normalizeGitObjectId(verifiedOnly ? row.headSha : row.localSha)
  var remoteSha = normalizeGitObjectId(verifiedOnly ? row.verifiedTargetSha : row.remoteSha)
  if (localSha === "" || remoteSha === "" || localSha === remoteSha) return ""

  // As with version tags, only the checkout's current origin is authoritative.
  var slug = githubRepoSlug(row.remote)
  if (slug === "") return ""
  return "https://github.com/" + slug + "/compare/" + localSha + "..." + remoteSha
}

function updateCompareLabel(row) {
  if (updateCompareUrl(row) === "") return ""
  var verifiedOnly = row.pinnedEligible === true && row.upstreamBehind !== true
  return "Compare " + (verifiedOnly ? "verified snapshot " : "upstream ")
    + shortSha(verifiedOnly ? row.headSha : row.localSha) + " → "
    + shortSha(verifiedOnly ? row.verifiedTargetSha : row.remoteSha) + " on GitHub"
}

function updateReleaseCandidates(row) {
  if (!row || (row.pinnedEligible === true && row.upstreamBehind !== true)
      || row.versionChanged !== true || updateCompareUrl(row) === "") return []
  return githubReleaseCandidates(row.remote, row.remoteVersion)
}

// Click routing revalidates every URL even though the model constructed it.
// This makes the Panel boundary explicit: only exact GitHub release probes and
// locally-built release/tree/compare pages can reach curl or the web viewer.
function trustedGithubTagUrl(url, expression, base, path) {
  var text = String(url || "")
  var match = text.match(expression)
  if (!match) return ""

  var slug = githubRepoSlug("https://github.com/" + match[1] + "/" + match[2])
  if (slug === "") return ""
  var tag
  try {
    tag = decodeURIComponent(match[3])
  } catch (error) {
    return ""
  }
  if (tag === "" || tag.length > 256 || /[\u0000-\u001f\u007f]/.test(tag)) return ""
  var canonical = githubTagUrl("https://github.com/" + slug, tag, base, path)
  return canonical === text ? text : ""
}

function trustedGithubReleaseApiUrl(url) {
  return trustedGithubTagUrl(url,
    /^https:\/\/api\.github\.com\/repos\/([^\/]+)\/([^\/]+)\/releases\/tags\/([^\/?#\s]+)$/,
    "https://api.github.com/repos/", "/releases/tags/")
}

function trustedGithubReleaseUrl(url) {
  return trustedGithubTagUrl(url,
    /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/releases\/tag\/([^\/?#\s]+)$/,
    "https://github.com/", "/releases/tag/")
}

function trustedGithubTreeUrl(url) {
  return trustedGithubTagUrl(url,
    /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/tree\/([^\/?#\s]+)$/,
    "https://github.com/", "/tree/")
}

function trustedGithubCompareUrl(url) {
  var text = String(url || "")
  var match = text.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/compare\/([^\.\/]+)\.\.\.([^\/]+)$/)
  if (!match) return ""
  var slug = githubRepoSlug("https://github.com/" + match[1] + "/" + match[2])
  var localSha = normalizeGitObjectId(match[3])
  var remoteSha = normalizeGitObjectId(match[4])
  if (slug === "" || localSha === "" || remoteSha === "" || localSha === remoteSha) return ""
  var canonical = "https://github.com/" + slug + "/compare/" + localSha + "..." + remoteSha
  return canonical === text ? text : ""
}

function trustedGithubRepoUrl(url) {
  var text = String(url || "")
  var slug = githubRepoSlug(text)
  var canonical = slug === "" ? "" : "https://github.com/" + slug
  return canonical === text ? text : ""
}

function trustedGithubWebUrl(url) {
  return trustedGithubReleaseUrl(url) || trustedGithubTreeUrl(url)
    || trustedGithubCompareUrl(url) || trustedGithubRepoUrl(url)
}

function trustedGithubReleaseCandidate(value) {
  var probe = trustedGithubReleaseApiUrl(value ? value.probeUrl : "")
  var preferred = trustedGithubReleaseUrl(value ? value.preferredUrl : "")
  if (probe === "" || preferred === "") return null
  var expected = probe
    .replace("https://api.github.com/repos/", "https://github.com/")
    .replace("/releases/tags/", "/releases/tag/")
  return expected === preferred ? { probeUrl: probe, preferredUrl: preferred } : null
}

function githubNavigationRequest(candidateValues, fallbackUrl) {
  var fallback = trustedGithubWebUrl(fallbackUrl)
  if (fallback === "") return { candidates: [], fallbackUrl: "" }

  var values = Array.isArray(candidateValues) ? candidateValues : []
  var candidates = [], seen = {}
  for (var i = 0; i < values.length && candidates.length < 2; i++) {
    var candidate = trustedGithubReleaseCandidate(values[i])
    if (!candidate || seen[candidate.probeUrl]) continue
    seen[candidate.probeUrl] = true
    candidates.push(candidate)
  }
  return { candidates: candidates, fallbackUrl: fallback }
}

function releaseProbeCommand(apiUrl) {
  var probe = trustedGithubReleaseApiUrl(apiUrl)
  if (probe === "") return []
  return [
    "curl", "--silent", "--show-error", "--output", "/dev/null",
    "--request", "GET", "--connect-timeout", "3", "--max-time", "5",
    "--header", "Accept: application/vnd.github+json",
    "--header", "X-GitHub-Api-Version: 2022-11-28",
    "--write-out", "%{http_code}", probe
  ]
}

// Release navigation is asynchronous, while every other click in the panel is
// immediate. Keeping the generation and process lifecycle in one explicit
// value makes "latest choice wins" testable without relying on QML callback
// timing. Transitions return effects; Panel.qml alone performs those effects.
function releaseNavigationInitialState() {
  return {
    generation: 0,
    activeGeneration: 0,
    activeRequest: null,
    activeCandidateIndex: 0,
    queuedRequest: null,
    probeExited: false,
    probeOutputFinished: false,
    probeExitCode: -1,
    probeResponseCode: ""
  }
}

function copyReleaseNavigationState(state) {
  var current = state || {}
  return {
    generation: Number(current.generation) || 0,
    activeGeneration: Number(current.activeGeneration) || 0,
    activeRequest: current.activeRequest || null,
    activeCandidateIndex: Number(current.activeCandidateIndex) || 0,
    queuedRequest: current.queuedRequest || null,
    probeExited: current.probeExited === true,
    probeOutputFinished: current.probeOutputFinished === true,
    probeExitCode: Number(current.probeExitCode),
    probeResponseCode: String(current.probeResponseCode || "")
  }
}

function releaseNavigationResult(state) {
  return {
    state: state,
    stopProbe: false,
    startRequest: null,
    scheduleStart: false,
    openUrl: ""
  }
}

function clearActiveReleaseNavigation(state) {
  state.activeGeneration = 0
  state.activeRequest = null
  state.activeCandidateIndex = 0
  state.probeExited = false
  state.probeOutputFinished = false
  state.probeExitCode = -1
  state.probeResponseCode = ""
}

function activateReleaseNavigation(state, entry) {
  state.activeGeneration = entry.generation
  state.activeRequest = entry.request
  state.activeCandidateIndex = 0
  state.queuedRequest = null
  state.probeExited = false
  state.probeOutputFinished = false
  state.probeExitCode = -1
  state.probeResponseCode = ""
}

function activeReleaseNavigationStart(state) {
  if (!state || state.activeGeneration === 0 || !state.activeRequest) return null
  var candidates = state.activeRequest.candidates || []
  var candidate = candidates[state.activeCandidateIndex]
  if (!candidate) return null
  return { generation: state.activeGeneration, probeUrl: candidate.probeUrl }
}

// A release click revokes the active generation before deciding whether the
// new request needs a probe. If a process is still settling, only the newest
// request remains queued; its probe cannot start until both old callbacks land.
function releaseNavigationRequestTransition(state, value) {
  var next = copyReleaseNavigationState(state)
  var hadActive = next.activeGeneration !== 0
  next.generation++
  next.queuedRequest = null
  if (hadActive) next.activeRequest = null

  var request = githubNavigationRequest(
    value ? value.candidates : [], value ? value.fallbackUrl : "")
  var result = releaseNavigationResult(next)
  result.stopProbe = hadActive
  if (request.fallbackUrl === "") return result
  if (request.candidates.length === 0) {
    result.openUrl = request.fallbackUrl
    return result
  }

  var entry = { generation: next.generation, request: request }
  if (hadActive) {
    next.queuedRequest = entry
    return result
  }

  activateReleaseNavigation(next, entry)
  result.startRequest = activeReleaseNavigationStart(next)
  return result
}

// Actions and non-release navigation are newer human choices too. Active URLs
// are quarantined immediately; late callbacks may settle the process but can
// no longer navigate or consume a queued request.
function releaseNavigationRevokeTransition(state) {
  var next = copyReleaseNavigationState(state)
  var hadActive = next.activeGeneration !== 0
  next.generation++
  next.queuedRequest = null
  if (hadActive) next.activeRequest = null
  var result = releaseNavigationResult(next)
  result.stopProbe = hadActive
  return result
}

function releaseNavigationDirectTransition(state, url) {
  var result = releaseNavigationRevokeTransition(state)
  result.openUrl = browsableUrl(url)
  return result
}

function settleReleaseNavigation(state) {
  var next = copyReleaseNavigationState(state)
  var result = releaseNavigationResult(next)
  if (next.activeGeneration === 0 || !next.probeExited || !next.probeOutputFinished) return result

  if (next.activeGeneration === next.generation && next.activeRequest) {
    var candidates = next.activeRequest.candidates || []
    var candidate = candidates[next.activeCandidateIndex]
    var responseCode = String(next.probeResponseCode || "").trim()
    if (candidate && Number(next.probeExitCode) === 0 && responseCode === "200") {
      result.openUrl = trustedGithubReleaseUrl(candidate.preferredUrl)
    } else if (candidate && Number(next.probeExitCode) === 0 && responseCode === "404"
        && next.activeCandidateIndex + 1 < candidates.length) {
      next.activeCandidateIndex++
      next.probeExited = false
      next.probeOutputFinished = false
      next.probeExitCode = -1
      next.probeResponseCode = ""
      result.scheduleStart = true
      return result
    } else {
      result.openUrl = trustedGithubWebUrl(next.activeRequest.fallbackUrl)
    }
  }
  clearActiveReleaseNavigation(next)
  result.scheduleStart = !!next.queuedRequest
    && next.queuedRequest.generation === next.generation
  return result
}

function releaseNavigationProbeExitedTransition(state, exitCode) {
  var next = copyReleaseNavigationState(state)
  if (next.activeGeneration === 0) return releaseNavigationResult(next)
  next.probeExited = true
  next.probeExitCode = Number(exitCode)
  return settleReleaseNavigation(next)
}

function releaseNavigationProbeOutputTransition(state, responseCode) {
  var next = copyReleaseNavigationState(state)
  if (next.activeGeneration === 0) return releaseNavigationResult(next)
  next.probeOutputFinished = true
  next.probeResponseCode = String(responseCode || "").trim()
  return settleReleaseNavigation(next)
}

function releaseNavigationStartQueuedTransition(state) {
  var next = copyReleaseNavigationState(state)
  var result = releaseNavigationResult(next)
  if (next.activeGeneration !== 0) {
    if (next.activeGeneration === next.generation && next.activeRequest)
      result.startRequest = activeReleaseNavigationStart(next)
    else if (!next.activeRequest) clearActiveReleaseNavigation(next)
    if (result.startRequest || next.activeGeneration !== 0) return result
  }
  var entry = next.queuedRequest
  if (!entry || entry.generation !== next.generation) {
    next.queuedRequest = null
    return result
  }
  activateReleaseNavigation(next, entry)
  result.startRequest = activeReleaseNavigationStart(next)
  return result
}

// The request and command validators share the same API URL boundary, so this
// is defensive rather than expected. It prevents a validator disagreement
// from leaving a generation permanently busy when no process was started.
function releaseNavigationProbeStartFailedTransition(state) {
  var next = copyReleaseNavigationState(state)
  var result = releaseNavigationResult(next)
  if (next.activeGeneration === next.generation && next.activeRequest)
    result.openUrl = trustedGithubWebUrl(next.activeRequest.fallbackUrl)
  clearActiveReleaseNavigation(next)
  result.scheduleStart = !!next.queuedRequest
    && next.queuedRequest.generation === next.generation
  return result
}

function versionLabel(row) {
  if (!row) return ""
  return releaseVersionLabel(row.localVersion)
}

// A checkout the background check has actually compared and found level
// with its remote. Unchecked is not up to date — it is unknown, and the
// button stays offered until the check says otherwise.
// "Current" is a positive claim, so it is not made while the setting hides
// an unreviewed upstream change: such a row shows neither the arrow nor the
// check. A superseded checkout keeps its check: it is ahead of the snapshot.
function upToDate(row) {
  if (!row || row.updateChecked !== true || row.behind === true) return false
  var hiddenUpstream = row.unverifiedAllowed !== true && row.upstreamBehind === true
    && row.verifiedSuperseded !== true
  return !hiddenUpstream
}

function countBehind(rows) {
  var total = 0
  for (var i = 0; i < (rows || []).length; i++)
    if (rows[i] && rows[i].behind === true) total++
  return total
}

// ---- Bulk update ----------------------------------------------------------
//
// The rows one "Update all" would install, in list order. Only rows with an
// installable request: a verified snapshot when one differs, otherwise the
// observed unreviewed tip when the setting allows it. Ahead-of-verified and
// non-GitHub origins are excluded here; they stay counted by countBehind.
function bulkUpdateCandidates(rows) {
  var out = []
  for (var i = 0; i < (rows || []).length; i++) {
    var row = rows[i]
    if (!row || String(row.id || "") === "") continue
    var name = plainText(row.name || row.id)
    if (row.pinnedEligible === true) {
      var verified = normalizeGitObjectId(row.verifiedTargetSha)
      if (!/^[0-9a-f]{40}$/.test(verified)) continue
      out.push({ id: String(row.id), name: name, kind: "verified", targetSha: verified,
        display: name + " — verified snapshot " + shortSha(verified) })
    } else if (row.unverifiedEligible === true) {
      var tip = normalizeGitObjectId(row.remoteSha)
      if (!/^[0-9a-f]{40}$/.test(tip)) continue
      out.push({ id: String(row.id), name: name, kind: "unverified", targetSha: tip,
        display: name + " — unreviewed commit " + shortSha(tip) })
    }
  }
  return out
}

// One line per candidate, in list order. Plain text only; names are already
// sanitized by bulkUpdateCandidates.
function bulkUpdateConfirmMessage(candidates) {
  var list = candidates || []
  var lines = []
  for (var i = 0; i < list.length; i++) lines.push(String(list[i].display || ""))
  return "Update " + list.length + (list.length === 1 ? " plugin" : " plugins")
    + " to exactly these commits?\n\n" + lines.join("\n") + "\n\n"
    + "Verified snapshots are rechecked before publication. "
    + "Unreviewed commits install exactly as listed, nothing newer."
}

// "Updated x, skipped y (name: reason; …)". Names and reasons are already
// plain text when the store builds them.
function bulkUpdateSummary(results) {
  var updated = 0
  var skipped = []
  for (var i = 0; i < (results || []).length; i++) {
    if (results[i] && results[i].ok === true) updated++
    else if (results[i]) skipped.push(String(results[i].name || "") + ": " + String(results[i].reason || "skipped"))
  }
  var summary = "Updated " + updated + ", skipped " + skipped.length
  return skipped.length > 0 ? summary + " (" + skipped.join("; ") + ")" : summary
}

// ---- Update data: fixed helper protocol, never a source of commands --------

// Three bytes per non-ASCII UTF-16 code unit is conservative even when a raw
// parser splits a surrogate pair. No encoded copy of an oversized chunk.
function updateDataByteBound(text) {
  var bytes = 0
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i)
    bytes += code < 128 ? 1 : code < 2048 ? 2 : 3
  }
  return bytes
}

function boundedUpdateDataChunk(text, bytes, chunk, limit) {
  if (chunk.length > limit || bytes + updateDataByteBound(chunk) > limit)
    return { text: "", bytes: limit + 1, overflow: true }
  return { text: text + chunk, bytes: bytes + updateDataByteBound(chunk), overflow: false }
}

function updateDataObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === keys.split(",").sort().join(",")
}

function updateDataInteger(value, max) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value
    && value >= 0 && value <= max
}

function updateDataJson(raw, limit) {
  if (typeof raw !== "string" || raw.length > limit || updateDataByteBound(raw) > limit) return null
  try { return JSON.parse(raw) } catch (error) { return null }
}

function validUpdateDataPaths(paths) {
  if (!updateDataObject(paths, "plugins,active,archive")) return false
  var suffix = "/.config/omarchy/plugins"
  if (typeof paths.plugins !== "string" || paths.plugins.slice(-suffix.length) !== suffix) return false
  var home = paths.plugins.slice(0, -suffix.length)
  if (home.length === 0 || home.length > 512 || updateDataByteBound(home) > 512
      || home.charAt(0) !== "/" || /[<>&\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(home.replace(/ /g, ""))) return false
  var components = home.slice(1).split("/")
  for (var i = 0; i < components.length; i++)
    if (components[i] === "" || components[i] === "." || components[i] === "..") return false
  return paths.active === home + "/.config/omarchy/plugin-manager-updates"
    && paths.archive === home + "/.config/omarchy/plugin-manager-updates-archive"
}

function parseUpdateDataStatus(raw, exitCode) {
  var value = updateDataJson(raw, 8192)
  if (!updateDataObject(value, "schemaVersion,paths,available,activeCount,lowerBound,limit,error")
      || value.schemaVersion !== 1 || !updateDataInteger(value.limit, TRANSACTION_LIMIT_MAX)
      || value.limit < TRANSACTION_LIMIT_MIN || typeof value.available !== "boolean"
      || typeof value.lowerBound !== "boolean" || typeof value.error !== "string" || value.error.length > 200
      || (value.paths !== null && !validUpdateDataPaths(value.paths))) return null
  if (value.available) {
    if (exitCode !== 0 || value.paths === null || value.error !== ""
        || !updateDataInteger(value.activeCount, value.limit + 1) || value.lowerBound !== (value.activeCount === value.limit + 1)) return null
  } else if (exitCode !== 1 || value.activeCount !== null || value.lowerBound || value.error === "") return null
  return value
}

function parseCleanupResult(raw, exitCode) {
  var value = updateDataJson(raw, 4096)
  if (!updateDataObject(value, "schemaVersion,status,discovered,visited,removed,preserved,partial,removedUnsynced,unknown,discoveryComplete,refreshRequired,error")
      || value.schemaVersion !== 1 || value.refreshRequired !== true || typeof value.discoveryComplete !== "boolean"
      || typeof value.error !== "string" || value.error.length > 200
      || ["complete", "limited", "cancelled", "partial", "failed", "unknown"].indexOf(value.status) < 0) return null
  var counts = ["discovered", "visited", "removed", "preserved", "partial", "removedUnsynced", "unknown"]
  for (var i = 0; i < counts.length; i++)
    if (!updateDataInteger(value[counts[i]], i < 4 ? 512 : 1)) return null
  if (value.visited > value.discovered || value.removedUnsynced > value.partial
      || value.removed + value.partial + value.unknown > 128
      || value.visited !== value.removed + value.preserved + value.partial + value.unknown
      || value.partial !== (value.status === "partial" ? 1 : 0)
      || value.unknown !== (value.status === "unknown" ? 1 : 0)) return null
  if (value.status === "complete") {
    if (exitCode !== 0 || !value.discoveryComplete || value.visited !== value.discovered || value.error !== "") return null
  } else if (exitCode !== 1 || value.error === "") return null
  return value
}

function updateDataCountLabel(status, loading) {
  if (loading) return "Loading…"
  if (!status || !status.available) return "Unavailable"
  return status.lowerBound ? "≥" + (status.limit + 1) + "/" + status.limit + " (lower bound)" : status.activeCount + "/" + status.limit
}

// Warning threshold for Settings: within a few entries of the configured
// capacity, or already past it. Drives the near-limit warning; never a
// mutation by itself.
function updateDataNearLimit(status) {
  if (!status || status.available !== true) return false
  return status.lowerBound || status.activeCount >= status.limit - TRANSACTION_LIMIT_NEAR
}

// Host-owned labels never receive helper errors, paths or free-form output.
// These are invocation sample counts, not a claim about all retained history.
function cleanupOutcomeText(result) {
  if (!result) return "Cleanup outcome unknown. Refresh status and inspect retained history before another attempt."
  return "Cleanup " + result.status + ". Sampled entries: removed " + result.removed
    + "; preserved " + result.preserved + "; partial " + result.partial
    + " (removed without confirmed sync " + result.removedUnsynced + "); unknown " + result.unknown
    + ". Counts cover this pass only. Inspect retained history; rollback backups deleted cannot be recovered."
}

function updateDataCommand(helperPath, cleanup) {
  // QML destruction can SIGKILL its direct child. The inner timeout retains
  // its own process group and deadline even if the outer observer disappears.
  // TERM to the outer forwards to the inner; only the inner escalates to KILL,
  // so no observer-side KILL can tear down supervision before the owned group.
  return ["/usr/bin/timeout", cleanup ? "22" : "8",
    "/usr/bin/timeout", "-k", "1", cleanup ? "20" : "6",
    "/usr/bin/python3", "-I", "-S", helperPath,
    cleanup ? "--cleanup-completed" : "--update-data-status"]
}

// ---- Look: density, font size, accent ---------------------------------------

// Accent colours the picker offers, in this order, when the theme defines them.
var ACCENT_NAMES = ["blue", "cyan", "green", "magenta", "yellow", "red", "orange"]

// name -> "#rrggbb" for every quoted hex colour in a theme's colors.toml.
function parsePalette(text) {
  var palette = {}
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s*([a-z_]+)\s*=\s*"(#[0-9a-fA-F]{6})"/)
    if (m) palette[m[1]] = m[2]
  }
  return palette
}

// "theme" followed by whichever accent colours the palette has.
function accentChoices(palette) {
  var list = ["theme"]
  for (var i = 0; i < ACCENT_NAMES.length; i++)
    if (palette && hasOwnKey(palette, ACCENT_NAMES[i])) list.push(ACCENT_NAMES[i])
  return list
}

// The palette colour for a choice, or null when the theme's own accent applies
// ("theme", or a colour this theme does not define).
function paletteAccent(choice, palette) {
  if (ACCENT_NAMES.indexOf(choice) >= 0 && palette && hasOwnKey(palette, choice)) return palette[choice]
  return null
}

// Multiplier for the panel's spacing and widths. Normal is the stock look.
function densityScale(name) {
  if (name === "compact") return 0.82
  if (name === "comfortable") return 1.15
  return 1
}

// Text multiplier chosen in settings, on top of the density's own text scaling.
function fontSizeScale(name) {
  if (name === "small") return 0.88
  if (name === "large") return 1.12
  return 1
}

// A string setting restricted to a known set; anything else is the fallback.
function choiceSetting(settings, key, allowed, fallback) {
  if (!settings || !hasOwnKey(settings, key)) return fallback
  var value = settings[key]
  return typeof value === "string" && allowed.indexOf(value) >= 0 ? value : fallback
}
