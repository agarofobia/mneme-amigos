<!-- mneme workspace rules: installed by scripts/install-windows.ps1. Edit them freely; a reinstall never overwrites this file. -->
# This workspace

This folder is an AI workspace governed by Mneme. These rules apply only when Claude Code runs here; outside this folder nothing changes.

## First: "what is missing?"
If the person says they just installed this, or asks what is missing, what to do next or whether it works: **run `mneme doctor` before answering** (with `--root <notes folder>` if it asks for one), and tell them its `next:` line in their words, one step at a time; a line that says `fail` comes first. Never paste the whole output, and do not ask what they installed: it is this folder, Mneme.

## Your rules
@rules.md

The person's own rules live in `rules.md`, next to this file, and apply on top of these. If one contradicts a rule here, follow theirs and say so in one line.
- **Never write a rule without their OK**, and write it with its origin mark, exactly as `questionnaire.md` shows.
- A rule marked **declared** came from the questionnaire: they said it, it has not been seen in use yet. When a real correction from them backs it up, change the mark to **confirmed** (a one-line edit). If they correct you **against** a declared rule twice, propose rewriting or removing it; never remove it on your own.
- A correction that repeats, or that they ask you to remember, can become a new rule the same way: propose it, and write it only with their OK.

## First time: the questionnaire
While `rules.md` says `questionnaire: not offered`, offer it **in your first reply of any conversation here**, whatever they opened with: answer what they asked first, then offer it in one line (a few questions, about 5 minutes, so they start with rules of their own). If they are in the middle of something urgent, the offer still goes, as the last line. Then change that line to `questionnaire: done <date>` or `questionnaire: declined <date>`, so no other window offers it again. They can always ask for it later. To run it, follow `questionnaire.md`.

## Where things live
- **The notes** are in the notes folder chosen at install (`notas/` by default). Mneme keeps their history in its `.mneme/` folder: **never edit anything inside `.mneme/`**, except `.mneme/config.json` as "Changing how Mneme works" says.
- Projects, scratch files and anything else can live next to the notes folder.

## Before answering or writing
- If the answer may be in the notes, **search first**: the `search` tool of the `mneme` MCP server (or `mneme search "<words>"` in a terminal). Read the section it points to before relying on it, and say which note you used.
- Before creating a note, search for one that already covers the topic.

## How notes are written
1. **One owner per fact.** A fact lives in one note; other notes link to it (`[[Note name]]`) instead of copying it. A copy does not age with its source, and nothing warns when they drift apart.
2. **Update, don't branch.** Add to the note that owns the topic; do not start a parallel "v2" note.
3. **Correcting is replacing.** When something turns out wrong, replace the text (Mneme keeps the old version) instead of piling a correction below it. When a whole note is superseded, say so at its top with a link to the current one.
4. **Every status carries its date**, as in "Status (2026-09-25): ...". A status without a date cannot be trusted later.
5. **Small notes, split into sections with headings.** Mneme searches, guards and reports changes by section.

## When Mneme stops a write
Mneme denies a write that **removes a section another session wrote** (a heading and what is under it). It does **not** stop you from editing on top of an old read: when a note you read changes, it **tells you** ("Notes you read have changed since you read them"), and it is on you to read it again before writing. When a write is denied: read the note again, keep the other session's sections, and write again. Never work around it with a shell command: that is how work gets lost.

## Changing how Mneme works
How Mneme searches and guards lives in `<notes folder>/.mneme/config.json`, the one file of `.mneme/` that may be edited. It is shared by every window, so:
1. **Show the person the change and get their OK** before writing it. When they paste a block from the galaxy ("El orden" → copy config.json), that block holds only what changes: merge it into the file, keeping every other key.
2. Keep the previous content, write, and run `mneme doctor --root <notes folder>`. If it says `fail config`, put the previous content back and tell them why.
3. Tell them to **open Claude Code again**: the search connection reads the configuration when it starts.

A key Mneme does not know, or a value it cannot use, does not stop Mneme: that key goes back to its default and every window says so until it is fixed (`mneme doctor` names it).

## Several sessions at once
Several sessions (and several AIs) can work here at the same time. Mneme tells you when a note you read changes. Leave a section to the session that is writing it; if you need to change it too, say so first.

## Talking to the person
- **Answer what was asked first.** Details after, and only if they help.
- **Everyday words, in their language.** The words Mneme and Claude use inside are translated. Say the technical one only if the person used it first or asked for the technical detail, and then once, with its meaning next to it.

| Inside word | Say instead |
|---|---|
| root | your notes folder |
| ledger | the history of changes: who changed what, and when |
| hook | the automatic check Mneme runs around each edit |
| session | a Claude Code window |
| MCP server | the connection that lets Claude search your notes |
| denied, guard, lease | Mneme stopped the edit: it would have removed a part another window wrote |
| external write | a change made outside Claude (you in an editor, or a command) |
| embeddings; lexical | search by meaning; search by words |
| stale, superseded | outdated, replaced by (the current note) |
| exit code, stdout, JSON, PATH | do not name them: say what happened |

The table is a minimum: any other inside word gets the same treatment. A command the person has to type goes exactly as it is; one you can run yourself, you run. When you offer options, each one says what happens to their notes or their work, not what you will do inside.

## When the person does not understand something
Say what it is, what it is for, and where it is written (a note here, or the README in the Mneme folder). If you cannot find where it is written, say so: never make up a source.
