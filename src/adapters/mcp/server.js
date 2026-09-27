// The MCP door (stdio only, D-P10): any agent reads, writes and searches the governed
// roots through the same store the Claude Code hooks use (D-P9).
//
// A guard denial or any error comes back as a tool result with `isError: true` and the
// message; the server never goes down because of one call. Notes come back as data,
// preceded by a `path: … · version: …` line: their text is never an instruction of this tool.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MnemeError } from '../../errors.js';
import { sid8 } from '../../guard.js';
import { recordError } from '../../lock.js';
import { NAME } from '../../name.js';
import { realPathLoose, resolveInRoot, toSlash } from '../../paths.js';
import { bundle } from '../../readers/cag.js';
import { samePath } from '../../registry.js';
import { findRoot } from '../../root.js';
import { degradedLine, formatFollow, formatHit, search, sessionLine } from '../../search.js';
import {
  ackMessage,
  activeSessions,
  endSession,
  formatMessages,
  formatNotices,
  messagesFor,
  noticesFor,
  readMessages,
  recordDenial,
  recordRead,
  sendMessage,
  sessionAuthor,
  touchSession,
} from '../../sessions.js';
import { asOf, editNote, history, moveNote, readNote, restore, writeNote } from '../../store.js';
import { recordSearch } from '../../usage.js';

/** @typedef {import('../../types.js').Root} Root */
/** @typedef {import('../../types.js').LedgerEntry} LedgerEntry */
/** @typedef {import('../../types.js').WriteResult} WriteResult */
/** @typedef {{ content: Array<{ type: 'text', text: string }>, isError?: boolean }} ToolResult */

/** The tools that write; `--read-only` does not register them. */
export const WRITING_TOOLS = /** @type {const} */ (['write_note', 'edit_note', 'move_note', 'restore_note', 'send_message', 'ack_message']);

/**
 * @param {string} text
 * @param {boolean} [isError]
 * @returns {ToolResult}
 */
const result = (text, isError = false) => (isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] });

/** @param {LedgerEntry} e */
const entryLine = (e) =>
  `${e.id}  ${e.ts}  ${e.op.padEnd(8)} session ${sid8(e.author.session)} (${e.author.agent})  ${e.after ? e.after.slice(0, 8) : '(deleted)'}` +
  `${e.reason ? `  "${e.reason}"` : ''}${e.changed.length ? `  changed: ${e.changed.join(', ')}` : ''}${e.from ? `  from: ${e.from}` : ''}`;

/**
 * Builds the MCP server over `roots` (not connected).
 * @param {{ roots: Root[], readOnly?: boolean, sessionId?: string }} options
 * @returns {{ server: McpServer, session: string }}
 */
