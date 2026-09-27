# Mneme

*Named after Mneme, the Muse of memory in the oldest Greek tradition.*

> **Pre-release.** Nothing is published yet.

**Several AI agent sessions writing the same folder of markdown notes, without stepping on each other.**

mneme governs a plain folder of notes (an Obsidian vault, a `docs/` folder, anything markdown). Every write gets an **author, a version and a reason**. A session is **told when a note it read has changed**, and by whom. A session **cannot delete a section another session wrote**. Whatever changes outside the tools (a shell command, a text editor) is **detected and recorded**. Search marks what has **expired or been superseded** instead of letting it win by similarity. Your notes stay plain markdown files that you edit with any editor.

It is not another retrieval system. RAG, CAG and the rest answer *what goes into the context*. mneme answers *who wrote this, is it still valid, and did it collide with another session*, and any retrieval strategy reads from the same governed folder.

## Why

Running two or three agent sessions on the same knowledge base breaks in three ways:

1. **One session deletes what another wrote.** A session that rewrites a whole file takes the other sessions' sections with it. Git separates by file, not by section.
2. **Stale facts win.** Similarity search does not know that something was replaced: a rejected proposal can rank above its rejection.
3. **Nobody knows what changed while they worked.** Session A decides based on a note that session B just rewrote.

## How it works

A **root** is a folder that contains a `.mneme/` directory, like a repository contains `.git/`. The root of a file is the nearest ancestor with `.mneme/`; a nested root is a boundary.

```
<root>/
├── your notes (.md): untouched unless a write asks for it
└── .mneme/
    ├── config.json
    ├── ledger.jsonl      one line per write: who, when, why, before/after, sections changed
    ├── objects/          every version of every note, addressed by content (sha256)
    ├── leases.jsonl      audit of the permissions granted to override the guard
    ├── messages.jsonl    messages between sessions
    ├── index/            search indexes (rebuilt, never a source of truth)
    └── run/              ephemeral state: lock, sessions, reads, pending writes, errors
```

- **One write path, two doors.** Claude Code keeps using its native `Edit`/`Write`, and **hooks** guard and record them. Any other agent uses the **MCP server** (stdio only). Both call the same library under **one cross-process lock**.
- **The guard.** A section (a heading) belongs to the session that wrote it. A write that would remove a section owned by another session is **denied with the reason**, and the denial says how a person can let it through. When a heading title repeats and another session owns any copy, the removal is ambiguous, and the ambiguity is denied.
- **The watcher.** Before any operation on a note, mneme compares the file with the last version in the ledger. A difference nobody claimed is recorded as an `external` write, together with the sections it removed. `mneme scan` sweeps the whole root.
- **Notices.** In its next prompt, a session is told about the notes it read that changed since, and about any section *it owns* that someone else changed or removed, even in a note it never read. Each change is told once.
- **Messages.** Sessions can leave each other messages, to a session, to everyone (`*`) or to whoever comes next (`next`), with replies that keep the correlation.
- **Staleness.** A note with `expires: YYYY-MM-DD` or `superseded_by: [[other]]` in its frontmatter, or a section with `<!-- expires: YYYY-MM-DD -->` or `<!-- superseded-by: [[other]] -->`, comes out marked `[STALE: …]` in search.
- **Readers.** A hybrid search (lexical BM25 + optional embeddings from a local Ollama, fused by reciprocal rank) and a **CAG bundle**: a deterministic, size-bounded text of pinned notes plus an index of every note, ready to be cached as a prompt prefix. Both read the same root and can be scoped to folders.
- **Session reader.** A continuation ("go on", "you have my OK, carry on") has its topic in the conversation, not in its words, so a search by text finds nothing. mneme already knows what each session was working on: the notes it read (recorded by the `Read` hook and by the MCP `read_note`) and the sections it wrote (signed in the ledger). When a search is given a session and finds **nothing**, it answers with those instead: the 20 most recent notes that session touched, their written sections (or every section of a note it only read), most recent note first and one note per slot, so a note with many sections does not take every place. The query already found nothing, so here it only picks which section of each note comes first; with `--reader session`, asked for by name, the notes the query names come first. It never mixes them with matches and never shows another session's notes; the output says so on its first line, `(from what this session was working on)`. Use it with `mneme search "<query>" --session <id>` (the full id, or its first characters if only one known session starts with them), `--reader session` to ask for it alone, the MCP `search` tool (which uses its own session unless given `session`), or `search(roots, query, { session })` in the API. Without a session, search is exactly as before. An eval case can carry `session` and `ts`: it then searches as of that moment, so only what the session had touched by then counts.

