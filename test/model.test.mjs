// Model.js is loaded by QML, so it has no module system of its own. Reading
// and evaluating the source keeps the shipped file free of node-isms while
// still letting the parsing rules be tested outside a running shell.
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

const source = readFileSync(new URL("../Model.js", import.meta.url), "utf8")
const Model = new Function(
  source + `
  return {
    splitSections, parseArray, parseGitMap, parseManifestMeta, mergePlugins, countRemovable, rowsInGroup,
    groupLabel, sectionHeading, kindLabel, kindsLabel, kindOptions, filterByKind, nextKind, filterKind,
    filterKindLabel, statusOptions, filterByStatus, matchesQuery, filterRows, isFiltering, emptyMessage,
    groupOptions, installedFilterHints, actionHints, nextOption, verifiedIdSet, isVerified, upToDate,
    catalogStarsById, rowStarLabel, parseCatalog, catalogEntries, plainText, buildCatalog, catalogCount,
    starLabel, starSlugFor, starToggleCommand, parseStarResult, bumpCount, repoShortLabel, browsableUrl,
    repoWebUrl, rowRepoUrl, normalizedManifestVersion, normalizedReleaseVersion, releaseVersionLabel,
    githubReleaseCandidates, versionReleaseCandidates, versionFallbackUrl, parseUpdateReport,
    applyUpdateReport, applyPinnedUpdates, pinnedRequest, pinnedUpdateTooltip, updateStatus,
    updateCompareLabel, unverifiedRequest, updateUnverifiedConfirmMessage, parseSelfSettings, parseSelfEntry,
    withSelfSetting, allowUnverifiedUpdates, updateBadge, updateCompareUrl, updateReleaseCandidates,
    versionLabel, countBehind, bulkUpdateCandidates, bulkUpdateConfirmMessage, bulkUpdateSummary,
    trustedGithubReleaseApiUrl, trustedGithubReleaseUrl, trustedGithubRepoUrl, trustedGithubWebUrl,
    githubNavigationRequest, releaseProbeCommand, releaseNavigationInitialState,
    releaseNavigationRequestTransition, releaseNavigationRevokeTransition, releaseNavigationDirectTransition,
    releaseNavigationProbeExitedTransition, releaseNavigationProbeOutputTransition,
    releaseNavigationStartQueuedTransition, releaseNavigationProbeStartFailedTransition, metaLine,
    authorLabel, descriptionLine, hasDescription, sourceBadge, normalizeGitUrl, lastLine, actionVerb,
    actionGerund, successMessage, failureMessage, needsPlacement, canEnable, placementOptions, enableCommand,
    findRow, parseLayoutSections, canMove, moveOptions, moveCommand, moveNote, canDisable, disableCommand,
    enableNote, disableNote, restartShellCommand
  }`
)()

test("The catalog is read from the canonical endpoint from the helper alone", () => {
  // The catalog is fetched, projected and cached by the pinned helper. No
  // QML or JavaScript names that endpoint, so nothing here can retarget the
  // catalog host. Python's subprocess contract pins the same URL and rejects
  // even valid JSON returned with a redirect status.
  const helper = readFileSync(new URL("../helpers/pinned_update.py", import.meta.url), "utf8")
  assert.match(helper, /^CATALOG_URL = "https:\/\/plugins\.omarchy\.org\/catalog\.json"$/m)
  assert.doesNotMatch(source, /CATALOG_URL|catalog\.json/)
  assert.doesNotMatch(source, /plugins\.omarchy\.org/)
})

test("pinned update eligibility binds raw repo, verified status, unique id and full SHA", () => {
  const pinned = Function(source + "; return { pinnedRequest, applyPinnedUpdates }")()
  const base = "a".repeat(40), target = "b".repeat(40)
  const raw = { id: "acme.plugin", repo: "https://github.com/acme/plugin",
    sourceType: "community", verificationStatus: "verified", verificationCommit: target }
  const rows = [{ id: raw.id, gitManaged: true, updatable: true, headSha: base,
    updateOrigin: "git@github.com:acme/plugin.git", remote: raw.repo,
    localSha: base, remoteSha: "c".repeat(40), updateChecked: true, behind: true,
    localVersion: "1.0", remoteVersion: "2.0", versionChanged: true }]
  const entries = plugins => Model.catalogEntries({ plugins }, {})
  const request = pinned.pinnedRequest(rows[0], entries([raw]))
  assert.deepEqual(request, { schemaVersion: 1, id: raw.id, repository: raw.repo,
    verifiedCommit: target, expectedLocalHead: base })
  const projected = pinned.applyPinnedUpdates(rows, entries([raw]))[0]
  assert.equal(projected.remoteSha, rows[0].remoteSha, "upstream evidence is not the update target")
  assert.equal(projected.verifiedTargetSha, target)
  assert.equal(projected.behind, true)
  assert.equal(projected.versionChanged, true, "version information still describes upstream")
  assert.equal(pinned.applyPinnedUpdates([{ ...rows[0], headSha: target }], entries([raw]))[0].pinnedEligible, false)
  for (const change of [{ verificationStatus: "unverified" }, { verificationCommit: "b".repeat(64) },
    { repo: raw.repo + "?x" }, { repo: "https://github.com/other/plugin" },
    { id: "acme.<plugin>" }, { sourceType: "builtin" }]) {
    assert.equal(pinned.pinnedRequest(rows[0], entries([{ ...raw, ...change }])), null)
  }
  assert.equal(pinned.pinnedRequest(rows[0], entries([raw, raw])), null)
  assert.equal(pinned.pinnedRequest({ ...rows[0], updateOrigin: "", clonedFrom: raw.repo }, entries([raw])), null)
  assert.equal(pinned.pinnedRequest(rows[0], null), null)
  // With no catalog the only candidate is the unreviewed tip, which exists
  // only when the user's setting allows it.
  assert.equal(pinned.applyPinnedUpdates(rows, null)[0].behind, false)
  assert.equal(pinned.applyPinnedUpdates(rows, null, true)[0].behind, true)
  assert.equal(pinned.applyPinnedUpdates(rows, null, "true")[0].behind, false, "strictly the boolean true")
})

test("bulk update candidates cover verified rows, opt-in tips, and nothing else", () => {
  const verified = "b".repeat(40), head = "a".repeat(40), tip = "c".repeat(40)
  const origin = "https://github.com/acme/plugin"
  const base = { name: "Plugin", gitManaged: true, updatable: true, headSha: head,
    updateOrigin: origin, remote: origin, localSha: head, remoteSha: tip,
    updateChecked: true, ancestors: [head] }
  const catalog = Model.catalogEntries({ plugins: [{ id: "acme.verified", repo: origin,
    sourceType: "community", verificationStatus: "verified", verificationCommit: verified }] }, {})
  const rows = Model.applyPinnedUpdates([
    { ...base, id: "acme.verified" },
    { ...base, id: "acme.tip" },
    { ...base, id: "acme.ahead", ancestors: [head, verified], localSha: head, remoteSha: head },
    { ...base, id: "acme.plain", updateOrigin: "https://example.com/acme/plain.git",
      remote: "https://example.com/acme/plain.git" },
  ], catalog, true)
  const candidates = Model.bulkUpdateCandidates(rows)
  assert.deepEqual(candidates.map(c => c.id), ["acme.verified", "acme.tip"])
  assert.equal(candidates[0].kind, "verified")
  assert.equal(candidates[0].targetSha, verified)
  assert.equal(candidates[0].display, "Plugin — verified snapshot " + verified.slice(0, 7))
  assert.equal(candidates[1].kind, "unverified")
  assert.equal(candidates[1].targetSha, tip)
  assert.equal(candidates[1].display, "Plugin — unreviewed commit " + tip.slice(0, 7))
  // Verified-only default: the tip drops out, the snapshot stays.
  assert.deepEqual(Model.bulkUpdateCandidates(Model.applyPinnedUpdates(rows, catalog)).map(c => c.id),
    ["acme.verified"])
  // The ahead row is superseded with nothing upstream, the plain one has no
  // GitHub origin: neither is a candidate, but the plain one stays behind
  // under existing semantics.
  assert.equal(Model.countBehind(rows), 3)
  // Confirm message names each plugin with its exact target.
  const message = Model.bulkUpdateConfirmMessage(candidates)
  assert.match(message, /Update 2 plugins to exactly these commits\?/)
  assert.match(message, new RegExp("Plugin — verified snapshot " + verified.slice(0, 7)))
  assert.match(message, new RegExp("Plugin — unreviewed commit " + tip.slice(0, 7)))
  assert.equal(Model.bulkUpdateConfirmMessage([candidates[0]]).split("\n")[0], "Update 1 plugin to exactly these commits?")
  // Summary counts updates and names every skip with its reason.
  assert.equal(Model.bulkUpdateSummary([
    { name: "A", ok: true }, { name: "B", ok: false, reason: "tip moved" },
  ]), "Updated 1, skipped 1 (B: tip moved)")
  assert.equal(Model.bulkUpdateSummary([{ name: "A", ok: true }]), "Updated 1, skipped 0")
})

function upstreamFixture(verified = "a".repeat(40)) {
  const head = "a".repeat(40), tip = "c".repeat(40)
  const row = { id: "acme.plugin", name: "Plugin", sourceDir: "/plugins/acme", updatable: true,
    gitManaged: true, headSha: head, localVersion: "1.0", remote: "https://github.com/acme/plugin",
    updateOrigin: "https://github.com/acme/plugin" }
  const catalog = Model.catalogEntries({ plugins: [{ id: row.id, repo: row.remote,
    sourceType: "community", verificationStatus: "verified", verificationCommit: verified }] }, {})
  const report = { [row.sourceDir]: { localSha: head, remoteSha: tip,
    localVersion: "1.0", remoteVersion: "2.0" } }
  return { row, catalog, report, head, tip }
}

test("with the setting on, all detected upstream changes survive verification projection and remain discoverable", () => {
  const { row, catalog, report, head, tip } = upstreamFixture()
  const upstream = Model.applyUpdateReport([row], report)[0]
  for (const entries of [catalog, [], Model.catalogEntries({ plugins: [{ id: row.id,
    repo: row.remote, sourceType: "community", verificationStatus: "unverified" }] }, {})]) {
    const projected = Model.applyPinnedUpdates([upstream], entries, true)[0]
    for (const key of ["localSha", "remoteSha", "localVersion", "remoteVersion", "updateChecked", "versionChanged"])
      assert.equal(projected[key], upstream[key], key)
    assert.equal(projected.upstreamBehind, true)
    assert.equal(projected.pinnedEligible, false)
    assert.equal(Model.countBehind([projected]), 1)
    assert.equal(Model.filterRows([projected], "all", "update", "").length, 1)
    assert.equal(Model.upToDate(projected), false)
    assert.equal(projected.unverifiedEligible, true)
    assert.match(Model.pinnedUpdateTooltip(projected), /Upstream changes — not verified/)
    assert.match(Model.pinnedUpdateTooltip(projected), /Install unreviewed commit ccccccc/)
    assert.match(Model.pinnedUpdateTooltip(projected), /asks first/)
    assert.equal(Model.updateCompareUrl(projected), `${row.remote}/compare/${head}...${tip}`)
  }
})

test("verified-only discovery never fabricates branch evidence or survives catalog removal", () => {
  const target = "b".repeat(40)
  const { row, catalog, head } = upstreamFixture(target)
  const unknown = Model.applyUpdateReport([row], {})[0]
  const projected = Model.applyPinnedUpdates([unknown], catalog, true)[0]
  assert.equal(projected.pinnedEligible, true)
  assert.equal(Model.countBehind([projected]), 1)
  assert.equal(Model.filterRows([projected], "all", "update", "").length, 1)
  assert.equal(projected.updateChecked, false)
  assert.equal(projected.remoteSha, "")
  assert.equal(projected.localSha, "")
  assert.equal(projected.upstreamBehind, false)
  assert.equal(projected.verifiedTargetSha, target)
  assert.match(Model.pinnedUpdateTooltip(projected), /Upstream check unavailable/)
  assert.match(Model.pinnedUpdateTooltip(projected), /Verified snapshot bbbbbbb available/)
  assert.equal(Model.updateCompareUrl(projected), `${row.remote}/compare/${head}...${target}`)
  assert.deepEqual(Model.updateReleaseCandidates(projected), [])
  const revoked = Model.applyPinnedUpdates([projected], [], true)[0]
  assert.equal(revoked.behind, false)
  assert.equal(revoked.verifiedTargetSha, "")
  assert.equal(Model.upToDate(revoked), false)
})

test("a verified snapshot already contained in the installed HEAD is never offered", () => {
  const verified = "b".repeat(40)
  const { row, catalog, head } = upstreamFixture(verified)
  const atTip = { [row.sourceDir]: { localSha: head, remoteSha: head, localVersion: "1.0", remoteVersion: "" } }
  const ahead = Model.applyUpdateReport([{ ...row, ancestors: [head, "d".repeat(40), verified] }], atTip)[0]
  const projected = Model.applyPinnedUpdates([ahead], catalog, true)[0]
  assert.equal(projected.verifiedSuperseded, true)
  assert.equal(projected.pinnedEligible, false)
  assert.equal(projected.behind, false)
  assert.equal(projected.upstreamBehind, false)
  assert.equal(projected.verifiedTargetSha, verified, "the target stays visible for the status line")
  assert.equal(Model.countBehind([projected]), 0)
  assert.equal(Model.filterRows([projected], "all", "update", "").length, 0)
  assert.match(Model.updateStatus(projected), /^No upstream changes; Installed is ahead of verified snapshot bbbbbbb$/)
  assert.match(Model.pinnedUpdateTooltip(projected), /Update disabled; the installed commit already contains verified snapshot bbbbbbb/)
  assert.equal(Model.updateCompareUrl(projected), "")
  assert.equal(Model.updateCompareLabel(projected), "")
  assert.deepEqual(Model.updateReleaseCandidates(projected), [])

  // The same target absent from the recent ancestry stays a candidate for
  // the helper, which proves or refuses ancestry itself.
  const unknown = Model.applyPinnedUpdates(
    [Model.applyUpdateReport([{ ...row, ancestors: [head, "d".repeat(40)] }], atTip)[0]], catalog, true)[0]
  assert.equal(unknown.verifiedSuperseded, false)
  assert.equal(unknown.pinnedEligible, true)
  assert.equal(unknown.behind, true)
  assert.match(Model.updateStatus(unknown), /Verified snapshot bbbbbbb available/)
  const missing = Model.applyPinnedUpdates([Model.applyUpdateReport([row], atTip)[0]], catalog, true)[0]
  assert.equal(missing.pinnedEligible, true)

  // Being exactly at the verified commit is neither eligible nor superseded.
  const exact = Model.applyPinnedUpdates([{ ...ahead, headSha: verified, ancestors: [verified] }], catalog, true)[0]
  assert.equal(exact.verifiedSuperseded, false)
  assert.equal(exact.pinnedEligible, false)
  assert.doesNotMatch(Model.updateStatus(exact), /ahead/)

  // Detected upstream changes still surface on a superseded row.
  const behindTip = { [row.sourceDir]: { localSha: head, remoteSha: "c".repeat(40), localVersion: "1.0", remoteVersion: "2.0" } }
  const both = Model.applyPinnedUpdates(
    [Model.applyUpdateReport([{ ...row, ancestors: [head, verified] }], behindTip)[0]], catalog, true)[0]
  assert.equal(both.verifiedSuperseded, true)
  assert.equal(both.pinnedEligible, false)
  assert.equal(both.behind, true)
  assert.match(Model.updateStatus(both), /^Upstream changes — not verified; Installed is ahead of verified snapshot bbbbbbb$/)
  assert.equal(Model.updateCompareUrl(both), `${row.remote}/compare/${head}...${"c".repeat(40)}`)
})

test("stale and failed reports stay unknown even at the verified snapshot", () => {
  const { row, catalog, report } = upstreamFixture()
  const previous = Model.applyPinnedUpdates(Model.applyUpdateReport([row], report), catalog, true)
  for (const failed of [{}, { [row.sourceDir]: { ...report[row.sourceDir], remoteSha: "" } },
    { [row.sourceDir]: { ...report[row.sourceDir], localSha: "b".repeat(40) } }]) {
    const fresh = Model.applyPinnedUpdates(Model.applyUpdateReport(previous, failed), catalog, true)[0]
    assert.equal(fresh.updateChecked, false)
    assert.equal(fresh.behind, false)
    assert.equal(fresh.remoteSha, "")
    assert.equal(Model.upToDate(fresh), false)
    assert.equal(Model.updateCompareUrl(fresh), "")
    assert.match(Model.pinnedUpdateTooltip(fresh), /Upstream check unavailable/)
  }
})

test("catalog, installed load and branch report converge in all arrival orders", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  const { row, catalog, report, head, tip } = upstreamFixture()
  const rawLoad = `===list===\n${JSON.stringify([{ id: row.id }])}\n===catalog===\n`
    + `${JSON.stringify([{ id: row.id, sourceDir: row.sourceDir }])}\n===git===\n`
    + `${JSON.stringify({ path: row.sourceDir, remote: row.remote, headSha: head, exactTag: "", ancestors: head })}`
    + "\n===manifest===\n[]"
  const rawReport = JSON.stringify({ path: row.sourceDir, ...report[row.sourceDir] })
  for (const order of ["CLR", "CRL", "LCR", "LRC", "RCL", "RLC"]) {
    const state = { rows: [], catalog: [], loading: false, loadError: "", loadRetried: false,
      pendingUpdateReport: "", checkingUpdates: false, rowsLoaded() {}, finishOpenLoad() {},
      selfSettings: {}, allowUnverifiedUpdates: true, busy: false, bulkActive: false,
      consumeBulkSummary() { this.consumed = true } }
    const api = Function("Model", "state", `with (state) {
      ${qmlFunction(store, "applyLoad")}; ${qmlFunction(store, "applyUpdateReport")};
      return { applyLoad, applyUpdateReport }
    }`)(Model, state)
    for (const event of order) {
      if (event === "L") api.applyLoad(rawLoad)
      if (event === "R") api.applyUpdateReport(rawReport)
      if (event === "C") {
        state.catalog = catalog
        state.rows = Model.applyPinnedUpdates(state.rows, state.catalog, state.allowUnverifiedUpdates)
      }
    }
    const projected = state.rows[0]
    assert.equal(state.consumed, true, `a fresh load looks for a recorded summary: ${order}`)
    assert.equal(projected.remoteSha, tip, order)
    assert.equal(projected.verifiedTargetSha, head, order)
    assert.equal(projected.pinnedEligible, false, order)
    assert.equal(Model.countBehind(state.rows), 1, order)
    api.applyLoad(rawLoad.replace(head, "d".repeat(40)))
    assert.equal(state.rows[0].updateChecked, false, "old HEAD report cannot attach to reload")
    assert.equal(state.rows[0].upstreamBehind, false)
  }
})

const payload = (list, catalog, git, manifest = "") =>
  `===list===\n${list}\n===catalog===\n${catalog}\n===git===\n${git}\n===manifest===\n${manifest}`

test("splitSections rejects output that is missing a section", () => {
  assert.equal(Model.splitSections("===list===\n[]"), null)
  assert.equal(Model.splitSections(""), null)
})

test("splitSections rejects sections that arrive out of order", () => {
  assert.equal(Model.splitSections("===git===\n===list===\n===catalog===\n===manifest===\n"), null)
})

test("splitSections rejects output that stops before the manifest section", () => {
  assert.equal(Model.splitSections("===list===\n[]\n===catalog===\n[]\n===git===\n"), null)
})

test("splitSections returns each section's body", () => {
  const sections = Model.splitSections(payload("[1]", "[2]", "a\tb", "x\ty\tz"))
  assert.equal(sections.list.trim(), "[1]")
  assert.equal(sections.catalog.trim(), "[2]")
  assert.equal(sections.git.trim(), "a\tb")
  assert.equal(sections.manifest.trim(), "x\ty\tz")
})

test("parseManifestMeta reads the author and version of each manifest", () => {
  const meta = Model.parseManifestMeta("acme.weather\tAcme Corp\t1.2.3\nacme.dev\t\t\n")
  assert.deepEqual(meta["acme.weather"], { author: "Acme Corp", version: "1.2.3" })
  assert.deepEqual(meta["acme.dev"], { author: "", version: "" })
})

test("parseManifestMeta skips blank and separator-less lines", () => {
  const meta = Model.parseManifestMeta("\nno-tabs-here\nacme.weather\tAcme\t1.0.0\n")
  assert.deepEqual(Object.keys(meta), ["acme.weather"])
})

test("parseArray tells a failed command apart from an empty result", () => {
  assert.deepEqual(Model.parseArray("[]"), [])
  assert.equal(Model.parseArray("command not found"), null)
  assert.equal(Model.parseArray('{"id":"x"}'), null)
  assert.equal(Model.parseArray(""), null)
})

// ---- Untrusted display text ----------------------------------------------
//
// Every Text in Qt defaults to Text.AutoText, which sniffs its content and
// renders anything tag-shaped as rich text — including `<img src=…>`, which
// fetches. Names, descriptions, authors and notes all arrive from a public
// registry or from a stranger's manifest, and they are drawn inside a shell
// process that outlives every panel. So they are stripped of anything that
// could open a tag before they are ever stored.

test("plainText removes what could be read as markup", () => {
  assert.equal(Model.plainText('<img src="https://evil/beacon">'), 'img src="https://evil/beacon"')
  assert.equal(Model.plainText("<b>Bold</b>"), "bBold/b")
  assert.equal(Model.plainText("<!DOCTYPE html>"), "!DOCTYPE html")
})

test("plainText leaves ordinary text alone", () => {
  assert.equal(Model.plainText("AT&T Monitor"), "AT&T Monitor")
  assert.equal(Model.plainText("Battery — 80% · charging"), "Battery — 80% · charging")
  assert.equal(Model.plainText(""), "")
  assert.equal(Model.plainText(null), "")
})

// A newline or a carriage return in a one-line label lets crafted text push
// the rest of a confirmation off the visible area.
test("plainText flattens control characters into spaces", () => {
  assert.equal(Model.plainText("Weather\nRemove everything?"), "Weather Remove everything?")
  assert.equal(Model.plainText("a\r\nb\tc"), "a b c")
})

test("parseGitMap keeps JSON-framed remotes and exact local tags, including empty fields", () => {
  const map = Model.parseGitMap([
    JSON.stringify({ path: "/plugins/prefixed", remote: "https://example.com/a.git", exactTag: "v1.0.3", headSha: "A".repeat(40),
      ancestors: "A".repeat(40) + "\n" + "c".repeat(40) + "\n" }),
    JSON.stringify({ path: "/plugins/plain", remote: "git@example.com:b.git", exactTag: "1.0.3", headSha: "b".repeat(64), ancestors: "" }),
    JSON.stringify({ path: "/plugins/noremote", remote: "", exactTag: "", headSha: "", ancestors: "" })
  ].join("\n"))
  assert.deepEqual(map["/plugins/prefixed"], {
    remote: "https://example.com/a.git", exactTag: "v1.0.3", headSha: "a".repeat(40),
    ancestors: ["a".repeat(40), "c".repeat(40)]
  })
  assert.deepEqual(map["/plugins/plain"], {
    remote: "git@example.com:b.git", exactTag: "1.0.3", headSha: "b".repeat(64), ancestors: []
  })
  assert.deepEqual(map["/plugins/noremote"], { remote: "", exactTag: "", headSha: "", ancestors: [] })
  assert.ok("noremote" in {} === false)
  assert.ok(Object.prototype.hasOwnProperty.call(map, "/plugins/noremote"))
})

test("parseGitMap skips malformed, non-object, and wrong-schema JSON records", () => {
  const valid = JSON.stringify({ path: "/plugins/a", remote: "https://x/a.git", exactTag: "v1", headSha: "a".repeat(40), ancestors: "" })
  const git = fields => JSON.stringify({ remote: "https://x/r.git", exactTag: "", headSha: "a".repeat(40), ...fields })
  const records = [
    JSON.stringify({ path: "/plugins/no-ancestors", remote: "https://x/a.git", exactTag: "v1", headSha: "a".repeat(40) }),
    git({ path: "/plugins/ancestors-array", ancestors: ["a".repeat(40)] }),
    git({ path: "/plugins/ancestors-too-many", ancestors: Array(129).fill("a".repeat(40)).join("\n") }),
    git({ path: "/plugins/ancestors-nonhex", ancestors: "a".repeat(40) + "\n" + "g".repeat(40) }),
    git({ path: "/plugins/ancestors-short", ancestors: "a".repeat(39) }),
    "not-json",
    "/plugins/legacy\thttps://github.com/owner/repo.git\tv1.0.0",
    "null",
    "[]",
    '"string"',
    JSON.stringify({ path: "/plugins/missing", remote: "https://x/missing.git", exactTag: "v1", ancestors: "" }),
    JSON.stringify({ path: "/plugins/wrong-type", remote: 42, exactTag: "v1", headSha: "a".repeat(40), ancestors: "" }),
    JSON.stringify({ path: "/plugins/extra", remote: "https://x/extra.git", exactTag: "v1", headSha: "a".repeat(40), ancestors: "", forged: true }),
    JSON.stringify({ path: "/plugins/control", remote: "https://x/control.git", exactTag: "v1\u0001", headSha: "a".repeat(40), ancestors: "" }),
    JSON.stringify({ path: "/plugins/short-head", remote: "https://x/short.git", exactTag: "", headSha: "a".repeat(39), ancestors: "" }),
    JSON.stringify({ path: "/plugins/nonhex-head", remote: "https://x/nonhex.git", exactTag: "", headSha: "g".repeat(40), ancestors: "" }),
    JSON.stringify({ path: "/plugins/hostile-head", remote: "https://x/hostile.git", exactTag: "", headSha: "a".repeat(39) + "\nforged", ancestors: "" }),
    valid
  ]
  const map = Model.parseGitMap(records.join("\n"))
  assert.deepEqual(Object.keys(map), ["/plugins/a"])
  const full = Array(128).fill("b".repeat(40)).join("\n")
  assert.equal(Model.parseGitMap(git({ path: "/plugins/full", ancestors: full }))["/plugins/full"].ancestors.length, 128)
})