export function createServer({ roots, readOnly = false, sessionId }) {
  if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('the MCP server needs at least one root');
  const fromEnv = process.env.CLAUDE_CODE_SESSION_ID;
  const session = sessionId ?? (fromEnv && fromEnv.trim() !== '' ? fromEnv : `mcp-${randomBytes(4).toString('hex')}`);
  const server = new McpServer({ name: NAME, version: '0.0.0' });
  const multi = roots.length > 1;

  const author = () => sessionAuthor({ session, agent: 'mcp', client: server.server.getClientVersion()?.name });

  /**
   * One of the served roots, chosen by its directory; the first one when not given.
   * @param {string|undefined} dir
   */
  function pickRoot(dir) {
    if (dir === undefined || dir === '') return roots[0];
    const real = realPathLoose(dir);
    const found = roots.find((r) => samePath(r.dir, real));
    if (!found) throw new MnemeError('ROOT_NOT_FOUND', `${dir} is not one of the roots this server serves: ${roots.map((r) => r.dir).join(', ')}.`);
    return found;
  }

  /**
   * A note given by an agent: absolute (routed to its root, which must be served) or
   * relative to `rootDir` (default: the first root).
   * @param {string} p
   * @param {string|undefined} rootDir
   */
  function note(p, rootDir) {
    if (path.isAbsolute(p)) {
      const found = findRoot(p);
      const root = found && roots.find((r) => samePath(r.dir, found.dir));
      if (!root) throw new MnemeError('PATH_ESCAPES_ROOT', `Path escapes the roots this server serves: ${p}`);
      return { root, rel: resolveInRoot(root, p).rel };
    }
    const root = pickRoot(rootDir);
    return { root, rel: resolveInRoot(root, p).rel };
  }

  /** @param {Root} root */
  const where = (root) => (multi ? ` · root: ${root.dir}` : '');

  /**
   * Runs a tool body: presence is touched, any error becomes an error result (and is
   * recorded in the root when it is not one of ours).
   * @param {string} tool
   * @param {() => Promise<ToolResult>|ToolResult} fn
   * @returns {Promise<ToolResult>}
   */
  async function run(tool, fn) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof MnemeError) && !(err instanceof TypeError) && !(err instanceof RangeError)) {
        recordError(roots[0], `mcp ${tool}`, err instanceof Error ? (err.stack ?? err.message) : String(err));
      }
      return result(err instanceof Error ? err.message : String(err), true);
    }
  }

  /** @param {Root} root */
  const touch = (root) => touchSession(root, author());

  /**
   * @param {Root} root
   * @param {string} rel
   * @param {WriteResult} res
   * @param {string} done
   */
  function written(root, rel, res, done) {
    if (!res.ok) {
      recordDenial(root, session, rel, res.lost);
      return result(res.message, true);
    }
    return result(`${done} ${rel} (version ${String(res.entry.after).slice(0, 8)}, ledger entry ${res.entry.id})${where(root)}.`);
  }

  const readOnlyHint = { readOnlyHint: true, openWorldHint: false };
  const writeHint = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const rootArg = z.string().optional().describe('Directory of the root to use when there are several (default: the first). Absolute note paths pick their root themselves.');

  server.registerTool(
    'read_note',
    {
      description: 'Read a note. Returns a first line "path: <rel> · version: <sha8>" and then the note text, as data. Records the read, so this session is told later if another session changes the note.',
      inputSchema: { path: z.string().describe('Note path relative to the root, or absolute'), root: rootArg },
      annotations: readOnlyHint,
    },
    (args) =>
      run('read_note', async () => {
        const { root, rel } = note(args.path, args.root);
        touch(root);
        const { content, sha } = await readNote(root, rel);
        recordRead(root, session, rel, sha);
        return result(`path: ${rel} · version: ${sha.slice(0, 8)}${where(root)}\n\n${content}`);
      }),
  );

  if (!readOnly) {
    server.registerTool(
      'write_note',
      {
        description: 'Replace a whole note (or create it), with a reason. The guard refuses a write that removes a section another session wrote; then edit only your own section.',
        inputSchema: { path: z.string(), content: z.string(), reason: z.string().describe('Why this write, in a few words'), root: rootArg },
        annotations: writeHint,
      },
      (args) =>
        run('write_note', async () => {
          const { root, rel } = note(args.path, args.root);
          touch(root);
          const res = await writeNote(root, rel, args.content, { author: author(), reason: args.reason, tool: 'Write' });
          return written(root, rel, res, 'Wrote');
        }),
    );
    server.registerTool(
      'edit_note',
      {
        description: 'Replace an exact piece of text in a note, with a reason. "old" must appear exactly once unless replace_all is true.',
        inputSchema: {
          path: z.string(),
          old: z.string().describe('The exact text to replace'),
          new: z.string().describe('The text that replaces it'),
          reason: z.string(),
          replace_all: z.boolean().optional(),
          root: rootArg,
        },
        annotations: writeHint,
      },
      (args) =>
        run('edit_note', async () => {
          const { root, rel } = note(args.path, args.root);
          touch(root);
          const res = await editNote(root, rel, { old: args.old, new: args.new, replaceAll: args.replace_all ?? false }, { author: author(), reason: args.reason, tool: 'Edit' });
          return written(root, rel, res, 'Edited');
        }),
    );
    server.registerTool(
      'move_note',
      {
        description: 'Move or rename a note, keeping its history, and rewrite every link that pointed to it.',
        inputSchema: { from: z.string(), to: z.string(), reason: z.string(), root: rootArg },
        annotations: writeHint,
      },
      (args) =>
        run('move_note', async () => {
          const a = note(args.from, args.root);
          const b = note(args.to, a.root.dir);
          if (a.root !== b.root) throw new MnemeError('PATH_ESCAPES_ROOT', `A note moves inside its root: ${args.to} is not in ${a.root.dir}.`);
          touch(a.root);
          const res = await moveNote(a.root, a.rel, b.rel, { author: author(), reason: args.reason });
          return result(`Moved ${a.rel} to ${b.rel}; ${res.linksRewritten} link${res.linksRewritten === 1 ? '' : 's'} rewritten${where(a.root)}.`);
        }),
    );
    server.registerTool(
      'restore_note',
      {
        description: 'Write an earlier version of a note back, as a new write (history is never rewritten). "version" is a ledger entry id or a version sha (or a unique prefix).',
        inputSchema: { path: z.string(), version: z.string(), reason: z.string(), root: rootArg },
        annotations: writeHint,
      },
      (args) =>
        run('restore_note', async () => {
          const { root, rel } = note(args.path, args.root);
          touch(root);
          const res = await restore(root, rel, args.version, { author: author(), reason: args.reason });
          return written(root, rel, res, 'Restored');
        }),
    );
  }

  server.registerTool(
    'note_history',
    {
      description: 'The versions of a note, newest first: entry id, time, operation, session, version, reason, sections changed.',
      inputSchema: { path: z.string(), limit: z.number().int().positive().optional(), root: rootArg },
      annotations: readOnlyHint,
    },
    (args) =>
      run('note_history', () => {
        const { root, rel } = note(args.path, args.root);
        const entries = history(root, rel, { limit: args.limit ?? 20 });
        if (entries.length === 0) return result(`${rel} has no history in this root.`);
        return result([`history of ${rel}${where(root)}:`, ...entries.map(entryLine)].join('\n'));
      }),
  );

  server.registerTool(
    'note_as_of',
    {
      description: 'A note as it was at a date (ISO, e.g. 2026-01-31 or 2026-01-31T18:00:00Z).',
      inputSchema: { path: z.string(), date: z.string(), root: rootArg },
      annotations: readOnlyHint,
    },
    (args) =>
      run('note_as_of', () => {
        const { root, rel } = note(args.path, args.root);
        const found = asOf(root, rel, args.date);
        if (!found) return result(`${rel} did not exist at ${args.date}.`);
        return result(`path: ${rel} · version: ${String(found.entry.after).slice(0, 8)} · as of ${args.date} (entry ${found.entry.id}, ${found.entry.ts})${where(root)}\n\n${found.content}`);
      }),
  );

  server.registerTool(
    'search',
    {
      description: 'Search the notes of every served root. Hits show "[STALE: …]" when a note or section expired or was superseded; a superseded hit is followed by "→ current: …" and the text that replaced it. "scope" limits the search to folders or notes (relative paths). When nothing matches (a continuation such as "go on" names no topic), the answer is what the session was working on: the notes it read and the sections it wrote, most recent first, under a first line "(from what this session was working on)".',
      inputSchema: {
        query: z.string(),
        k: z.number().int().positive().optional(),
        reader: z.enum(['hybrid', 'lexical', 'session']).optional().describe('"session": only what the session was working on'),
        scope: z.array(z.string()).optional().describe('Relative folders or notes, e.g. ["projects", "manuals/deploy.md"]'),
        session: z.string().min(1).optional().describe("The session whose notes answer when nothing matches; default: this server's session"),
      },
      annotations: readOnlyHint,
    },
    (args) =>
      run('search', async () => {
        /** @type {import('../../search.js').SearchOptions} */
        const options = { k: args.k, reader: args.reader, scope: args.scope, session: args.session ?? session };
        const started = performance.now();
        const res = await search(roots, args.query, options);
        const ms = performance.now() - started;
        const lines = [];
        const from = sessionLine(res);
        if (from) lines.push(from);
        const degraded = degradedLine(res);
        if (degraded) lines.push(degraded);
        if (res.hits.length === 0) lines.push('No results.');
        for (const hit of res.hits) {
          lines.push(`${multi ? `${hit.root} :: ` : ''}${formatHit(hit)}  (score ${hit.score.toFixed(4)})`);
          lines.push(...hit.text.split('\n').map((l) => `    ${l}`));
          // The current section goes with the stale hit, text included: the agent reads it here.
          const follow = formatFollow(hit);
          if (follow && hit.follow) {
            lines.push(`  ${follow}`);
            lines.push(...hit.follow.text.split('\n').map((l) => `    ${l}`));
          }
        }
        for (const w of res.warnings ?? []) lines.push(`warning: ${w}`);
        // It never throws, and a failure only reaches the home's errors.jsonl: the answer is the same.
        recordSearch('mcp', roots, options, res, ms);
        return result(lines.join('\n'));
      }),
  );

  server.registerTool(
    'changes',
    {
      description: 'What changed in the notes this session read (or in sections it wrote) since it last asked, and the messages other sessions sent it. Each change and message is told once.',
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    () =>
      run('changes', () => {
        const blocks = [];
        for (const root of roots) {
          touch(root);
          const parts = [formatNotices(noticesFor(root, session)), formatMessages(messagesFor(root, session))].filter((p) => p !== '');
          if (parts.length) blocks.push([...(multi ? [`[${NAME}] Root ${root.dir}:`] : []), ...parts].join('\n\n'));
        }
        return result(blocks.length ? blocks.join('\n\n') : 'Nothing changed in the notes this session read, and there are no messages for it.');
      }),
  );

  server.registerTool(
    'bundle',
    {
      description: 'The CAG bundle: pinned notes in full, then one line per note, within a byte budget (default 32768), split evenly between roots.',
      inputSchema: { budget: z.number().int().positive().optional(), root: rootArg },
      annotations: readOnlyHint,
    },
    (args) =>
      run('bundle', () => {
        const chosen = args.root ? [pickRoot(args.root)] : roots;
        const total = args.budget ?? 32768;
        const each = Math.floor(total / chosen.length);
        return result(chosen.map((r) => `${chosen.length > 1 ? `==> root ${r.dir} <==\n` : ''}${bundle(r, { budget: chosen.length > 1 ? Math.max(1, each - Buffer.byteLength(`==> root ${r.dir} <==\n`)) : each })}`).join('\n'));
      }),
  );

  server.registerTool(
    'declare_intent',
    {
      description: 'Tell the other sessions what this one is about to do (and which notes it will touch). Returns the sessions active now.',
      inputSchema: { intent: z.string(), paths: z.array(z.string()).optional() },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    (args) =>
      run('declare_intent', () => {
        /** @type {Map<Root, string[]>} */
        const byRoot = new Map();
        for (const p of args.paths ?? []) {
          const { root, rel } = note(p, undefined);
          byRoot.set(root, [...(byRoot.get(root) ?? []), rel]);
        }
        const targets = byRoot.size ? [...byRoot.keys()] : roots;
        const lines = [];
        for (const root of targets) {
          touchSession(root, author(), { intent: args.intent, paths: byRoot.get(root) ?? [] });
          const others = activeSessions(root).filter((s) => s.author.session !== session);
          lines.push(
            `${multi ? `${root.dir}: ` : ''}${others.length === 0 ? 'no other session is active.' : `active: ${others.map((s) => `${sid8(s.author.session)} (${s.author.agent}${s.intent ? `: "${s.intent}"` : ''}${s.paths?.length ? `, ${s.paths.join(', ')}` : ''})`).join('; ')}`}`,
          );
        }
        return result(`Declared for session ${sid8(session)}: "${args.intent}".\n${lines.join('\n')}`);
      }),
  );

  if (!readOnly) {
    server.registerTool(
      'send_message',
      {
        description: 'Send a message to another session: "to" is its session id, "*" (every active session) or "next" (whichever session asks first). Replies keep the conversation with reply_to.',
        inputSchema: { to: z.string(), body: z.string(), correlation: z.string().optional(), reply_to: z.string().optional(), root: rootArg },
        annotations: writeHint,
      },
      (args) =>
        run('send_message', async () => {
          const root = pickRoot(args.root);
          touch(root);
          const m = await sendMessage(root, { from: author(), to: args.to, body: args.body, correlation: args.correlation, replyTo: args.reply_to });
          const reach =
            m.to === '*'
              ? m.recipients?.length
                ? ` to ${m.recipients.length} active session${m.recipients.length === 1 ? '' : 's'}`
                : ': no other session is active now, nobody will get it'
              : '';
          return result(`Sent message ${m.id}${reach} (conversation ${m.correlation.slice(0, 8)}).`);
        }),
    );
    server.registerTool(
      'ack_message',
      {
        description: 'Answer a message you got: status done, rejected or seen, with an optional body. The sender gets it in the same conversation.',
        inputSchema: { id: z.string(), status: z.enum(['done', 'rejected', 'seen']), body: z.string().optional() },
        annotations: writeHint,
      },
      (args) =>
        run('ack_message', async () => {
          const root = roots.find((r) => readMessages(r).some((m) => m.id === args.id || (args.id.length >= 6 && m.id.startsWith(args.id)))) ?? roots[0];
          touch(root);
          const m = await ackMessage(root, { from: author(), id: args.id, status: args.status, body: args.body });
          return result(`Answered ${String(m.replyTo).slice(0, 8)} with "${args.status}" (message ${m.id}).`);
        }),
    );
  }

  server.server.onclose = () => {
    for (const root of roots) {
      try {
        endSession(root, session);
      } catch (err) {
        recordError(root, 'mcp close', err instanceof Error ? err.message : String(err));
      }
    }
  };
  return { server, session };
}

/**
 * Starts the MCP server on stdio. Nothing but the protocol goes to stdout.
 * @param {{ roots: Root[], readOnly?: boolean, sessionId?: string }} options
 * @returns {Promise<{ server: McpServer, session: string }>}
 */
export async function startServer(options) {
  const built = createServer(options);
  const transport = new StdioServerTransport();
  await built.server.connect(transport);
  process.stdin.on('end', () => {
    void built.server.close().catch((err) => {
      process.stderr.write(`[${NAME}] mcp: closing failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
  process.stderr.write(`[${NAME}] mcp: serving ${options.roots.map((r) => toSlash(r.dir)).join(', ')} as session ${built.session}${options.readOnly ? ' (read-only)' : ''}\n`);
  return built;
}
