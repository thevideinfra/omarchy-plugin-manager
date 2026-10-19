# Plugin Manager

An Omarchy bar widget that manages the plugins you already have, from the bar:
see what is installed, enable, disable, update, or remove it, and arrange where
each widget sits in the bar. It opens as a popup under the bar.

Fork of juancasanueva/omarchy-plugin-manager; Browse and the windowed mode removed.

The plugin id is unchanged, so the shell may show the upstream listing's `verified` pill for this fork. Updates stay pinned to this checkout's own remote, not the upstream repository.

Plugins are installed with the Omarchy CLI (`omarchy plugin add ...`). This
plugin no longer installs from a catalog.

![kind: bar-widget](https://img.shields.io/badge/kind-bar--widget-informational)

![The popup: a puzzle icon and Plugins heading with an installed, total, and
to-update summary, labelled Source, Kind, and Status dropdowns, a Search field,
and separated plugin rows with descriptions, metadata, repository links, update
badges, switches, and actions above a hint bar with filter keys on the left and
row actions on the right](preview.png)

## What it does

Click the puzzle icon and a popup lists what the shell actually found on disk.
The header shows how many plugins are installed and how many are behind, with a
refresh button, **Update all**, **Arrange**, and **Settings**. Each row has an
on/off switch and the actions that apply to it. The Installed list, update safety
rules, Arrange, and Settings are described below, then the keyboard, install and
removal of the plugin itself, and how to develop it.

## Appearance

The popup's look and what it shows are set in two places that write the same
keys: the **Appearance** and **Show** sections at the top of the in-popup
Settings page (the gear in the header), and the plugin's entry in the bar widget
settings of the Omarchy shell. They are stored in that plugin's entry in
`~/.config/omarchy/shell.json` and apply to an open popup straight away. The
Settings page saves with `omarchy bar set <id> <key> <value> --json`, so only
the one key changes.

| Setting | Choices | Default | Effect |
|---------|---------|---------|--------|
| Density | `compact` (0.61), `normal` (0.71), `comfortable` (0.83) | `normal` | Spacing and width, as a fraction of the shell's stock sizes (the same scale omaudiopanel uses) |
| Font size | `small` (0.85), `normal` (0.95), `large` (1.07) | `normal` | Text size, on top of the density's own scaling |
| Accent colour | `theme`, or a colour from the active theme palette: `blue`, `cyan`, `green`, `magenta`, `yellow`, `red`, `orange` | `theme` | The colour the popup highlights with |
| `showDescriptions` | on / off | on | The description line under each plugin |
| `showMeta` | on / off | on | The author, kind and version line under each plugin |
| `showSummary` | on / off | on | The "installed, total, to update" counts in the header |
| `showKeyHints` | on / off | on | The filter and action key hints at the bottom |

Switching a line off collapses it; the list reclaims the space. Key hints are
display only, so the shortcuts keep working when they are hidden. When the popup
is too narrow for the hints on one line they stack on two.

`theme` follows the theme's own accent. A palette colour is read by name from
the current theme's `colors.toml`, so it follows a theme change, and falls back
to the theme accent when the new theme does not define it.

## Settings

**Settings**, opened from the gear in the header, groups its switches and
**Restart Shell** action into rounded cards. Search and filters stay hidden
while Settings is open, and the cards scroll when the available height is small.
It holds the Appearance and Show sections (above), the **Allow updating unverified plugins** switch, the transaction
history limit, **Restart Shell**, and the Info card (all described below).

The **Info** card shows the plugin, active update-data, and update-data archive
paths, abbreviating the account's passwd home as `~` for display only. Loading
or unavailable paths are labeled accordingly, never replaced with an
environment-derived path.

**Delete update data** asks before permanently deleting **completed journals and
rollback backups from both active and archive roots**. Deletion is irreversible;
it does not uninstall plugins or undo updates. Failed, unresolved, interrupted
and unsafe histories are preserved. Cancel sends no deletion request. A zero
active count does not disable the button: the archive may still contain completed
data. The button waits for an available status and for local actions to settle.

**Transaction history limit** keeps 32 entries by default and can be set from
8 to 128 in steps of 8. It only moves the capacity threshold at which proven
successes archive and new transactions refuse; it never weakens what counts as
proven success. The helper reads the same `shell.json` entry Settings writes,
so both agree without a new command shape. Settings never lets the limit drop
below the live active count, so lowering it cannot wedge updates. The helper
reads the saved value from before the first transaction exists onward; if it
cannot read the saved value, it enforces the default and Settings names the
limit actually in force.

Opening Settings only reads status; it never starts cleanup automatically.
After each cleanup attempt, Settings keeps a bounded outcome message with this
pass's removed/preserved sample counts and separately refreshes the active count.
These counts are not the total retained history and do not claim both roots are
empty. Unknown or partial outcomes require inspection, not an automatic retry.
Closing the popup can lose the outcome; reopen Settings for a new observation.

## Arrange the bar

Choose **Arrange** (`󰕮`) in the header. The popup opens its own overlay, like
Settings. After a save rebuilds the bar, Arrange returns
to the popup on the same screen. Drag entries within or between **Left**, **Center**, and **Right**.
**Dropping saves immediately** through `omarchy-bar move`; there is no Apply
step. Press `Esc` during a drag or release outside the board to cancel it.

The board shows **configured order**, not a pixel-perfect bar
preview. Each duplicate keeps its own raw position and settings: moving one
instance does not move every entry with the same ID. The host may pin the tray
visually, so tray placement on screen can differ from configured order. An ID
that cannot pass losslessly through the CLI stays visible, with a move-refusal
message rather than a silently altered ID.

Layout messages stay with Arrange and popup placement, not Settings. Relevant
status messages appear below **Back**, above the controls they describe.

A host layout change cancels any stale drag. A client exit alone does not prove
that the move saved: the manager waits for the expected host layout. After an
uncertain or mismatched result, inspect the current board and click **Use current
layout** to accept it after the client exits; the manager never retries a move
automatically. **Back**, `Esc`/`Backspace` outside a drag, **Hide popup**, or choosing another
page cancels automatic return, not the pending move lock. Automatic popup
destruction does not cancel return.

The plugin's headless `MoveOwner.qml` is its `panel` entry point, retained with
`keepLoaded`, so a pending move survives the bar rebuild a move causes. It starts
hidden without config reads or inventory work. It also lets the shell's
`summon`, `toggle` and `hide` open and close the popup. Hiding retains pending reconciliation; explicit plugin
reload, disable/removal, or shell shutdown does not. This is not a global lock
against other tools or popup instances, nor an atomic compare-and-swap with the
host: avoid concurrent bar edits while a move is pending.

## The Installed list

What the shell actually found, in two sections:

- **Installed** — everything under `~/.config/omarchy/plugins`, with update
  and remove buttons alongside the on/off switch.
- **Built-in** — everything shipped under `/usr/share/omarchy`. These can be
  switched on and off like any other plugin, but not pulled or deleted: they
  are not ours to change.

The split is not cosmetic. In one mixed list, most rows carry controls that do
nothing, and you have to work out which from a badge. Two sections make the
available actions constant within each one.

A bar down the left of each row says whether the plugin is on. For a bar
widget "on" means exactly one thing — it has a place in the bar — because
that is what the shell itself reports.

Under the name, every row states **what the plugin actually does** — the
description from its manifest, wrapped across as many lines as it takes. It
used to be pinned at two, which was wrong in both directions: a
one-line blurb paid for a blank line it never used, and anything longer was
cut off mid-sentence with no way to read the rest. Rows therefore differ in
height, and that is the better trade — an uneven list is something you can
see past, a truncated sentence is not. A plugin whose author left the
description out says so, which is how you tell an empty manifest field
from a failed read. After the description comes **who wrote it, what it plugs
into, and which version is on disk** — read from each plugin's own
`manifest.json` at load time, so it is there for every plugin rather than only
the git checkouts an update check happens to reach. For a user Git checkout with
a current GitHub origin, that version is also the Release name to look up.
Clicking it checks `v<version>` first, then `<version>`. The first published
GitHub Release opens. If neither exists, navigation falls back in exactness
order: a matching local version tag at `HEAD`, the loaded `HEAD` commit, then
the validated repository root. The checkout does not need a local tag to make
the version interactive; the tag is provenance for the best fallback, not
proof that GitHub published a Release. Built-ins and rows without this current
Git checkout contract remain plain. The bounded GitHub API checks happen only
after the click — opening the panel makes no Release API request. Last comes a
link to the plugin's own repository:
reading what you are running is the whole defence here, and it should not get
harder once a plugin is installed. Git remotes are converted to something a
browser can open, so ssh and `git@host:path` checkouts link too.

A row that shows that link needs no badge saying it came from git — the link
already said so. So the `git` / `local` badge appears only on rows that have
no link, where it is the one thing separating a checkout whose origin has
gone missing from a folder somebody dropped in by hand. Both lose the link
and the update button; without the badge they would look identical.

A labelled filter row sits above Search, and every control narrows both lists
at once:

- **Source filter** (`s`) — **All**, **Installed**, or **Built-in**. Picking one
  section hides the other, which is also the quickest way to see that a
  section is empty.
- **Kind filter** (`f`) — bar-widget, panel, overlay, menu, service. The
  dropdown is built from the kinds actually installed, so the row never offers a
  filter that would match nothing. A plugin that replaces the whole bar and one
  that mounts inside it share the **Bar-widget** option, because both answer the
  same question; each row still names its own kind.
- **Status filter** (`t`) — **All**, **Enabled**, **Disabled**, or **Update**.
  Enabled/Disabled read the same on/off state shown by each row's switch;
  Update shows checkouts with a newer marketplace-verified snapshot for their
  GitHub origin, and, only with **Allow updating unverified plugins** switched
  on, checkouts with detected upstream changes as well.
- **Search by name** (`/`) — matches the name and the id, so typing
  `hyprmoncfg` finds `crmne.hyprmoncfg`. It deliberately does not search
  descriptions: a search that matched prose would surface plugins whose names
  look nothing like what you typed. An `x` appears at the end of the box while
  there is a term to clear.

The hint bar under the list shows the filters on the left — `[S] SOURCE
[F] KIND  [T] STATUS`, each naming its dropdown while neutral and its value,
brighter, once it narrows — and the row actions on the right.
When nothing matches, the message names whichever controls excluded everything
— including source and status when they are hiding otherwise matching plugins.

### Knowing what needs updating

**Only what can be installed counts as an update.** By default, update
badges, the header count, the Update filter, and the bar's blue dot include a
checkout only when the marketplace has verified a newer snapshot of it. A
repository whose author has pushed past the verified commit, or that the
marketplace does not list at all, is not an update: the panel says **No
verified update available** and offers nothing, because nothing reviewed is
there to offer. The background check still records what it observed.

**Allow updating unverified plugins**, in the settings pane (the gear in the
header), changes that. It is **off by default**. Switched on, every
checkout with observed upstream changes shows again, with an orange arrow rather
than the green one, and is counted. Update works for GitHub origins: the
button installs the exact upstream commit the check observed after a
confirmation that names that commit and links its diff. A checkout hosted
elsewhere shows its arrow and **update needs a GitHub origin**, with the
button disabled, because the helper binds only canonical GitHub repositories.
Nothing is fetched from a moving branch: the commit the row shows is the
commit the helper is asked for, and if the tip moved while the question was
on screen the answer installs nothing. A verified snapshot always wins: when
one is installable it is what Update installs, unreviewed tips are offered only
when there is no verified snapshot ahead of the checkout, and a checkout meeting
both conditions is counted once. With the setting on you are choosing to run
code the marketplace has not reviewed.

The setting is stored in this plugin's own entry in
`~/.config/omarchy/shell.json`, as `allowUnverifiedUpdates: true`, written
through the host and merged over whatever else that entry holds. The history
limit lives in the same entry as `transactionLimit`
(a bounded integer, removed when it equals the default 32). A switch
refuses to write until the plugin list has loaded and that entry was read
whole, so a failed read can never rewrite the entry from an empty copy. With
the setting off, a checkout whose only difference is an unreviewed upstream
commit carries neither the arrow nor the green check: the panel does not claim
it is current, it says **No verified update available**.

**Restart Shell**, the button below the other settings, clears Quickshell's
compiled-QML cache and runs `omarchy restart shell`, so every plugin, this one
included, is loaded again from what is on disk. Reach for it when a plugin
edited in place keeps showing its old self after a rescan. What is removed is
exactly `quickshell/qmlcache` under `$XDG_CACHE_HOME` (`~/.cache` when unset),
a cache Quickshell rebuilds on its next start; nothing else is touched, a
symlink planted on that name is left alone rather than followed, and a cache
that does not exist yet is simply not there to remove. The host refuses the
restart while the session is locked. The result arrives as a notification,
because the panel does not survive its own restart.

- **Upstream changes — not verified** (setting on) means the observed branch
  tip does not match an authorized verification snapshot. Being at an older
  verified SHA does not make the checkout current. **Unreviewed commit …
  installable** follows it when the tip can be installed under the setting.
- **Verified snapshot … available** names the only installable candidate. If
  upstream is newer and unreviewed, Update still requests only this verified SHA.
  A differing SHA is not proof of ancestry: the helper must prove fast-forward eligibility.
- **Installed is ahead of verified snapshot …** means the installed commit
  already contains the verified one, for example after updating through the
  host command or another tool. Update is disabled because the helper would
  refuse that downgrade. Ancestry comes from the checkout's most recent 128
  commits, so an older verified commit beyond that window is still offered and
  refused with a reason.
- **No upstream changes** (setting on) requires a matching checkout-bound
  branch report. **Upstream check unavailable** and, with the setting off,
  **Update check unavailable** mean missing, failed, or stale evidence, not current.

The badge and details' Changes link compare the exact upstream commits when
upstream changes are detected; otherwise they compare the verified-only candidate.
Their labels identify which comparison opens. Report versions describe upstream,
never the separately named verified target. Cached catalog metadata may display a
candidate; executing a verified snapshot always requires fresh exact
repository/SHA authorization. There is no fallback from a verified snapshot to
an upstream SHA and no confirmation that overrides a refusal.

### The actions

- **Update all** (`u`, or the header button) — asks once, then applies every
  installable update in one background run. A worker stop signal finishes the
  current preparation and skips unstarted items.
- **Enable / disable** — one switch per row, not a pair of icons that trade
  places. An icon that changes with the state makes you read the glyph to
  learn where the plugin stands and read it again to work out what clicking
  will do; a switch is already showing you both. Switching one on asks a bar
  widget *where* it goes first and lands it in the section you picked;
  anything else simply goes on. Switching one off takes a widget out of the
  bar and leaves the plugin on disk. The knob only moves once the shell has
  actually done it, so cancelling the placement question leaves the switch
  where it was rather than lying about a plugin that never went on.

  Whether a plugin can be switched off is the shell's call, not this panel's:
  a whole bar has no off, only a successor. Those rows still draw the switch,
  dimmed and fixed on — a row with no control at all reads as something that
  failed to render. Disabling this panel closes the window you are clicking
  in, so that one confirms and hands you the command to undo it.
- **Move** — choose **Arrange** in the header to reposition widgets (see
  above); Installed rows have no move button. Enabling a widget asks which
  section to use. Nothing edits `shell.json` directly.
- **Update** — invokes the bundled Python helper with the displayed repository,
  full target SHA, id, and expected installed HEAD. It installs only that
  commit, never `origin HEAD`, another branch, or a fallback commit. The host
  `omarchy plugin update` command is deliberately not used. The target is the
  marketplace-verified snapshot, installed on the click; or, only with **Allow
  updating unverified plugins** switched on and no verified snapshot ahead, the
  exact upstream commit the background check observed, installed after a
  confirmation that names it. Such an install is recorded as unverified in the
  transaction's `request.json` (`unverifiedCommit` instead of `verifiedCommit`)
  and in the desktop notification ("Pinned plugin update (unverified)").
- **Remove** — for anything under `~/.config/omarchy/plugins`, runs
  `omarchy plugin remove <id> --yes` behind a confirmation.

### Pinned install and update transaction, and recovery

Updates run as a pinned transaction. The helper also contains an install shape
of the same transaction (a new directory published with `RENAME_NOREPLACE`),
but this plugin's popup no longer offers it: plugins are installed with
`omarchy plugin add`. Where the text below mentions installs it describes the
helper's behaviour, not a control you can reach.

The helper reads `https://plugins.omarchy.org/catalog.json` directly over HTTPS,
without redirects or cached fallback, before fetching and again before
publication. The popup reads the same canonical URL for its verified-update data, but
through its own cache (below); execution never consults that cache and rejects
every redirect response.
A unique community listing must still be verified at exactly the
requested repository and full SHA. For an unverified request, made only under
**Allow updating unverified plugins**, the catalog is not consulted at all: the
target is the exact upstream commit the popup observed. No fetch and no checkout ever names a branch, and an ambiguous or
unreadable answer refuses instead of picking among candidates. Every other
check below applies unchanged. HTTPS and `git@github.com:` / `ssh://git@github.com/`
origins compare canonically; network Git always uses canonical HTTPS. Repository
moves, revoked verification, malformed metadata, or unavailable objects refuse
rather than silently choosing another target.

Staging lives in a private 0700 transaction under
`~/.config/omarchy/plugin-manager-updates/txn-<random>/`, outside plugin discovery
and on the same filesystem. The helper uses isolated, hook-free Git, checks the
snapshot tree and manifest id, and runs the host validator **before** publishing.
An update exchanges the installed directory with the staged checkout using Linux
`RENAME_EXCHANGE`.
There is no missing-directory gap and nothing the helper did not create is ever
removed. Files and directory entries are fsynced; only successful publication
triggers the host `rescanPlugins` IPC operation. Only a successful rescan ends the transaction as updated.

| Prerequisite | Refusal behavior |
|---|---|
| Actual account home, owned non-symlink directories, no group/other write access | No alternate HOME, worktree, or path fallback |
| Ordinary SHA-1 checkout with one origin and standard core/branch configuration | Includes, other config sections, external object stores/worktrees, symlinks and hardlinks are refused; local Git config is never executed |
| Clean tracked files and index | Dirty, staged, untracked, ignored files and special index flags are refused; never stash, reset or delete user changes |
| Fast-forward proven within 256 fetched history levels | Divergence, downgrade, missing ancestry, or unavailable target refuses |
| Bounded work | 120-second transaction; 64 MiB raw authorization catalog; 16 MiB projected catalog/cache; 1,000 source files, depth 20, 16 MiB source tree; 32 MiB Git file limit and 128 MiB inspected checkout limit |
| Same filesystem with atomic exchange support | Refuse rather than use two renames |

Whatever the helper publishes retains
a fresh `.git`, canonical origin and detached HEAD. It is a shallow clone
(depth 256) with no tracking branch, so the host's own `omarchy plugin update
<id>` does not work for that checkout: later updates for it go through this
popup's pinned update only. To return to the host flow, remove the plugin and
add it with the host command.
Local branches, tags, reflogs, hooks and configuration are **not migrated**;
they remain in the original checkout at the transaction's `checkout/` backup.

### Read-only update-data status

From the plugin checkout, run
`/usr/bin/python3 -I -S helpers/pinned_update.py --update-data-status`.
This fixed endpoint accepts no path arguments and returns one JSON object (at
most 8 KiB), with `schemaVersion: 1`, canonical `paths.plugins`, `paths.active`
and `paths.archive` derived from the account's passwd home, not `HOME` or XDG
variables. Unsafe or oversized home metadata is refused, with `paths: null`.

`available: true` includes `activeCount`, the effective `limit` (default 32,
settable from 8 to 128 in Settings; the helper falls back to the default when
the saved value is unreadable, and Settings then names the limit in force), and `lowerBound`: false for counts up to
the limit, true for limit + 1 (meaning **at least** that many). Every direct active entry
counts, including unknown files and symlinks; contents and archives are never
inspected. Missing active data or its configuration parents means zero; an
unsafe/unreadable root means `available: false`, `activeCount: null`, a bounded
`error`, and exit code 1 instead of success (0). A missing home is unavailable.
The endpoint creates, archives and deletes nothing, does not open the plugins
or archive directories, and does not acquire or replace the update lock.
It is a bounded observation with cancellation/deadline checks, not a locked
snapshot or permission to mutate data. The Settings view requests it on
opening and after local cleanup, update and install completions, including
failures. There is no polling loop. An invalidated response cannot restore a
pre-mutation count.

### Delete completed update data

**This permanently removes rollback backups.** To explicitly delete only
confirmed-success transactions in both active and archived data, run from the
plugin checkout:

```sh
/usr/bin/python3 -I -S helpers/pinned_update.py --cleanup-completed
```

The command is the authorization: it has no interactive prompt and accepts no
paths, extra options or environment overrides. In Settings, the shared
confirmation dialog explicitly names both roots, completed journals, rollback
backups and irreversible deletion; its destructive **Delete** action sends one
request. It rechecks busy/action/status state when answered. Failed, unresolved,
malformed, unsafe and interrupted histories are preserved. Installed plugins
are never opened, and journal backup strings are never used as deletion paths.

The command holds the updater's active-directory inode lock throughout discovery
and removal. If only safe archive storage exists, it creates just the missing
active lock directory (0700) under the validated existing Omarchy parent. Missing
storage is a no-op; it never creates configuration parents, a lockfile, or an
archive directory, and never replaces an existing active root. Unsafe roots and
lock contention fail closed. The read-only status endpoint still creates nothing.

#### Result and process contract

Stdout is one JSON object plus newline, at most 4 KiB. Exit 0 means `complete`;
all other outcomes exit 1. Version 1 has exactly these fields:

| Field | Meaning |
|---|---|
| `schemaVersion` | Integer `1`. |
| `status` | `complete`, `limited`, `cancelled`, `partial`, `failed`, or `unknown` (see below). |
| `discovered`, `visited` | Nonnegative integers: names collected and names processed, respectively; `visited <= discovered <= 512`. |
| `removed` | Confirmed, synced transaction removals. |
| `preserved` | Visited names left untouched: non-transaction names or refused candidates. Not a total retained count. |
| `partial` | Candidates where mutation began but completion/durability failed (at most one). |
| `removedUnsynced` | Subset of `partial`: directory removed but final parent sync failed. Never included in `removed`. |
| `unknown` | Attempted candidate whose outcome could not be observed (at most one). |
| `discoveryComplete` | Boolean: both present roots were fully enumerated. Does not imply every discovered candidate was processed. |
| `refreshRequired` | Always `true`: separately call `--update-data-status` after completion; there is no embedded recount or locked final count. |
| `error` | Empty for `complete`; otherwise sanitized diagnostic, at most 200 characters. No per-path results. |

`visited = removed + preserved + partial + unknown`. Unvisited discovered names
are `discovered - visited`; incomplete discovery leaves the remaining total
unknown. Earlier counts survive later errors. `complete` means the bounded
inventory was processed, not that all history was eligible or that storage is
empty. `limited` means discovery/candidate/budget/deadline exhaustion; `cancelled`
means cancellation before a reported partial mutation; `partial` stops after the
first partial candidate; `failed` covers storage/lock/I/O failure; `unknown`
means an attempted removal lost its outcome. Never treat partial/unknown as
success or automatically retry them.

Discovery stores at most **256 names per root, 512 total**, without sorting,
charging one extra lookahead name to detect overflow. At most **128 transaction
candidates across both roots** are attempted, including refusals. A single shared
budget (below) covers discovery and every candidate; exhausted budgets stop work,
not just one candidate. Names are collected from fresh held-descriptor views.

Cleanup stays foreground, creates no subprocesses, and handles TERM/INT/HUP by
cooperative cancellation. It is not the updater's detached launch path. A CLI
caller must supply its own process-group timeout/hard-stop for blocked I/O.
Missing/truncated JSON, output failure or owner destruction means **outcome
unknown**, even if files were removed. Do not retry automatically; refresh status
and inspect retained history.

Settings uses dedicated raw `SplitParser` processes, not the generic action
collector. Both stdout and stderr have conservative UTF-8 budgets: 8 KiB each
for status, 4 KiB each for cleanup, in addition to the helper's producer limits.
Schema, exit code and counter relationships must agree before reporting an
outcome. Labels contain static prose and validated numbers, never helper error
markup. A fresh status process is created only after the previous one's deferred
exit callbacks settle; requests coalesce without retrying cleanup.

Fixed argv invokes the bundled helper through `/usr/bin/python3 -I -S` with
`--update-data-status` or `--cleanup-completed`, never a shell or a displayed
path. Each runs under an inner `/usr/bin/timeout -k 1` (6 seconds for status,
20 for cleanup) and an outer `/usr/bin/timeout` (8 or 22 seconds). The outer
observer forwards TERM on overflow/destruction; it has no competing KILL timer.
The independent inner supervisor retains its group and one-second hard-stop if
QML destroys the direct child. The existing detached updater is unchanged.
Cleanup joins the store's busy state, while the helper's inode lock remains the
authority across surfaces/processes; UI guards are not a global filesystem lock.

#### Removal safety

The command uses `remove_completed(lock, parent, name, budget)` for each original
`txn-<24 lowercase hex digits>` name. `CleanupLock(Updater())` itself remains
existing-only; only the command opts into missing-active-root creation.

| Boundary | Internal contract |
|---|---|
| Eligibility | Rechecked `request`, `prepared`, `published` and `result` journals must prove exact success. Only those four journal files, optional `index-before` / `index-final` files and an update's `checkout` directory are accepted at the top level. |
| Preflight | Two bounded full-tree passes before mutation. Owned, safe-mode real directories and singly linked regular files only; no symlinks, specials or mount crossings. Linux's bounded `/proc/self/fdinfo` mount IDs also reject same-device bind mounts; unavailable checks fail closed. |
| Tree ceilings | 32 MiB per file, 128 MiB total, 4,096 entries and directory depth 20 relative to the transaction. Descriptor use is depth-bounded, not entry-count-bounded; account paths over 32 components are refused. |
| Shared budget | By default: 200,000 work units, 32,768 visited entries, 4 MiB charged name/record metadata and 512 MiB inspected file sizes across all passes/candidates. A 15-second cooperative deadline and worker cancellation checks apply; these cannot interrupt a blocked kernel I/O call. |
| Mutation | Descriptor-relative identity rechecks; backup contents first, checkout root and journals later, interruption marker and transaction last. Changes are fsynced; active/archive roots are never removed or replaced. |

The result has `status`, `transactionRemoved` and a bounded `error`:
`refused` means this call changed nothing; `removed` means removal and parent
sync succeeded; `partial` means mutation began but completion or durability is
uncertain. `transactionRemoved: true` with `partial` specifically reports a
removed directory whose final parent sync failed. The CLI counts that outcome
in `partial` and `removedUnsynced`, never in `removed`.

Recursive deletion is **not atomic and has no rollback**. Before the first
unlink, an exclusive `.cleanup-started` marker is synced in the transaction.
Even a marker-only failure is `partial`. Eligibility rejects that marker,
including during updater archival; it remains through backup/journal removal.
If the marker has already gone, the success journals have too, so remaining
malformed data cannot silently qualify again. Interrupted remnants require
manual inspection, not automatic recovery. Removing a backup forfeits its
rollback data; this primitive does not undo any installed update.

The advisory lock excludes cooperating update/cleanup workers, not arbitrary
same-user writers. Rechecks detect observed changes but cannot make a recursive
snapshot or eliminate the final check-to-unlink race. Tests use disposable data
and simulated mount identities, never host mounts or live update roots.


### Recovery and retained transactions

When the active directory holds at least the configured limit (default 32) of
entries, the next update first archives
provably completed transactions into
`~/.config/omarchy/plugin-manager-updates-archive/txn-<same-id>/` and refuses
only when the recount after that walk still sits at the limit, so a limit
lowered into the active count archives down instead of wedging every update.
Below that threshold, nothing is archived. Only exact `updated` results (or an
`installed` result recorded by the helper's install shape) qualify: the published result, original request, prepared identities and
backup layout must agree, with no `refused.json` marker. Reload, enable or
finalization failures, partial records, unknown schemas and unsafe entries
stay active. Historical eligibility does not depend on the plugin's current HEAD.
Stored device numbers are evidence, not assertions: the kernel may renumber a
filesystem's device across a remount or reboot, so identity is the inode plus
the directories' current co-location. Histories recorded before such a
renumbering still validate instead of wedging the limit forever.

Archival moves each whole transaction, including its original checkout, without
copying or deleting files, traversing backup contents, rewriting journals or
leaving aliases in the active directory. The private 0700 archive is on the
same filesystem; no-replace renames never overwrite an existing archive entry.
Both directories are fsynced. The archive grows cumulatively and is never
automatically pruned or enumerated by the helper.

**Archived journals keep their historical absolute backup paths.** If the
recorded active path no longer exists, look under
`~/.config/omarchy/plugin-manager-updates-archive/<same txn>/checkout` and inspect
the journals beside it. Do not blindly reuse a stale `backup` string.

Inspect `request.json`, `prepared.json` (directory device/inode identities),
`published.json` and `result.json` to distinguish staging from publication.
A crash between publication and journaling requires checking those identities
and both HEADs; do not assume the backup name alone proves which tree it
contains.
There is no automatic recovery or rollback that could overwrite later edits.
The advisory lock serializes helper requests, not arbitrary same-user writers;
final rechecks do not make concurrent external edits race-free.
Keep backups until reviewed, and recover manually only after preserving the
current checkout. If every entry within the configured limit remains unresolved,
or discovery encounters one entry beyond it, further updates refuse
with a README recovery hint. Review
`~/.config/omarchy/plugin-manager-updates/` and manually move only transactions
you have understood and preserved; the helper never guesses about incomplete
history. Discovery inspects at most the configured limit's direct entries under the existing helper
lock, and successful archival requires a fresh capacity count before proceeding.
An archive error also refuses the new transaction: inspect both active and
archive locations before retrying, since an earlier move may have completed.
Never resolve a collision by overwriting an archived transaction.

Once clicked, the finite worker runs independently of the QML observer. Closing
the popup is **not cancellation**, including during a manager self-update.
For a bulk update, a worker stop signal finishes the current preparation and
skips unstarted items. Already checked updates still apply after final safety
checks, followed by a shell rescan and the recorded summary. There is no bulk
Stop control in the popup.
The already-loaded Python worker retains no dependency on reopening its helper
source after publication. Its bounded notification and transaction records
outlive the window. A rescan failure reports **updated; reload failed**, not unchanged. A refusal
reports **unchanged; update refused** followed by the helper's reason (for
example a dirty checkout or a revoked verification), and the same reason is written to `refused.json` in the
transaction directory when one was opened.
If the observer loses the result, inspect the retained transaction; do not retry
blindly. Live Quickshell hot-reload/self-update behavior still needs runtime
validation; disposable transaction tests do not prove desktop integration.

### Where verified-update data comes from

The popup still fetches the Omarchy marketplace catalog,
`https://plugins.omarchy.org/catalog.json`, but only as the source of
verified-update snapshots and of the `verified` pill beside an installed plugin's
name (joined by id). It is never browsed or installed from. The catalog is read
from the cache when the popup opens and fetched when that cache is missing or
stale, projected down to the fields the update checks use, and cached for six
hours in `~/.cache/omarchy-plugin-manager/`. A failed automatic fetch falls back
to the cached copy. The refresh button forces a re-fetch.

Raw downloads are capped at 64 MiB by both curl and the helper's stream reader;
the projected catalog sent to the popup and stored in the cache is capped at
16 MiB. The cache is read and written only by `helpers/pinned_update.py`, the
same helper that updates. It reaches the cache directory component by component
through owner-checked no-follow directory descriptors, creating a missing one
private (0700), and refuses a symlink, another owner, or group/world write
anywhere on that path. A fresh projection is written to an exclusive temporary
file beside the cache and renamed into place relative to the same descriptor.

### Verified is a signal, not a promise

The registry runs a security baseline over listings and marks some verified.
Joined by id to the catalog, the badge appears as a pill beside the name of
Installed rows, so what you already run says whether the registry reviewed it.
Plugin code runs unsandboxed with your user's privileges whether or not it
carries a badge.

## Why it confirms

Updating fetches a repository and loads its QML into the long-running
`omarchy-shell` process. Plugin code is **unsandboxed**: it runs with your
user's full privileges. Removing deletes a directory. Both actions confirm
first; an update confirmation shows the short commit and the repository the
fetch will use, so you can read both before anything runs.

Commands are executed as argv arrays, never through a shell, so a repository
url cannot become a command. Urls are also validated against `https://`,
`ssh://`, and `git@host:path` before they are passed on.

## Keyboard

| Key | Action |
|-----|--------|
| `↑` `↓` / `k` `j` | Move the selection |
| `Enter` | Update the selected plugin |
| `Delete` | Remove the selected plugin |
| `u` | Update all |
| `/` | Focus the search box |
| `f` | Cycle the Kind dropdown |
| `s` | Cycle the Source dropdown |
| `t` | Cycle the Status dropdown |
| `r` | Refresh the plugin list and re-check updates |
| `Tab` / `Shift+Tab` | Switch to the next / previous bar panel |
| `Esc` | Clear the search, then leave the field, then close the popup |

Open dialogs retain their own keys.

## Install

```bash
omarchy plugin add https://github.com/thevideinfra/omarchy-plugin-manager.git --enable
```

Then move it if it did not land where you want it:

```bash
omarchy bar move io.github.juancasanueva.plugin-manager --section right
```


## Remove

```bash
omarchy plugin remove io.github.juancasanueva.plugin-manager --yes
```

That deletes `~/.config/omarchy/plugins/io.github.juancasanueva.plugin-manager`
and takes the widget out of your bar. The verified-update cache at
`~/.cache/omarchy-plugin-manager/` and transactions/backups under
`~/.config/omarchy/plugin-manager-updates/` and
`~/.config/omarchy/plugin-manager-updates-archive/` survive removal. An already accepted
finite update also continues through finalization. Review retained transactions
before removing or moving them; the manager never automatically deletes backups.

To take it off the bar without uninstalling it, use the panel's own disable
button, or:

```bash
omarchy plugin disable io.github.juancasanueva.plugin-manager
```

## Requirements

No dependencies are installed automatically. Enable/disable/remove use the host
commands; pinned updates additionally require system Python 3 (stdlib only),
Linux `/proc`, `flock`, and libc/filesystem `renameat2` exchange support.
A fixed `/usr/bin/env -i` argv supplies only PATH and WAYLAND_DISPLAY, then
executes `/usr/bin/python3 -I -S`; helper subprocesses use their own clean environment.

| Command | Used for |
|---------|----------|
| `git` | discovery and isolated exact-SHA fetch/ancestry/checkout |
| `jq` | parsing plugin manifests and the shell configuration |
| `curl` | fetching the verified-update catalog and remote manifests |
| `notify-send` | reporting pinned-update outcomes outside the popup |
| `python3`, `omarchy-plugin-validate`, `qs` | bounded update transaction, staged validation, and post-publication rescan |
| `bash`, coreutils | the loading and update scripts |
| `omarchy-launch-browser` | opening repository and Release links in your chosen browser |

### What it writes

Only on an explicit action: enabling/disabling edits shell configuration via
host commands, and removal uses host commands. Pinned updates write private
staging, transaction records and retained original checkouts, and atomically
exchange one plugin directory. At the active transaction limit, pinned updates
can create `~/.config/omarchy/plugin-manager-updates-archive/` and move completed
transaction directories there, preserving all recovery data. Archival does not
edit shell.json or change installed plugins. The verified-update cache at
`~/.cache/omarchy-plugin-manager/` is written automatically when the catalog is
missing or stale, through owner-checked no-follow directory descriptors with a
descriptor-relative atomic rename, never through a path a symlink could redirect.
Appearance settings, the unverified-updates switch and the history limit are
written to the plugin's entry in `~/.config/omarchy/shell.json` through the host.

## Develop

The plugin directory must live at
`~/.config/omarchy/plugins/io.github.juancasanueva.plugin-manager`. Saving any
file under `~/.config/omarchy/plugins/` hot-reloads the plugin code, except
through a symlinked checkout, where the shell needs a restart after QML edits.

```bash
omarchy plugin validate ~/.config/omarchy/plugins/io.github.juancasanueva.plugin-manager
qmllint -I /usr/share/omarchy/shell BarWidget.qml Panel.qml MoveOwner.qml

node --test test/*.test.mjs
python3 -m unittest discover -s test -p 'test_*.py'

omarchy-shell shell rescanPlugins
omarchy-shell shell toggle io.github.juancasanueva.plugin-manager '{}'
```

## Layout

| File | Role |
|------|------|
| `manifest.json` | Plugin contract: id, kinds, entry points, and the density, font size and accent settings |
| `BarWidget.qml` | The bar slot and the open/close contract the bar routes through |
| `Panel.qml` | The popup: Installed list, filters, search, header actions, Settings, Arrange, and the dialogs |
| `MoveOwner.qml` | Headless retained owner (the `panel` entry point) of bar moves, so Arrange survives the bar rebuild; also lets shell summon/toggle/hide open and close the popup |
| `PanelStyle.qml`, `AccentSource.qml` | Density, font size and accent settings |
| `PluginStore.qml` | The data layer: plugin list, update check, verified-update data, actions, and what is pending confirmation |
| `PluginRow.qml` | One row: name, author/kind/version, description, repository link, on/off switch, and its buttons |
| `SettingsInfo.qml` | The Settings Info card and Delete update data |
| `ActionConfirmDialog.qml`, `ChoiceDialog.qml` | The modals: confirm an action, or ask which one |
| `BarLayoutPane.qml` | The Arrange board |
| `ReleaseNavigator.qml` | The click-time Release probe and the one place a browser is launched from |
| `PopupBridge.js` | Hand-off between the popup and the retained owner |
| `Model.js` | Pure parsing, merging, grouping, searching, and filtering |
| `helpers/pinned_update.py` | The pinned update transaction, update-data status and cleanup, and the catalog cache |
| `helpers/github_star.py` | GitHub star toggle helper (present, not wired into the popup) |

## License

MIT — see [LICENSE](LICENSE).