test("parseGitMap keeps hostile delimiters inside one JSON record", () => {
  const path = "/plugins/real\n{\"path\":\"/plugins/path-forgery\"}"
  const remote = "git@github.com:owner/repo.git\n"
    + "/plugins/tsv-forgery\thttps://github.com/attacker/repo.git\tv9.9.9\n"
    + "{\"path\":\"/plugins/json-forgery\",\"remote\":\"https://github.com/attacker/repo\",\"exactTag\":\"v9.9.9\"}"
    + "\\quoted\"tail"
  const record = JSON.stringify({ path, remote, exactTag: "v1.0.3", headSha: "a".repeat(40), ancestors: "a".repeat(40) })
  const map = Model.parseGitMap(record)

  assert.deepEqual(Object.keys(map), [path])
  assert.deepEqual(map[path], { remote, exactTag: "v1.0.3", headSha: "a".repeat(40), ancestors: ["a".repeat(40)] })
  assert.equal(map["/plugins/path-forgery"], undefined)
  assert.equal(map["/plugins/tsv-forgery"], undefined)
  assert.equal(map["/plugins/json-forgery"], undefined)
})

const listEntries = [
  { id: "omarchy.clock", name: "Clock", kinds: ["bar-widget"], enabled: true, firstParty: true },
  { id: "acme.weather", name: "Weather", kinds: ["bar-widget"], enabled: true, firstParty: false },
  { id: "acme.dev", name: "Dev", kinds: ["service"], enabled: false, firstParty: false }
]
const catalogEntries = [
  { id: "omarchy.clock", sourceDir: "/usr/share/omarchy/shell/plugins/panels/clock", description: "Clock" },
  { id: "acme.weather", sourceDir: "/plugins/acme.weather", description: "Weather" },
  { id: "acme.dev", sourceDir: "/plugins/acme.dev", description: "Dev" }
]
const gitMap = {
  "/plugins/acme.weather": { remote: "https://example.com/weather.git", exactTag: "v2.0.1", headSha: "a".repeat(40),
    ancestors: ["a".repeat(40), "9".repeat(40)] },
  "/plugins/acme.dev": { remote: "", exactTag: "", headSha: "b".repeat(64) }
}

test("mergePlugins strips markup out of everything a manifest supplied", () => {
  const rows = Model.mergePlugins(
    [{ id: "evil.one", name: '<img src="https://evil/n">', kinds: ["bar-widget"], enabled: true }],
    [{ id: "evil.one", sourceDir: "/plugins/evil.one", description: '<img src="https://evil/d">' }],
    {},
    { "evil.one": { author: '<img src="https://evil/a">', version: "<b>9</b>" } })
  const row = rows[0]
  for (const field of [row.name, row.description, row.author, row.localVersion]) {
    assert.ok(!/[<>]/.test(field), "left markup in: " + field)
  }
})

test("mergePlugins puts installed plugins ahead of built-ins", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  assert.deepEqual(rows.map(r => r.id), ["acme.dev", "acme.weather", "omarchy.clock"])
})

test("mergePlugins marks built-ins as neither removable nor updatable", () => {
  const clock = Model.mergePlugins(listEntries, catalogEntries, gitMap).find(r => r.id === "omarchy.clock")
  assert.equal(clock.removable, false)
  assert.equal(clock.updatable, false)
  assert.equal(clock.gitManaged, false)
})

test("mergePlugins offers update only where a remote exists", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  const weather = rows.find(r => r.id === "acme.weather")
  const dev = rows.find(r => r.id === "acme.dev")

  assert.equal(weather.gitManaged, true)
  assert.equal(weather.updatable, true)
  assert.equal(weather.remote, "https://example.com/weather.git")
  assert.equal(weather.exactTag, "v2.0.1")
  assert.equal(weather.headSha, "a".repeat(40))

  // A working copy with no origin is still git-managed, but a fast-forward
  // has nowhere to pull from.
  assert.equal(dev.gitManaged, true)
  assert.equal(dev.updatable, false)
  assert.equal(dev.removable, true)
})

test("mergePlugins survives a plugin the catalog never mentioned", () => {
  const rows = Model.mergePlugins([{ id: "ghost", name: "Ghost", firstParty: false }], [], {})
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sourceDir, "")
  assert.equal(rows[0].removable, false)
  assert.equal(rows[0].updatable, false)
})

// A bar has no off, only a successor, so the shell reports canDisable: false
// for one. The row has to carry that or the panel offers a verb the CLI will
// refuse.
test("mergePlugins carries whether a plugin can be switched off", () => {
  const rows = Model.mergePlugins(
    [{ id: "a.bar", name: "Bar", kinds: ["bar"], enabled: true, canDisable: false },
     { id: "b.widget", name: "Widget", kinds: ["bar-widget"], enabled: true, canDisable: true }],
    [], {})
  assert.equal(rows.find(r => r.id === "a.bar").canDisable, false)
  assert.equal(rows.find(r => r.id === "b.widget").canDisable, true)
})

test("mergePlugins carries the author and version out of each manifest", () => {
  const meta = { "acme.weather": { author: "Acme Corp", version: "2.0.1" } }
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap, meta)
  const weather = rows.find(r => r.id === "acme.weather")
  assert.equal(weather.author, "Acme Corp")
  assert.equal(weather.localVersion, "2.0.1")
  assert.equal(weather.exactTag, "v2.0.1")

  const dev = rows.find(r => r.id === "acme.dev")
  assert.equal(dev.author, "")
  assert.equal(dev.localVersion, "")
})

test("mergePlugins ignores entries with no id", () => {
  assert.deepEqual(Model.mergePlugins([null, {}, { name: "x" }], [], {}), [])
})

test("countRemovable counts only what lives in the user plugin directory", () => {
  assert.equal(Model.countRemovable(Model.mergePlugins(listEntries, catalogEntries, gitMap)), 2)
})

// ---- Enabling ------------------------------------------------------------

test("canEnable offers the action only to plugins that are off", () => {
  assert.equal(Model.canEnable({ id: "a.b", enabled: false, kinds: ["bar-widget"] }), true)
  assert.equal(Model.canEnable({ id: "a.b", enabled: true, kinds: ["bar-widget"] }), false)
  assert.equal(Model.canEnable(null), false)
})

// Disable takes a widget out of the bar and leaves the plugin on disk. It is
// the exact inverse of enable, and the only thing it cannot be applied to is a
// whole-bar plugin: a bar has no off, only a successor.
test("canDisable offers the action only to plugins that are on", () => {
  assert.equal(Model.canDisable({ id: "a.b", enabled: true, canDisable: true }), true)
  assert.equal(Model.canDisable({ id: "a.b", enabled: false, canDisable: true }), false)
  assert.equal(Model.canDisable({ id: "a.b", enabled: true, canDisable: false }), false)
  assert.equal(Model.canDisable(null), false)
})

test("disableCommand names the plugin and nothing else", () => {
  assert.deepEqual(Model.disableCommand({ id: "a.b" }), ["omarchy", "plugin", "disable", "a.b"])
  assert.deepEqual(Model.disableCommand({ id: "" }), [])
  assert.deepEqual(Model.disableCommand(null), [])
})

// Enabling or disabling a bar widget rewrites bar.layout, which makes the bar
// rebuild its widgets — this panel among them. The status line it would have
// written is destroyed before anyone reads it, so the outcome is announced
// where it survives.
test("enableNote says where the widget landed", () => {
  assert.equal(Model.enableNote("right"), "It has a place in the right section of the bar now.")
  assert.equal(Model.enableNote(""), "It is switched on now.")
  assert.equal(Model.enableNote("nonsense"), "It is switched on now.")
})

test("disableNote makes clear nothing was uninstalled", () => {
  assert.equal(Model.disableNote(), "It is off the bar, but still installed.")
})

test("the disable action reports in its own words", () => {
  assert.equal(Model.actionVerb("disable"), "Disable")
  assert.equal(Model.actionGerund("disable"), "Disabling")
  assert.equal(Model.successMessage("disable", "Active window"), "Disabled Active window")
})

test("needsPlacement asks where only for widgets that take a place in the bar", () => {
  assert.equal(Model.needsPlacement({ kinds: ["bar-widget"] }), true)
  assert.equal(Model.needsPlacement({ kinds: ["service", "bar-widget"] }), true)
  assert.equal(Model.needsPlacement({ kinds: ["service"] }), false)
  assert.equal(Model.needsPlacement({ kinds: ["overlay"] }), false)
  assert.equal(Model.needsPlacement(null), false)
})

// A whole-bar plugin replaces the bar rather than sitting in a section, and
// `omarchy plugin enable` fails outright if handed a placement for one.
test("needsPlacement refuses to place a plugin that IS the bar", () => {
  assert.equal(Model.needsPlacement({ kinds: ["bar"] }), false)
  assert.equal(Model.needsPlacement({ kinds: ["bar", "bar-widget"] }), false)
})

test("placementOptions offers the three sections the bar actually has", () => {
  assert.deepEqual(Model.placementOptions().map(o => o.value), ["left", "center", "right"])
})

// The restart runs detached with a stub `omarchy` on PATH, so what is
// asserted is what the shell will do, not the text of the script.
function runRestartShell(env) {
  const bin = mkdtempSync(join(tmpdir(), "pm-restart-bin-"))
  try {
    writeFileSync(join(bin, "omarchy"), "#!/bin/bash\nprintf '%s\\n' \"$*\" > \"$CALLED\"\n")
    chmodSync(join(bin, "omarchy"), 0o755)
    const cmd = Model.restartShellCommand()
    return spawnSync(cmd[0], cmd.slice(1), {
      env: { ...env, PATH: bin + ":/usr/bin:/bin", CALLED: join(bin, "called") },
      encoding: "utf8"
    })
  } finally {
    // Read before the directory goes, so the caller sees what was invoked.
    runRestartShell.called = existsSync(join(bin, "called")) ? readFileSync(join(bin, "called"), "utf8") : null
    rmSync(bin, { recursive: true, force: true })
  }
}

test("restartShellCommand is a constant argv: bash runs a fixed script and no data", () => {
  const cmd = Model.restartShellCommand()
  assert.equal(cmd.length, 4)
  assert.deepEqual(cmd.slice(0, 2), ["bash", "-c"])
  assert.equal(cmd[3], "restart-shell")
  assert.deepEqual(Model.restartShellCommand(), cmd)
})

test("restartShellCommand drops the compiled-QML cache under HOME, then hands the restart to the host", () => {
  const home = mkdtempSync(join(tmpdir(), "pm-restart-home-"))
  try {
    const cache = join(home, ".cache", "quickshell", "qmlcache")
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, "0aeff5ea.qmlc"), "stale")
    const run = runRestartShell({ HOME: home })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(existsSync(cache), false)
    assert.equal(existsSync(join(home, ".cache", "quickshell")), true)
    assert.equal(runRestartShell.called, "restart shell\n")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("restartShellCommand honours XDG_CACHE_HOME and restarts even when there is no cache yet", () => {
  const home = mkdtempSync(join(tmpdir(), "pm-restart-home-"))
  try {
    const xdg = join(home, "elsewhere")
    const cache = join(xdg, "quickshell", "qmlcache")
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, "0aeff5ea.qmlc"), "stale")
    const run = runRestartShell({ HOME: home, XDG_CACHE_HOME: xdg })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(existsSync(cache), false)
    assert.equal(runRestartShell.called, "restart shell\n")

    const bare = runRestartShell({ HOME: home, XDG_CACHE_HOME: join(home, "nothing-here") })
    assert.equal(bare.status, 0, bare.stderr)
    assert.equal(runRestartShell.called, "restart shell\n")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("restartShellCommand leaves a symlink planted on the cache name where it is", () => {
  const home = mkdtempSync(join(tmpdir(), "pm-restart-home-"))
  try {
    const victim = join(home, "victim")
    mkdirSync(victim)
    writeFileSync(join(victim, "keep.txt"), "must survive")
    mkdirSync(join(home, ".cache", "quickshell"), { recursive: true })
    const cache = join(home, ".cache", "quickshell", "qmlcache")
    symlinkSync(victim, cache)
    const run = runRestartShell({ HOME: home })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "must survive")
    assert.equal(lstatSync(cache).isSymbolicLink(), true)
    assert.equal(runRestartShell.called, "restart shell\n")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("enableCommand passes the section only when one was chosen", () => {
  assert.deepEqual(
    Model.enableCommand({ id: "a.b", kinds: ["bar-widget"] }, "right"),
    ["omarchy", "plugin", "enable", "a.b", "right"])
  assert.deepEqual(
    Model.enableCommand({ id: "a.b", kinds: ["service"] }, ""),
    ["omarchy", "plugin", "enable", "a.b"])
})

// The section is what the user picked from a fixed list, never free text —
// but this builds an argv array that reaches a CLI, so it is checked here too
// rather than trusted because the UI happens to be a set of buttons today.
test("enableCommand drops a section that is not one of the three", () => {
  assert.deepEqual(
    Model.enableCommand({ id: "a.b", kinds: ["bar-widget"] }, "--yes"),
    ["omarchy", "plugin", "enable", "a.b"])
  assert.deepEqual(
    Model.enableCommand({ id: "a.b", kinds: ["bar-widget"] }, "Right"),
    ["omarchy", "plugin", "enable", "a.b"])
})

test("enableCommand refuses a row with no id", () => {
  assert.deepEqual(Model.enableCommand(null, "left"), [])
  assert.deepEqual(Model.enableCommand({ id: "" }, "left"), [])
})

test("the enable action reports failure in its own words", () => {
  assert.equal(Model.actionVerb("enable"), "Enable")
  assert.equal(Model.actionGerund("enable"), "Enabling")
})

// The placement question outlives the list underneath it: a background reload
// can land while the dialog is open, and answering must not enable whatever
// now happens to sit at that position.
test("findRow looks a plugin up by id rather than by position", () => {
  const rows = [{ id: "a.b" }, { id: "c.d" }]
  assert.equal(Model.findRow(rows, "c.d").id, "c.d")
  assert.equal(Model.findRow(rows, "gone"), null)
  assert.equal(Model.findRow(rows, ""), null)
  assert.equal(Model.findRow(null, "a.b"), null)
})

// The panel is a plugin, and cloning one into ~/.config/omarchy/plugins makes
// the shell tear every plugin widget down and rebuild it — this panel with
// them. So anything that has to be asked about an install must be asked BEFORE
// the install starts, which means reading the kind off the registry listing
// rather than off the manifest that does not exist yet.
// "Bar" is a whole-bar replacement, and it is a prefix of "Bar widget" — so
// this has to match the phrase, not the word.
test("mergePlugins tags each row with the section it belongs to", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  assert.equal(rows.find(r => r.id === "omarchy.clock").group, "built-in")
  assert.equal(rows.find(r => r.id === "acme.weather").group, "installed")
})

test("rowsInGroup slices the flat list without reordering it", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  const installed = Model.rowsInGroup(rows, "installed")
  const builtin = Model.rowsInGroup(rows, "built-in")

  assert.deepEqual(installed.map(r => r.id), ["acme.dev", "acme.weather"])
  assert.deepEqual(builtin.map(r => r.id), ["omarchy.clock"])

  // The two slices must rejoin into the original order, because one flat
  // selection index addresses both sections.
  assert.deepEqual([...installed, ...builtin].map(r => r.id), rows.map(r => r.id))
})

test("sectionHeading counts what is actually on screen", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  assert.equal(Model.sectionHeading(rows, "installed"), "INSTALLED  ·  2")
  assert.equal(Model.sectionHeading(rows, "built-in"), "BUILT-IN  ·  1")
  assert.equal(Model.sectionHeading(Model.filterByKind(rows, "service"), "installed"), "INSTALLED  ·  1")
})

test("kindOptions is derived from installed plugins, not a fixed list", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  assert.deepEqual(Model.kindOptions(rows), [
    { value: "all", label: "All" },
    { value: "bar-widget", label: "Bar-widget" },
    { value: "service", label: "Service" }
  ])
})

test("kindOptions gives an unknown kind a chip rather than hiding it", () => {
  const rows = Model.mergePlugins(
    [{ id: "a.b", name: "B", kinds: ["hologram"], firstParty: false }], [], {})
  assert.deepEqual(Model.kindOptions(rows).map(o => o.value), ["all", "hologram"])
  assert.equal(Model.kindLabel("hologram"), "hologram")
})

test("the bar and widget chips are merged into one that covers both kinds", () => {
  const rows = Model.mergePlugins([
    { id: "a.whole", name: "Whole", kinds: ["bar"], firstParty: false },
    { id: "a.mounted", name: "Mounted", kinds: ["bar-widget"], firstParty: false },
    { id: "a.daemon", name: "Daemon", kinds: ["service"], firstParty: false }
  ], [], {})

  assert.deepEqual(Model.kindOptions(rows), [
    { value: "all", label: "All" },
    { value: "bar-widget", label: "Bar-widget" },
    { value: "service", label: "Service" }
  ])

  assert.deepEqual(
    Model.filterByKind(rows, "bar-widget").map(r => r.id),
    ["a.mounted", "a.whole"])
})

test("the merged chip is reachable by either kind it covers", () => {
  const rows = Model.mergePlugins(
    [{ id: "a.whole", name: "Whole", kinds: ["bar"], firstParty: false }], [], {})
  assert.equal(Model.filterByKind(rows, "bar").length, 1)
  assert.equal(Model.filterKind("bar"), "bar-widget")
  assert.equal(Model.filterKind("service"), "service")
})

test("rows still name their own kind — merging is a filter concern only", () => {
  assert.equal(Model.kindLabel("bar"), "Bar")
  assert.equal(Model.kindLabel("bar-widget"), "Widget")
  assert.equal(Model.filterKindLabel("bar-widget"), "Bar-widget")
  assert.equal(Model.filterKindLabel("service"), "Service")
})

test("filterByKind keeps plugins that declare the kind among several", () => {
  const rows = Model.mergePlugins(
    [{ id: "a.b", name: "B", kinds: ["service", "bar-widget"], firstParty: false }], [], {})
  assert.equal(Model.filterByKind(rows, "service").length, 1)
  assert.equal(Model.filterByKind(rows, "bar-widget").length, 1)
  assert.equal(Model.filterByKind(rows, "panel").length, 0)
  assert.equal(Model.filterByKind(rows, "all").length, 1)
  assert.equal(Model.filterByKind(rows, "").length, 1)
})

test("nextKind wraps so the cycle key never dead-ends", () => {
  const options = [{ value: "all" }, { value: "bar-widget" }, { value: "service" }]
  assert.equal(Model.nextKind(options, "all"), "bar-widget")
  assert.equal(Model.nextKind(options, "service"), "all")
  assert.equal(Model.nextKind(options, "gone"), "all")
  assert.equal(Model.nextKind([], "all"), "all")
})

test("metaLine pairs the author with readable kind labels", () => {
  assert.equal(Model.metaLine({ id: "a.b", author: "Ada", kinds: [] }), "Ada  ·  no kind")
  assert.equal(Model.metaLine({ id: "a.b", author: "Ada", kinds: ["bar-widget", "service"] }), "Ada  ·  Widget · Service")
})

// A manifest with no author still names its namespace in the id, and that
// namespace is the handle the plugin was published under.
test("metaLine falls back to the id namespace when no author is declared", () => {
  assert.equal(Model.metaLine({ id: "agx.screen-time", kinds: ["bar-widget"] }), "agx  ·  Widget")
})

test("metaLine drops the author segment when nothing names one", () => {
  assert.equal(Model.metaLine({ id: "ghost", kinds: ["service"] }), "Service")
})

test("authorLabel prefers the manifest author over the id namespace", () => {
  assert.equal(Model.authorLabel({ id: "agx.screen-time", author: "  agx  " }), "agx")
  assert.equal(Model.authorLabel({ id: "agx.screen-time" }), "agx")
  assert.equal(Model.authorLabel({ id: "ghost" }), "")
  assert.equal(Model.authorLabel(null), "")
})

test("descriptionLine says a missing description is the manifest's doing", () => {
  assert.equal(Model.descriptionLine({ description: "Does a thing" }), "Does a thing")
  assert.match(Model.descriptionLine({ description: "   " }), /manifest/)
  assert.match(Model.descriptionLine({}), /manifest/)
  assert.equal(Model.hasDescription({ description: "Does a thing" }), true)
  assert.equal(Model.hasDescription({ description: "  " }), false)
})

test("sourceBadge stays silent for built-ins, whose section already said it", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  assert.equal(Model.sourceBadge(rows.find(r => r.id === "omarchy.clock")), "")
  assert.equal(Model.sourceBadge(rows.find(r => r.id === "acme.weather")), "git")
  assert.equal(Model.sourceBadge(rows.find(r => r.id === "acme.dev")), "git")
  assert.equal(Model.sourceBadge({ firstParty: false, gitManaged: false }), "local")
})

test("lastLine picks the last thing stderr actually said", () => {
  assert.equal(Model.lastLine("first\nsecond\n\n  \n"), "second")
  assert.equal(Model.lastLine("   "), "")
})

test("failureMessage prefers the CLI's own words, and falls back to the exit code", () => {
  assert.equal(Model.failureMessage("remove", "fatal: repository not found\n", 128), "Remove failed: fatal: repository not found")
  assert.equal(Model.failureMessage("remove", "", 1), "Remove failed (exit 1)")
})

test("actionGerund does not produce Updateing", () => {
  assert.equal(Model.actionGerund("update"), "Updating")
  assert.equal(Model.actionGerund("remove"), "Removing")
  assert.equal(Model.actionGerund("install"), "Working")
  assert.equal(Model.actionVerb("install"), "Action")
})

// No install kind is sent any more, so none keeps a message branch.
test("successMessage names no install kind", () => {
  assert.equal(Model.successMessage("install", "omarchy-clock"), "Done")
  assert.equal(Model.successMessage("add", "omarchy-clock"), "Done")
})

test("matchesQuery searches name and id, case-insensitively", () => {
  const row = { name: "Hardware Tooltip", id: "im0001gt.hw-tooltip", description: "Names your CPU and GPU" }
  assert.equal(Model.matchesQuery(row, "hardware"), true)
  assert.equal(Model.matchesQuery(row, "TOOLTIP"), true)
  assert.equal(Model.matchesQuery(row, "im0001gt"), true)
  assert.equal(Model.matchesQuery(row, "hw-tool"), true)
  assert.equal(Model.matchesQuery(row, "  tooltip  "), true)
})

test("matchesQuery does not search descriptions", () => {
  // A search that matched prose would surface plugins whose names look
  // nothing like what was typed, which reads as a bug rather than a feature.
  const row = { name: "Hardware Tooltip", id: "im0001gt.hw-tooltip", description: "Names your CPU and GPU" }
  assert.equal(Model.matchesQuery(row, "GPU"), false)
})

test("an empty query matches everything, including a whitespace-only one", () => {
  const row = { name: "A", id: "b.c" }
  assert.equal(Model.matchesQuery(row, ""), true)
  assert.equal(Model.matchesQuery(row, "   "), true)
  assert.equal(Model.matchesQuery(row, null), true)
})

test("statusOptions exposes All, Enabled, Disabled, and Update", () => {
  assert.deepEqual(Model.statusOptions(), [
    { value: "all", label: "All" },
    { value: "enabled", label: "Enabled" },
    { value: "disabled", label: "Disabled" },
    { value: "update", label: "Update" }
  ])
})

test("filterRows applies status, kind, and search together", () => {
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap)
  const checkedRows = rows.map(row => ({ ...row, behind: row.id === "acme.weather" }))

  assert.deepEqual(Model.filterRows(rows, "all", "all", "").map(r => r.id), ["acme.dev", "acme.weather", "omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "all", "enabled", "").map(r => r.id), ["acme.weather", "omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "all", "disabled", "").map(r => r.id), ["acme.dev"])
  assert.deepEqual(Model.filterRows(rows, "all", "enabled", "acme").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(rows, "bar-widget", "enabled", "acme").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(rows, "service", "disabled", "dev").map(r => r.id), ["acme.dev"])
  assert.deepEqual(Model.filterRows(rows, "service", "enabled", "weather").map(r => r.id), [])
  assert.deepEqual(Model.filterRows(checkedRows, "all", "update", "").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(checkedRows, "bar-widget", "update", "weather").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(checkedRows, "service", "update", "weather").map(r => r.id), [])
})

test("status filtering preserves both section classes and their flat selection order", () => {
  const rows = Model.mergePlugins([
    { id: "z.installed-on", name: "Zed", kinds: ["service"], enabled: true, firstParty: false },
    { id: "a.installed-off", name: "Alpha", kinds: ["service"], enabled: false, firstParty: false },
    { id: "z.builtin-on", name: "Zulu", kinds: ["service"], enabled: true, firstParty: true },
    { id: "a.builtin-off", name: "Able", kinds: ["service"], enabled: false, firstParty: true }
  ], [], {}).map(row => ({
    ...row,
    behind: row.id === "a.installed-off" || row.id === "z.builtin-on"
  }))
  const filtered = Model.filterRows(rows, "service", "disabled", "a")
  const rejoined = [...Model.rowsInGroup(filtered, "installed"), ...Model.rowsInGroup(filtered, "built-in")]
  const updates = Model.filterRows(rows, "service", "update", "")
  const rejoinedUpdates = [...Model.rowsInGroup(updates, "installed"), ...Model.rowsInGroup(updates, "built-in")]

  assert.deepEqual(Model.filterByStatus(rows, "all").map(r => r.id), rows.map(r => r.id))
  assert.deepEqual(rejoined.map(r => r.id), ["a.installed-off", "a.builtin-off"])
  assert.deepEqual(rejoined.map(r => r.group), ["installed", "built-in"])
  assert.deepEqual(rejoined.map(r => r.id), filtered.map(r => r.id))
  assert.deepEqual(rejoinedUpdates.map(r => r.id), ["a.installed-off", "z.builtin-on"])
  assert.deepEqual(rejoinedUpdates.map(r => r.id), updates.map(r => r.id))
})