## Install (from source, until it is published)

Requires Node 22 or later.

```bash
git clone <this repository>
cd mneme
npm ci
npm link          # puts the `mneme` command on your PATH
```

### On Windows

One script sets Mneme up in a **workspace**, a folder of its own, and says what it did at each step:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

Everything Mneme needs lives inside the workspace (`%USERPROFILE%\AI-Workspace` by default, `-Workspace <folder>` to choose): the hooks in its `.claude\settings.json`, the MCP server in its `.mcp.json`, and the workspace rules in its `CLAUDE.md` (it asks first; they tell Claude how to treat the notes). Claude Code loads those only when it runs in that folder, so **outside the workspace nothing changes**: your own settings, rules and skills are not touched. The notes are a new `notas` folder in the workspace, or the folder you already have with `-Notes <folder>` (an Obsidian vault works; nothing in it is modified).

The script also checks Node, installs the dependencies, puts `mneme` on your user PATH, turns on the semantic reader if Ollama and `nomic-embed-text` are there (it asks before downloading the model, 274 MB), and ends with `mneme doctor` and a first search. Running it again changes nothing. Then open Claude Code in the workspace (`cd` there, then `claude`) and approve the `mneme` MCP server when it asks. The Mneme folder *is* the installation: the hooks and the server point to it, so do not move it afterwards (or run the script again from the new place). `scripts\uninstall-windows.ps1` undoes it; your notes, the workspace rules and any skills stay.

**A recommended kit.** `-Kit <folder>` also offers someone's skills and rules. A kit is a folder with `claude\skills\<name>\SKILL.md` and, optionally, `RULES.md` (or `claude\CLAUDE.md`) and `PROMPT.md`. Each skill is offered one by one (`-KitSkills all|none` to skip the questions), goes to the workspace's `.claude\skills`, and one already there is never overwritten. The rules are *not* written anywhere: they are copied to the workspace's `.claude\recomendado\`, and you paste `PROMPT.md` into Claude Code, which compares them with the workspace rules and adds only what you approve.

To have Mneme's hooks in every Claude Code session instead of one folder, run `mneme hooks install` yourself (it edits `~\.claude\settings.json`, with a backup).

## First run

```bash
mneme init ~/notes --adopt   # govern an existing folder: nothing is modified
mneme hooks install          # Claude Code: backs up settings.json and adds the hooks
mneme doctor                 # every check should say ok (embeddings off is a warning)
mneme search "rollback procedure"
```

`hooks install` backs up your `~/.claude/settings.json` and adds six hook entries. `hooks uninstall` removes only those entries and, if nothing else changed, restores the file byte for byte.

By default each entry runs `node "<absolute path of this checkout>/bin/mneme.js" hook <Event>`. If your settings file travels between machines (a dotfiles repo, a cloud session) or you move the checkout, choose the command yourself with `--command`. `{event}` marks where the event name goes; without it, ` hook <Event>` is appended:

```bash
npm link   # puts mneme on the PATH
mneme hooks install --command 'command -v mneme >/dev/null 2>&1 || exit 0; mneme hook {event}'
```

That entry runs Mneme where it is on the PATH and does nothing (exit 0) where it is not. `status`, `uninstall` and `doctor` recognize the entries by the command you gave; on a machine without that install record they still recognize any entry ending in `mneme hook <Event>` or `bin/mneme.js" hook <Event>`. `doctor` warns when an entry calls `mneme` by name and `mneme` is not on the PATH.

For other MCP agents (or for tools in Claude Code), register the server:

```bash
claude mcp add mneme -- mneme mcp --root ~/notes --read-only
```

Use `--read-only` in Claude Code when the hooks are installed: writes then go through the native tools, which the hooks already guard. Agents without hooks use the full server (no `--read-only`).

## CLI

