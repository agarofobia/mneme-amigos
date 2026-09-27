// Shared JSDoc types. This module exports nothing at runtime; import types with
// `@typedef {import('./types.js').Root} Root`.

/**
 * Who performed an operation.
 * @typedef {Object} Author
 * @property {string} session  stable id of the agent session ('external' for writes nobody claimed)
 * @property {'claude-code'|'mcp'|'cli'|'external'|'adopt'} agent
 * @property {string} [client] MCP client name, when known
 * @property {string} [user]   OS user
 * @property {string} [host]
 */

/**
 * A heading and the text it governs.
 * @typedef {Object} Section
 * @property {number} level    1-6
 * @property {string} title    heading text, trimmed
 * @property {string} key      '#'.repeat(level) + ' ' + title: the unit the guard counts
 * @property {string[]} path   titles from the outermost enclosing heading down to this one
 * @property {number} start    offset of the heading line
 * @property {number} ownEnd   offset of the next heading of any level (or end of text)
 * @property {number} end      offset of the next heading of the same or a higher level (or end of text)
 */

/**
 * @typedef {Object} Frontmatter
 * @property {Record<string, string|string[]>} data
 * @property {number} end  offset right after the closing fence (0 when there is none)
 */

/**
 * @typedef {Object} ParsedNote
 * @property {Frontmatter} frontmatter
 * @property {{ start: number, ownEnd: number }} preamble  text between the frontmatter and the first heading
 * @property {Section[]} sections  in document order; headings inside code fences are not sections
 */

/**
 * @typedef {Object} EmbeddingsConfig
 * @property {'none'|'ollama'|'module'} provider
 * @property {string} url
 * @property {string} model
 * @property {number} timeoutMs
 * @property {string} queryPrefix
 * @property {string} documentPrefix
 * @property {string} [module]   provider "module": the file that exports createEmbedder (relative to the root, or absolute)
 * @property {Record<string, unknown>} [options]  provider "module": passed to createEmbedder as given
 */

/**
 * @typedef {Object} Config
 * @property {1} version
 * @property {number} guardLevels   headings at this level or above are protected by the guard
 * @property {'deny'|'record'} guard  what the guard does with a write that removes another session's section
 * @property {string[]} extensions  files that are notes
 * @property {string[]} ignoreDirs  directory names skipped anywhere in the tree
 * @property {string[]} ignorePaths relative path prefixes skipped
 * @property {number} activeWindowMinutes
 * @property {number} activeWarnAt
 * @property {number} lockTimeoutMs
 * @property {number} leaseMinutes
 * @property {number} wakeUpBudget  bytes of the CAG bundle injected when a session starts (0: off)
 * @property {EmbeddingsConfig} embeddings
 * @property {{ k: number, minLexical: number, minLexicalRatio: number, minCosine: number, stale: 'follow'|'mark' }} search
 *   floors for hitPasses (search.js); `stale`: whether a superseded hit brings the current section with it
 * @property {{ k1: number, b: number, rrfK: number }} ranking  BM25's k1 and b; the RRF constant of the hybrid reader
 * @property {{ expires: string[], superseded_by: string[], pinned: string[] }} metadataAliases
 */

/**
 * A governed root.
 * @typedef {Object} Root
 * @property {string} dir       real path, forward slashes
 * @property {string} stateDir  dir + '/' + STATE_DIR
 * @property {Config} config
 * @property {string[]} [configProblems]  what config.json got wrong, each back to its default (§4.3)
 */

/**
 * One line of the ledger.
 * @typedef {Object} LedgerEntry
 * @property {1} v
 * @property {string} id
 * @property {string} ts       ISO timestamp
 * @property {string} rel      path relative to the root, forward slashes, NFC
 * @property {'adopt'|'write'|'edit'|'move'|'restore'|'external'|'delete'} op
 * @property {Author} author
 * @property {string} [reason]
 * @property {string|null} before  sha256 of the content before (null: did not exist)
 * @property {string|null} after   sha256 of the content after (null: deleted)
 * @property {string} [from]       previous rel, for op 'move'
 * @property {Record<string, number>} delta  heading key -> change in copies (levels <= guardLevels)
 * @property {string[]} changed    keys of sections whose own text changed
 * @property {{ lease: string }} [override]
 * @property {string[]} [violations]  for 'external'/'delete': keys with an owner that it removed
 * @property {true} [raced]         two-phase write: the file at commit was not the predicted content
 * @property {true} [late]          two-phase write whose commit never ran, confirmed later by the watcher
 * @property {string} prev          sha256 of the previous ledger line as stored ('' for the first)
 */

/**
 * @typedef {{ ok: true, entry: LedgerEntry } | { ok: false, lost: Array<{ key: string, owners: string[] }>, message: string }} WriteResult
 */

/**
 * @typedef {Object} SearchHit
 * @property {string} root  the root's dir
 * @property {string} rel
 * @property {{ path: string[], key: string, start: number, end: number }} section  key '' = text before the first heading
 * @property {number} score
 * @property {string} text  the section's own text, at most 1200 characters
 * @property {{ reason: string }} [stale]
 * @property {SearchFollow} [follow]  superseded, with `search.stale: "follow"`: where its link leads
 * @property {'session'} [via]  it did not match the query: it is what the searching session was working on
 *   (the search found nothing and was given a session); absent on every hit that matched
 */

/**
 * The current section a superseded hit points to, found in the hit's own root. One hop only:
 * a current section that is itself stale says so in `stale` and is not followed further.
 * @typedef {Object} SearchFollow
 * @property {string} rel
 * @property {{ path: string[], key: string, start: number, end: number } | null} section  null: the link names no heading there, so the whole note is current
 * @property {string} text  the section with its subsections (or the note after its frontmatter), at most 1200 characters
 * @property {{ reason: string }} [stale]
 */

/**
 * @typedef {Object} Embedder
 * @property {string} name
 * @property {(texts: string[], role: 'query'|'document') => Promise<number[][]>} embed
 */

export {};