test("groupOptions offers the two sections plus All, in section order", () => {
  assert.deepEqual(Model.groupOptions(), [
    { value: "all", label: "All" },
    { value: "installed", label: "Installed" },
    { value: "built-in", label: "Built-in" }
  ])
})

test("filterRows narrows by group alongside kind, status, and search", () => {
  const rows = [
    { id: "acme.dev", name: "Dev", kinds: ["service"], enabled: false, group: "installed" },
    { id: "acme.weather", name: "Weather", kinds: ["bar-widget"], enabled: true, group: "installed" },
    { id: "omarchy.clock", name: "Clock", kinds: ["bar-widget"], enabled: true, group: "built-in" }
  ]
  assert.deepEqual(Model.filterRows(rows, "all", "all", "", "all").map(r => r.id), ["acme.dev", "acme.weather", "omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "all", "all", "").map(r => r.id), ["acme.dev", "acme.weather", "omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "all", "all", "", "installed").map(r => r.id), ["acme.dev", "acme.weather"])
  assert.deepEqual(Model.filterRows(rows, "all", "all", "", "built-in").map(r => r.id), ["omarchy.clock"])
  assert.deepEqual(Model.filterRows(rows, "bar-widget", "enabled", "", "installed").map(r => r.id), ["acme.weather"])
  assert.deepEqual(Model.filterRows(rows, "all", "all", "clock", "installed").map(r => r.id), [])
  assert.deepEqual(Model.filterRows(rows, "all", "all", "", "nonsense").map(r => r.id), [])
})

test("isFiltering and emptyMessage account for the group filter", () => {
  assert.equal(Model.isFiltering("all", "all", "", "all"), false)
  assert.equal(Model.isFiltering("all", "all", ""), false)
  assert.equal(Model.isFiltering("all", "all", "", "installed"), true)
  assert.equal(Model.isFiltering("all", "all", "", "built-in"), true)

  assert.equal(Model.emptyMessage("all", "all", "", "built-in"), "No built-in plugins found.")
  assert.equal(Model.emptyMessage("all", "all", "zzz", "installed"), "No installed plugins match “zzz”.")
  assert.equal(Model.emptyMessage("service", "disabled", "", "built-in"), "No disabled built-in service plugins found.")
  assert.equal(Model.emptyMessage("all", "update", "", "installed"), "No confirmed installed plugin updates found.")
  assert.equal(Model.emptyMessage("service", "update", "zzz", "built-in"), "No confirmed built-in service plugin updates match “zzz”.")
  assert.equal(Model.emptyMessage("all", "all", "", "all"), "No plugins found.")
})

test("isFiltering includes status and clears only when all controls are neutral", () => {
  assert.equal(Model.isFiltering("all", "all", ""), false)
  assert.equal(Model.isFiltering("all", "all", "   "), false)
  assert.equal(Model.isFiltering("service", "all", ""), true)
  assert.equal(Model.isFiltering("all", "enabled", ""), true)
  assert.equal(Model.isFiltering("all", "disabled", ""), true)
  assert.equal(Model.isFiltering("all", "update", ""), true)
  assert.equal(Model.isFiltering("all", "all", "clock"), true)
})

test("emptyMessage names every active exclusion, including status", () => {
  assert.equal(Model.emptyMessage("all", "all", "zzz"), "No plugins match “zzz”.")
  assert.equal(Model.emptyMessage("service", "all", "zzz"), "No service plugins match “zzz”.")
  assert.equal(Model.emptyMessage("all", "disabled", "zzz"), "No disabled plugins match “zzz”.")
  assert.equal(Model.emptyMessage("service", "disabled", "zzz"), "No disabled service plugins match “zzz”.")
  assert.equal(Model.emptyMessage("service", "enabled", ""), "No enabled service plugins found.")
  assert.equal(Model.emptyMessage("all", "disabled", ""), "No disabled plugins found.")
  assert.equal(Model.emptyMessage("all", "update", "zzz"), "No confirmed plugin updates match “zzz”.")
  assert.equal(Model.emptyMessage("service", "update", "zzz"), "No confirmed service plugin updates match “zzz”.")
  assert.equal(Model.emptyMessage("service", "update", ""), "No confirmed service plugin updates found.")
  assert.equal(Model.emptyMessage("all", "update", ""), "No confirmed updates found.")
  assert.equal(Model.emptyMessage("bar-widget", "all", ""), "No bar-widget plugins found.")
  assert.equal(Model.emptyMessage("all", "all", ""), "No plugins found.")
})

// ---- Marketplace catalog ---------------------------------------------------

const catalogDoc = {
  generatedAt: "2026-08-20T21:33:17.660Z",
  plugins: [
    {
      id: "acme.weather", name: "Weather", description: "Forecast in the bar",
      author: "acme", version: "v1.2.3", category: "Widgets", kind: "Bar widget",
      repo: "https://github.com/acme/omarchy-weather",
      installCommand: "omarchy plugin add https://github.com/acme/omarchy-weather.git --enable",
      installAvailable: true, verificationStatus: "verified", sourceType: "community",
      verificationCommit: "d".repeat(40),
      stars: 120, marketplaceHearts: 7, addedAt: "2026-08-19",
      listedAt: "2026-08-19T14:30:00.000Z",
      accent: "cyan", initials: "WE", previewThumbnail: "assets/img/w-card.webp"
    },
    {
      id: "acme.suite", name: "Suite", description: "A whole shell",
      author: "acme", version: "", category: "Desktop", kind: "Suite",
      repo: "https://github.com/acme/suite", installCommand: "",
      installAvailable: false, installNote: "This repository has its own installer.",
      verificationStatus: "unverified", sourceType: "community",
      stars: 9, marketplaceHearts: 0, accent: "violet", initials: "SU"
    },
    {
      id: "omarchy.clock", name: "Clock", description: "Built in",
      category: "Widgets", installAvailable: true, sourceType: "builtin",
      repo: "https://github.com/omarchy/omarchy", stars: 999, initials: "CL"
    }
  ]
}

test("parseCatalog rejects anything that is not a plugin document", () => {
  assert.equal(Model.parseCatalog("not json"), null)
  assert.equal(Model.parseCatalog('{"plugins":"nope"}'), null)
  assert.equal(Model.parseCatalog(""), null)
  assert.ok(Model.parseCatalog(JSON.stringify(catalogDoc)))
})

test("catalogEntries drops built-ins, which ship with Omarchy already", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  assert.deepEqual(entries.map(e => e.id), ["acme.weather", "acme.suite"])
})

test("catalogEntries defaults to explicit GitHub-star ordering", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  assert.deepEqual(entries.map(e => e.stars), [120, 9])
})

test("catalogEntries keeps GitHub stars honest", () => {
  const entries = Model.catalogEntries(catalogDoc)
  assert.deepEqual(entries.map(e => e.stars), [120, 9])

  for (const value of [undefined, null, "12", false, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(Model.catalogCount(value), null)
    assert.equal(Model.starLabel(value), "")
  }
  assert.equal(Model.catalogCount(0), 0)
  assert.equal(Model.starLabel(0), "0")
})

test("catalogEntries keeps the marketplace's reviewed commit, normalized, and drops junk", () => {
  const listing = extra => Object.assign({ verificationStatus: "verified", sourceType: "community",
    repo: "https://github.com/acme/thing" }, extra)
  const doc = { plugins: [
    listing({ id: "a.one", verificationCommit: "2D9321902AA0176D47DCDB21D76884BCA6A34F73" }),
    listing({ id: "a.two", verificationCommit: "not-a-sha" }),
    listing({ id: "a.three" })
  ] }
  const entries = Model.catalogEntries(doc)
  assert.equal(entries.find(e => e.id === "a.one").updateSnapshot.verifiedCommit, "2d9321902aa0176d47dcdb21d76884bca6a34f73")
  assert.equal(entries.find(e => e.id === "a.two").updateSnapshot, null)
  assert.equal(entries.find(e => e.id === "a.three").updateSnapshot, null)
})

// Same brace-balanced extraction idiom as update-producer.test.mjs; no QML runtime.
function qmlFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, name)
  const brace = source.indexOf("{", start)
  let depth = 0
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1)
  }
  assert.fail(`Unterminated QML function ${name}`)
}

test("the unreviewed-update confirmation installs exactly the commit it named, or nothing", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  const tip = "c".repeat(40)
  const run = (row, sha, gate = true) => {
    const state = { busy: false, pendingKind: "update", pendingId: "thing", pendingLabel: "Thing", pendingUrl: "",
      pendingUnverifiedSha: sha, pendingPlacementNeeded: false, rows: row ? [row] : [], calls: [],
      bulkActive: false, bulkQueue: [],
      runUpdate(target) { this.calls.push(target.id) }, runAction() { this.calls.push("action") },
      canStartUpdate: () => gate, startDisable() {}, startAdd() {} }
    Function("Model", "state", `with (state) { ${qmlFunction(store, "cancelPending")}; ${qmlFunction(store, "confirmPending")}; confirmPending() }`)(Model, state)
    assert.equal(state.pendingKind, "", "the question is retired whatever the answer")
    assert.equal(state.pendingUnverifiedSha, "")
    return state.calls
  }
  const eligible = { id: "thing", unverifiedEligible: true, remoteSha: tip }
  assert.deepEqual(run(eligible, tip), ["thing"])
  assert.deepEqual(run(eligible, "d".repeat(40)), [], "the tip moved while the question was up")
  assert.deepEqual(run({ ...eligible, unverifiedEligible: false }, tip), [], "the setting went off or a verified snapshot appeared")
  assert.deepEqual(run(null, tip), [], "the row left the list")
  assert.deepEqual(run(eligible, tip, false), [], "busy or unsettled processes still gate")
  // The dialog offers the exact diff, and only for this kind of question.
  assert.match(store, /readonly property string confirmCompareUrl: pendingKind === "update"\s*\? Model\.updateCompareUrl\(Model\.findRow\(rows, pendingId\)\) : ""/)
  assert.match(store, /if \(pendingKind === "update"\)\s*return Model\.updateUnverifiedConfirmMessage\(pendingLabel, Model\.findRow\(rows, pendingId\)\)/)
})

test("a reloaded store reports a recorded bulk summary once, then never again", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  assert.match(store, /id: summaryProc/)
  assert.match(store, /\["--consume-bulk-summary"\]/)
  assert.match(store, /if \(!busy && !bulkActive\) consumeBulkSummary\(\)/)
  const target = "b".repeat(40), base = "a".repeat(40)
  const model = Function(source + "; return { findRow, bulkUpdateSummary, applyUpdateReport, applyPinnedUpdates, parseUpdateReport }")()
  const state = { rows: [{ id: "acme.plugin", name: "Plugin" }], busy: false, bulkActive: false,
    bulkQueue: [], bulkPendingRequests: [], bulkResults: [], pinnedOutput: "", pinnedOverflow: false,
    bulkRescanFailed: false, lastBulkSummaryNonce: "", summaryOutput: "", summaryOverflow: false,
    summaryDrainOnly: false,
    pendingUpdateReport: "", allowUnverifiedUpdates: false, catalog: [],
    setStatus(text, isError) { this.status = { text, isError: isError === true } },
    requestFreshUpdateCycle() { this.freshCycle = true }, refreshUpdateData() { this.updateRefresh = true },
    actionFinished(kind, label, code) { (this.finished = this.finished || []).push([kind, label, code]) },
    applyUpdateReport: (rows) => rows, applyPinnedUpdates: (rows) => rows }
  state.root = state
  Object.assign(state, Function("Model", "state", `with (state) {
    ${qmlFunction(store, "finishBulkSummary")};
    ${qmlFunction(store, "finishBulkProcess")};
    ${qmlFunction(store, "finishBulk")}; return {finishBulkSummary, finishBulkProcess, finishBulk}
  }`)(model, state))
  const payload = JSON.stringify({ status: "bulk complete", nonce: "7-9",
    updates: [{ id: "acme.plugin", status: "updated", reason: "" }], rescan: "complete" })
  state.summaryOutput = payload
  state.finishBulkSummary()
  assert.equal(state.status.text, "Updated 1, skipped 0")
  assert.equal(state.freshCycle, true)
  assert.equal(state.lastBulkSummaryNonce, "7-9")
  state.status = null
  state.freshCycle = false
  state.summaryOutput = payload
  state.finishBulkSummary()
  assert.equal(state.status, null, "the same batch is not announced twice")
  assert.equal(state.freshCycle, false)
  state.summaryOutput = payload
  state.busy = true
  state.finishBulkSummary()
  assert.equal(state.status, null, "a summary never retires an action still running")
})

test("both update entry points require the displayed tuple and settled processes", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  const model = Function(source + "; return { pinnedRequest, unverifiedRequest, findRow, shortSha }")()
  const target = "b".repeat(40), base = "a".repeat(40)
  const row = { id: "thing", name: "Thing", headSha: base, remoteSha: "c".repeat(40), verifiedTargetSha: target,
    gitManaged: true, pinnedEligible: true, updateOrigin: "https://github.com/acme/plugin" }
  const catalog = [{ id: row.id, updateSnapshot: { id: row.id, repository: row.updateOrigin, verifiedCommit: target } }]
  const pinnedProc = { running: false }, actionProc = { running: false }
  const state = { rows: [row], catalog, catalogLoaded: true, busy: false,
    busyKind: "", busyId: "", busyRowId: "", pinnedOutput: "", pinnedExited: false,
    pinnedOverflow: false, pinnedHelperPath: "/plugin/helpers/pinned_update.py", allowUnverifiedUpdates: false,
    pendingKind: "", pendingId: "", pendingLabel: "", pendingUrl: "", pendingUnverifiedSha: "",
    setStatus() {}, loadProcessSettled: () => true, updateProcessSettled: () => true }
  state.root = state
  const names = ["updateRequest", "canStartUpdate", "startUpdate", "runUpdate"]
  Object.assign(state, Function("Model", "state", "pinnedProc", "actionProc", "Quickshell", `with (state) {
    ${names.map(name => qmlFunction(store, name)).join("\n")}; return {${names.join(",")}}
  }`)(model, state, pinnedProc, actionProc, { env: key => key === "WAYLAND_DISPLAY" ? "wayland-23" : "" }))
  state.runUpdate(row)
  assert.deepEqual(pinnedProc.command.slice(0, 9), ["/usr/bin/env", "-i", "--",
    "PATH=/usr/bin:/bin", "WAYLAND_DISPLAY=wayland-23", "/usr/bin/python3", "-I", "-S", state.pinnedHelperPath])
  assert.equal(JSON.parse(pinnedProc.command[9]).verifiedCommit, target)
  const environmentProbe = spawnSync(pinnedProc.command[0], pinnedProc.command.slice(1, 8).concat([
    "-c", "import os,json; print(json.dumps(dict(os.environ)))"
  ]), { env: { PINNED_UNWANTED: "discard" }, encoding: "utf8", timeout: 2000, maxBuffer: 4096 })
  assert.equal(environmentProbe.status, 0, environmentProbe.stderr)
  const environment = JSON.parse(environmentProbe.stdout)
  assert.equal(environment.PATH, "/usr/bin:/bin")
  assert.equal(environment.WAYLAND_DISPLAY, "wayland-23")
  assert.equal(environment.PINNED_UNWANTED, undefined)
  for (const change of [{ catalogLoaded: false }, { catalog: [] }, { busy: true },
    { rows: [] }, { loadProcessSettled: () => false }, { updateProcessSettled: () => false }]) {
    const saved = { ...state }
    Object.assign(state, change)
    pinnedProc.running = false
    state.runUpdate(row)
    assert.equal(pinnedProc.running, false)
    Object.assign(state, saved)
  }
  pinnedProc.running = false
  state.runUpdate({ ...row, verifiedTargetSha: "c".repeat(40) })
  assert.equal(pinnedProc.running, false, "stale display cannot silently retarget")
  state.runUpdate({ ...row, pinnedEligible: false })
  assert.equal(pinnedProc.running, false, "upstream availability does not authorize execution")

  // The unreviewed tip: only with the setting on, only through the question,
  // and the request names that exact commit rather than a verified one.
  const unverified = { ...row, pinnedEligible: false, unverifiedEligible: true, verifiedTargetSha: "" }
  state.rows = [unverified]
  state.runUpdate(unverified)
  assert.equal(pinnedProc.running, false, "the setting is off")
  state.allowUnverifiedUpdates = true
  state.startUpdate(unverified)
  assert.equal(pinnedProc.running, false, "an unreviewed commit asks first")
  assert.equal(state.pendingKind, "update")
  assert.equal(state.pendingUnverifiedSha, unverified.remoteSha)
  state.pendingKind = ""
  state.runUpdate(unverified)
  assert.equal(pinnedProc.running, true)
  const sent = JSON.parse(pinnedProc.command[9])
  assert.deepEqual(sent, { schemaVersion: 1, id: row.id, repository: row.updateOrigin,
    unverifiedCommit: unverified.remoteSha, expectedLocalHead: base })
  pinnedProc.running = false
  state.rows = [{ ...unverified, remoteSha: "d".repeat(40) }]
  state.runUpdate(unverified)
  assert.equal(pinnedProc.running, false, "the tip the row shows must still be the tip the list holds")
})