```
init [dir] [--adopt]                 govern a folder (--adopt: it already has notes; nothing is modified)
doctor [--root <dir>]                check the installation: ledger, objects, lock, index, embeddings, hooks
status [--root <dir>]                who is working now, last writes, external writes, leases
history <note> [--limit <n>]         versions of a note
show <note> --version <id>           one version's content
as-of <note> <date>                  the note as it was at a date
restore <note> <id> --reason <why>   write an earlier version back (a new write)
allow <note> --session <id> --reason <why> [--minutes <n>]   let a blocked session through (a person, at a terminal)
move <from> <to> --reason <why>      move a note and rewrite the links to it
search "<query>" [-k <n>] [--reader hybrid|lexical|session] [--scope <dir>]... [--root <dir>]... [--session <id>]
bundle [--budget <bytes>]            the CAG bundle on stdout
index                                bring the search index up to date
scan                                 record what changed outside the tools as external writes
audit [--since <date>] [--json]      losses, clashes, lease removals and guard denials over a period (exit 1 on a loss)
eval <cases.json> [--k <n>] [--reader lexical|hybrid] [--results <file.jsonl>]
hooks install|uninstall|status [--settings <settings.json>] [--command <cmd>]
mcp [--root <dir>]... [--read-only]  the MCP server on stdio
wake-up [--budget <bytes>] [--root <dir>]...
message send <to> <body> [--reply-to <id>] [--correlation <id>]   to: a session id, "*" or "next"
                                     "next": the first session that asks takes it; if it ends (or is not seen for
                                     activeWindowMinutes) without answering done or rejected, the next one that asks does
message list [--session <id>] [--limit <n>]
report [--days <n>] [--root <dir>]...   usage counts as JSON, to copy and send: nothing private in it
```

`audit` is read-only. A **loss** is content of a session that disappeared because of another write, external or not, and that cannot be restored (its earlier version is missing from `.mneme/objects`) or went without being recorded (the ledger chain is broken). Everything else it lists can be undone: a *clash* (another write removed a section a session wrote; the version before is kept, `open` until the section is back), a removal a person allowed with `allow`, a write the guard blocked, and notes changed on disk that the next access will record.

## Usage report

Every search that comes in through the CLI or the MCP server leaves one line in `~/.config/mneme/usage/searches.jsonl` (under `MNEME_HOME` when it is set): when, which door, which reader, `k`, how many hits, whether the session reader answered or the hybrid reader fell back, how many milliseconds, over how many roots. Nothing else: never the query (not even a hash of it), a note, a heading, a path, a session id, the user or the machine. The file stays on your machine, rotates at 1 MB to `searches.1.jsonl` (one is kept), and `MNEME_USAGE_LOG=0` turns it off; if it cannot be written the search answers exactly the same and the error goes to `errors.jsonl`. `mneme report [--days <n>] [--root <dir>]...` prints a JSON of counts over the last 30 days (by default) and every registered root: those searches, writes by agent and operation (adopting notes is not a write), guard denials, sessions and their reads, messages, errors, notes, sections and bytes, the embeddings provider, how many settings files have the hooks, and the version, platform and Node it runs on. Nothing is sent anywhere: you read it, and copy it to whoever asked if you want to. It never carries a note's name or text, a heading, a query, a session id, a path, a user or a host name, only numbers, dates without a time and words from a fixed list, and a test plants markers in all of those and checks that none gets out.

## MCP tools