test("action confirmation keyboard skips absent action and isolates present action", () => {
  const dialog = readFileSync(new URL("../ActionConfirmDialog.qml", import.meta.url), "utf8")
  const Qt = Object.fromEntries(["Escape", "Left", "Right", "Tab", "Backtab", "Return", "Enter"].map(key => [`Key_${key}`, key]))
  const calls = []
  const root = { opened: true, actionVisible: false, selectedIndex: 1,
    canceled: () => calls.push("cancel"), confirmed: () => calls.push("confirm"), actionRequested: () => calls.push("action") }
  const names = ["pick", "resetSelection", "handleKey"]
  Object.assign(root, Function("root", "Qt", `${names.map(name => qmlFunction(dialog, name)).join("\n")}\nreturn {${names.join(",")}}`)(root, Qt))
  const key = key => root.handleKey({ key })
  for (const direction of ["Left", "Right", "Tab", "Backtab"]) {
    root.resetSelection()
    key(direction)
    assert.equal(root.selectedIndex, 0)
    key(direction)
    assert.equal(root.selectedIndex, 1)
  }
  key("Return")
  root.actionVisible = true
  key("Tab")
  assert.equal(root.selectedIndex, 2)
  key("Enter")
  root.pick(2) // Mouse and keyboard share the same isolated dispatch.
  assert.deepEqual(calls, ["confirm", "action", "action"])
  assert.equal(root.opened, true)
  key("Right")
  assert.equal(root.selectedIndex, 0)
  key("Backtab")
  assert.equal(root.selectedIndex, 2)
  key("Left")
  assert.equal(root.selectedIndex, 1)
  key("Escape")
  root.pick(0)
  assert.deepEqual(calls.slice(-2), ["cancel", "cancel"])
  root.opened = false
  assert.equal(key("Return"), false)
  root.opened = true
  root.selectedIndex = 2
  root.resetSelection()
  assert.equal(root.selectedIndex, 1, "reopening defaults to confirm")
  assert.match(dialog, /onOpenedChanged: if \(opened\) root\.resetSelection\(\)/)
  root.actionVisible = false
  root.selectedIndex = 2
  const visibilityHandler = dialog.match(/onActionVisibleChanged: ([^\n]+)/)[1]
  Function("root", `with (root) { ${visibilityHandler} }`)(root)
  assert.equal(root.selectedIndex, 1, "disappearing action restores a reachable answer")
  root.pick(2)
  assert.equal(calls.length, 5, "hidden action never dispatches")
  assert.equal(key("Space"), false)
  assert.match(dialog, /wrapMode: Text\.WrapAtWordBoundaryOrAnywhere/)
  assert.equal((dialog.match(/Text \{/g) || []).length, (dialog.match(/textFormat: Text\.PlainText/g) || []).length)
})

test("action confirmation scrolls long messages while keeping both button layouts visible", () => {
  const dialog = readFileSync(new URL("../ActionConfirmDialog.qml", import.meta.url), "utf8")
  const viewport = dialog.match(/Flickable \{([\s\S]*?)\n\s*Item \{/)
  assert.ok(viewport, "message needs a scrollable viewport separate from buttons")
  assert.match(viewport[1], /clip: true/)
  assert.match(viewport[1], /flickableDirection: Flickable\.VerticalFlick/)
  assert.match(viewport[1], /contentHeight: messageText\.implicitHeight/)
  assert.match(viewport[1], /contentWidth: width/)
  assert.match(viewport[1], /Text \{\s*id: messageText\s*width: messageScroll\.width\s*text: root\.message/)
  assert.match(viewport[1], /wrapMode: Text\.WrapAtWordBoundaryOrAnywhere/)
  assert.doesNotMatch(viewport[1], /elide:|maximumLineCount:|\.slice\(|\.substring\(/)
  assert.match(dialog, /height: content\.implicitHeight \+ contentTopInset \+ contentBottomInset/)
  assert.match(dialog, /spacing: root\.look\.sp\(20\)/)
  assert.match(dialog, /height: root\.look\.sp\(root\.actionVisible \? 78 : 34\)/)
  const expression = viewport[1].match(/height: (Math\.min[\s\S]*?)\n\s*clip:/)[1]
  const height = Function("root", "Style", "card", "buttons", "content", "contentHeight", `return (${expression})`)
  for (const scale of [1, 1.5]) for (const paneHeight of [300, 480, 900]) {
    for (const actionVisible of [false, true]) for (const textHeight of [20, 20000]) {
      const Style = { space: value => value * scale }
      const card = { contentTopInset: 19 * scale, contentBottomInset: 19 * scale }
      const buttons = { height: Style.space(actionVisible ? 78 : 34) }
      const content = { spacing: Style.space(20) }
      const reserved = card.contentTopInset + card.contentBottomInset + buttons.height + content.spacing
      const available = paneHeight - Style.space(32) - reserved
      const actual = height({ height: paneHeight, look: { sp: Style.space } }, Style, card, buttons, content, textHeight)
      assert.equal(actual, Math.min(textHeight, available))
      assert.ok(actual + reserved <= paneHeight - Style.space(32), "buttons fit inside the pane")
      assert.equal(textHeight > actual, textHeight === 20000, "only overflowing messages scroll")
      assert.equal(height({ height: 50, look: { sp: Style.space } }, Style, card, buttons, content, textHeight), 0,
        "impossibly small panes never create a negative viewport")
    }
  }
})

test("pinned updates use a dedicated bounded process, not the host HEAD updater", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  assert.doesNotMatch(store, /"omarchy", "plugin", "update"/)
  // The only path into an update question is the unreviewed tip, after the gate.
  assert.equal(store.split('pendingKind = "update"').length - 1, 1)
  assert.match(store, /function startUpdate\(row\) \{\s*if \(!canStartUpdate\(row\)\) return\s*if \(row\.pinnedEligible === true\) \{\s*runUpdate\(row\)\s*return\s*\}[\s\S]*?pendingUnverifiedSha = row\.remoteSha\s*pendingKind = "update"/)
  const process = store.slice(store.indexOf("id: pinnedProc"), store.indexOf("id: actionProc"))
  assert.match(process, /clearEnvironment: true/)
  assert.match(process, /splitMarker: ""/)
  assert.doesNotMatch(process, /StdioCollector/)
  assert.match(store, /Qt.resolvedUrl\("helpers\/pinned_update.py"\)/)
})

test("buildCatalog turns raw catalog text into slim entries, or an error, in one pure call", () => {
  const raw = JSON.stringify(catalogDoc)
  const built = Model.buildCatalog(raw)
  assert.equal(built.error, "")
  assert.deepEqual(built.entries.map(entry => entry.id), ["acme.weather", "acme.suite"])

  for (const bad of ["not json", "", "[]", '{"plugins": 3}', undefined]) {
    const failed = Model.buildCatalog(bad)
    assert.equal(failed.entries, null, String(bad))
    assert.equal(failed.error, "Could not read the plugin catalog")
  }
})

// Catalog runtime, lifecycle, and Model.js parity are exercised in
// catalog-builder.test.mjs rather than pinning one transport implementation.

test("catalogStarsById joins GitHub stars onto installed rows by id", () => {
  const entries = Model.catalogEntries(catalogDoc, {})
  const stars = Model.catalogStarsById(entries)
  // Null prototype, like verifiedIdSet: an id named `constructor` is data.
  assert.equal(Object.getPrototypeOf(stars), null)
  assert.equal(stars["acme.weather"], 120)
  // A row with a catalog listing shows its count; one without shows nothing,
  // and an unknown count is omitted rather than shown as zero.
  assert.equal(Model.rowStarLabel({ id: "acme.weather" }, stars), "120")
  assert.equal(Model.rowStarLabel({ id: "nobody.home" }, stars), "")
  assert.equal(Model.rowStarLabel(null, stars), "")
  assert.equal(Model.rowStarLabel({ id: "acme.weather" }, null), "")
  assert.equal(Model.rowStarLabel({ id: "x" }, Model.catalogStarsById([{ id: "x", stars: null }])), "")
  assert.equal(Model.rowStarLabel({ id: "y" }, Model.catalogStarsById([{ id: "y", stars: 1966 }])), "2k")
})

test("starLabel keeps big counts short", () => {
  assert.equal(Model.starLabel(0), "0")
  assert.equal(Model.starLabel(999), "999")
  assert.equal(Model.starLabel(1200), "1.2k")
  assert.equal(Model.starLabel(undefined), "")
})

test("starSlugFor names the exact GitHub repository a star would act on", () => {
  assert.equal(Model.starSlugFor({ repo: "https://github.com/acme/thing" }), "acme/thing")
  assert.equal(Model.starSlugFor({ repo: "git@github.com:acme/thing.git" }), "acme/thing")
  assert.equal(Model.starSlugFor({ repo: "https://gitlab.com/acme/thing" }), "")
  assert.equal(Model.starSlugFor({ repo: "" }), "")
  assert.equal(Model.starSlugFor(null), "")
})

test("star commands invoke the bundled helper with no shell involved", () => {
  assert.deepEqual(Model.starToggleCommand("/plugin/helpers/github_star.py", "acme/thing"),
    ["/usr/bin/python3", "-I", "-S", "/plugin/helpers/github_star.py", "acme/thing"])
  assert.deepEqual(Model.starToggleCommand("/plugin/helpers/github_star.py", ""), [])
})

test("parseStarResult reads changed, fallback, and failed apart", () => {
  assert.deepEqual(Model.parseStarResult('{"kind":"changed","starred":true}', 0), { kind: "changed", starred: true })
  assert.deepEqual(Model.parseStarResult('{"kind":"changed","starred":false}', 0), { kind: "changed", starred: false })
  assert.deepEqual(Model.parseStarResult('{"kind":"fallback"}', 0), { kind: "fallback" })
  assert.deepEqual(Model.parseStarResult("", 1), { kind: "failed" })
})

test("bumpCount moves known counts and never invents unknown ones", () => {
  assert.equal(Model.bumpCount(4, 1), 5)
  assert.equal(Model.bumpCount(0, -1), 0)
  assert.equal(Model.bumpCount(null, 1), null)
  assert.equal(Model.bumpCount(undefined, 1), null)
})

// Omarchy themes define foreground, background, accent, urgent and muted —
// there is no success role to borrow, so the installed badge brings its own
// green and only has to survive both ends of the theme range.
test("repoShortLabel drops the host, which is the same on every card", () => {
  assert.equal(Model.repoShortLabel("https://github.com/akitaonrails/ai-usagebar"), "akitaonrails/ai-usagebar")
  assert.equal(Model.repoShortLabel("https://github.com/acme/thing.git"), "acme/thing")
  assert.equal(Model.repoShortLabel("https://github.com/acme/thing/"), "acme/thing")
  assert.equal(Model.repoShortLabel("git@github.com:acme/thing.git"), "acme/thing")
  assert.equal(Model.repoShortLabel(""), "")
})

test("browsableUrl only ever hands https to the browser", () => {
  // The repo field arrives over the network, so a url that is not a web page
  // must never reach the launcher.
  assert.equal(Model.browsableUrl("https://omarchyplugins.com/"), "https://omarchyplugins.com/")
  assert.equal(Model.browsableUrl("https://github.com/a/b"), "https://github.com/a/b")
  assert.equal(Model.browsableUrl("http://github.com/a/b"), "")
  assert.equal(Model.browsableUrl("javascript:alert(1)"), "")
  assert.equal(Model.browsableUrl("file:///etc/passwd"), "")
  assert.equal(Model.browsableUrl("https://github.com/a b"), "")
  assert.equal(Model.browsableUrl("https://github.com"), "")
  assert.equal(Model.browsableUrl(""), "")
  assert.equal(Model.browsableUrl(null), "")
})

// An installed checkout names its origin in git's own vocabulary, which is
// not a web address: ssh remotes and the .git suffix both have to be turned
// into something a browser can open.
test("repoWebUrl turns a git remote into a page you can open", () => {
  assert.equal(Model.repoWebUrl("https://github.com/a/b.git"), "https://github.com/a/b")
  assert.equal(Model.repoWebUrl("git@github.com:a/b.git"), "https://github.com/a/b")
  assert.equal(Model.repoWebUrl("ssh://git@github.com/a/b.git"), "https://github.com/a/b")
  assert.equal(Model.repoWebUrl("https://gitlab.com/group/sub/proj/"), "https://gitlab.com/group/sub/proj")
})

test("repoWebUrl refuses anything that is not a repository on the web", () => {
  assert.equal(Model.repoWebUrl(""), "")
  assert.equal(Model.repoWebUrl("/home/me/plugins/local"), "")
  assert.equal(Model.repoWebUrl("javascript:alert(1)"), "")
  assert.equal(Model.repoWebUrl("file:///etc/passwd"), "")
  assert.equal(Model.repoWebUrl("git@github.com:a b.git"), "")
  assert.equal(Model.repoWebUrl("https://github.com"), "")
})

test("rowRepoUrl prefers the live origin over what the plugin was cloned from", () => {
  // The origin is where an update will actually pull from; clonedFrom is only
  // a record of how it first arrived, and a checkout can be repointed.
  assert.equal(
    Model.rowRepoUrl({ remote: "git@github.com:a/live.git", clonedFrom: "https://github.com/a/old" }),
    "https://github.com/a/live")
  assert.equal(Model.rowRepoUrl({ remote: "", clonedFrom: "https://github.com/a/old" }), "https://github.com/a/old")
  assert.equal(Model.rowRepoUrl({ remote: "", clonedFrom: "" }), "")
  assert.equal(Model.rowRepoUrl(null), "")
})

test("manifest versions become bounded encoded Release candidates in deterministic order", () => {
  assert.equal(Model.normalizedManifestVersion("  1.2.3\n"), "1.2.3")
  assert.equal(Model.normalizedManifestVersion("x".repeat(100)), "x".repeat(100))
  assert.equal(Model.normalizedManifestVersion("x".repeat(101)), "")

  const candidates = Model.githubReleaseCandidates(
    "git@github.com:acme/thing.git", "  1.2.3+build/one  ")
  assert.deepEqual(candidates, [
    {
      probeUrl: "https://api.github.com/repos/acme/thing/releases/tags/v1.2.3%2Bbuild%2Fone",
      preferredUrl: "https://github.com/acme/thing/releases/tag/v1.2.3%2Bbuild%2Fone"
    },
    {
      probeUrl: "https://api.github.com/repos/acme/thing/releases/tags/1.2.3%2Bbuild%2Fone",
      preferredUrl: "https://github.com/acme/thing/releases/tag/1.2.3%2Bbuild%2Fone"
    }
  ])

  assert.equal(Model.normalizedReleaseVersion("vv1.2.3"), "1.2.3")
  assert.equal(Model.releaseVersionLabel("V1.2.3"), "v1.2.3")
  assert.equal(Model.releaseVersionLabel("vv"), "")
  assert.deepEqual(Model.githubReleaseCandidates(
    "https://github.com/acme/thing", "v1.2.3"), [
    {
      probeUrl: "https://api.github.com/repos/acme/thing/releases/tags/v1.2.3",
      preferredUrl: "https://github.com/acme/thing/releases/tag/v1.2.3"
    },
    {
      probeUrl: "https://api.github.com/repos/acme/thing/releases/tags/1.2.3",
      preferredUrl: "https://github.com/acme/thing/releases/tag/1.2.3"
    }
  ])
})

test("installed version eligibility requires checkout, version, and hardened current GitHub origin, not exactTag", () => {
  const eligible = {
    gitManaged: true,
    localVersion: "1.0.3",
    exactTag: "",
    headSha: "a".repeat(40),
    remote: "ssh://git@github.com/Owner/repo.name.git"
  }
  assert.equal(Model.versionReleaseCandidates(eligible).length, 2)
  assert.equal(Model.versionFallbackUrl(eligible),
    "https://github.com/Owner/repo.name/tree/" + "a".repeat(40))

  for (const row of [
    { ...eligible, gitManaged: false },
    { ...eligible, localVersion: "" },
    { ...eligible, localVersion: "x".repeat(101) },
    { ...eligible, remote: "", clonedFrom: eligible.remote },
    { ...eligible, remote: "https://gitlab.com/acme/thing" },
    { ...eligible, remote: "https://github.com/acme/thing/tree/main" },
    null
  ]) {
    assert.deepEqual(Model.versionReleaseCandidates(row), [])
    assert.equal(Model.versionFallbackUrl(row), "")
  }
})

test("installed version fallback prefers exact tag, then loaded HEAD, then repository root", () => {
  const row = {
    gitManaged: true,
    localVersion: "1.0.3",
    exactTag: "v1.0.3",
    headSha: "a".repeat(40),
    remote: "https://github.com/acme/thing.git"
  }
  assert.equal(Model.versionFallbackUrl(row),
    "https://github.com/acme/thing/tree/v1.0.3")
  assert.equal(Model.versionFallbackUrl({ ...row, exactTag: "" }),
    "https://github.com/acme/thing/tree/" + "a".repeat(40))
  assert.equal(Model.versionFallbackUrl({ ...row, exactTag: "", headSha: "" }),
    "https://github.com/acme/thing")
  assert.equal(Model.versionFallbackUrl({ ...row, exactTag: "release-1.0.3" }),
    "https://github.com/acme/thing/tree/" + "a".repeat(40))
})

test("Release candidates preserve hardened GitHub owner and repository boundaries", () => {
  const accepted = [
    "https://github.com/Mixed-Case/.github.git",
    "git@github.com:owner-name/repo_name.git",
    "ssh://git@github.com/Owner/repo.name.git"
  ]
  for (const remote of accepted)
    assert.equal(Model.githubReleaseCandidates(remote, "1.0.0").length, 2)

  for (const remote of [
    "https://github.com/../repo",
    "https://github.com/%2e%2e/repo",
    "https://github.com/owner/..",
    "https://github.com/owner/repo/tree/main",
    "https://github.com/-owner/repo",
    "https://github.com/owner_name/repo",
    "https://github.com/" + "a".repeat(40) + "/repo",
    "https://github.com/owner/" + "r".repeat(101)
  ]) assert.deepEqual(Model.githubReleaseCandidates(remote, "1.0.0"), [], remote)
})

// ---- Update checks ---------------------------------------------------------

const baseRows = [
  { id: "a.behind", sourceDir: "/plugins/a", name: "Behind", remote: "https://github.com/acme/behind.git", headSha: "a".repeat(40) },
  { id: "b.current", sourceDir: "/plugins/b", name: "Current", remote: "https://github.com/acme/current.git", headSha: "c".repeat(40) },
  { id: "c.unreachable", sourceDir: "/plugins/c", name: "Unreachable", headSha: "c".repeat(40) },
  { id: "d.notgit", sourceDir: "/plugins/d", name: "Not git" }
]

const sha40A = "a".repeat(40)
const sha40B = "b".repeat(40)
const sha40C = "c".repeat(40)
const sha64A = "a".repeat(64)
const sha64B = "b".repeat(64)

function updateRecord(overrides = {}) {
  return JSON.stringify({
    path: "/plugins/a",
    localSha: sha40A,
    remoteSha: sha40B,
    localVersion: "1.0.0",
    remoteVersion: "1.2.0",
    ...overrides
  })
}

const report = Model.parseUpdateReport([
  updateRecord(),
  updateRecord({ path: "/plugins/b", localSha: sha40C, remoteSha: sha40C, localVersion: "2.0.0", remoteVersion: "" }),
  updateRecord({ path: "/plugins/c", localSha: sha40C, remoteSha: "", localVersion: "3.0.0", remoteVersion: "" })
].join("\n"))

test("parseUpdateReport accepts exact JSONL records and keys on the plugin directory", () => {
  assert.deepEqual(Object.keys(report).sort(), ["/plugins/a", "/plugins/b", "/plugins/c"])
  assert.equal(report["/plugins/a"].remoteVersion, "1.2.0")
  assert.equal(report["/plugins/a"].localSha, sha40A)
})

test("parseUpdateReport rejects malformed JSON, legacy TSV, and the wrong schema", () => {
  const lines = [
    "not-json",
    "/plugins/legacy\t" + sha40A + "\t" + sha40B + "\t1\t2",
    "[]",
    "null",
    JSON.stringify({ path: "/plugins/missing", localSha: sha40A, remoteSha: sha40B, localVersion: "1" }),
    updateRecord({ path: "/plugins/extra", extra: "field" }),
    updateRecord({ path: "/plugins/legacy-tag", remoteTag: "v2" }),
    JSON.stringify({ path: "/plugins/type", localSha: sha40A, remoteSha: sha40B, localVersion: 1, remoteVersion: "2" }),
    updateRecord({ path: "/plugins/valid" })
  ]
  const parsed = Model.parseUpdateReport(lines.join("\n"))
  assert.deepEqual(Object.keys(parsed), ["/plugins/valid"])
})

test("parseUpdateReport keeps hostile path and version bytes inside their JSONL record", () => {
  const forgedPath = "/plugins/evil\n" + updateRecord({ path: "/plugins/victim" })
  const forgedVersion = "1.0\tforged\n" + updateRecord({ path: "/plugins/victim" })
  const parsed = Model.parseUpdateReport(updateRecord({
    path: forgedPath,
    localVersion: forgedVersion,
    remoteVersion: "2.0\rforged"
  }))

  assert.deepEqual(Object.keys(parsed), [forgedPath])
  assert.equal(parsed[forgedPath].localVersion, "1.0 forged " + updateRecord({ path: "/plugins/victim" }))
  assert.equal(parsed[forgedPath].remoteVersion, "2.0 forged")
  assert.equal(parsed["/plugins/victim"], undefined)
})

test("parseUpdateReport accepts only empty, 40-hex, or 64-hex object ids", () => {
  const accepted = Model.parseUpdateReport([
    updateRecord({ path: "/plugins/sha1", localSha: sha40A.toUpperCase(), remoteSha: sha40B.toUpperCase() }),
    updateRecord({ path: "/plugins/sha256", localSha: sha64A, remoteSha: sha64B }),
    updateRecord({ path: "/plugins/unknown", remoteSha: "" })
  ].join("\n"))
  assert.deepEqual(Object.keys(accepted), ["/plugins/sha1", "/plugins/sha256", "/plugins/unknown"])
  assert.equal(accepted["/plugins/sha1"].localSha, sha40A)

  const rejected = Model.parseUpdateReport([
    updateRecord({ path: "/plugins/short", localSha: "a".repeat(39) }),
    updateRecord({ path: "/plugins/long", remoteSha: "b".repeat(65) }),
    updateRecord({ path: "/plugins/nonhex", remoteSha: "g".repeat(40) })
  ].join("\n"))
  assert.deepEqual(rejected, {})
})

test("a differing remote head marks the row behind", () => {
  const rows = Model.applyUpdateReport(baseRows, report)
  const behind = rows.find(r => r.id === "a.behind")
  assert.equal(behind.behind, true)
  assert.equal(behind.updateChecked, true)
  assert.equal(behind.versionChanged, true)
  assert.equal(behind.localSha, sha40A)
  assert.equal(behind.remoteSha, sha40B)
})

test("applyUpdateReport replays report evidence only for an unchanged loaded HEAD", () => {
  const row = Model.applyUpdateReport(baseRows, report)[0]
  assert.equal(row.headSha, sha40A)
  assert.equal(row.behind, true)
  assert.equal(Model.updateCompareUrl(row),
    "https://github.com/acme/behind/compare/" + sha40A + "..." + sha40B)
})

test("a matching head is up to date, not behind", () => {
  const rows = Model.applyUpdateReport(baseRows, report)
  const current = rows.find(r => r.id === "b.current")
  assert.equal(current.behind, false)
  assert.equal(current.updateChecked, true)
})

test("an unreachable remote is 'not known', never 'up to date'", () => {
  // Being quietly told nothing is how a stale plugin sits there looking current.
  const rows = Model.applyUpdateReport(baseRows, report)
  const unknown = rows.find(r => r.id === "c.unreachable")
  assert.equal(unknown.updateChecked, false)
  assert.equal(unknown.behind, false)

  const missing = rows.find(r => r.id === "d.notgit")
  assert.equal(missing.updateChecked, false)
  assert.equal(missing.behind, false)
})

// The manifest read at load time is the only version a built-in or a
// non-git checkout ever gets; an update pass that skipped it must not blank it.
test("applyUpdateReport keeps a manifest version the git pass never saw", () => {
  const rows = Model.applyUpdateReport(
    [{ id: "e.local", sourceDir: "/plugins/e.local", localVersion: "3.1.4" }],
    report
  )
  assert.equal(rows[0].localVersion, "3.1.4")
})

test("applyUpdateReport flattens displayed versions and revalidates sha evidence", () => {
  const rows = Model.applyUpdateReport(
    [{ id: "e.direct", sourceDir: "/plugins/e.direct", localVersion: "old\nversion", headSha: sha40A }],
    { "/plugins/e.direct": {
      localSha: sha40A.toUpperCase(),
      remoteSha: "not-an-object-id",
      localVersion: "1.0\tlocal",
      remoteVersion: "2.0\nremote"
    } }
  )
  assert.equal(rows[0].localVersion, "1.0 local")
  assert.equal(rows[0].remoteVersion, "2.0 remote")
  assert.equal(rows[0].localSha, sha40A)
  assert.equal(rows[0].remoteSha, "")
  assert.equal(rows[0].updateChecked, false)
  assert.equal(rows[0].behind, false)
})

test("applyUpdateReport does not mutate the rows it was given", () => {
  const rows = Model.applyUpdateReport(baseRows, report)
  assert.equal(rows[0].behind, true)
  assert.equal(baseRows[0].behind, undefined)
})

test("applyUpdateReport clears stale shas when later evidence is absent or invalid", () => {
  const stale = [{
    id: "stale",
    sourceDir: "/plugins/stale",
    localVersion: "1.0.0",
    headSha: sha40A,
    localSha: sha40A,
    remoteSha: sha40B,
    updateChecked: true,
    behind: true
  }]
  const missing = Model.applyUpdateReport(stale, {})[0]
  assert.equal(missing.localSha, "")
  assert.equal(missing.remoteSha, "")
  assert.equal(missing.updateChecked, false)
  assert.equal(missing.behind, false)

  const invalid = Model.parseUpdateReport(updateRecord({
    path: "/plugins/stale",
    remoteSha: "not-an-object-id"
  }))
  const rejected = Model.applyUpdateReport(stale, invalid)[0]
  assert.equal(rejected.localSha, "")
  assert.equal(rejected.remoteSha, "")
  assert.equal(rejected.behind, false)
})

function assertUpdateEvidenceCleared(row) {
  assert.equal(row.localSha, "")
  assert.equal(row.remoteSha, "")
  assert.equal(row.remoteVersion, "")
  assert.equal(row.updateChecked, false)
  assert.equal(row.behind, false)
  assert.equal(row.versionChanged, false)
  assert.equal(Model.updateCompareUrl(row), "")
  assert.deepEqual(Model.updateReleaseCandidates(row), [])
}

test("changed loaded HEAD rejects a pending report and clears every derived target", () => {
  const freshlyLoaded = [{
    id: "a.behind",
    sourceDir: "/plugins/a",
    localVersion: "1.2.0",
    remote: "https://github.com/acme/behind.git",
    exactTag: "v1.2.0",
    headSha: sha40B,
    gitManaged: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remoteVersion: "1.2.0",
    updateChecked: true,
    behind: true,
    versionChanged: true
  }]
  const row = Model.applyUpdateReport(freshlyLoaded, report)[0]
  assertUpdateEvidenceCleared(row)
  assert.equal(row.localVersion, "1.2.0")
  assert.equal(row.headSha, sha40B)
  assert.equal(row.exactTag, "v1.2.0")
  assert.equal(Model.versionFallbackUrl(row),
    "https://github.com/acme/behind/tree/v1.2.0")
})

test("absent or invalid loaded HEAD rejects otherwise valid report evidence", () => {
  for (const headSha of ["", "a".repeat(39), "g".repeat(40), null]) {
    const row = Model.applyUpdateReport([{
      ...baseRows[0],
      localVersion: "1.0.0",
      headSha,
      localSha: sha40A,
      remoteSha: sha40B,
      behind: true,
      versionChanged: true
    }], report)[0]
    assertUpdateEvidenceCleared(row)
    assert.equal(row.localVersion, "1.0.0")
    assert.equal(row.headSha, "")
  }
})

test("pending report lifecycle rejects an old generation and accepts a fresh matching generation", () => {
  const oldPending = Model.parseUpdateReport(updateRecord())
  const oldLoaded = Model.applyUpdateReport(baseRows, oldPending)[0]
  assert.equal(oldLoaded.behind, true)

  // A successful pull or external checkout change reloads both the manifest
  // version and its provenance before the old process result is replayed.
  const newLoaded = {
    ...baseRows[0],
    localVersion: "1.2.0",
    exactTag: "v1.2.0",
    headSha: sha40B
  }
  const replayed = Model.applyUpdateReport([newLoaded], oldPending)[0]
  assertUpdateEvidenceCleared(replayed)
  assert.equal(replayed.localVersion, "1.2.0")
  assert.equal(replayed.exactTag, "v1.2.0")

  // The same stale result arriving after the new load remains powerless.
  const lateOldResult = Model.applyUpdateReport([replayed], oldPending)[0]
  assertUpdateEvidenceCleared(lateOldResult)

  const freshPending = Model.parseUpdateReport(updateRecord({
    localSha: sha40B,
    remoteSha: sha40C,
    localVersion: "1.2.0",
    remoteVersion: "1.3.0"
  }))
  const fresh = Model.applyUpdateReport([lateOldResult], freshPending)[0]
  assert.equal(fresh.behind, true)
  assert.equal(fresh.versionChanged, true)
  assert.equal(fresh.localSha, sha40B)
  assert.equal(fresh.remoteSha, sha40C)
  assert.equal(Model.updateCompareUrl(fresh),
    "https://github.com/acme/behind/compare/" + sha40B + "..." + sha40C)
  assert.equal(Model.updateReleaseCandidates(fresh)[0].preferredUrl,
    "https://github.com/acme/behind/releases/tag/v1.3.0")
})

test("the badge only shows an arrow when the versions actually differ", () => {
  // Authors do not reliably bump the manifest, so equal versions across a real
  // update is the common case — "1.0.0 → 1.0.0" would read as a bug.
  assert.equal(Model.updateBadge({ behind: true, versionChanged: true, localVersion: "1.0.0", remoteVersion: "1.2.0" }), "1.0.0 → 1.2.0")
  assert.equal(Model.updateBadge({ behind: true, versionChanged: false, localVersion: "1.0.0", remoteVersion: "1.0.0" }), "update")
  assert.equal(Model.updateBadge({ behind: false }), "")
  assert.equal(Model.updateBadge(null), "")
})

test("updateCompareUrl builds the exact GitHub comparison for 40-hex and 64-hex evidence", () => {
  assert.equal(Model.updateCompareUrl({
    behind: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remote: "https://github.com/acme/thing.git"
  }), "https://github.com/acme/thing/compare/" + sha40A + "..." + sha40B)

  assert.equal(Model.updateCompareUrl({
    behind: true,
    localSha: sha64A.toUpperCase(),
    remoteSha: sha64B.toUpperCase(),
    remote: "git@github.com:acme/thing.git"
  }), "https://github.com/acme/thing/compare/" + sha64A + "..." + sha64B)
})

test("updateCompareUrl supports GitHub SSH origins through the hardened slug parser", () => {
  const expected = "https://github.com/Owner/repo.name/compare/" + sha40A + "..." + sha40B
  assert.equal(Model.updateCompareUrl({
    behind: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remote: "ssh://git@github.com/Owner/repo.name.git"
  }), expected)
  assert.equal(Model.updateCompareUrl({
    behind: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remote: "git@github.com:Owner/repo.name.git"
  }), expected)
})

test("updateCompareUrl requires distinct valid object ids on a behind row", () => {
  const proven = {
    behind: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remote: "https://github.com/acme/thing"
  }
  assert.equal(Model.updateCompareUrl({ ...proven, behind: false }), "")
  assert.equal(Model.updateCompareUrl({ ...proven, localSha: "" }), "")
  assert.equal(Model.updateCompareUrl({ ...proven, remoteSha: "" }), "")
  assert.equal(Model.updateCompareUrl({ ...proven, remoteSha: sha40A }), "")
  assert.equal(Model.updateCompareUrl({ ...proven, localSha: "a".repeat(39) }), "")
  assert.equal(Model.updateCompareUrl({ ...proven, remoteSha: "g".repeat(40) }), "")
  assert.equal(Model.updateCompareUrl(null), "")
})

test("updateCompareUrl trusts only the current GitHub origin", () => {
  const proven = { behind: true, localSha: sha40A, remoteSha: sha40B }
  assert.equal(Model.updateCompareUrl({
    ...proven,
    remote: "https://gitlab.com/acme/thing.git",
    clonedFrom: "https://github.com/acme/thing.git"
  }), "")
  assert.equal(Model.updateCompareUrl({
    ...proven,
    remote: "",
    clonedFrom: "https://github.com/acme/thing.git"
  }), "")
  assert.equal(Model.updateCompareUrl({
    ...proven,
    remote: "https://github.com/acme/thing/tree/main"
  }), "")
  assert.equal(Model.updateCompareUrl({
    ...proven,
    remote: "https://github.com/%2e%2e/thing"
  }), "")
})

test("changed remote versions build ordered encoded Release candidates without remote tag proof", () => {
  const row = {
    behind: true,
    versionChanged: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remoteVersion: "2.0.0+build",
    remote: "ssh://git@github.com/Owner/repo.name.git"
  }
  assert.deepEqual(Model.updateReleaseCandidates(row).map(candidate => candidate.preferredUrl), [
    "https://github.com/Owner/repo.name/releases/tag/v2.0.0%2Bbuild",
    "https://github.com/Owner/repo.name/releases/tag/2.0.0%2Bbuild"
  ])
})

test("update Release lookup requires changed version plus exact comparison evidence", () => {
  const proven = {
    behind: true,
    versionChanged: true,
    localSha: sha40A,
    remoteSha: sha40B,
    remoteVersion: "2.0.0",
    remote: "https://github.com/acme/thing.git"
  }
  const rejected = [
    { ...proven, behind: false },
    { ...proven, versionChanged: false },
    { ...proven, localSha: "" },
    { ...proven, remoteSha: "" },
    { ...proven, remoteSha: sha40A },
    { ...proven, remoteVersion: "" },
    { ...proven, remoteVersion: "x".repeat(101) },
    { ...proven, remote: "", clonedFrom: proven.remote },
    { ...proven, remote: "https://gitlab.com/acme/thing", clonedFrom: proven.remote },
    null
  ]
  for (const row of rejected) assert.deepEqual(Model.updateReleaseCandidates(row), [])

  const sameVersion = { ...proven, versionChanged: false, remoteVersion: "1.0.0" }
  assert.deepEqual(Model.updateReleaseCandidates(sameVersion), [])
  assert.equal(Model.updateCompareUrl(sameVersion),
    "https://github.com/acme/thing/compare/" + sha40A + "..." + sha40B)
})

test("GitHub navigation accepts only constructed release, tree, compare, and repository URLs", () => {
  const release = "https://github.com/acme/thing/releases/tag/v1.2.0%2Bbuild"
  const api = "https://api.github.com/repos/acme/thing/releases/tags/v1.2.0%2Bbuild"
  const tree = "https://github.com/acme/thing/tree/v1.2.0%2Bbuild"
  const compare = "https://github.com/acme/thing/compare/" + sha40A + "..." + sha40B
  const repo = "https://github.com/acme/thing"
  assert.equal(Model.trustedGithubReleaseApiUrl(api), api)
  assert.equal(Model.trustedGithubReleaseUrl(release), release)
  assert.equal(Model.trustedGithubWebUrl(tree), tree)
  assert.equal(Model.trustedGithubWebUrl(compare), compare)
  assert.equal(Model.trustedGithubRepoUrl(repo), repo)
  assert.equal(Model.trustedGithubWebUrl(repo), repo)

  const rejected = [
    "http://github.com/acme/thing/tree/v1",
    "https://api.github.com/repos/acme/thing/releases/latest",
    "https://github.com/acme/thing/releases/tag/%0Aevil",
    "https://github.com/acme/thing/tree/v1?x=1",
    "https://github.com/acme/thing/compare/main...master",
    "https://github.com/acme/thing/issues"
  ]
  assert.equal(Model.trustedGithubReleaseApiUrl(rejected[1]), "")
  for (const url of rejected) assert.equal(Model.trustedGithubWebUrl(url), "")
})

test("click routing validates, pairs, deduplicates, and bounds Release candidates", () => {
  const api = "https://api.github.com/repos/acme/thing/releases/tags/v1.2.0"
  const release = "https://github.com/acme/thing/releases/tag/v1.2.0"
  const tree = "https://github.com/acme/thing/tree/v1.2.0"
  const compare = "https://github.com/acme/thing/compare/" + sha40A + "..." + sha40B
  const plain = {
    probeUrl: "https://api.github.com/repos/acme/thing/releases/tags/1.2.0",
    preferredUrl: "https://github.com/acme/thing/releases/tag/1.2.0"
  }
  assert.deepEqual(Model.githubNavigationRequest([
    { probeUrl: api, preferredUrl: release },
    { probeUrl: api, preferredUrl: release },
    plain,
    {
      probeUrl: "https://api.github.com/repos/acme/thing/releases/tags/third",
      preferredUrl: "https://github.com/acme/thing/releases/tag/third"
    }
  ], tree), {
    candidates: [{ probeUrl: api, preferredUrl: release }, plain], fallbackUrl: tree
  })
  assert.deepEqual(Model.githubNavigationRequest([], compare), {
    candidates: [], fallbackUrl: compare
  })
  assert.deepEqual(Model.githubNavigationRequest([
    { probeUrl: api, preferredUrl: "https://github.com/other/repo/releases/tag/v1.2.0" },
    { probeUrl: "https://evil.test", preferredUrl: release }
  ], tree), {
    candidates: [], fallbackUrl: tree
  })
  assert.deepEqual(Model.githubNavigationRequest([{ probeUrl: api, preferredUrl: release }], "https://evil.test"), {
    candidates: [], fallbackUrl: ""
  })
})

function releaseRequest(version) {
  return Model.githubNavigationRequest(
    Model.githubReleaseCandidates("https://github.com/acme/thing", version),
    `https://github.com/acme/thing/tree/${version}`)
}

function settleProbe(state, order, exitCode = 0, responseCode = "200") {
  const effects = []
  for (const event of order) {
    const transition = event === "exit"
      ? Model.releaseNavigationProbeExitedTransition(state, exitCode)
      : Model.releaseNavigationProbeOutputTransition(state, responseCode)
    effects.push(transition)
    state = transition.state
  }
  return { state, effects }
}

test("release navigation A then B starts only B after A fully settles", () => {
  const a = releaseRequest("v1"), b = releaseRequest("v2")
  let transition = Model.releaseNavigationRequestTransition(
    Model.releaseNavigationInitialState(), a)
  const aGeneration = transition.startRequest.generation
  let state = transition.state

  transition = Model.releaseNavigationRequestTransition(state, b)
  state = transition.state
  assert.equal(transition.stopProbe, true)
  assert.equal(transition.startRequest, null)
  assert.equal(state.activeGeneration, aGeneration)
  assert.equal(state.activeRequest, null)
  assert.equal(state.queuedRequest.request.candidates[0].preferredUrl, b.candidates[0].preferredUrl)

  const settled = settleProbe(state, ["exit", "output"])
  assert.equal(settled.effects[0].openUrl, "")
  assert.equal(settled.effects[0].scheduleStart, false)
  assert.equal(settled.effects[1].openUrl, "")
  assert.equal(settled.effects[1].scheduleStart, true)

  transition = Model.releaseNavigationStartQueuedTransition(settled.state)
  assert.equal(transition.startRequest.probeUrl, b.candidates[0].probeUrl)
  const completed = settleProbe(transition.state, ["output", "exit"])
  assert.equal(completed.effects[0].openUrl, "")
  assert.equal(completed.effects[1].openUrl, b.candidates[0].preferredUrl)
})

test("release navigation A then B then C coalesces to C", () => {
  const a = releaseRequest("v1"), b = releaseRequest("v2"), c = releaseRequest("v3")
  let transition = Model.releaseNavigationRequestTransition(
    Model.releaseNavigationInitialState(), a)
  transition = Model.releaseNavigationRequestTransition(transition.state, b)
  assert.equal(transition.state.queuedRequest.request.candidates[0].preferredUrl, b.candidates[0].preferredUrl)
  transition = Model.releaseNavigationRequestTransition(transition.state, c)
  assert.equal(transition.state.queuedRequest.request.candidates[0].preferredUrl, c.candidates[0].preferredUrl)
  assert.notEqual(transition.state.queuedRequest.request.candidates[0].preferredUrl, b.candidates[0].preferredUrl)

  const settled = settleProbe(transition.state, ["output", "exit"])
  transition = Model.releaseNavigationStartQueuedTransition(settled.state)
  assert.equal(transition.startRequest.probeUrl, c.candidates[0].probeUrl)
  const completed = settleProbe(transition.state, ["exit", "output"])
  assert.equal(completed.effects[1].openUrl, c.candidates[0].preferredUrl)
})

test("repository and direct fallback navigation revoke A and open immediately", () => {
  const a = releaseRequest("v1")
  const repo = "https://github.com/acme/thing"
  const compare = "https://github.com/acme/thing/compare/" + sha40A + "..." + sha40B

  for (const direct of [
    state => Model.releaseNavigationDirectTransition(state, repo),
    state => Model.releaseNavigationRequestTransition(
      state, Model.githubNavigationRequest([], compare))
  ]) {
    let transition = Model.releaseNavigationRequestTransition(
      Model.releaseNavigationInitialState(), a)
    transition = direct(transition.state)
    assert.equal(transition.stopProbe, true)
    assert.ok(transition.openUrl === repo || transition.openUrl === compare)
    assert.equal(transition.state.activeRequest, null)
    assert.equal(transition.state.queuedRequest, null)
    const settled = settleProbe(transition.state, ["exit", "output"])
    for (const effect of settled.effects) assert.equal(effect.openUrl, "")
  }
})

test("Marketplace root URL survives direct navigation validation", () => {
  const url = "https://omarchyplugins.com/"
  const transition = Model.releaseNavigationDirectTransition(
    Model.releaseNavigationInitialState(), url)
  assert.equal(transition.openUrl, url)
})

test("actions, tab switches, reload, and close revoke A in either callback order", () => {
  const a = releaseRequest("v1")
  for (const order of [["exit", "output"], ["output", "exit"]]) {
    for (const choice of ["action", "tab", "reload", "close"]) {
      let transition = Model.releaseNavigationRequestTransition(
        Model.releaseNavigationInitialState(), a)
      transition = Model.releaseNavigationRevokeTransition(transition.state)
      assert.equal(transition.stopProbe, true, choice)
      assert.equal(transition.state.activeRequest, null, choice)
      const settled = settleProbe(transition.state, order)
      for (const effect of settled.effects) {
        assert.equal(effect.openUrl, "", choice)
        assert.equal(effect.startRequest, null, choice)
      }
    }
  }
})

test("canceled A callbacks cannot open or consume queued B in either order", () => {
  const a = releaseRequest("v1"), b = releaseRequest("v2")
  for (const order of [["exit", "output"], ["output", "exit"]]) {
    let transition = Model.releaseNavigationRequestTransition(
      Model.releaseNavigationInitialState(), a)
    transition = Model.releaseNavigationRequestTransition(transition.state, b)
    const first = settleProbe(transition.state, [order[0]])
    assert.equal(first.effects[0].openUrl, "")
    assert.equal(first.state.queuedRequest.request.candidates[0].preferredUrl, b.candidates[0].preferredUrl)
    assert.equal(first.state.activeGeneration !== 0, true)

    const second = settleProbe(first.state, [order[1]])
    assert.equal(second.effects[0].openUrl, "")
    assert.equal(second.effects[0].scheduleStart, true)
    assert.equal(second.state.queuedRequest.request.candidates[0].preferredUrl, b.candidates[0].preferredUrl)
    transition = Model.releaseNavigationStartQueuedTransition(second.state)
    assert.equal(transition.startRequest.probeUrl, b.candidates[0].probeUrl)
  }
})

test("ordered Release probes route first 200, second 200, both 404, and hard failures", () => {
  const request = releaseRequest("1.2.0")

  let started = Model.releaseNavigationRequestTransition(
    Model.releaseNavigationInitialState(), request)
  let completed = settleProbe(started.state, ["output", "exit"], 0, "200")
  assert.equal(completed.effects[1].openUrl, request.candidates[0].preferredUrl)

  started = Model.releaseNavigationRequestTransition(
    Model.releaseNavigationInitialState(), request)
  let first = settleProbe(started.state, ["exit", "output"], 0, "404")
  assert.equal(first.effects[1].openUrl, "")
  assert.equal(first.effects[1].scheduleStart, true)
  let second = Model.releaseNavigationStartQueuedTransition(first.state)
  assert.equal(second.startRequest.probeUrl, request.candidates[1].probeUrl)
  completed = settleProbe(second.state, ["output", "exit"], 0, "200")
  assert.equal(completed.effects[1].openUrl, request.candidates[1].preferredUrl)

  started = Model.releaseNavigationRequestTransition(
    Model.releaseNavigationInitialState(), request)
  first = settleProbe(started.state, ["output", "exit"], 0, "404")
  second = Model.releaseNavigationStartQueuedTransition(first.state)
  completed = settleProbe(second.state, ["exit", "output"], 0, "404")
  assert.equal(completed.effects[1].openUrl, request.fallbackUrl)
  assert.equal(completed.effects[1].scheduleStart, false)

  for (const failure of [
    { exitCode: 0, responseCode: "403" },
    { exitCode: 0, responseCode: "500" },
    { exitCode: 0, responseCode: "not-http" },
    { exitCode: 28, responseCode: "000" }
  ]) {
    started = Model.releaseNavigationRequestTransition(
      Model.releaseNavigationInitialState(), request)
    completed = settleProbe(
      started.state, ["exit", "output"], failure.exitCode, failure.responseCode)
    assert.equal(completed.effects[1].openUrl, request.fallbackUrl)
    assert.equal(completed.effects[1].scheduleStart, false)
  }
})

test("rapid replacement owns navigation at either candidate stage", () => {
  const a = releaseRequest("1"), b = releaseRequest("2")
  for (const candidateStage of [0, 1]) {
    let transition = Model.releaseNavigationRequestTransition(
      Model.releaseNavigationInitialState(), a)
    if (candidateStage === 1) {
      const first = settleProbe(transition.state, ["exit", "output"], 0, "404")
      transition = Model.releaseNavigationStartQueuedTransition(first.state)
      assert.equal(transition.startRequest.probeUrl, a.candidates[1].probeUrl)
    }

    transition = Model.releaseNavigationRequestTransition(transition.state, b)
    assert.equal(transition.stopProbe, true)
    assert.equal(transition.state.activeRequest, null)
    assert.equal(transition.state.queuedRequest.request.candidates[0].preferredUrl,
      b.candidates[0].preferredUrl)

    const oldSettled = settleProbe(transition.state, ["output", "exit"])
    const replacement = Model.releaseNavigationStartQueuedTransition(oldSettled.state)
    assert.equal(replacement.startRequest.probeUrl, b.candidates[0].probeUrl)
    const bCompleted = settleProbe(replacement.state, ["exit", "output"], 0, "200")
    assert.equal(bCompleted.effects[1].openUrl, b.candidates[0].preferredUrl)
  }
})

test("cancellation revokes navigation at either candidate stage", () => {
  const request = releaseRequest("1")
  for (const candidateStage of [0, 1]) {
    let transition = Model.releaseNavigationRequestTransition(
      Model.releaseNavigationInitialState(), request)
    if (candidateStage === 1) {
      const first = settleProbe(transition.state, ["output", "exit"], 0, "404")
      transition = Model.releaseNavigationStartQueuedTransition(first.state)
    }
    transition = Model.releaseNavigationRevokeTransition(transition.state)
    assert.equal(transition.stopProbe, true)
    const settled = settleProbe(transition.state, ["exit", "output"], 0, "200")
    for (const effect of settled.effects) {
      assert.equal(effect.openUrl, "")
      assert.equal(effect.startRequest, null)
    }
  }
})

test("release probe start failure clears busy state and uses the active fallback", () => {
  const request = releaseRequest("v1")
  const started = Model.releaseNavigationRequestTransition(
    Model.releaseNavigationInitialState(), request)
  const failed = Model.releaseNavigationProbeStartFailedTransition(started.state)
  assert.equal(failed.state.activeGeneration, 0)
  assert.equal(failed.openUrl, request.fallbackUrl)
})

test("compact panel height uses full available geometry independent of content", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const surface = panel.match(/KeyboardPanel \{\s*id: panel\b([\s\S]*?)PanelKeyCatcher \{/)
  assert.ok(surface, "compact KeyboardPanel surface must exist")
  assert.match(surface[1], /^\s*contentHeight: panel\.cappedContentHeight\(panel\.availableCardHeight\)\s*$/m)
})

test("compact panel keeps its existing fitted width", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const surface = panel.match(/KeyboardPanel \{\s*id: panel\b([\s\S]*?)PanelKeyCatcher \{/)
  assert.ok(surface, "compact KeyboardPanel surface must exist")
  assert.match(surface[1], /^\s*contentWidth: panel\.fittedContentWidth\(root\.look\.sp\(440\)\)\s*$/m)
})

test("the Installed list has no url field and no install entry point", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")

  assert.doesNotMatch(panel, /urlField|addButton/)
  assert.doesNotMatch(panel, /function askAdd\(|function focusUrlField\(/)
  assert.doesNotMatch(panel, /https:\/\/github\.com\/user\/omarchy-plugin\.git/)
  assert.doesNotMatch(panel, /\ba add\b/)
  assert.doesNotMatch(panel, /startAdd|askInstall/)
})

test("Installed filters: labels on top, Search on its own row", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")

  assert.match(panel, /property string groupFilter: "all"/)
  assert.match(panel, /readonly property var groupOptions: Model\.groupOptions\(\)/)
  assert.match(panel, /Model\.filterRows\(rows, kindFilter, statusFilter, searchQuery, groupFilter\)/)
  assert.match(panel, /Model\.isFiltering\(kindFilter, statusFilter, searchQuery, groupFilter\)/)
  assert.match(panel, /Model\.emptyMessage\(root\.kindFilter, root\.statusFilter, root\.searchQuery, root\.groupFilter\)/)
  assert.match(panel, /function setGroupFilter\(group\)/)

  // The Installed row is one labelled block, Source · Kind · Status, sized in
  // equal columns.
  const start = panel.indexOf("id: installedFilters")
  const end = panel.indexOf("id: searchFieldLoader", start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const block = panel.slice(start, end)
  assert.doesNotMatch(panel, /browsing/)
  assert.match(block, /readonly property real optionWidth: Math\.floor\(\(width - gap \* 2\) \/ 3\)/)
  for (const label of ["Source", "Kind", "Status"]) {
    assert.match(block, new RegExp(`anchors\\.top: parent\\.top\\s+text: "${label}"`), label)
  }
  for (const id of ["groupDropdown", "kindDropdown", "statusDropdown"]) {
    assert.match(block, new RegExp(`id: ${id}\\s+anchors\\.left: parent\\.left\\s+anchors\\.right: parent\\.right\\s+anchors\\.bottom: parent\\.bottom`), id)
  }

  // Search sits below the filter row, and the key catcher
  // yields to the new dropdown's popup like the others.
  assert.doesNotMatch(panel, /anchors\.left: root\.browsing \? parent\.left : statusFilterControl\.right/)
  assert.doesNotMatch(panel, /function dropdownWidth\(/)
  assert.match(panel, /groupDropdown\.popupOpen/)
})

test("installedFilterHints mirrors the Browse row for Source, Kind, and Status", () => {
  const options = {
    group: Model.groupOptions(),
    kind: [{ value: "all", label: "All" }, { value: "service", label: "Service" }],
    status: Model.statusOptions()
  }

  assert.deepEqual(Model.installedFilterHints({ group: "all", kind: "all", status: "all" }, options), [
    { key: "s", text: "SOURCE", active: false },
    { key: "f", text: "KIND", active: false },
    { key: "t", text: "STATUS", active: false }
  ])
  assert.deepEqual(Model.installedFilterHints({ group: "built-in", kind: "service", status: "update" }, options), [
    { key: "s", text: "BUILT-IN", active: true },
    { key: "f", text: "SERVICE", active: true },
    { key: "t", text: "UPDATE", active: true }
  ])
  assert.equal(Model.installedFilterHints({}, options)[0].text, "SOURCE")
})

test("verifiedIdSet joins installed rows to the marketplace's verified listings by id", () => {
  const catalog = [
    { id: "acme.weather", verified: true },
    { id: "acme.dev", verified: false },
    { id: "constructor", verified: true },
    { id: "", verified: true }
  ]
  const ids = Model.verifiedIdSet(catalog)
  assert.equal(Model.isVerified({ id: "acme.weather" }, ids), true)
  assert.equal(Model.isVerified({ id: "acme.dev" }, ids), false)
  assert.equal(Model.isVerified({ id: "omarchy.clock" }, ids), false)
  // Untrusted ids never reach prototype machinery.
  assert.equal(Model.isVerified({ id: "constructor" }, ids), true)
  assert.equal(Model.isVerified({ id: "toString" }, ids), false)
  assert.equal(Model.isVerified(null, ids), false)
  assert.equal(Model.isVerified({ id: "acme.weather" }, Model.verifiedIdSet([])), false)
  assert.equal(Model.isVerified({ id: "acme.weather" }, null), false)
})

test("Installed rows wear the marketplace's verified pill beside the name", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")

  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  assert.match(store, /readonly property var verifiedIds: Model\.verifiedIdSet\(catalog\)/)
  assert.match(panel, /readonly property alias verifiedIds: store\.verifiedIds/)
  assert.equal(panel.split("verified: Model.isVerified(modelData, root.verifiedIds)").length - 1, 2)
  // The catalog is what knows who is verified, so opening the panel reads it
  // (cache first) even when Browse has never been visited.
  const opened = panel.slice(panel.indexOf("onOpenedChanged: {"), panel.indexOf("// ---- Processes"))
  assert.match(opened, /revokeReleaseNavigation\(\)\s*store\.loadOnOpen\(\)/)
  assert.doesNotMatch(opened, /loadCatalog\(false\)/)

  assert.match(row, /property bool verified: false/)
  const pill = row.slice(row.indexOf("id: verifiedPill"), row.indexOf("id: verifiedPill") + 900)
  assert.match(pill, /visible: root\.verified/)
  assert.match(pill, /text: "󰄬 verified"/)
  assert.match(pill, /color: root\.look\.accent/)
  assert.match(pill, /textFormat: Text\.PlainText/)
  // The name yields to the pill instead of eliding it off the row.
  assert.match(row, /id: name[\s\S]*?width: Math\.max\(0, Math\.min\(implicitWidth,[\s\S]*?verifiedPill\.visible \? verifiedPill\.width \+ nameLine\.spacing : 0/)
})

test("the header refresh button is display-sized and spins instead of greying while refreshing", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  assert.match(panel, /readonly property bool refreshing: loading \|\| checkingUpdates/)

  const button = panel.slice(panel.indexOf("id: refreshButton"), panel.indexOf("id: refreshSpinner"))
  assert.match(button, /fontSize: root\.look\.font\.display/)
  // The button's own glyph steps aside while refreshing; the spinner takes its place.
  assert.match(button, /iconText: root\.refreshing \? "" : "󰉹"/)
  assert.doesNotMatch(button, /opacity: enabled \? 1 : 0\.4/)
  assert.match(button, /opacity: root\.busy \? 0\.4 : 1/)

  const spinner = panel.slice(panel.indexOf("id: refreshSpinner"), panel.indexOf("id: refreshSpinner") + 800)
  assert.match(spinner, /visible: root\.refreshing/)
  assert.match(spinner, /text: "󰑓"/)
  // The header re-read glyph is a list mark, distinct from the per-row update
  // arrow; the small badge overlays it at reduced size and hides while refreshing.
  assert.match(button, /visible: !root\.refreshing[\s\S]*?text: "󰑐"[\s\S]*?Math\.round\(refreshButton\.fontSize \* 0\.55\)/)
  assert.match(spinner, /textFormat: Text\.PlainText/)
  assert.match(spinner, /RotationAnimation on rotation \{[\s\S]*?running: root\.refreshing[\s\S]*?from: 0[\s\S]*?to: 360[\s\S]*?direction: RotationAnimation\.Clockwise[\s\S]*?loops: Animation\.Infinite/)
})

test("the title puzzle piece snaps into place when the panel opens", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const icon = panel.slice(panel.indexOf("id: titleIcon"), panel.indexOf("id: title\n"))
  assert.match(icon, /transformOrigin: Item\.Center/)
  assert.match(icon, /SequentialAnimation \{\s*id: titleIconIntro/)
  const intro = icon.slice(icon.indexOf("id: titleIconIntro"))

  // Hidden before the first frame, and started from that frame rather than
  // from the `opened` flag: Browse's first frame lands later than Installed's
  // and an animation clocked from `opened` was over before it was drawn.
  assert.match(panel, /property bool titleIconIntroArmed: false/)
  assert.match(panel, /onOpenedChanged: \{\s*if \(!opened\) \{[^\n]*return \}\s*titleIconIntro\.stop\(\)\s*titleIcon\.opacity = 0\s*titleIconIntroArmed = true/)
  assert.doesNotMatch(panel, /onOpenedChanged: \{[\s\S]{0,200}titleIconIntro\.restart\(\)/)
  const arm = panel.slice(panel.indexOf("id: titleIconIntroTrigger"), panel.indexOf("id: titleIconIntroTrigger") + 500)
  assert.match(arm, /target: titleIcon\.Window\.window/)
  assert.match(arm, /enabled: root\.titleIconIntroArmed/)
  assert.match(arm, /function onFrameSwapped\(\) \{\s*root\.titleIconIntroArmed = false\s*titleIconIntro\.restart\(\)\s*\}/)

  // Travel is a smooth in-out over most of a second, so it reads the whole
  // way; the "click" is a separate impact at the end, not a back-easing tail.
  assert.match(intro, /^\s*PauseAnimation \{ duration: 120 \}/m)
  assert.match(intro, /property: "scale"[\s\S]*?from: 3[\s\S]*?to: 1[\s\S]*?duration: 700[\s\S]*?easing\.type: Easing\.InOutCubic/)
  assert.match(intro, /property: "rotation"[\s\S]*?from: -150[\s\S]*?to: 0[\s\S]*?duration: 700[\s\S]*?easing\.type: Easing\.InOutCubic/)
  assert.match(intro, /property: "opacity"[\s\S]*?from: 0[\s\S]*?to: 1[\s\S]*?duration: 250/)
  assert.doesNotMatch(intro, /Easing\.OutBack/)
  const settle = intro.slice(intro.indexOf("id: titleIconSettle"))
  assert.match(settle, /property: "scale"[\s\S]*?to: 0\.88[\s\S]*?property: "scale"[\s\S]*?to: 1\.08[\s\S]*?property: "scale"[\s\S]*?to: 1\b/)
  assert.match(settle, /property: "rotation"[\s\S]*?to: 8[\s\S]*?property: "rotation"[\s\S]*?to: -5[\s\S]*?property: "rotation"[\s\S]*?to: 0/)
})

test("the row state bar is a 5px rule", () => {
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")
  const bar = row.slice(row.indexOf("id: stateBar"), row.indexOf("id: stateBar") + 500)
  assert.match(bar, /width: root\.look\.sp\(5\)/)
})

test("the row's update and remove buttons use the large icon size", () => {
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")
  const update = row.slice(row.indexOf("id: updateButton"), row.indexOf("PanelActionButton {", row.indexOf("id: updateButton")))
  assert.match(update, /fontSize: root\.look\.font\.iconLarge/)
  const remove = row.slice(row.indexOf("PanelActionButton {", row.indexOf("id: updateButton")))
  assert.match(remove, /iconText: "󰩹"/)
  assert.match(remove, /fontSize: root\.look\.font\.iconLarge/)
})

test("a row's update button spins while that row is being updated", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")

  // The store tracks the updating row by id, not by the (non-unique) label;
  // the panel reads it through an alias.
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  assert.match(store, /property string busyRowId: ""/)
  assert.match(store, /function runUpdate\(row\) \{[\s\S]*?busyRowId = row\.id[\s\S]*?pinnedProc\.running = true/)
  assert.match(store, /root\.busyId = ""\s+root\.busyRowId = ""/)
  assert.match(panel, /property alias busyRowId: store\.busyRowId/)
  assert.equal(panel.split('updating: root.busyKind === "update" && root.busyRowId === modelData.id').length - 1, 1)

  assert.match(row, /property bool updating: false/)
  const button = row.slice(row.indexOf("id: updateButton"), row.indexOf("PanelActionButton {", row.indexOf("id: updateButton")))
  assert.match(button, /iconText: root\.updating \? "" : "󰑐"/)
  assert.match(button, /opacity: root\.updating \? 1 : \(enabled \? 1 : 0\.4\)/)
  const spinner = button.slice(button.indexOf("id: updateSpinner"))
  assert.match(spinner, /visible: root\.updating/)
  assert.match(spinner, /text: "󰑐"/)
  assert.match(spinner, /color: updateButton\.foreground/)
  assert.match(spinner, /textFormat: Text\.PlainText/)
  assert.match(spinner, /RotationAnimation on rotation \{[\s\S]*?running: root\.updating[\s\S]*?from: 0[\s\S]*?to: 360[\s\S]*?direction: RotationAnimation\.Clockwise[\s\S]*?loops: Animation\.Infinite/)
})

test("upToDate is true only for a checked checkout that is not behind", () => {
  assert.equal(Model.upToDate({ updatable: true, updateChecked: true, behind: false }), true)
  assert.equal(Model.upToDate({ updatable: true, updateChecked: true, behind: true }), false)
  assert.equal(Model.upToDate({ updatable: true, updateChecked: false, behind: false }), false)
  assert.equal(Model.upToDate({ updatable: true }), false)
  assert.equal(Model.upToDate(null), false)
})

test("an up-to-date row's update button is disabled and never spins", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")

  assert.match(row, /readonly property bool upToDate: Model\.upToDate\(row\)/)
  const button = row.slice(row.indexOf("id: updateButton"), row.indexOf("PanelActionButton {", row.indexOf("id: updateButton")))
  assert.match(button, /enabled: root\.actionsEnabled && root\.updateEnabled && !root\.upToDate/)
  // Enter on a selected row goes through the same gate, which the store owns
  // so both windows refuse the same rows.
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  assert.match(store, /function canStartUpdate\(row\) \{\s+if \(!row \|\| busy/)
  assert.match(panel, /function startUpdate\(row\) \{\s+if \(!store\.canStartUpdate\(row\)\) return\s+revokeReleaseNavigation\(\)\s+store\.startUpdate\(row\)/)
})

test("every keyboard-cycled filter replays its value into its dropdown", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  // A mouse pick assigns Dropdown.value and breaks the binding; a later key
  // cycle must push the filter back in or the dropdown shows a stale choice.
  for (const [filter, dropdown] of [
    ["kindFilter", "kindDropdown"], ["groupFilter", "groupDropdown"], ["statusFilter", "statusDropdown"]
  ]) {
    const handler = "on" + filter[0].toUpperCase() + filter.slice(1) + "Changed"
    assert.match(panel, new RegExp(`${handler}: if \\(${dropdown} && ${dropdown}\\.value !== ${filter}\\)\\s+${dropdown}\\.value = ${filter}`), handler)
  }
})

test("nextOption cycles any option list and nextKind is that same walk", () => {
  const options = [{ value: "a" }, { value: "b" }, { value: "c" }]
  assert.equal(Model.nextOption(options, "a"), "b")
  assert.equal(Model.nextOption(options, "c"), "a")
  assert.equal(Model.nextOption(options, "gone"), "a")
  assert.equal(Model.nextKind(options, "b"), Model.nextOption(options, "b"))
})

test("one hint bar: filter hints left, action hints right, keys cycle the dropdowns", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")

  assert.match(panel, /readonly property var installedFilterHints: Model\.installedFilterHints\(/)
  for (const name of ["cycleGroupFilter", "cycleKindFilter", "cycleStatusFilter"])
    assert.match(panel, new RegExp(`function ${name}\\(\\) \\{\\s+(?:closeArrange\\(\\)\\s+)?set\\w+\\(Model\\.nextOption\\(`), name)

  const keys = panel.slice(panel.indexOf("onTextKey:"), panel.indexOf("// ---- Fixed chrome"))
  assert.match(keys, /t === "f" \|\| t === "F"\) root\.cycleKindFilter\(\)/)
  assert.match(keys, /t === "s" \|\| t === "S"\) root\.cycleGroupFilter\(\)/)
  assert.match(keys, /t === "t" \|\| t === "T"\) root\.cycleStatusFilter\(\)/)
  assert.doesNotMatch(keys, /browsing|switchTab/)

  // The old centred hints line is gone; one bar carries both groups.
  assert.doesNotMatch(panel, /id: hints\b/)
  assert.doesNotMatch(panel, /select   ⏎/)
  const bar = panel.slice(panel.indexOf("id: hintBar"), panel.indexOf("id: listScroll"))
  assert.match(bar, /anchors\.bottom: parent\.bottom/)
  assert.match(bar, /PanelSeparator \{/)
  assert.match(bar, /id: filterHints\s+anchors\.left: parent\.left/)
  assert.match(bar, /id: actionHints\s+anchors\.right: parent\.right/)
  assert.match(bar, /model: root\.installedFilterHints/)
  assert.match(bar, /model: Model\.actionHints\(root\.bulkUpdatableCount > 0\)/)
  // One delegate for both groups, keys shown uppercase in the accent.
  assert.equal(bar.split("delegate: hintDelegate").length - 1, 2)
  assert.match(bar, /text: "\[" \+ hint\.modelData\.key\.toUpperCase\(\) \+ "\]"\s+color: root\.look\.accent/)
  assert.match(bar, /color: hint\.modelData\.active \? root\.contentForeground : root\.secondaryForeground/)
  assert.doesNotMatch(bar, /Text\.RichText|Text\.AutoText|StyledText/)

  // The scroll region stops above the bar.
  const list = panel.slice(panel.indexOf("id: listScroll"), panel.indexOf("id: listScroll") + 600)
  assert.match(list, /anchors\.bottom: root\.look\.showKeyHints \? hintBar\.top : parent\.bottom/)
  assert.doesNotMatch(panel, /hints\.implicitHeight|hints\.top/)
})

test("Panel delegates data, processes and actions to PluginStore", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")

  assert.match(panel, /PluginStore \{\s*id: store\s*externalBusy: !!root\.popupMoveOwner && root\.popupMoveOwner\.busy\s*selfId: root\.moduleName(?:\s*\/\/[^\n]*)*\s*shell: root\.bar \? root\.bar\.shell : null\s*\}/)
  // Every process and script lives in the store; the panel keeps only the
  // release probe, which is about navigation rather than data.
  for (const id of ["loadProc", "updateProc", "catalogProc", "actionProc"]) {
    assert.match(store, new RegExp(`Process \\{\\s*id: ${id}`), id)
    assert.doesNotMatch(panel, new RegExp(`id: ${id}\\b`), id)
  }
  // The probe and its state machine glue live in ReleaseNavigator.qml,
  // used by the popup.
  assert.doesNotMatch(panel, /Process \{\s*id: releaseProbe/)
  assert.match(panel, /ReleaseNavigator \{ id: releaseNavigator \}/)
  for (const script of ["updateScript", "noticeScript"]) {
    assert.match(store, new RegExp(`readonly property string ${script}:`), script)
    assert.doesNotMatch(panel, new RegExp(`property string ${script}`), script)
  }
  // Installing is the pinned helper's third shape now, not a bash script that
  // hands a url to the host command.
  assert.doesNotMatch(store, /installScript/)
  // State the surface binds to is aliased, so existing bindings read the
  // store without naming it.
  for (const name of [
    "rows", "loading", "loadError", "checkingUpdates", "busyKind", "busyRowId",
    "busyId", "status", "statusIsError"
  ]) assert.match(panel, new RegExp(`property alias ${name}: store\\.${name}\\b`), name)
  for (const name of ["busy", "verifiedIds", "behindCount", "installedTotal", "updateActionsEnabled"])
    assert.match(panel, new RegExp(`readonly property (alias|\\w+) ${name}: store\\.${name}\\b`), name)
  // Thin wrappers keep the keyboard handler and buttons untouched, and keep
  // release navigation — a panel concern — revoked where it always was.
  assert.match(panel, /function reload\(\) \{\s*revokeReleaseNavigation\(\)\s*return store\.reload\(\)\s*\}/)
  assert.match(panel, /function checkUpdates\(\) \{\s*return store\.checkUpdates\(\)\s*\}/)
  assert.match(panel, /function setStatus\(text, isError, source\) \{\s*store\.setStatus\(text, isError, source\)\s*\}/)
  // The store announces what the panel used to do inline.
  assert.match(store, /signal reloadStarted\(\)/)
  assert.match(store, /signal rowsLoaded\(\)/)
  assert.match(store, /signal actionFinished\(string kind, string label, int exitCode\)/)
  assert.match(panel, /function onReloadStarted\(\) \{ root\.revokeReleaseNavigation\(\) \}/)
  assert.match(panel, /function onRowsLoaded\(\) \{\s*root\.clampSelection\(\)/)
  // The store never touches the browser or the dialogs.
  assert.doesNotMatch(store, /omarchy-launch-browser|detailsEntry|releaseNavigation/)
  assert.doesNotMatch(panel, /Quickshell\.execDetached\(\["bash"/)
})

test("catalog refresh failures retain displayed entries in every process callback order", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  const process = store.slice(store.indexOf("    id: catalogProc"), store.indexOf("  // The Python worker is independent"))
  const callbacks = process
    .replace("onStreamFinished: {", "function outputFinished() {")
    .replace("onStreamFinished: {", "function errorFinished() {")
    .replace("onExited: function(exitCode)", "function exited(exitCode)")
  const orders = [
    ["outputFinished", "errorFinished", "exited"], ["outputFinished", "exited", "errorFinished"],
    ["errorFinished", "outputFinished", "exited"], ["errorFinished", "exited", "outputFinished"],
    ["exited", "outputFinished", "errorFinished"], ["exited", "errorFinished", "outputFinished"]
  ]
  for (const order of orders) {
    for (const error of ["Could not fetch the catalog: Command failed: curl\n", "", "<error>\n" + "x".repeat(500)]) {
      const displayed = [{ id: "cached" }]
      const state = { catalog: displayed, catalogLoaded: true, catalogLoading: false, catalogError: "",
        catalogGeneration: 4, catalogExitCode: 0, catalogOutputFinished: true, catalogErrorFinished: true,
        pinnedHelperPath: "/plugin/helpers/pinned_update.py", rows: [],
        catalogBuildPending: null }
      state.root = state
      const catalogProc = { running: false }
      const catalogOutput = { text: "" }, catalogErrors = { text: error }
      const queue = []
      const Qt = { callLater: fn => queue.push(fn) }
      const functions = ["loadCatalog", "finishCatalogFetch", "applyCatalog", "applyCatalogResult"]
      const handlers = ["outputFinished", "errorFinished", "exited"]
      const api = Function("state", "Model", "catalogProc", "catalogOutput", "catalogErrors", "Qt",
        `with (state) { ${functions.map(name => qmlFunction(store, name)).join("\n")}
          ${handlers.map(name => qmlFunction(callbacks, name)).join("\n")}
          return { ${[...functions, ...handlers].join(",")} }
        }`)(state, Model, catalogProc, catalogOutput, catalogErrors, Qt)
      state.finishCatalogFetch = api.finishCatalogFetch
      state.applyCatalogResult = api.applyCatalogResult
      api.loadCatalog(true)
      api.applyCatalogResult({ generation: 4, entries: [{ id: "obsolete" }] })
      assert.equal(state.catalog, displayed, "an earlier worker cannot overwrite a new refresh")
      for (const [index, name] of order.entries()) {
        api[name](1)
        assert.equal(state.catalogLoading, index < 2)
      }
      assert.equal(state.catalog, displayed)
      assert.equal(state.catalogLoaded, true)
      assert.equal(queue.length, 0, "failed stdout is never built")
      assert.match(state.catalogError, /Catalog refresh failed\./)
      assert.match(state.catalogError, /Try Refresh again\./)
      if (error.startsWith("Could not")) assert.match(state.catalogError, /Command failed: curl/)
      assert.ok(state.catalogError.length < 260)
      assert.doesNotMatch(state.catalogError, /[<>\n]/)
      // A subsequent successful refresh clears the error and discovers listings.
      catalogProc.running = false
      catalogOutput.text = JSON.stringify({ plugins: [{ id: "new" }] })
      catalogErrors.text = ""
      api.loadCatalog(true)
      for (const name of order) api[name](0)
      assert.equal(queue.length, 1)
      assert.equal(state.catalogLoading, true, "success waits for the build turn")
      queue.shift()()
      assert.deepEqual(state.catalog.map(entry => entry.id), ["new"])
      assert.equal(state.catalogLoading, false)
      assert.equal(state.catalogError, "")
    }
  }
})

test("the catalog is served by the pinned helper through an owner-checked cache, never a bash script", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  const helper = readFileSync(new URL("../helpers/pinned_update.py", import.meta.url), "utf8")

  // The fetch, projection and six-hour cache moved into the helper, which
  // opens ~/.cache/omarchy-plugin-manager by descriptor and publishes with a
  // descriptor-relative rename. No path-named mkdir/mktemp/mv remains in QML.
  assert.doesNotMatch(store, /catalogScript|\$HOME\/\.cache|mktemp|mv \\"\$tmp\\"|jq -c --argjson schema/)
  assert.doesNotMatch(store, /MARKETPLACE_STATS_URL|CATALOG_URL/)
  assert.match(helper, /MARKETPLACE_STATS_URL = "https:\/\/api\.omarchyplugins\.com\/v1\/stats"/)
  assert.match(helper, /CACHE_DIR = \("\.cache", "omarchy-plugin-manager"\)/)
  assert.match(helper, /os\.rename\(name, CACHE_FILE, src_dir_fd=cache, dst_dir_fd=cache\)/)

  // loadCatalog runs the helper with the exact request shape it validates,
  // through the same scrubbed environment the transactions use.
  const catalogProc = { running: false }
  const state = { catalogLoading: false, catalogError: "stale", pinnedHelperPath: "/plugin/helpers/pinned_update.py",
    catalogGeneration: 0, catalogExitCode: 0, catalogOutputFinished: true, catalogErrorFinished: true }
  state.root = state
  const loadCatalog = Function("state", "catalogProc", `with (state) {
    ${qmlFunction(store, "loadCatalog")}; return loadCatalog
  }`)(state, catalogProc)
  loadCatalog(true)
  assert.equal(catalogProc.running, true)
  assert.equal(state.catalogLoading, true)
  assert.equal(state.catalogError, "")
  assert.deepEqual(catalogProc.command, ["/usr/bin/env", "-i", "--", "PATH=/usr/bin:/bin",
    "/usr/bin/python3", "-I", "-S", state.pinnedHelperPath,
    JSON.stringify({ schemaVersion: 1, catalog: { force: true } })])
  catalogProc.running = false
  loadCatalog()
  assert.equal(JSON.parse(catalogProc.command[8]).catalog.force, true, "unfinished callbacks block reuse")
  state.catalogExitCode = 0
  state.catalogOutputFinished = state.catalogErrorFinished = true
  loadCatalog()
  assert.equal(JSON.parse(catalogProc.command[8]).catalog.force, false)
  catalogProc.running = false
  state.catalogExitCode = 0
  state.catalogOutputFinished = state.catalogErrorFinished = true
  loadCatalog("1")
  assert.equal(JSON.parse(catalogProc.command[8]).catalog.force, false, "only a boolean true forces")
  // A running fetch is never doubled.
  catalogProc.command = null
  loadCatalog(true)
  assert.equal(catalogProc.command, null)
  // The helper refuses anything but that shape, with nothing on stdout.
  const refused = spawnSync("/usr/bin/python3", ["-I", "-S", new URL("../helpers/pinned_update.py", import.meta.url).pathname,
    JSON.stringify({ schemaVersion: 1, catalog: { force: "yes" } })], { encoding: "utf8", timeout: 10_000 })
  assert.equal(refused.status, 1)
  assert.equal(refused.stdout, "")
  assert.match(refused.stderr, /Invalid catalog request/)
})

test("release probe uses fixed bounded curl argv and returns only the HTTP status", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-release-probe-test-"))
  const curl = join(root, "curl"), argvLog = join(root, "argv")
  const api = "https://api.github.com/repos/acme/thing/releases/tags/v1.2.0"
  try {
    writeFileSync(curl, `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$PROBE_ARGV"
printf '%s' "$PROBE_CODE"
exit "$PROBE_EXIT"
`)
    chmodSync(curl, 0o755)
    const command = Model.releaseProbeCommand(api)
    assert.deepEqual(command, [
      "curl", "--silent", "--show-error", "--output", "/dev/null",
      "--request", "GET", "--connect-timeout", "3", "--max-time", "5",
      "--header", "Accept: application/vnd.github+json",
      "--header", "X-GitHub-Api-Version: 2022-11-28",
      "--write-out", "%{http_code}", api
    ])
    assert.deepEqual(Model.releaseProbeCommand("https://evil.test"), [])

    const run = (code, exit) => spawnSync(command[0], command.slice(1), {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        PROBE_ARGV: argvLog,
        PROBE_CODE: code,
        PROBE_EXIT: String(exit)
      }
    })
    let result = run("200", 0)
    assert.equal(result.status, 0)
    assert.equal(result.stdout, "200")
    assert.deepEqual(readFileSync(argvLog, "utf8").trim().split("\n"), command.slice(1))

    result = run("404", 0)
    assert.equal(result.stdout, "404")
    result = run("000", 28)
    assert.equal(result.status, 28)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("versionLabel stays silent when no version is known", () => {
  assert.equal(Model.versionLabel({ localVersion: "1.2.3" }), "v1.2.3")
  assert.equal(Model.versionLabel({ localVersion: "v1.2.3" }), "v1.2.3")
  assert.equal(Model.versionLabel({ localVersion: "  " }), "")
  assert.equal(Model.versionLabel({}), "")
})

test("countBehind counts only rows a check actually found behind", () => {
  assert.equal(Model.countBehind(Model.applyUpdateReport(baseRows, report)), 1)
  assert.equal(Model.countBehind([
    { behind: true },
    { behind: false },
    { behind: "unknown" },
    { behind: 1 },
    null
  ]), 1)
  assert.equal(Model.countBehind([]), 0)
})

test("bar update dot projects the panel's confirmed count without changing button behavior", () => {
  const barWidget = readFileSync(new URL("../BarWidget.qml", import.meta.url), "utf8")

  assert.match(barWidget,
    /readonly property int updateCount: panelLoader\.item \? panelLoader\.item\.behindCount : 0/)
  assert.match(barWidget, /visible: root\.updateCount > 0/)
  assert.match(barWidget,
    /anchors\.right: button\.right\s+anchors\.rightMargin: Style\.space\(3\)\s+anchors\.top: button\.top\s+anchors\.topMargin: Style\.space\(5\)/)
  assert.match(barWidget,
    /width: Style\.space\(6\)\s+height: width\s+radius: width \/ 2\s+color: Color\.accent/)
  assert.doesNotMatch(barWidget, /id: badgeLabel|String\(root\.updateCount\)/)
  assert.match(barWidget, /enabled: false/)
  const tooltipExpression = /tooltipText:\s*(.+)/.exec(barWidget)?.[1]
  assert.ok(tooltipExpression)
  const tooltipText = new Function("root", `return ${tooltipExpression}`)
  assert.equal(tooltipText({ updateCount: 0 }), "Plugins")
  assert.equal(tooltipText({ updateCount: 2 }), "Plugins - 2 to update")
  assert.equal(tooltipText({ updateCount: 12 }), "Plugins - 12 to update")
  assert.match(barWidget,
    /if \(b === Qt\.MiddleButton\) root\.refresh\(\)\s+else root\.openFromBar\(\)/)
})

// ---- Store loading ---------------------------------------------------------

test("a plugin-list read that comes back empty is retried once before it is an error", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  // `omarchy plugin list` asks the shell over IPC; while the shell is busy
  // (right after a restart) that
  // answer is empty. One bounded retry turns a spurious "could not read" into
  // a slightly later success; a second failure is reported as before.
  assert.match(store, /property bool loadRetried: false/)
  assert.match(store, /Timer \{\s*id: loadRetry\s*interval: 1500[\s\S]*?onTriggered: root\.reload\(\)/)
  const apply = store.slice(store.indexOf("function applyLoad(raw) {"), store.indexOf("function checkUpdates()"))
  assert.match(apply, /if \(!sections \|\| !listEntries\) \{[\s\S]*?if \(!loadRetried\) \{\s*loadRetried = true\s*loading = true\s*loadRetry\.start\(\)\s*return\s*\}[\s\S]*?loadError = "Could not read the plugin list"/)
  assert.match(apply, /loadError = ""\s*loadRetried = false/)
})

test("opening loads the list first and only then the catalog and update check", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  // The catalog parse blocks the shell's main thread for seconds in QML, and
  // the list read needs the shell to answer an IPC call. Running them
  // together made the list read come back empty; run them in order instead.
  assert.match(store, /property bool openLoadPending: false/)
  assert.match(store, /function loadOnOpen\(\) \{\s*openLoadPending = true\s*reload\(\)\s*\}/)
  assert.match(store, /function finishOpenLoad\(\) \{\s*if \(!openLoadPending\) return\s*openLoadPending = false\s*checkUpdates\(\)\s*if \(!catalogLoaded && !catalogLoading\) loadCatalog\(false\)\s*\}/)
  const apply = store.slice(store.indexOf("function applyLoad(raw) {"), store.indexOf("function checkUpdates()"))
  // Both the success path and the final failure path release the follow-ups,
  // so a broken list never strands the catalog.
  assert.equal(apply.split("finishOpenLoad()").length - 1, 2)
})

test("the small panel row marks updatable plugins and leaves unknown states unmarked", () => {
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")
  const start = row.indexOf("id: stateMark")
  const nameStart = row.indexOf("id: name\n")
  assert.ok(start > row.indexOf("id: nameLine") && start < nameStart, "the mark leads the name inside nameLine")
  const mark = row.slice(start, nameStart)
  assert.match(row, /readonly property bool hasUpdate: row \? row\.behind === true : false/)
  assert.match(row, /readonly property bool upToDate: Model\.upToDate\(row\)/)
  assert.match(mark, /visible: root\.hasUpdate \|\| root\.upToDate/)
  assert.match(mark, /text: root\.hasUpdate \? "󰜷" : "󰸞"/)
  // Green is reserved for an installable verified snapshot; an upstream-only
  // change shares the arrow but in orange, so the mark alone says whether
  // the Update button will do anything. The status line takes the same
  // colour as the arrow in both cases.
  assert.match(row, /readonly property bool installable: row \? row\.pinnedEligible === true : false/)
  assert.match(row, /readonly property color updateMarkColor: installable \? "#5fb865" : "#f28c28"/)
  assert.match(mark, /color: root\.hasUpdate \? root\.updateMarkColor : "#5fb865"/)
  assert.match(row, /text: Model\.updateStatus\(root\.row\)\s+color: root\.updateMarkColor/)
  assert.doesNotMatch(row, /root\.installable \? root\.updateMarkColor : root\.foreground/)
  assert.match(mark, /textFormat: Text\.PlainText/)
  assert.match(mark, /font\.family: root\.fontFamily/)
  assert.match(mark, /font\.pixelSize: root\.look\.font\.title/)
  assert.match(mark, /font\.bold: true/)

  // Exercise the shipped visibility binding, not an unchecked => current guess.
  const visible = new Function("root", `return ${mark.match(/visible: ([^\n]+)/)[1]}`)
  for (const [data, expected] of [
    [{ updatable: true, updateChecked: true, behind: true }, true],
    [{ updatable: true, updateChecked: true, behind: false }, true],
    [{ updatable: true, updateChecked: false, behind: false }, false],
    [{ updatable: true }, false],
    [{ updatable: false, updateChecked: false, behind: false }, false],
    [null, false]
  ]) {
    assert.equal(visible({ hasUpdate: data ? data.behind === true : false, upToDate: Model.upToDate(data) }), expected)
  }

  // Every visible adornment reserves its spacing; the title never gets negative width.
  const name = row.slice(nameStart, row.indexOf("id: verifiedPill"))
  assert.match(mark, /anchors\.verticalCenter: parent\.verticalCenter/)
  assert.match(name, /anchors\.verticalCenter: parent\.verticalCenter/)
  assert.match(name, /elide: Text\.ElideRight/)
  const width = new Function("implicitWidth", "nameLine", "stateMark", "verifiedPill", "updatePill",
    `return ${name.match(/width: ([\s\S]*?)\n\s*text:/)[1]}`)
  for (const markVisible of [false, true]) {
    for (const pillVisible of [false, true]) {
      for (const updateVisible of [false, true]) {
        for (const lineWidth of [40, 200, 400]) {
          const available = lineWidth - (markVisible ? 28 : 0) - (pillVisible ? 68 : 0) - (updateVisible ? 108 : 0)
          for (const naturalWidth of [40, 1000]) {
            assert.equal(width(naturalWidth, { width: lineWidth, spacing: 8 },
              { visible: markVisible, width: 20 }, { visible: pillVisible, width: 60 },
              { visible: updateVisible, width: 100 }), Math.max(0, Math.min(naturalWidth, available)))
          }
        }
      }
    }
  }
})

test("the popup comparison chip follows verification on the title line, not the actions", () => {
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")
  const title = row.slice(row.indexOf("id: nameLine"), row.indexOf("// As many lines"))
  const actions = row.slice(row.indexOf("id: actions"))
  assert.match(title, /id: name\s[\s\S]*id: verifiedPill[\s\S]*id: updatePill/)
  const chip = title.slice(title.indexOf("id: updatePill"))
  assert.match(chip, /anchors\.verticalCenter: parent\.verticalCenter/)
  assert.match(chip, /text: "󰚰 " \+ Model\.updateBadge\(root\.row\)/)
  assert.match(chip, /textFormat: Text\.PlainText/)
  assert.match(chip, /color: root\.installable\s*\? Qt\.rgba\(root\.look\.accent\.r, root\.look\.accent\.g, root\.look\.accent\.b, 0\.16\)\s*: Qt\.rgba\(Color\.muted\.r, Color\.muted\.g, Color\.muted\.b, 0\.16\)/)
  assert.match(chip, /color: root\.installable \? root\.look\.accent : root\.secondaryForeground/)
  assert.match(chip, /font\.underline: updateBadgeMouse\.containsMouse/)
  assert.match(chip, /enabled: root\.compareUrl !== ""/)
  assert.match(chip, /onClicked: root\.openComparison\(\)/)
  assert.match(chip, /visible: updateBadgeMouse\.containsMouse\s*text: Model\.updateCompareLabel\(root\.row\)/)
  assert.match(row, /function openComparison\(\) \{\s*if \(compareUrl === ""\) return\s*githubNavigationRequested\(\[\], compareUrl\)/)
  const visible = new Function("root", `return ${chip.match(/visible: ([^\n]+)/)[1]}`)
  for (const verified of [false, true]) {
    for (const hasUpdate of [false, true]) {
      assert.equal(visible({ verified, hasUpdate }), hasUpdate)
    }
  }
  assert.equal(row.split("id: updateBadge\n").length - 1, 1)
  assert.doesNotMatch(actions, /id: updatePill|id: updateBadge|openComparison\(\)/)
  assert.doesNotMatch(actions, /Item\s*\{\s*visible: root\.hasUpdate/)
  // The title's available width ends before the action controls, not at the row edge.
  assert.match(row, /id: details[\s\S]*?anchors\.right: actions\.left\s*anchors\.rightMargin: root\.look\.sp\(10\)/)
  assert.match(title, /id: nameLine\s*width: parent\.width/)
})

function expandedKeyHarness(state = {}) {
  const source = readFileSync(new URL("../Expanded.qml", import.meta.url), "utf8")
    .replace("Keys.onPressed: function(event)", "function expandedKey(event)")
  const calls = []
  const root = { browsing: true, detailsOpen: true, confirming: false, placing: false,
    closeDetails: () => calls.push("back"), dismiss: () => calls.push("dismiss"),
    switchTab: tab => calls.push(tab), searchFieldFocused: false, ...state }
  const Qt = { Key_Backspace: "Backspace", Key_Escape: "Escape" }
  const press = Function("root", "Qt",
    `${qmlFunction(source, "expandedKey")}; return expandedKey`)(root, Qt)
  return { calls, root, press }
}

test("the popup subtitle sits on its own full-width row under the title", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  const rowStart = panel.lastIndexOf("Item {", panel.indexOf("id: subtitle"))
  const rowEnd = panel.indexOf("PanelSeparator { foreground: root.contentForeground }", rowStart)
  const row = panel.slice(rowStart, rowEnd)
  assert.match(row, /x: title\.x/)
  assert.match(row, /width: parent\.width - x/)
  assert.match(row, /height: subtitle\.visible \? subtitle\.implicitHeight : 0/)
  const sub = panel.slice(panel.indexOf("id: subtitle"), panel.indexOf("id: subtitle") + 700)
  assert.match(sub, /visible: root\.look\.showSummary && text !== ""/)
  assert.doesNotMatch(sub, /anchors\.baseline: title\.baseline/)
  assert.match(sub, /anchors\.right: parent\.right/)
  assert.doesNotMatch(row, /Update all \(/)
  assert.match(panel, /function askBulkUpdate\(\) \{\s*if \(!store\.askBulkUpdate\(\)\) return\s*revokeReleaseNavigation\(\)\s*\}/)
  assert.match(panel, /var summary = root\.installedTotal \+ " installed · " \+ root\.rows\.length \+ " total"/)
  assert.match(panel, /return summary \+ " · " \+ root\.behindCount \+ " to update"/)
  assert.doesNotMatch(panel, /"  ·  "/)
})

test("PopupBridge hands the expanded window back to the popup on its own output", async () => {
  const source = readFileSync(new URL("../PopupBridge.js", import.meta.url), "utf8")
  assert.match(source, /^\.pragma library$/m)
  const bridge = Function(source.replace(/^\.pragma library$/m, "") + "; return { register, unregister, openPopup }")()
  const opened = []
  const left = { screenName: "DP-1", open: () => opened.push("DP-1") }
  const right = { screenName: "HDMI-A-1", open: () => opened.push("HDMI-A-1") }
  assert.equal(bridge.openPopup("DP-1"), false, "nothing registered yet")
  bridge.register(left)
  bridge.register(right)
  bridge.register(right)
  assert.equal(bridge.openPopup("HDMI-A-1"), true)
  assert.equal(bridge.openPopup("DP-1"), true)
  // An output that no longer exists falls back to the first live widget.
  assert.equal(bridge.openPopup("DP-9"), true)
  assert.equal(bridge.openPopup(""), true)
  assert.deepEqual(opened, ["HDMI-A-1", "DP-1", "DP-1", "DP-1"])
  bridge.unregister(left)
  bridge.unregister(left)
  assert.equal(bridge.openPopup("DP-1"), true)
  assert.equal(opened[opened.length - 1], "HDMI-A-1")
  bridge.unregister(right)
  assert.equal(bridge.openPopup("DP-1"), false)

  const barWidget = readFileSync(new URL("../BarWidget.qml", import.meta.url), "utf8")
  assert.match(barWidget, /import "PopupBridge\.js" as PopupBridge/)
  assert.match(barWidget, /readonly property string screenName: root\.QsWindow\.window && root\.QsWindow\.window\.screen/)
  assert.match(barWidget, /Component\.onCompleted: PopupBridge\.register\(root\)/)
  assert.match(barWidget, /Component\.onDestruction: PopupBridge\.unregister\(root\)/)
})

test("unverified upstream changes are hidden unless the setting allows them", () => {
  const { row, catalog, report, head, tip } = upstreamFixture()
  const upstream = Model.applyUpdateReport([row], report)[0]
  // Off (the default, and anything that is not the boolean true).
  for (const setting of [undefined, false, "true", 1]) {
    const off = Model.applyPinnedUpdates([upstream], catalog, setting)[0]
    assert.equal(off.upstreamBehind, true, "the observation survives")
    assert.equal(off.remoteSha, tip)
    assert.equal(off.unverifiedEligible, false)
    assert.equal(off.pinnedEligible, false)
    assert.equal(off.behind, false)
    assert.equal(Model.countBehind([off]), 0)
    assert.equal(Model.filterRows([off], "all", "update", "").length, 0)
    // Hidden is not current: no arrow, but no green check either.
    assert.equal(Model.upToDate(off), false)
    assert.equal(Model.updateStatus(off), "No verified update available")
    assert.doesNotMatch(Model.pinnedUpdateTooltip(off), /upstream|unreviewed/i)
    assert.match(Model.pinnedUpdateTooltip(off), /Update disabled/)
    assert.equal(Model.updateCompareUrl(off), "")
    assert.equal(Model.updateCompareLabel(off), "")
    assert.deepEqual(Model.updateReleaseCandidates(off), [])
  }
  const unchecked = Model.applyPinnedUpdates([Model.applyUpdateReport([row], {})[0]], catalog)[0]
  assert.equal(Model.updateStatus(unchecked), "Update check unavailable")
  // On: the tip is offered, as the exact commit the check observed.
  const on = Model.applyPinnedUpdates([upstream], catalog, true)[0]
  assert.equal(on.unverifiedEligible, true)
  assert.equal(on.behind, true)
  assert.equal(Model.countBehind([on]), 1)
  assert.equal(Model.upToDate(on), false)
  assert.equal(Model.updateStatus(on), "Upstream changes — not verified; Unreviewed commit ccccccc installable")
  assert.equal(Model.updateCompareUrl(on), `${row.remote}/compare/${head}...${tip}`)
  assert.deepEqual(Model.unverifiedRequest(on), { schemaVersion: 1, id: row.id, repository: row.remote,
    unverifiedCommit: tip, expectedLocalHead: head })
  // A verified snapshot always wins over the unreviewed tip.
  const verifiedAhead = Model.applyPinnedUpdates([upstream], upstreamFixture("b".repeat(40)).catalog, true)[0]
  assert.equal(verifiedAhead.pinnedEligible, true)
  assert.equal(verifiedAhead.unverifiedEligible, false)
  assert.match(Model.updateStatus(verifiedAhead), /Verified snapshot bbbbbbb available$/)
  // A tip that is the verified commit itself is the verified path, never the unreviewed one.
  const tipVerified = Model.applyPinnedUpdates([upstream], upstreamFixture(tip).catalog, true)[0]
  assert.equal(tipVerified.pinnedEligible, true)
  assert.equal(tipVerified.unverifiedEligible, false)
  // Superseded stays superseded: the setting never resurrects a downgrade.
  const atTip = { [row.sourceDir]: { localSha: head, remoteSha: head, localVersion: "1.0", remoteVersion: "" } }
  const superseded = Model.applyPinnedUpdates([Model.applyUpdateReport([{ ...row, ancestors: [head, "b".repeat(40)] }], atTip)[0]],
    upstreamFixture("b".repeat(40)).catalog, true)[0]
  assert.equal(superseded.verifiedSuperseded, true)
  assert.equal(superseded.behind, false)
  // Switching off afterwards hides the same row again.
  assert.equal(Model.applyPinnedUpdates([on], catalog, false)[0].behind, false)
  // A checkout the helper cannot bind (not a GitHub origin) is still shown
  // and counted with the setting on: nothing promised is hidden, only the
  // button stays off and the status says why.
  const elsewhere = Model.applyPinnedUpdates([{ ...upstream, updateOrigin: "https://gitlab.com/acme/plugin",
    remote: "https://gitlab.com/acme/plugin" }], catalog, true)[0]
  assert.equal(elsewhere.unverifiedShown, true)
  assert.equal(elsewhere.unverifiedEligible, false)
  assert.equal(elsewhere.behind, true)
  assert.equal(Model.countBehind([elsewhere]), 1)
  assert.equal(Model.upToDate(elsewhere), false)
  assert.equal(Model.updateStatus(elsewhere), "Upstream changes — not verified; update needs a GitHub origin")
  assert.match(Model.pinnedUpdateTooltip(elsewhere), /Update disabled; the helper installs only from a GitHub origin/)
  assert.equal(Model.unverifiedRequest(elsewhere), null)
  assert.equal(Model.applyPinnedUpdates([elsewhere], catalog, false)[0].behind, false)
  // A current checkout with the setting off keeps its check; a superseded one too.
  const level = Model.applyPinnedUpdates([Model.applyUpdateReport([row], {
    [row.sourceDir]: { ...report[row.sourceDir], remoteSha: head } })[0]], catalog, false)[0]
  assert.equal(Model.upToDate(level), true)
  assert.equal(Model.upToDate(Model.applyPinnedUpdates([superseded], catalog, false)[0]), true)
})

test("unverifiedRequest binds the observed tip to the canonical origin and nothing else", () => {
  const head = "a".repeat(40), tip = "c".repeat(40)
  const row = { id: "acme.plugin", gitManaged: true, headSha: head, remoteSha: tip,
    updateOrigin: "git@github.com:Acme/Plugin.git" }
  assert.deepEqual(Model.unverifiedRequest(row), { schemaVersion: 1, id: row.id,
    repository: "https://github.com/acme/plugin", unverifiedCommit: tip, expectedLocalHead: head })
  for (const change of [{ firstParty: true }, { gitManaged: false }, { remoteSha: head },
    { remoteSha: "C".repeat(40) }, { remoteSha: "c".repeat(39) }, { remoteSha: "c".repeat(64) }, { remoteSha: "" },
    { headSha: "A".repeat(40) }, { headSha: "" }, { updateOrigin: "" },
    { updateOrigin: "https://gitlab.com/acme/plugin" }, { updateOrigin: "https://github.com/acme/plugin?x" }]) {
    assert.equal(Model.unverifiedRequest({ ...row, ...change }), null, JSON.stringify(change))
  }
  assert.equal(Model.unverifiedRequest(null), null)
  const message = Model.updateUnverifiedConfirmMessage("Plugin", row)
  assert.match(message, /^Update Plugin to an unreviewed commit\?\n\n/)
  assert.match(message, /has not verified ccccccc/)
  assert.match(message, /Exactly this commit is installed, nothing newer\.$/)
  assert.doesNotMatch(message, /[<>&]/)
})

test("the plugin's own shell.json entry is read strictly and the setting is the boolean true only", () => {
  assert.deepEqual(Model.parseSelfSettings(""), {})
  assert.deepEqual(Model.parseSelfSettings("   \n"), {})
  assert.deepEqual(Model.parseSelfSettings("nonsense"), {})
  assert.deepEqual(Model.parseSelfSettings("[1,2]"), {})
  assert.deepEqual(Model.parseSelfSettings('"x"'), {})
  assert.deepEqual(Model.parseSelfSettings(JSON.stringify({ id: "x", allowUnverifiedUpdates: true, n: 2, s: "a",
    nested: { a: 1 }, list: [1], big: "x".repeat(300), __proto__: { polluted: true } })),
    { allowUnverifiedUpdates: true, n: 2, s: "a" })
  assert.deepEqual(Model.parseSelfSettings(`{"allowUnverifiedUpdates": true, "pad": "${"x".repeat(5000)}"}`), {}, "bounded")
  for (const value of [true]) assert.equal(Model.allowUnverifiedUpdates({ allowUnverifiedUpdates: value }), true)
  for (const value of ["true", 1, "yes", null, undefined, {}, []])
    assert.equal(Model.allowUnverifiedUpdates({ allowUnverifiedUpdates: value }), false, String(value))
  assert.equal(Model.allowUnverifiedUpdates({}), false)
  assert.equal(Model.allowUnverifiedUpdates(null), false)
  assert.equal(Model.allowUnverifiedUpdates(Object.create({ allowUnverifiedUpdates: true })), false, "own key only")

  // The settings section rides ahead of the four fixed ones and is optional.
  const four = "===list===\n[]\n===catalog===\n[]\n===git===\n\n===manifest===\n"
  assert.equal(Model.splitSections(four).settings, "")
  const five = '===settings===\n{"allowUnverifiedUpdates":true}\n' + four
  assert.equal(Model.splitSections(five).settings.trim(), '{"allowUnverifiedUpdates":true}')
  assert.deepEqual(Model.parseArray(Model.splitSections(five).list), [])
  assert.equal(Model.splitSections(four + "===settings===\n{}"), null, "a trailing settings marker is not a valid stream")
  // The entry is one jq line of user-written text: a marker inside a value
  // stays inside the settings slice and cannot shift the four fixed sections.
  for (const marker of ["===list===", "===git===", "===catalog===", "===manifest===", "===settings===\n"]) {
    const entry = JSON.stringify({ allowUnverifiedUpdates: true, note: "x" + marker + "y" })
    const sections = Model.splitSections("===settings===\n" + entry + "\n" + four)
    assert.ok(sections, JSON.stringify(marker))
    assert.equal(sections.settings, entry, JSON.stringify(marker))
    assert.deepEqual(Model.parseArray(sections.list), [], JSON.stringify(marker))
    assert.deepEqual(Model.parseArray(sections.catalog), [], JSON.stringify(marker))
    assert.equal(Model.allowUnverifiedUpdates(Model.parseSelfSettings(sections.settings)), true, JSON.stringify(marker))
  }
  // A settings line that never ends is a truncated stream; an empty entry
  // (absent from shell.json) leaves the list marker directly after its own.
  assert.equal(Model.splitSections("===settings===\n{\"a\":1}"), null)
  assert.equal(Model.splitSections("===settings===\n" + four).settings, "")
  assert.deepEqual(Model.parseArray(Model.splitSections("===settings===\n" + four).list), [])
  // The strict view never yields a marker-bearing value with a marker outside its line.
  const truncated = Model.splitSections("===settings===\n{\"note\":\"===list===\n[]\"}\n" + four)
  assert.ok(truncated)
  assert.deepEqual(Model.parseSelfSettings(truncated.settings), {}, "an entry cut by its own newline just fails to parse")
})

test("the plugin's own entry is kept whole for writing and null when it could not be read", () => {
  assert.deepEqual(Model.parseSelfEntry(""), {})
  assert.deepEqual(Model.parseSelfEntry("  \n"), {})
  assert.equal(Model.parseSelfEntry("nonsense"), null)
  assert.equal(Model.parseSelfEntry("[1]"), null)
  assert.equal(Model.parseSelfEntry(`{"pad":"${"x".repeat(5000)}"}`), null, "oversized is unknown, not empty")
  const raw = JSON.stringify({ id: "x", pinned: ["a", "b"], nested: { k: 1 }, big: "y".repeat(300), n: 2, allowUnverifiedUpdates: true })
  assert.deepEqual(Model.parseSelfEntry(raw), { pinned: ["a", "b"], nested: { k: 1 }, big: "y".repeat(300), n: 2, allowUnverifiedUpdates: true })
  assert.deepEqual(Model.parseSelfSettings(raw), { n: 2, allowUnverifiedUpdates: true }, "the strict view drops what it cannot vouch for")
  const entry = Model.parseSelfEntry(raw)
  const off = Model.withSelfSetting(entry, "allowUnverifiedUpdates", false)
  assert.deepEqual(off, { pinned: ["a", "b"], nested: { k: 1 }, big: "y".repeat(300), n: 2 })
  assert.deepEqual(entry.pinned, ["a", "b"], "the loaded entry is not mutated")
  assert.deepEqual(Model.withSelfSetting(off, "allowUnverifiedUpdates", true).allowUnverifiedUpdates, true)
  assert.deepEqual(Model.withSelfSetting(off, "allowUnverifiedUpdates", "true"), off, "only the boolean true is stored")
  assert.deepEqual(Model.withSelfSetting({ id: "x", __proto__: { leak: 1 } }, "allowUnverifiedUpdates", true), { allowUnverifiedUpdates: true })
  assert.deepEqual(Model.withSelfSetting(null, "allowUnverifiedUpdates", true), { allowUnverifiedUpdates: true })
})

// ---- Moving a bar widget between sections ---------------------------------

test("parseLayoutSections keeps only well-formed placements and the first one per widget", () => {
  const layout = Model.parseLayoutSections(JSON.stringify([
    { id: "omarchy.clock", section: "left" },
    { id: "acme.widget", section: "right" },
    { id: "acme.widget", section: "center" },
    { id: "bad id", section: "left" },
    { id: "../escape", section: "left" },
    { id: "acme.nowhere", section: "top" },
    { id: 42, section: "left" },
    { id: "acme.nosection" },
    "acme.string",
    null,
    { id: "__proto__", section: "left" }
  ]))
  assert.deepEqual({ ...layout }, { "omarchy.clock": "left", "acme.widget": "right", "__proto__": "left" })
  assert.equal(Object.getPrototypeOf(layout), null, "no prototype to pollute")
  assert.equal(layout.constructor, undefined)
  // Not an array, not JSON, oversized, empty: section unknown for every row.
  for (const raw of ["", "   ", "{}", '{"id":"a","section":"left"}', "nope", "[", "x".repeat(70000)])
    assert.deepEqual({ ...Model.parseLayoutSections(raw) }, {}, JSON.stringify(raw.slice(0, 12)))
  const many = JSON.stringify(Array.from({ length: 600 }, (_, i) => ({ id: "acme.w" + i, section: "left" })))
  assert.equal(Object.keys(Model.parseLayoutSections(many)).length, 512, "bounded entry count")
})

test("splitSections carries the layout line ahead of the fixed sections and bounds it to one line", () => {
  const four = "===list===\n[]\n===catalog===\n[]\n===git===\n\n===manifest===\n"
  const layout = JSON.stringify([{ id: "acme.widget", section: "right" }])
  // Layout alone, settings alone, both, neither.
  assert.equal(Model.splitSections("===layout===\n" + layout + "\n" + four).layout, layout)
  assert.equal(Model.splitSections("===layout===\n" + layout + "\n" + four).settings, "")
  const both = Model.splitSections('===settings===\n{"allowUnverifiedUpdates":true}\n===layout===\n' + layout + "\n" + four)
  assert.equal(both.settings, '{"allowUnverifiedUpdates":true}')
  assert.equal(both.layout, layout)
  assert.deepEqual(Model.parseArray(both.list), [])
  assert.equal(Model.splitSections(four).layout, "")
  // The loader printed the marker but jq had nothing: the list follows at once.
  const empty = Model.splitSections("===settings===\n===layout===\n" + four)
  assert.equal(empty.settings, "")
  assert.equal(empty.layout, "")
  assert.deepEqual(Model.parseArray(empty.list), [])
  // A marker inside a layout value cannot shift the fixed sections.
  for (const marker of ["===list===", "===git===", "===catalog===", "===manifest===", "===settings===\n", "===layout===\n"]) {
    const line = JSON.stringify([{ id: "acme.widget", section: "right", note: "x" + marker + "y" }])
    const sections = Model.splitSections("===layout===\n" + line + "\n" + four)
    assert.ok(sections, JSON.stringify(marker))
    assert.equal(sections.layout, line, JSON.stringify(marker))
    assert.deepEqual(Model.parseArray(sections.list), [], JSON.stringify(marker))
    assert.deepEqual({ ...Model.parseLayoutSections(sections.layout) }, { "acme.widget": "right" }, JSON.stringify(marker))
  }
  // A layout line that never ends is a truncated stream; a layout marker after
  // its own line is corruption; layout before settings is out of order.
  assert.equal(Model.splitSections("===layout===\n" + layout), null)
  assert.equal(Model.splitSections(four + "===layout===\n[]"), null)
  assert.equal(Model.splitSections("===layout===\n" + layout + "\n===settings===\n{}\n" + four), null)
})

test("mergePlugins stamps each row with the section shell.json places it in", () => {
  const layout = Model.parseLayoutSections(JSON.stringify([
    { id: "acme.weather", section: "center" }, { id: "omarchy.clock", section: "left" }]))
  const rows = Model.mergePlugins(listEntries, catalogEntries, gitMap, {}, layout)
  const byId = Object.fromEntries(rows.map(r => [r.id, r]))
  assert.equal(byId["acme.weather"].barSection, "center")
  assert.equal(byId["omarchy.clock"].barSection, "left")
  assert.equal(byId["acme.dev"].barSection, "")
  // No layout at all, or a plain object with inherited keys, never invents one.
  for (const row of Model.mergePlugins(listEntries, catalogEntries, gitMap)) assert.equal(row.barSection, "")
  const constructorRow = Model.mergePlugins([{ id: "constructor", name: "c" }], [], {}, {}, {})[0]
  assert.equal(constructorRow.barSection, "")
})

test("canMove, moveOptions and moveCommand only move a placed bar widget somewhere else", () => {
  const placed = { id: "acme.widget", enabled: true, kinds: ["bar-widget"], barSection: "right" }
  assert.equal(Model.canMove(placed), true)
  assert.equal(Model.canMove({ ...placed, kinds: ["service", "bar-widget"] }), true)
  assert.equal(Model.canMove({ ...placed, enabled: false }), false, "not on the bar")
  assert.equal(Model.canMove({ ...placed, barSection: "" }), false, "section unknown")
  assert.equal(Model.canMove({ ...placed, barSection: "top" }), false)
  assert.equal(Model.canMove({ ...placed, kinds: ["service"] }), false, "takes no place")
  assert.equal(Model.canMove({ ...placed, kinds: ["bar", "bar-widget"] }), false, "IS the bar")
  assert.equal(Model.canMove({ ...placed, id: "" }), false)
  assert.equal(Model.canMove(null), false)
  // A built-in widget in the bar moves like any other; the shell owns the rule.
  assert.equal(Model.canMove({ ...placed, id: "omarchy.clock", firstParty: true }), true)

  assert.deepEqual(Model.moveOptions("right").map(o => o.value), ["left", "center"])
  assert.deepEqual(Model.moveOptions("center").map(o => o.value), ["left", "right"])
  assert.deepEqual(Model.moveOptions("").map(o => o.value), ["left", "center", "right"])

  assert.deepEqual(Model.moveCommand(placed, "left"), ["omarchy", "plugin", "enable", "acme.widget", "left"])
  assert.deepEqual(Model.moveCommand(placed, "right"), [], "already there")
  assert.deepEqual(Model.moveCommand(placed, "Left"), [], "exact section names only")
  assert.deepEqual(Model.moveCommand(placed, "--index"), [], "never an option")
  assert.deepEqual(Model.moveCommand(placed, ""), [])
  assert.deepEqual(Model.moveCommand({ ...placed, enabled: false }, "left"), [])
  assert.equal(Model.moveNote("left"), "It is in the left section of the bar now.")
  assert.equal(Model.successMessage("move", "Clock"), "Moved Clock")
  assert.equal(Model.actionVerb("move"), "Move")
  assert.equal(Model.actionGerund("move"), "Moving")
})

test("the store moves a widget through the placement question or straight from a named section", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  // The move rides the same dialog as placement, minus the current section,
  // and is not a yes/no confirmation.
  assert.match(store, /readonly property bool confirming: pendingKind !== "" && pendingKind !== "place" && pendingKind !== "move"/)
  assert.match(store, /readonly property bool placing: pendingKind === "place" \|\| pendingKind === "move"/)
  assert.match(store, /property string pendingSection: ""/)
  assert.match(store, /readonly property var placementChoices: pendingKind === "move"\s*\? Model\.moveOptions\(pendingSection\) : Model\.placementOptions\(\)/)
  assert.match(store, /"Move " \+ pendingLabel \+ " to which section of the bar\?"/)
  assert.match(store, /function askMove\(row\) \{\s*if \(!Model\.canMove\(row\) \|\| busy\) return false[\s\S]*?pendingSection = String\(row\.barSection \|\| ""\)\s*pendingKind = "move"\s*return true/)
  // Detached like enable: the layout rewrite tears the popup down.
  assert.match(store, /function startMoveTo\(row, section\) \{\s*if \(busy\) return false\s*var command = Model\.moveCommand\(row, section\)\s*if \(command\.length === 0\) return false\s*runDetached\(Model\.successMessage\("move", row\.name\), Model\.moveNote\(section\), command, "layout"\)/)
  assert.match(store, /if \(pendingKind === "move"\) \{\s*var moving = Model\.findRow\(rows, pendingId\)[\s\S]*?cancelPending\(\)[\s\S]*?"Could not move " \+ movingLabel[\s\S]*?startMoveTo\(moving, section\)\s*return\s*\}/)
  assert.match(store, /function cancelPending\(\) \{[\s\S]*?pendingSection = ""/)
  // The layout section is read with the same bounded jq the settings use,
  // and every row is stamped from it.
  assert.match(store, /printf '===layout===\\\\n'; "\s*\+ "head -c 1048577 -- \\"\$HOME\/\.config\/omarchy\/shell\.json\\" 2>\/dev\/null "/)
  assert.match(store, /Model\.parseManifestMeta\(sections\.manifest\),\s*Model\.parseLayoutSections\(sections\.layout\)\)/)
  assert.doesNotMatch(store, /runAction\("move"/)
})

test("popup Installed rows omit the move control and keep their other actions", () => {
  const row = readFileSync(new URL("../PluginRow.qml", import.meta.url), "utf8")
  assert.doesNotMatch(row, /\b(?:moveButton|moveRequested|canMove)\b|Move in the bar|󰓡/)
  assert.match(row, /id: enabledSwitch/)
  assert.match(row, /onToggled: root\.canDisable \? root\.disableRequested\(\) : root\.enableRequested\(\)/)
  assert.match(row, /onClicked: root\.updateRequested\(\)/)
  assert.match(row, /onClicked: root\.removeRequested\(\)/)
  for (const action of ["openRepo", "openVersion", "openComparison"])
    assert.ok(row.includes(`onClicked: root.${action}()`), `${action} link remains`)
  assert.match(row, /visible: root\.hasUpdate \|\| root\.upToDate/)
  assert.match(row, /text: Model\.updateStatus\(root\.row\)/)
  assert.match(row, /id: updateBadge/)
})

test("popup positioning stays in Arrange without dead Installed row wiring", () => {
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  assert.doesNotMatch(panel, /askMove|onMoveRequested: \{/)
  assert.match(panel, /tooltipText: "Arrange"/)
  assert.match(panel, /onClicked: root\.arrangeOpen \? root\.closeArrange\(\) : root\.openArrange\(\)/)
  assert.match(panel, /root\.requestBarMove\(snapshot, fromSection, rawIndex, targetSection, preRemovalGap\)/)
  for (const index of ["index", "globalIndex"]) {
    for (const action of ["Enable", "Disable"])
      assert.ok(panel.includes(`on${action}Requested: {\n                root.selectedIndex = ${index}\n                root.ask${action}(modelData)`), `${action} remains for ${index}`)
  }
  assert.match(panel, /function askEnable\(row\) \{\s*if \(!store\.askEnable\(row\)\) return/)
  assert.match(panel, /opened: root\.placing\s*message: root\.placementMessage\s*choices: root\.placementChoices/)
})

test("the store owns the pending confirmation flow", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")

  // The surface tells the store who it is: disabling the surface's own plugin
  // is the one disable that needs a warning.
  assert.match(store, /property string selfId: ""/)
  assert.match(store, /if \(row\.id === selfId\) \{/)
  assert.match(store, /"omarchy plugin enable " \+ selfId \+ " right"/)
  for (const name of ["pendingKind", "pendingId", "pendingLabel"])
    assert.match(store, new RegExp(`property string ${name}: ""`), name)
  assert.match(store, /function cancelPending\(\) \{[\s\S]*?pendingSection = ""/)
  // Only a marketplace-verified listing is installable at all, so there is no
  // "is it verified" bit left to carry around.
  assert.doesNotMatch(store, /pendingVerified\b/)
  // The question, the button and the busy state all call it an install; the
  // old "add" kind is gone, so no message helper keeps a branch for it.
  assert.doesNotMatch(store, /pendingKind === "add"|pendingKind = "add"/)
  for (const surface of ["Panel.qml"]) {
    const source = readFileSync(new URL("../" + surface, import.meta.url), "utf8")
    assert.match(source, /confirmText: root\.pendingKind === "cleanup" \? "Delete" : Model\.actionVerb\(root\.pendingKind\) === "Action"\s*\? "Confirm"\s*: Model\.actionVerb\(root\.pendingKind\)/, surface)
  }
  for (const fn of ["actionVerb", "actionGerund", "successMessage"])
    assert.equal(Model[fn]("add", "x"), Model[fn]("nonsense", "x"), fn + " keeps no dead add branch")
  assert.match(store, /readonly property bool confirming: pendingKind !== "" && pendingKind !== "place"/)
  assert.match(store, /readonly property bool placing: pendingKind === "place"/)
  assert.match(store, /readonly property var placementChoices: pendingKind === "move"\s*\? Model\.moveOptions\(pendingSection\) : Model\.placementOptions\(\)/)
  assert.match(store, /readonly property string placementMessage:/)
  assert.match(store, /readonly property string confirmMessage: \{/)
  for (const fn of [
    "askRemove(row)", "askEnable(row)", "askDisable(row)",
    "confirmPlacement(section)", "cancelPending()", "confirmPending()"
  ]) assert.match(store, new RegExp(`function ${fn.replace(/[()]/g, "\\$&")} \\{`), fn)
  // Asking returns whether the request was taken, so a surface can do its
  // own bookkeeping (close details, retire a probe) only for real requests.
  assert.match(store, /function askRemove\(row\) \{\s*if \(!row \|\| !row\.removable \|\| busy\) return false/)
  // Enable without a placement question and disable of anything but the
  // surface itself are direct actions, exactly as before.
  assert.match(store, /function askEnable\(row\) \{[\s\S]*?if \(!Model\.needsPlacement\(row\)\) \{[\s\S]*?startEnable\(row, ""\)\s*return true/)
  assert.match(store, /function askDisable\(row\) \{[\s\S]*?startDisable\(row\)\s*return true/)
  assert.match(store, /runAction\("remove", pendingLabel, \["omarchy", "plugin", "remove", pendingId, "--yes"\]\)/)

  // The popup keeps its bindings through aliases and thin wrappers.
  assert.match(panel, /PluginStore \{\s*id: store\s*externalBusy: !!root\.popupMoveOwner && root\.popupMoveOwner\.busy\s*selfId: root\.moduleName(?:\s*\/\/[^\n]*)*\s*shell: root\.bar \? root\.bar\.shell : null\s*\}/)
  for (const name of ["pendingKind", "pendingId", "pendingLabel"])
    assert.match(panel, new RegExp(`property alias ${name}: store\\.${name}\\b`), name)
  for (const name of ["confirming", "placing", "placementChoices", "placementMessage", "confirmMessage"])
    assert.match(panel, new RegExp(`readonly property alias ${name}: store\\.${name}\\b`), name)
  assert.match(panel, /function askRemove\(row\) \{\s*if \(!store\.askRemove\(row\)\) return\s*revokeReleaseNavigation\(\)\s*\}/)
  assert.match(panel, /function askEnable\(row\) \{\s*if \(!store\.askEnable\(row\)\) return\s*revokeReleaseNavigation\(\)\s*\}/)
  assert.match(panel, /function askDisable\(row\) \{\s*if \(!store\.askDisable\(row\)\) return\s*revokeReleaseNavigation\(\)\s*\}/)
  assert.match(panel, /function confirmPlacement\(section\) \{\s*if \(pendingKind !== "move"\) \{\s*store\.confirmPlacement\(section\)/)
  assert.match(panel, /function cancelPending\(\) \{\s*store\.cancelPending\(\)\s*\}/)
  assert.match(panel, /function confirmPending\(\) \{\s*store\.confirmPending\(\)\s*\}/)
  assert.doesNotMatch(panel, /property string pendingKind: ""/)
})

test("bulk update confirms once and delegates every bound verified or unverified target", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  assert.match(store, /property var bulkQueue: \[\]/)
  assert.match(store, /property var bulkResults: \[\]/)
  assert.match(store, /property bool bulkActive: false/)
  assert.match(store, /readonly property int bulkUpdatableCount: Model\.bulkUpdateCandidates\(rows\)\.length/)
  assert.match(store, /if \(pendingKind === "bulk-update"\)\s*return Model\.bulkUpdateConfirmMessage\(bulkQueue\)/)
  assert.match(store, /if \(!bulkActive\) bulkQueue = \[\]/)
  for (const fn of ["bulkUpdatables()", "askBulkUpdate()", "startNextBulk()", "runBulkUpdates(requests)", "finishBulkProcess()", "finishBulk()"])
    assert.match(store, new RegExp(`function ${fn.replace(/[()]/g, "\\$&").replace(/,/g, ",")} \\{`), fn)
  // One bulk confirmation covers the unreviewed tips: no per-row dialog later.
  assert.match(store, /if \(pendingKind === "bulk-update"\) \{[\s\S]*?var queue = bulkQueue\.slice\(\)/)
  assert.match(store, /JSON\.stringify\(\{ schemaVersion: 1, bulkUpdates: requests \}\)/)
  assert.match(store, /function finishBulkProcess\(\)[\s\S]*?outcomes\[update\.id\] = update/)
  for (const [surface, precedingId] of [["Panel.qml", "settingsButton"]]) {
    const source = readFileSync(new URL("../" + surface, import.meta.url), "utf8")
    assert.match(source, /readonly property alias bulkUpdatableCount: store\.bulkUpdatableCount/, surface)
    const button = source.slice(source.indexOf("id: updateAllButton"), source.indexOf("id: updateAllButton") + 700)
    assert.doesNotMatch(button, /visible:/, surface)
    assert.match(button, /iconText: "󰑐"/, surface)
    assert.match(button, /tooltipText: "Update all"/, surface)
    assert.match(button, /enabled: root\.updateActionsEnabled/, surface)
    assert.match(button, /opacity: root\.bulkUpdatableCount > 0 && enabled \? 1 : 0\.4/, surface)
    assert.match(button, /onClicked: (root\.)?(askBulkUpdate\(\)|store\.askBulkUpdate\(\))/, surface)
    assert.ok(source.indexOf(`id: ${precedingId}`) < source.indexOf("id: updateAllButton"), surface)
    assert.ok(source.indexOf("id: updateAllButton") < source.indexOf("id: refreshButton"), surface)
    const preceding = source.slice(source.indexOf(`id: ${precedingId}`), source.indexOf(`id: ${precedingId}`) + 500)
    assert.match(preceding, /anchors\.right: updateAllButton\.left/, surface)
    assert.match(button, /anchors\.right: refreshButton\.left/, surface)
  }

  const model = Function(source + `; return { pinnedRequest, unverifiedRequest, findRow, shortSha,
    bulkUpdateCandidates, bulkUpdateConfirmMessage, bulkUpdateSummary,
    applyUpdateReport, applyPinnedUpdates }`)()
  const target = "b".repeat(40), base = "a".repeat(40), tip = "c".repeat(40)
  const origin = "https://github.com/acme/plugin"
  const rows = () => ([
    { id: "acme.verified", name: "Verified", headSha: base, remoteSha: base, verifiedTargetSha: target,
      gitManaged: true, pinnedEligible: true, updateOrigin: origin },
    { id: "acme.tip", name: "Tip", headSha: base, remoteSha: tip, verifiedTargetSha: "",
      gitManaged: true, unverifiedEligible: true, updateOrigin: origin },
  ])
  const catalog = [{ id: "acme.verified",
    updateSnapshot: { id: "acme.verified", repository: origin, verifiedCommit: target } }]
  const begin = (overrides = {}) => {
    const pinnedProc = { running: false }, actionProc = { running: false }, summaryProc = { running: false }
    const state = { rows: rows(), catalog, catalogLoaded: true, busy: false,
      busyKind: "", busyId: "", busyRowId: "", pinnedOutput: "", pinnedExited: false,
      pinnedOverflow: false, pinnedHelperPath: "/helpers/pinned_update.py", allowUnverifiedUpdates: true,
      pendingKind: "", pendingId: "", pendingLabel: "", pendingUrl: "", pendingUnverifiedSha: "",
      pendingVerifiedCommit: "", pendingBranch: "", pendingSection: "", pendingPlacementNeeded: false,
      pendingUpdateReport: "", bulkQueue: [], bulkResults: [], bulkPendingRequests: [], bulkActive: false, finished: [], detached: [],
      summaryOutput: "", summaryOverflow: false, summaryDrainOnly: false, lastBulkSummaryNonce: "",
      setStatus(text, isError) { this.status = { text, isError: isError === true } },
      loadProcessSettled: () => true, updateProcessSettled: () => true,
      requestFreshUpdateCycle() { this.freshCycle = true }, refreshUpdateData() { this.updateRefresh = true },
      actionFinished(kind, label, code) { this.finished.push([kind, label, code]) },
      ...overrides }
    state.root = state
    const names = ["updateRequest", "canStartUpdate", "bulkUpdatables", "askBulkUpdate",
      "cancelPending", "confirmPending", "startNextBulk", "runBulkUpdates", "finishBulk",
      "finishBulkProcess", "finishPinnedUpdate", "runUpdate", "consumeBulkSummary", "finishBulkSummary"]
    Object.assign(state, Function("Model", "state", "pinnedProc", "actionProc", "summaryProc", "Quickshell", `with (state) {
      ${names.map(name => qmlFunction(store, name)).join("\n")}; return {${names.join(",")}}
    }`)(model, state, pinnedProc, actionProc, summaryProc, {
      env: () => "", execDetached(command) { state.detached.push(command) }
    }))
    state.pinnedProc = pinnedProc
    state.summaryProc = summaryProc
    return state
  }
  const land = (state, result) => {
    state.pinnedProc.running = false
    state.pinnedOutput = JSON.stringify(result)
    state.pinnedExited = true
    state.finishPinnedUpdate()
  }

  const state = begin()
  assert.equal(state.askBulkUpdate(), true)
  assert.equal(state.pendingKind, "bulk-update")
  assert.match(model.bulkUpdateConfirmMessage(state.bulkQueue), /Verified — verified snapshot bbbbbbb/)
  assert.match(model.bulkUpdateConfirmMessage(state.bulkQueue), /Tip — unreviewed commit ccccccc/)
  state.confirmPending()
  assert.equal(state.bulkActive, true)
  const batch = JSON.parse(state.pinnedProc.command.at(-1))
  assert.deepEqual(batch.bulkUpdates.map(request => request.id), ["acme.verified", "acme.tip"])
  assert.equal(batch.bulkUpdates[1].unverifiedCommit, tip,
    "the setting allows the unverified target in the same confirmed batch")
  assert.equal(state.busyKind, "bulk-update")
  land(state, { status: "bulk complete", nonce: "1-1", updates: [
    { id: "acme.verified", status: "updated", reason: "" },
    { id: "acme.tip", status: "updated", reason: "" },
  ] })
  assert.equal(state.bulkActive, false)
  assert.deepEqual(state.finished, [["bulk-update", "Update all", 0]])
  assert.equal(state.status.text, "Updated 2, skipped 0")
  assert.equal(state.status.isError, false)
  assert.equal(state.detached.length, 0, "the detached helper owns the final shell rescan")
  assert.equal(state.summaryProc.running, true, "the live panel consumes the updated summary")
  assert.deepEqual(state.summaryProc.command.slice(-2), ["--drain-bulk-summary", "1-1"])
  state.summaryOutput = JSON.stringify({ status: "bulk complete", nonce: "1-1",
    updates: [{ id: "acme.verified", status: "updated" }], rescan: "complete" })
  state.finishBulkSummary()
  assert.equal(state.finished.length, 1, "the live result nonce suppresses summary replay")

  const completedStatus = state.status
  state.summaryOutput = JSON.stringify({ status: "bulk complete", nonce: "2-1",
    updates: [{ id: "acme.verified", status: "unchanged; update refused",
      reason: "Another pinned update is running" }], rescan: "not needed" })
  state.finishBulkSummary()
  assert.equal(state.status, completedStatus, "a live drain must not present another batch's report")
  assert.equal(state.finished.length, 1)
  assert.equal(state.lastBulkSummaryNonce, "1-1")
  state.summaryProc.running = false
  state.consumeBulkSummary()
  assert.equal(state.summaryProc.command.at(-1), "--consume-bulk-summary")
  state.summaryOutput = JSON.stringify({ status: "bulk complete", nonce: "3-1",
    updates: [{ id: "acme.verified", status: "updated" }], rescan: "complete" })
  state.finishBulkSummary()
  assert.equal(state.finished.length, 2, "recovery still reports a legitimate unseen batch")
  assert.equal(state.lastBulkSummaryNonce, "3-1")

  // A moved tip skips with a reason instead of installing something else.
  const moved = begin()
  assert.equal(moved.askBulkUpdate(), true)
  moved.rows[1].remoteSha = "d".repeat(40)
  moved.confirmPending()
  land(moved, { status: "bulk complete", updates: [
    { id: "acme.verified", status: "updated", reason: "" },
  ] })
  assert.deepEqual(moved.bulkResults, [{ id: "acme.verified", name: "Verified", ok: true, reason: "" },
    { id: "acme.tip", name: "Tip", ok: false, reason: "the upstream tip moved" }])
  assert.equal(moved.status.text, "Updated 1, skipped 1 (Tip: the upstream tip moved)")
  assert.equal(moved.detached.length, 0, "the helper owns the rescan even after local skips")

  const uncertain = begin()
  assert.equal(uncertain.askBulkUpdate(), true)
  uncertain.rows[1].remoteSha = "d".repeat(40)
  uncertain.confirmPending()
  land(uncertain, { status: "outcome unknown; inspect retained transactions" })
  assert.equal(uncertain.detached.length, 0)
  assert.equal(uncertain.summaryProc.running, false, "an unknown outcome cannot claim another batch's summary")

  const rescanFailure = begin()
  assert.equal(rescanFailure.askBulkUpdate(), true)
  rescanFailure.confirmPending()
  land(rescanFailure, { status: "bulk complete", nonce: "1-2", rescan: "failed", updates: [
    { id: "acme.verified", status: "updated", reason: "" },
    { id: "acme.tip", status: "updated", reason: "" },
  ] })
  assert.equal(rescanFailure.status.text, "Updated 2, skipped 0; shell did not reload the updated plugins")
  assert.equal(rescanFailure.status.isError, true)
  assert.deepEqual(rescanFailure.finished, [["bulk-update", "Update all", 1]])
  assert.equal(rescanFailure.rows[0].remoteSha, base, "a failed shell rescan keeps pending update evidence")
  assert.equal(rescanFailure.freshCycle, undefined)
  assert.equal(rescanFailure.updateRefresh, undefined)
  assert.equal(rescanFailure.summaryProc.running, true, "a failed rescan still consumes the live summary")

  const updateReloadFailure = begin()
  updateReloadFailure.askBulkUpdate()
  updateReloadFailure.confirmPending()
  land(updateReloadFailure, { status: "bulk complete", updates: [
    { id: "acme.verified", status: "updated; reload failed", reason: "Shell rescan refused" },
    { id: "acme.tip", status: "updated", reason: "" },
  ] })
  assert.deepEqual(updateReloadFailure.bulkResults, [
    { id: "acme.verified", name: "Verified", ok: true, reason: "" },
    { id: "acme.tip", name: "Tip", ok: true, reason: "" },
  ])
  assert.equal(updateReloadFailure.status.text, "Updated 2, skipped 0")

  const rejected = begin()
  rejected.askBulkUpdate()
  rejected.confirmPending()
  land(rejected, { status: "unchanged; request refused", reason: "Invalid bulk update request" })
  assert.equal(rejected.status.text,
    "Updated 0, skipped 2 (Verified: Invalid bulk update request; Tip: Invalid bulk update request)")

  const prototypeId = begin({ bulkQueue: [{ id: "toString", name: "Special", kind: "verified", targetSha: target }],
    bulkPendingRequests: [{ id: "toString" }], bulkActive: true,
    pinnedOutput: JSON.stringify({ status: "bulk complete", updates: [
      { id: "toString", status: "updated", reason: "" },
    ] }) })
  prototypeId.finishBulkProcess()
  assert.deepEqual(prototypeId.bulkResults, [{ id: "toString", name: "Special", ok: true, reason: "" }])

  // A capacity refusal stops the run: the rest are skipped, not retried.
  const limited = begin()
  assert.equal(limited.askBulkUpdate(), true)
  limited.confirmPending()
  land(limited, { status: "bulk complete", nonce: "1-3", updates: [
    { id: "acme.verified", status: "unchanged; update refused", reason: "Transaction limit: review x" },
    { id: "acme.tip", status: "unchanged; update refused", reason: "Stopped: transaction limit" },
  ] })
  assert.equal(limited.bulkActive, false)
  assert.equal(limited.status.text,
    "Updated 0, skipped 2 (Verified: Transaction limit: review x; Tip: Stopped: transaction limit)")
  assert.equal(limited.detached.length, 0, "a run with no successful changes does not rescan the shell")
  assert.equal(limited.summaryProc.running, true, "an all-refused live batch consumes its summary")
})

test("the store reloads when shell.json changes under it", () => {
  const store = readFileSync(new URL("../PluginStore.qml", import.meta.url), "utf8")
  // Enable and disable are detached commands that rewrite shell.json. The bar
  // rebuilds the popup with its new state; the expanded panel is not a bar
  // widget and would keep showing the old rows, so the store watches the
  // file and reloads once the write has settled.
  // Opt-in: the popup is rebuilt by the bar on a real layout change, and
  // three per-monitor popups reloading at once would be pure waste.
  assert.match(store, /property bool watchConfig: false/)
  assert.match(store, /FileView \{\s*id: shellConfig\s*path: root\.watchConfig \? Quickshell\.env\("HOME"\) \+ "\/\.config\/omarchy\/shell\.json" : ""\s*preload: false\s*blockAllReads: true\s*watchChanges: root\.watchConfig\s*printErrors: false\s*onFileChanged: if \(root\.watchConfig\) configReload\.restart\(\)/)
  const panel = readFileSync(new URL("../Panel.qml", import.meta.url), "utf8")
  assert.doesNotMatch(panel, /watchConfig: true/)
  assert.match(store, /Timer \{\s*id: configReload\s*interval: 1000\s*repeat: false\s*onTriggered: if \(root\.watchConfig\) root\.reload\(\)/)
})

test("buildCatalog fails closed on hostile field values instead of throwing", () => {
  for (const field of ["name", "repo", "id"]) {
    const plugin = { id: "a", name: "A", repo: "https://github.com/acme/a" }
    plugin[field] = { toString: 1 }
    const built = Model.buildCatalog(JSON.stringify({ plugins: [plugin] }))
    assert.equal(built.entries, null, field)
    assert.equal(built.error, "Could not read the plugin catalog", field)
  }
})

test("an update snapshot exists only for an unambiguous verified GitHub commit", () => {
  const base = { id: "acme.fresh", name: "Fresh", repo: "https://github.com/acme/fresh",
    sourceType: "community", verificationStatus: "unverified" }
  const snapshot = change => Model.catalogEntries({ plugins: [{ ...base, ...change }] })[0].updateSnapshot
  assert.equal(snapshot({}), null)
  for (const change of [{ verificationStatus: "verified" },
    { verificationStatus: "verified", verificationCommit: "d".repeat(39) },
    { verificationStatus: "verified", verificationCommit: "d".repeat(40), sourceType: "builtin2" },
    { verificationStatus: "verified", verificationCommit: "d".repeat(40), repo: "https://evil.test/a/b" }])
    assert.equal(snapshot(change), null, JSON.stringify(change))
  assert.deepEqual(snapshot({ verificationStatus: "verified", verificationCommit: "d".repeat(40) }),
    { id: "acme.fresh", repository: "https://github.com/acme/fresh", verifiedCommit: "d".repeat(40) })
  const duplicated = Model.catalogEntries({ plugins: [
    { ...base, verificationStatus: "verified", verificationCommit: "d".repeat(40) },
    { ...base, verificationStatus: "verified", verificationCommit: "e".repeat(40) }] })
  assert.equal(duplicated.length, 2)
  assert.ok(duplicated.every(entry => entry.updateSnapshot === null))
})