| Tool | What it does |
|---|---|
| `read_note` | the note, preceded by `path: <rel> · version: <sha8>`; records the read for notices |
| `write_note` · `edit_note` · `move_note` · `restore_note` | guarded writes (hidden with `--read-only`) |
| `note_history` · `note_as_of` | versions of a note, or the note at a date |
| `search` | hybrid or lexical search, with `scope`; when nothing matches, what the session was working on (`session`, default: the server's) |
| `bundle` | the CAG bundle |
| `changes` | the notices and messages for this session |
| `declare_intent` | what this session is working on (presence) |
| `send_message` · `ack_message` | messages between sessions (hidden with `--read-only`) |

A guard denial or any error comes back as a tool result with `isError: true`: the server never goes down because of one.

## The GUI

```bash
mneme gui --open                       # write the page and open it in a browser
mneme gui --query "rollback" --query "storage budget"   # with search results
mneme gui --watch                      # rewrite it when a ledger changes; the page reloads itself
mneme gui --pack astrolabe-verdigris   # another pack (mneme gui --packs lists them)
```

`mneme gui` writes **one self-contained, read-only HTML file** (by default `~/.config/mneme/gui/index.html`, outside your notes): who is working now, every note with its sections and their owners, the history with diffs, the changes of the last 24 hours, the `audit` counts, and the results of each `--query`. Nothing listens on a port and the page loads nothing from the network: its Content-Security-Policy allows only its own script, by hash. The page never writes. Its actions (restore a version, allow a blocked session, search again) **copy a command** you run in a terminal, where the guard and the ledger already are.

The states it shows are the same words the tools use: **Denied** (the guard stopped a session from removing a section another one wrote), **Writing** (an active session is working on the note), **Stale** (expired or superseded, with the replacement), **External** (changed outside the tools, no author), **Adopted** (older than the root, no owner).

## The galaxy (preview of the 3D GUI)

```bash
mneme galaxia                          # export your notes, serve them on 127.0.0.1 and open the browser
mneme galaxia --root <dir> --workspace <AI-Workspace> --port 4748 --no-open
```

The notes as a galaxy: each group is a cloud, the links are lines, and a session's reads and writes travel as lights. Click a note to read it in a window (markdown, its `[[links]]` take you to the linked note, its connections and activity at the side) or to edit it with tools; **saving is not there yet** (it will write through the library, with author `gui`, like `restore`): the draft stays in the tab and can be copied. The installer leaves **`Abrir Mneme.cmd`** in the workspace, and the first time it shows the **first step** (the message that starts the rules questionnaire) while `rules.md` says `questionnaire: not offered`.

Unlike `mneme gui`, the galaxy **is a server**: it listens on 127.0.0.1 only, until you close its window. It exports to `~/.config/mneme/galaxia/` (your notes are only read), loads three.js and the markdown renderer from a CDN (it needs internet), and its only writes are **your packs**, behind a per-run token and a Host/Origin check.

**Packs for the galaxy** (`packFormat: 2`) change the whole skin: the interface tokens and the `escena` (the space's background, nebulae, stars, lines, group and session colors). Manage them in **opciones → apariencia**: use one, **create one from what you see**, save the fine-tuning into yours, send yours to the trash (`.papelera`, recoverable). The guide, with every token and scene key: [`packs/COMO-HACER-UN-PACK.md`](packs/COMO-HACER-UN-PACK.md). The example: `packs/cianotipo`.

## Packs

The GUI's look is a **pack**: a folder of data that restyles every part of the page. Mneme ships two: `astrolabe` (the default: engraved brass on ebony, the note drawn as an armillary sphere) and `astrolabe-verdigris` (the same pack with other colors, and nothing else). `--pack` takes a name (looked up in `~/.config/mneme/packs/<name>/`, then among the built-in ones) or a path.

A pack is **data, never code**: `pack.json`, CSS and assets. A pack with a script file, a style sheet that tries to leave the `<style>` element, `javascript:`, `expression()`, `@import`, or a remote `url()` is refused with the reason (`--allow-remote` lets remote fonts and images through, and opens the page's CSP to `https:` for them).

```json
{
  "packFormat": 1,
  "name": "my-pack",
  "version": "1.0.0",
  "description": "optional",
  "extends": "astrolabe",
  "device": "armillary",
  "tokens": { "--mn-accent": "#5fb49c" },
  "styles": ["pack.css"],
  "assets": { "my-font": "fonts/my-font.woff2" }
}
```

- `extends` (optional): a pack name or a relative path. Everything is inherited; the parent's styles come first, and tokens and assets merge with the child winning. Up to 4 levels. A pack that only sets `tokens` changes the colors and nothing else.
- `device`: `armillary` (the note as rings, bodies and hands) or `none`.
- `tokens`: CSS variables, all prefixed `--mn-`: `bg surface surface-2 ink ink-2 ink-3 line line-strong accent accent-ink focus denied stale external writing ok font-display font-ui font-mono fs-1…fs-6 space-1…space-6 radius border shadow motion-fast motion-slow ease ease-live`.
- `styles`: CSS files; reference an asset as `url("asset:<name>")` and it travels inside the page as a `data:` URL.
- `assets`: fonts (`.woff2 .woff .ttf .otf`) and images (`.png .jpg .webp .gif .svg`, SVG without script), 2 MB each at most.

Style the page through `[data-part=…]` selectors. These part names are the public contract: they do not change without a new `packFormat`.

`window titlebar titlebar-title maker-mark engrave root path field input sessions session owner-id owner-agent owner-time state-mark state-word stamp time label panel panel-header counter list folder list-item list-item-name flags nodata note note-top note-head note-title note-meta legend legend-word event event-title event-text section-wrap section section-main section-name heading-level section-title owner detail detail-row block block-head counters counter-value counter-name counter-sub notice notice-title notice-text history-row h-time h-action h-hash head-dot controls button button-label button-hash hint cmd diff diff-head diff-line diff-op diff-text tabs tab results result result-head result-path result-text score sep loading progress progress-readout progress-meta alidade scale-arc scale-done empty-plate guidance-text fail fail-text fail-cmd chain chain-links fracture`

The device's parts: `device device-ring device-orbit device-body device-body-shape device-hand device-thread device-meridian device-ecliptic device-ecliptic-arc device-tick device-event device-center device-center-disc device-center-hand`, and the marks inside `state-mark`: `mark-star mark-ring mark-drift mark-pencil hand hub pin`.

States travel as attributes: `data-state` on the window (`loading`, `empty`, `data`, `error`), `data-st` on sections, notes, sessions, notices and results (`denied`, `writing`, `stale`, `external`, `adopted`, `normal`), `data-op` on history rows and diff lines, `data-variant` on buttons (`primary`, `secondary`, `tertiary`, `command`), and `aria-pressed`, `aria-selected`, `aria-current` and `disabled` where a person chose something. Zones carry `data-zone` (`A` bar, `N` notes, `B` note, `C` side, `D` search, `F` failure).

## Configuration

`.mneme/config.json`. Every key is optional. **A mistake in it does not switch Mneme off:** a key it does not know is ignored and a value it cannot use goes back to its default (always the safe side: the guard keeps denying, search falls back to words), and it says so until you fix it: `mneme doctor` fails on `config`, other commands print one line on stderr, and Claude Code hears it at the start of each session and with every prompt. A leading BOM (what PowerShell's `Set-Content -Encoding utf8` writes) is fine.

```json
{ "version": 1, "guardLevels": 2, "guard": "deny", "extensions": [".md"],
  "ignoreDirs": [".git", ".mneme", "node_modules", ".obsidian", ".trash"], "ignorePaths": [],
  "activeWindowMinutes": 30, "activeWarnAt": 4, "lockTimeoutMs": 5000, "leaseMinutes": 10,
  "wakeUpBudget": 0,
  "embeddings": { "provider": "none", "url": "http://127.0.0.1:11434", "model": "bge-m3",
                  "timeoutMs": 3000, "queryPrefix": "", "documentPrefix": "", "module": "", "options": {} },
  "search": { "k": 5, "minLexical": 0, "minLexicalRatio": 1, "minCosine": 1, "stale": "follow" },
  "ranking": { "k1": 1.2, "b": 0.75, "rrfK": 60 },
  "metadataAliases": { "expires": [], "superseded_by": [], "pinned": [] } }
```

- `guardLevels`: headings at this level or above are owned and guarded (2 = `#` and `##`). `0` turns ownership off entirely: nothing is owned, nothing is guarded.
- `guard`: what the guard does when a write removes a section another session wrote. `"deny"` (the default) stops it; `"record"` lets it through, keeps the version before it, tells the owners, and records the write as authorized by the config (`audit` lists it next to the removals made under a lease). Ownership keeps being recorded, so switching back to `"deny"` protects what was written meanwhile.
- `wakeUpBudget`: bytes of the CAG bundle injected when a Claude Code session starts (0 = off; otherwise at least 1024).
- `embeddings.provider: "ollama"` enables the semantic half of hybrid search; `"module"` uses your own embedder (see *Bring your own embedder*). mneme never downloads a model: pull it yourself. Without a reachable model, search degrades to lexical within `timeoutMs` and says so.
- `ranking`: BM25's `k1` and `b` and the rank-fusion constant `rrfK` of the hybrid reader. The defaults are the textbook values; change them to experiment, and measure with `mneme eval`.
- `metadataAliases`: extra frontmatter keys that mean the same (for example `"expires": ["vence"]`).
- `search.stale`: what search does with a superseded hit. `"follow"` (the default) keeps it in its place, marked, and brings the section its link points to along with it, on the next line as `→ current: <note> > <heading>` (the MCP tool adds that section's text; the API returns it as `hit.follow`). It takes no place in `k` and reorders nothing. The link is followed once, inside the same root: `[[note#Heading]]` brings that section, `[[note]]` or a heading that is not there brings the whole note, and a current section that is itself stale is marked, not followed again. A link that leads nowhere (a URL, a note outside this root, a missing note) leaves only the mark. An expired hit has nothing to follow. `"mark"` only marks it, as before. `mneme eval` counts the followed section as found.
- `search.minLexical` and `search.minCosine`: the floor that lets a search come back **empty** when the notes do not cover the question, instead of returning the closest noise. A hit passes when its raw BM25 score reaches the lexical floor **or** its cosine with the query reaches `minCosine` (a hit only the semantic side found has BM25 0). The lexical floor is `minLexical`, capped at `minLexicalRatio` of the highest score the question could reach: a two-word question cannot score like a paragraph, and a fixed floor would silence it. The hybrid reader's own score is a rank fusion and cannot tell relevant from unrelated, so the floor looks at these signals instead. **Off by default** (`minLexical: 0`): BM25's scale depends on your corpus, so calibrate it with `mneme eval` on cases where nothing should come back (`"none": true`) **and** on short questions that do have an answer, and keep some of both in a `"split": "holdout"` you never tune on. On one ~340-note vault, `12.5` / `0.4` / `0.78` took unrelated questions from 0/5 to 5/5 (14/14 on a holdout), kept 9 of 10 labelled relevant hits, and answered 10 of 12 short questions on a holdout (a fixed `12.5` answered 3).

## Writing a third reader

The two readers are building blocks, not a closed set. A reader is any function that takes roots and a query and returns hits of this shape:

```js
/** @typedef {{ root: string, rel: string, section: { path: string[], key: string, start: number, end: number },
 *              score: number, text: string, stale?: { reason: string } }} SearchHit */
```

What you build it from:

```js
import { openRoot, listNotes } from './src/root.js';        // the notes of a root, honoring ignores and nested roots
import { parseNote } from './src/sections.js';             // frontmatter, preamble and sections with offsets
import { staleness } from './src/readers/stale.js';        // the STALE mark for a note or section
import { search } from './src/search.js';                  // the built-in readers: { reader: 'lexical' | 'hybrid', scope, k }
import { bundle } from './src/readers/cag.js';             // the CAG bundle: bundle(root, { budget, now })
```

To plug a different embedding model into the hybrid reader, pass an **Embedder**:

```js
/** @type {{ name: string, embed(texts: string[], role: 'query'|'document'): Promise<number[][]> }} */
const myEmbedder = { name: 'my-model', async embed(texts, role) { /* one vector per text */ } };
await search([openRoot('~/notes')], 'what changed in the deploy', { reader: 'hybrid', embedder: myEmbedder });
```

### Bring your own embedder

To make it the default for a root (search, `index`, the hooks, the MCP server and `doctor` all use it), point the config at a module:

```json
{ "embeddings": { "provider": "module", "module": "plugins/my-embedder.mjs", "model": "my-model-v2",
                  "options": { "dimensions": 768 } } }
```

```js
// plugins/my-embedder.mjs: `module` is relative to the root, or absolute
export async function createEmbedder(options, { root, config }) {
  // options: embeddings.options, as written; root: { dir, stateDir, config }
  return {
    name: 'my-model',
    async embed(texts, role) { /* role: 'query' or 'document'; return one vector per text */ },
  };
}
```

The module is imported the first time a vector is needed. If it cannot be loaded or fails, search degrades to lexical and says why, as it does when Ollama is down; `mneme doctor` loads it and asks for one vector. `queryPrefix` and `documentPrefix` are prepended by role, as with Ollama. `model` names the stored vectors: change it when the model changes, so old vectors are not mixed with new ones (left at its default, the file name is used).

Measure any reader with the eval: a JSON list of cases (`{ "query", "want": ["path substring"], "wantText", "none": true, "split": "dev" | "holdout" }`). `mneme eval cases.json --results results.jsonl` reports dev and holdout apart (tune on dev, report holdout) and writes one line per case, to commit next to the cases.

## Limitations

Read this before relying on it.

- **Out-of-band writes are detected, not prevented.** A shell command or an editor writes straight to disk. mneme records it as `external` on the next access or `scan`, and the section owners are told. It cannot stop it.
- **The ledger is an audit trail, not a signature.** An agent runs as your OS user and can append a well-formed line to the ledger. Each line carries the hash of the previous one, so an edited or deleted line in the middle is detected (`doctor`); an appended forgery is not. mneme protects against accidents and cooperative agents, not against a malicious one with a shell.
- **`allow` asks for an interactive terminal** so that a person, not the agent, grants the override. An agent can fake a terminal: this raises the bar, it does not close it.
- **Headings that existed before `init --adopt` have no owner.** Any session may remove them until one of its writes claims them. Sections written by hand in an editor (recorded as external) belong to `external`, so an agent needs a lease to remove them.
- **The guard protects sections from removal, not from edits.** Another session can rewrite the body of your section. The write is recorded and restorable, and you get a notice.
- **Repeated heading titles are denied conservatively.** If another session owns any copy of a repeated title, removing any copy needs a lease.
- **History keeps everything.** A secret that once entered a note stays in `.mneme/objects/`. To purge it, delete that object file (the ledger keeps its hash), and if `.mneme/` is under git, rewrite that history too.
- **Coordination is local to one machine and one filesystem.** Lock, presence, notices and messages work across processes and OS users sharing a disk, not across machines. Do not put a root on a network share or in a sync client (Dropbox, OneDrive, Syncthing).
- **The hooks cost time.** About 110 ms per hook call; an `Edit` pays two (before and after). While installed, they run on every `Edit`/`Write`/`Read` in every repository, and return early for files outside a root.
- **Claude Code's `Edit` is emulated to know what a write will leave.** If the real tool's result differs (line-ending or quote leniency, or `replace_all` in a file that mixes line endings), the entry is marked `raced` and only the predicted change is attributed.
- **The moment between the hook and the tool is not observed.** An outside write that lands after the `PreToolUse` check and before Claude Code's own `Write` is overwritten without a trace. The defense there is Claude Code's own rule that a file must be read before it is written.
- **The search floor has no universal default.** Out of the box, search returns the closest sections even for an unrelated question. `search.minLexical` fixes that, but its right value depends on the size and vocabulary of your notes: you calibrate it with your own eval cases (see Configuration). Very short follow-ups ("go ahead", "that's odd") come back empty once it is set, which is usually what you want; given a session, they come back with what that session was working on instead (see Session reader).
- **An MCP server may not know the Claude Code session it serves.** If the client does not pass `CLAUDE_CODE_SESSION_ID`, each server process gets its own id, so its reads are not joined with the hooks' session.
- **The ledger is read whole on each operation.** It is fast up to about 10,000 entries; there is no incremental cache yet.
- **Tested on Windows 11.** The CI is configured for Ubuntu and Windows, but no CI run has happened yet.

## Security model

- **No network listener.** The MCP server speaks stdio only. The only outbound call is to the embeddings URL you configure (default: localhost).
- **Paths are confined to the root.** Paths that escape it (`..`, absolute, symlinks, junctions), paths into `.mneme/`, and paths into a nested root are refused.
- **Notes are data.** Tool results carry the note's path and version. Notices quote paths and headings, never note bodies.
- **A module in the config is code.** `embeddings.provider: "module"` runs the file that `.mneme/config.json` names, with your permissions, whenever a vector is needed (including from the hooks). If your notes folder is shared (a git repository other people push to), anyone who can change its `config.json` can choose that file: keep `provider: "module"` for roots whose config you control. Packs, in contrast, are data: a pack with a script is refused.
- **The GUI is a file, not a server.** `mneme gui` writes a page that loads nothing from the network and allows only its own script (by hash); its actions are commands to copy. The galaxy (`mneme galaxia`, a preview) is the exception: a server on 127.0.0.1 whose only writes are your packs, behind a per-run token and a Host/Origin check.
- **Hooks never block on their own errors.** A failing hook lets the tool through, exits 0 and logs to `.mneme/run/errors.jsonl` (`doctor` shows it). A broken hook therefore skips the guard; that is the price of never freezing every session at once.

## License

MIT
