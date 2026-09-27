// Mneme GUI renderer: runs in the browser, inside the page `mneme gui` writes. It reads the
// snapshot from #mneme-data and builds the zones of docs/diseno/gui-mapa.md with stable
// part names (data-part) that packs style. It never writes anything: every action is a
// command the person copies into a terminal (contracts §4.17).
(() => {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const body = document.body;

  /** @type {any} */
  let DATA;
  try {
    DATA = JSON.parse(/** @type {HTMLElement} */ (document.getElementById('mneme-data')).textContent || '');
  } catch (e) {
    body.dataset.state = 'error';
    const f = document.querySelector('[data-zone=F] [data-part=fail-text]');
    if (f) f.textContent = `This page's snapshot could not be read (${/** @type {Error} */ (e).message}). Generate it again: mneme gui`;
    return;
  }
  const NAME = DATA.name;

  // ── small helpers ─────────────────────────────────────────────────────────
  /**
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {Array<Node|string|null|undefined|false>|Node|string|null} [children]
   * @returns {HTMLElement}
   */
  function h(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'part') node.setAttribute('data-part', v);
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of Array.isArray(children) ? children : [children]) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }
  /**
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {Array<Node|null|false>} [children]
   * @returns {SVGElement}
   */
  function s(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'part') node.setAttribute('data-part', v);
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else node.setAttribute(k, String(v));
    }
    for (const c of children) if (c) node.append(c);
    return node;
  }
  /** @param {string} text */
  const label = (text) => h('span', { part: 'label', text });
  /** @param {string} id */
  const sid8 = (id) => (id === 'external' ? '—' : String(id).slice(0, 8));
  const today = new Date(DATA.generatedAt).toDateString();
  /** @param {string} iso */
  function when(iso) {
    const d = new Date(iso);
    const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === today ? hm : `${d.toLocaleDateString('en', { month: 'short', day: 'numeric' })} ${hm}`;
  }
  /** @param {string} x */
  const q = (x) => `"${String(x).replace(/(["\\$`])/g, '\\$1')}"`;
  /** @param {any} a */
  const agentOf = (a) => (a.client ? `${a.agent} · ${a.client}` : a.agent);
  /** @param {string} key */
  const levelOf = (key) => (key.match(/^#+/) || [''])[0];
  const OPS = /** @type {Record<string, string>} */ ({ adopt: 'adopted', write: 'write', edit: 'edit', move: 'move', restore: 'restore', external: 'external', delete: 'delete' });
  const STATE_WORD = /** @type {Record<string, string>} */ ({ denied: 'Denied', writing: 'Writing', stale: 'Stale', external: 'External', adopted: 'Adopted' });

  /**
   * A small engraved mark per state (each pack colors it through its data-st).
   * @param {string} st
   */
  function stateMark(st) {
    const kids = [];
    if (st === 'writing') kids.push(s('circle', { part: 'mark-ring', cx: 8, cy: 8, r: 6.5 }), s('line', { part: 'hand', x1: 8, y1: 8, x2: 8, y2: 2.5 }), s('circle', { part: 'hub', cx: 8, cy: 8, r: 1.2 }));
    else if (st === 'external') kids.push(s('path', { part: 'mark-pencil', d: 'M4 4 L12 12 M12 4 L4 12' }));
    else if (st === 'stale') kids.push(s('circle', { part: 'mark-ring', cx: 8, cy: 8, r: 6 }), s('circle', { part: 'mark-drift', cx: 11.5, cy: 5, r: 1.8 }));
    else if (st === 'denied') kids.push(s('circle', { part: 'pin', cx: 8, cy: 8, r: 4 }));
    else if (st === 'adopted') kids.push(s('circle', { part: 'mark-ring', cx: 8, cy: 8, r: 3.5 }));
    else kids.push(s('path', { part: 'mark-star', d: 'M8 2 L9.3 6.7 L14 8 L9.3 9.3 L8 14 L6.7 9.3 L2 8 L6.7 6.7 Z' }));
    return s('svg', { part: 'state-mark', 'data-st': st, viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' }, kids);
  }

  /**
   * Copies a command; when the clipboard is not available, shows it selected instead.
   * @param {string} cmd
   * @param {HTMLElement} button
   */
  function copy(cmd, button) {
    const done = () => {
      button.dataset.copied = 'true';
      const was = button.dataset.label || button.textContent || '';
      button.dataset.label = was;
      const lab = button.querySelector('[data-part=button-label]');
      if (lab) lab.textContent = 'Copied';
      setTimeout(() => {
        delete button.dataset.copied;
        if (lab) lab.textContent = was;
      }, 1600);
    };
    showHint(cmd);
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(cmd).then(done, () => undefined);
  }
  /** @param {string} cmd */
  function showHint(cmd) {
    const hint = /** @type {HTMLElement|null} */ (document.querySelector('[data-part=hint]'));
    if (!hint) return;
    hint.replaceChildren(label('Run in a terminal'), h('code', { part: 'cmd', tabindex: '0', text: cmd }));
    hint.hidden = false;
    const code = hint.querySelector('code');
    if (code) {
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }

  // ── state ─────────────────────────────────────────────────────────────────
  const fromHash = new URLSearchParams(location.hash.slice(1));
  const ui = {
    root: Math.min(Number(fromHash.get('root') || 0) || 0, DATA.roots.length - 1),
    /** @type {string|null} */ note: fromHash.get('note'),
    /** @type {string|null} */ section: fromHash.get('section'),
    /** @type {string|null} */ version: null,
    /** @type {string|null} */ session: null,
    filter: '',
    diff: false,
    tab: 0,
  };
  const R = () => DATA.roots[Math.max(0, ui.root)];
  /** @returns {any} */
  const NOTE = () => R()?.notes.find((/** @type {any} */ n) => n.rel === ui.note) || null;
  function saveHash() {
    const p = new URLSearchParams();
    if (ui.root) p.set('root', String(ui.root));
    if (ui.note) p.set('note', ui.note);
    if (ui.section) p.set('section', ui.section);
    history.replaceState(null, '', `#${p.toString()}`);
  }

  // ── the zones ─────────────────────────────────────────────────────────────
  const zone = {
    A: /** @type {HTMLElement} */ (document.querySelector('[data-zone=A]')),
    N: /** @type {HTMLElement} */ (document.querySelector('[data-zone=N]')),
    B: /** @type {HTMLElement} */ (document.querySelector('[data-zone=B]')),
    C: /** @type {HTMLElement} */ (document.querySelector('[data-zone=C]')),
    D: /** @type {HTMLElement} */ (document.querySelector('[data-zone=D]')),
    F: /** @type {HTMLElement} */ (document.querySelector('[data-zone=F]')),
  };

  function renderA() {
    const root = R();
    const mark = s('svg', { part: 'maker-mark', viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' }, [
      s('circle', { part: 'engrave', cx: 12, cy: 12, r: 10 }),
      s('circle', { part: 'engrave', 'data-tone': 'dim', cx: 12, cy: 12, r: 6 }),
      s('path', { part: 'engrave', 'data-tone': 'dim', d: 'M12 2 V22 M2 12 H22' }),
      s('path', { part: 'mark-star', d: 'M12 8 L13 11 L16 12 L13 13 L12 16 L11 13 L8 12 L11 11 Z' }),
    ]);
    const rootPart =
      DATA.roots.length > 1
        ? h('label', { part: 'root' }, [
            label('Root'),
            h(
              'select',
              { part: 'input', 'data-kind': 'root', on: { change: (/** @type {Event} */ e) => pickRoot(Number(/** @type {HTMLSelectElement} */ (e.target).value)) } },
              DATA.roots.map((/** @type {any} */ r, /** @type {number} */ i) => h('option', { value: i, selected: i === ui.root, text: r.label })),
            ),
          ])
        : h('span', { part: 'root', title: root?.dir }, [label('Root'), h('span', { part: 'path', text: root ? `${root.label}/` : '—' })]);
    const input = /** @type {HTMLInputElement} */ (
      h('input', { part: 'input', type: 'search', placeholder: 'path or section', 'aria-label': 'Filter notes', value: ui.filter, spellcheck: 'false', autocomplete: 'off' })
    );
    input.addEventListener('input', () => {
      ui.filter = input.value;
      renderN();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        ui.filter = '';
        renderN();
      }
    });
    const sessions = (root?.sessions || []).map((/** @type {any} */ x) => {
      const writing = x.writing.length > 0;
      return h(
        'button',
        {
          part: 'session',
          type: 'button',
          'data-st': writing ? 'writing' : 'idle',
          'aria-pressed': String(ui.session === x.session),
          title: `${x.session}${x.intent ? ` — ${x.intent}` : ''}${writing ? `\nwriting ${x.writing.join(', ')}` : ''}\nseen ${when(x.lastSeen)}`,
          on: { click: () => pickSession(x.session) },
        },
        [stateMark(writing ? 'writing' : 'normal'), h('span', { part: 'owner-id', text: sid8(x.session) }), h('span', { part: 'owner-agent' }, [agentOf(x), writing ? h('span', { part: 'state-word', 'data-st': 'writing', text: ' writing' }) : null])],
      );
    });
    zone.A.replaceChildren(
      h('span', { part: 'titlebar-title' }, [mark, h('span', { text: 'Mneme' })]),
      rootPart,
      h('label', { part: 'field' }, [label('Filter'), input]),
      h('div', { part: 'sessions' }, [label(sessions.length ? 'Active' : 'No active sessions'), ...sessions]),
      h('span', { part: 'stamp', title: DATA.watch ? 'Regenerated by mneme gui --watch; this page reloads every 5 s' : `Snapshot. Refresh it with: ${NAME} gui` }, [
        label(DATA.watch ? 'Watching' : 'Snapshot'),
        h('span', { part: 'time', text: when(DATA.generatedAt) }),
      ]),
    );
    const k = /** @type {HTMLInputElement|null} */ (document.querySelector('[data-zone=A] input[type=search]'));
    if (k && document.activeElement === body && ui.filter) k.focus();
  }

  function renderN() {
    const root = R();
    const f = ui.filter.trim().toLowerCase();
    const touched = ui.session ? new Set([...(root.sessions.find((/** @type {any} */ x) => x.session === ui.session)?.touched || []), ...(root.sessions.find((/** @type {any} */ x) => x.session === ui.session)?.writing || [])]) : null;
    /** @type {HTMLElement[]} */
    const items = [];
    let folder = null;
    let shown = 0;
    for (const n of root.notes) {
      const match = !f || n.rel.toLowerCase().includes(f) || n.sections.some((/** @type {any} */ x) => x.title.toLowerCase().includes(f));
      if (!match) continue;
      shown++;
      const dir = n.rel.includes('/') ? n.rel.slice(0, n.rel.lastIndexOf('/')) : '';
      if (dir !== folder) {
        folder = dir;
        items.push(h('li', { part: 'folder', text: dir ? `${dir}/` : `${root.label}/` }));
      }
      const flags = Object.entries(n.flags)
        .filter(([, on]) => on)
        .map(([kind]) => stateMark(kind));
      const st = n.flags.denied ? 'denied' : n.flags.writing ? 'writing' : n.stale ? 'stale' : n.flags.external ? 'external' : 'normal';
      items.push(
        h('li', {}, [
          h(
            'button',
            {
              part: 'list-item',
              type: 'button',
              'data-st': st,
              'aria-current': n.rel === ui.note ? 'true' : null,
              'data-dim': touched && !touched.has(n.rel) ? 'true' : null,
              title: n.rel,
              on: { click: () => pickNote(n.rel) },
            },
            [h('span', { part: 'list-item-name', text: n.rel.slice(n.rel.lastIndexOf('/') + 1).replace(/\.md$/, '') }), h('span', { part: 'flags' }, flags)],
          ),
        ]),
      );
    }
    const header = h('div', { part: 'panel-header' }, [label('Notes'), h('span', { part: 'counter', text: f ? `${shown} / ${root.notes.length}` : String(root.notes.length) })]);
    const none =
      f && shown === 0
        ? h('div', { part: 'nodata' }, [
            h('p', { text: 'No note matches.' }),
            h('p', { text: 'For full-text search, regenerate with:' }),
            cmdButton(`${NAME} gui --query ${q(ui.filter.trim())}`),
          ])
        : null;
    zone.N.replaceChildren(...[header, h('ul', { part: 'list' }, items), none].filter((x) => x !== null));
  }

  /**
   * @param {string} cmd
   * @param {string} [text]
   */
  function cmdButton(cmd, text) {
    const b = h('button', { part: 'button', 'data-variant': 'command', type: 'button', title: 'Copy', on: { click: () => copy(cmd, b) } }, [h('span', { part: 'button-label', text: text || cmd })]);
    return b;
  }

  // ── the device: the note as an armillary sphere (gui-decision.md) ─────────
  /** @param {any} n */
  function device(n) {
    if (body.dataset.device === 'none') return null;
    const size = 244;
    const c = size / 2;
    const RINGS = [90, 68, 46];
    const ringOf = (/** @type {number} */ level) => Math.min(level, 3) - 1;
    /** @type {Record<number, any[]>} */
    const byRing = { 0: [], 1: [], 2: [] };
    n.sections.forEach((/** @type {any} */ x, /** @type {number} */ i) => byRing[ringOf(x.level)].push({ x, i }));
    const sel = n.sections.findIndex((/** @type {any} */ x) => x.key === ui.section);
    const turns = [0, 0, 0];
    /** @type {SVGElement[]} */
    const rings = [];
    /** @type {SVGElement[]} */
    const hands = [];
    const angles = new Map();
    for (let r = 0; r < 3; r++) {
      const list = byRing[r];
      const radius = RINGS[r];
      const step = list.length ? 360 / list.length : 0;
      list.forEach((/** @type {any} */ b, /** @type {number} */ j) => angles.set(b.i, { r, a: j * step - 90 + (r * 17) }));
      const own = list.find((/** @type {any} */ b) => b.i === sel);
      if (own) turns[r] = -(angles.get(own.i).a + 90);
      /** @type {SVGElement[]} */
      const bodies = list.map((/** @type {any} */ b) => {
        const { a } = angles.get(b.i);
        const rad = (a * Math.PI) / 180;
        const drift = b.x.st === 'stale' ? 9 : 0;
        const x = c + (radius + drift) * Math.cos(rad);
        const y = c + (radius + drift) * Math.sin(rad);
        const kids = [s('title', {}, [document.createTextNode(`${b.x.key}${STATE_WORD[b.x.st] ? ` — ${STATE_WORD[b.x.st]}` : ''}`)])];
        if (b.x.st === 'stale') kids.push(s('line', { part: 'device-thread', x1: c + radius * Math.cos(rad), y1: c + radius * Math.sin(rad), x2: x, y2: y }));
        if (b.x.st === 'external') kids.push(s('path', { part: 'mark-pencil', d: `M${x - 4} ${y - 4} L${x + 4} ${y + 4} M${x + 4} ${y - 4} L${x - 4} ${y + 4}` }));
        else kids.push(s('circle', { part: 'device-body-shape', cx: x, cy: y, r: b.i === sel ? 5 : 3.5 }));
        if (b.x.st === 'denied') kids.push(s('circle', { part: 'pin', cx: x, cy: y - 9, r: 3 }));
        return s(
          'g',
          { part: 'device-body', 'data-st': b.x.st, 'aria-selected': String(b.i === sel), tabindex: '-1', on: { click: () => pickSection(b.x.key) } },
          kids,
        );
      });
      rings.push(
        s('g', { part: 'device-ring', 'data-ring': r + 1, style: `transform:rotate(${turns[r]}deg);transform-origin:${c}px ${c}px` }, [
          s('circle', { part: 'device-orbit', cx: c, cy: c, r: radius }),
          ...list.map((/** @type {any} */ b) => {
            const { a } = angles.get(b.i);
            const rad = (a * Math.PI) / 180;
            const owners = b.x.owners.filter((/** @type {string} */ o) => o !== 'external');
            if (!owners.length) return null;
            const active = owners.find((/** @type {string} */ o) => R().sessions.some((/** @type {any} */ x) => x.session === o));
            const writingNow = n.writing.some((/** @type {any} */ w) => owners.includes(w.session));
            return s('line', { part: 'device-hand', 'data-st': writingNow ? 'writing' : active ? 'active' : 'idle', x1: c, y1: c, x2: c + (radius - 5) * Math.cos(rad), y2: c + (radius - 5) * Math.sin(rad) });
          }),
          ...bodies,
        ]),
      );
    }
    // the ecliptic: the note's time, from its first version to the snapshot
    const hist = [...n.history].reverse();
    const t0 = hist.length ? Date.parse(hist[0].ts) : Date.parse(DATA.generatedAt);
    const t1 = Date.parse(DATA.generatedAt);
    const span = Math.max(1, t1 - t0);
    const eclipticR = 110;
    const at = (/** @type {number} */ t) => -225 + (270 * (t - t0)) / span;
    const marks = [];
    for (let g = 0; g <= 27; g++) {
      const a = ((-225 + g * 10) * Math.PI) / 180;
      const long = g % 9 === 0;
      marks.push(s('line', { part: 'device-tick', 'data-long': String(long), x1: c + eclipticR * Math.cos(a), y1: c + eclipticR * Math.sin(a), x2: c + (eclipticR - (long ? 6 : 3)) * Math.cos(a), y2: c + (eclipticR - (long ? 6 : 3)) * Math.sin(a) }));
    }
    for (const v of hist) {
      const a = (at(Date.parse(v.ts)) * Math.PI) / 180;
      marks.push(
        s('circle', {
          part: 'device-event',
          'data-op': v.op,
          'aria-selected': String(v.id === ui.version),
          cx: c + (eclipticR + 5) * Math.cos(a),
          cy: c + (eclipticR + 5) * Math.sin(a),
          r: v.id === ui.version ? 3 : 1.8,
        }),
      );
    }
    const writing = n.writing.length > 0;
    return s('svg', { part: 'device', 'data-device': 'armillary', viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': `${n.rel}: ${n.sections.length} sections on their rings; ${n.history.length} versions on the ecliptic` }, [
      s('g', { part: 'device-ecliptic' }, [s('path', { part: 'device-ecliptic-arc', d: arc(c, c, eclipticR, -225, 45) }), ...marks]),
      s('line', { part: 'device-meridian', x1: c, y1: c - eclipticR, x2: c, y2: c + eclipticR }),
      ...rings,
      s('g', { part: 'device-center', 'data-st': writing ? 'writing' : 'idle' }, [
        s('circle', { part: 'device-center-disc', cx: c, cy: c, r: 12 }),
        s('line', { part: 'device-center-hand', x1: c, y1: c, x2: c, y2: c - 9, style: `transform-origin:${c}px ${c}px` }),
        s('circle', { part: 'hub', cx: c, cy: c, r: 1.6 }),
      ]),
    ]);
  }
  /**
   * @param {number} cx @param {number} cy @param {number} r @param {number} a0 @param {number} a1
   */
  function arc(cx, cy, r, a0, a1) {
    const p = (/** @type {number} */ a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    return `M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  }

  function renderB() {
    const n = NOTE();
    const root = R();
    const plate = h('div', { part: 'empty-plate' }, [
      s('svg', { part: 'device', 'data-device': 'empty', viewBox: '0 0 120 120', width: 120, height: 120, 'aria-hidden': 'true' }, [
        s('circle', { part: 'device-orbit', cx: 60, cy: 60, r: 52 }),
        s('path', { part: 'device-meridian', d: 'M60 4 V14 M60 106 V116 M4 60 H14 M106 60 H116' }),
      ]),
      h('p', { part: 'guidance-text', text: root ? 'No notes here yet.' : 'No governed root yet. Run:' }),
      root ? h('p', { part: 'progress-meta', text: `Write the first markdown note in ${root.dir}, or govern a folder that already has notes:` }) : null,
      cmdButton(`${NAME} init --adopt "<folder with notes>"`),
    ]);
    if (!n) {
      zone.B.replaceChildren(plate);
      return;
    }
    const sessionOf = (/** @type {string} */ id) => root.sessions.find((/** @type {any} */ x) => x.session === id);
    const legends = [];
    for (const w of n.writing) legends.push(h('p', { part: 'legend', 'data-st': 'writing' }, [h('span', { part: 'legend-word', text: 'Writing' }), ` · ${sid8(w.session)} (${agentOf(w)}) is working on this note now${w.keys.length ? `: ${w.keys.join(', ')}` : ''}`]));
    if (n.stale) legends.push(h('p', { part: 'legend', 'data-st': 'stale' }, [h('span', { part: 'legend-word', text: 'Stale' }), ` · the whole note: ${n.stale}`]));
    const head = h('div', { part: 'panel-header' }, [
      h('div', { part: 'note-head' }, [
        h('h1', { part: 'note-title', text: n.rel }),
        h('p', { part: 'note-meta' }, [
          h('span', { text: `${n.sections.length} sections · ${n.versions} versions` }),
          n.updated ? h('span', { text: ` · last write ${when(n.updated)}` }) : null,
        ]),
        ...legends,
      ]),
    ]);
    const denials = n.denials.map((/** @type {any} */ d) =>
      h('div', { part: 'event', 'data-st': 'denied' }, [
        h('p', { part: 'event-title' }, [stateMark('denied'), h('span', { part: 'legend-word', text: 'Write denied' }), h('span', { part: 'time', text: ` ${when(d.ts)}` })]),
        h('p', { part: 'event-text' }, [
          `Session ${sid8(d.session)} tried to remove ${d.sections.map((/** @type {any} */ x) => `${x.key} (written by ${x.owners.map(sid8).join(', ')})`).join(', ') || 'sections others wrote'}. The guard stopped it. A person can let it through for 10 minutes: `,
        ]),
        cmdButton(`${NAME} allow ${q(n.rel)} --session ${d.session} --reason "…" --root ${q(root.dir)}`),
      ]),
    );
    const rows = n.sections.map((/** @type {any} */ x) => {
      const last = x.last;
      const owner = x.owners.length
        ? x.owners.map((/** @type {string} */ o) => sessionOf(o) || { session: o, agent: last?.session === o ? last.agent : '' })
        : [];
      const dim = ui.session && !x.owners.includes(ui.session) && last?.session !== ui.session;
      let legend = null;
      if (x.st === 'writing') legend = [h('span', { part: 'legend-word', text: 'Writing' }), ` · ${n.writing.filter((/** @type {any} */ w) => w.keys.includes(x.key)).map((/** @type {any} */ w) => sid8(w.session)).join(', ')} is changing this section now`];
      else if (x.st === 'stale') legend = [h('span', { part: 'legend-word', text: 'Stale' }), ` · ${x.stale}`];
      else if (x.st === 'external') legend = [h('span', { part: 'legend-word', text: 'External' }), ` · changed outside the tools at ${when(last.ts)}, no author`];
      else if (x.st === 'denied') legend = [h('span', { part: 'legend-word', text: 'Denied' }), ' · another session tried to remove it; the guard stopped it'];
      else if (x.st === 'adopted') legend = [h('span', { part: 'legend-word', text: 'Adopted' }), ' · older than the root, no owner'];
      return h('div', { part: 'section-wrap', 'data-level': x.level }, [
        h(
          'button',
          { part: 'section', type: 'button', 'data-st': x.st, 'data-level': x.level, 'aria-pressed': String(x.key === ui.section), 'data-dim': dim ? 'true' : null, on: { click: () => pickSection(x.key) } },
          [
            stateMark(x.st),
            h('span', { part: 'section-main' }, [
              h('span', { part: 'section-name' }, [h('span', { part: 'heading-level', text: levelOf(x.key) }), h('span', { part: 'section-title', text: x.title })]),
              legend ? h('span', { part: 'legend', 'data-st': x.st }, legend) : null,
            ]),
            h('span', { part: 'owner', 'data-st': x.st }, [
              h('span', { part: 'owner-id', text: x.st === 'external' ? 'no author' : owner.length ? owner.map((/** @type {any} */ o) => sid8(o.session)).join(' ') : last && last.op !== 'adopt' ? sid8(last.session) : '—' }),
              h('span', { part: 'owner-agent', text: x.st === 'external' ? 'external' : owner.length ? owner.map((/** @type {any} */ o) => o.agent || '').filter(Boolean).join(' ') : last && last.op !== 'adopt' ? last.agent : '' }),
              h('span', { part: 'owner-time', text: last ? when(last.ts) : '' }),
            ]),
          ],
        ),
      ]);
    });
    const selected = n.sections.find((/** @type {any} */ x) => x.key === ui.section);
    const detail = selected
      ? h('div', { part: 'detail' }, [
          label('Section'),
          h('p', { part: 'detail-row' }, [h('span', { part: 'section-title', text: selected.key })]),
          h('p', { part: 'detail-row', text: selected.owners.length ? `Written by ${selected.owners.map(sid8).join(', ')}: only they remove it without a lease.` : 'No owner: any session may change it.' }),
          selected.last
            ? h('p', { part: 'detail-row', text: `Last touched ${when(selected.last.ts)} by ${sid8(selected.last.session)} (${OPS[selected.last.op] || selected.last.op}${selected.last.reason && selected.last.reason !== 'adopt' ? `: “${selected.last.reason}”` : ''}).` })
            : null,
        ])
      : null;
    zone.B.replaceChildren(
      plate,
      h('div', { part: 'note' }, [h('div', { part: 'note-top' }, [device(n), head]), ...denials, h('div', { part: 'list', role: 'list' }, rows), detail]),
    );
  }

  function renderC() {
    const root = R();
    const n = NOTE();
    const a = root.audit;
    /** @param {string} name @param {number|string} value @param {string} [sub] @param {string} [tone] */
    const counter = (name, value, sub, tone) => h('div', { part: 'counter', 'data-tone': tone || null }, [h('span', { part: 'counter-value', text: String(value) }), h('span', { part: 'counter-name', text: name }), sub ? h('span', { part: 'counter-sub', text: sub }) : null]);
    const audit = a
      ? h('section', { part: 'block', 'data-block': 'audit' }, [
          h('header', { part: 'block-head' }, [label('Audit'), h('span', { part: 'counter-sub', text: `whole ledger · ${a.entries} entries` })]),
          h('div', { part: 'counters' }, [
            counter('losses', a.losses, a.losses ? a.lossDetails[0] : 'nothing lost', a.losses ? 'denied' : 'ok'),
            counter('clashes', a.clashes, a.clashes ? `${a.clashesOpen} open` : undefined),
            counter('blocked by the guard', a.denials),
            counter('not recorded yet', a.unrecorded, a.unrecorded ? `${NAME} scan records them` : undefined),
          ]),
        ])
      : null;
    const notices = h('section', { part: 'block', 'data-block': 'notices' }, [
      h('header', { part: 'block-head' }, [label('Changed in the last 24 h'), h('span', { part: 'counter-sub', text: String(root.notices.length) })]),
      root.notices.length
        ? h(
            'div',
            { part: 'list' },
            root.notices.slice(0, 12).map((/** @type {any} */ x) => {
              const what = [x.added.length ? `added ${x.added.join(', ')}` : '', x.removed.length ? `removed ${x.removed.join(', ')}` : '', x.changed.length ? `changed ${x.changed.join(', ')}` : ''].filter(Boolean).join(' · ');
              return h('button', { part: 'notice', type: 'button', 'data-st': x.op === 'external' ? 'external' : x.violations ? 'denied' : 'normal', on: { click: () => pickNote(x.rel) } }, [
                h('span', { part: 'notice-title' }, [h('span', { part: 'path', text: x.rel }), h('span', { part: 'time', text: when(x.ts) })]),
                h('span', { part: 'notice-text', text: `${x.op === 'external' ? 'changed outside the tools, no author' : `${OPS[x.op] || x.op} by ${sid8(x.session)} (${agentOf(x)})`}${what ? `: ${what}` : ''}` }),
              ]);
            }),
          )
        : h('p', { part: 'nodata', text: '—' }),
    ]);
    /** @type {HTMLElement|null} */
    let historyBlock = null;
    /** @type {HTMLElement|null} */
    let controls = null;
    /** @type {HTMLElement|null} */
    let diff = null;
    if (n) {
      const version = n.history.find((/** @type {any} */ v) => v.id === ui.version) || null;
      historyBlock = h('section', { part: 'block', 'data-block': 'history' }, [
        h('header', { part: 'block-head' }, [label('History'), h('span', { part: 'counter-sub', text: n.versions > n.history.length ? `last ${n.history.length} of ${n.versions}` : String(n.versions) })]),
        h(
          'div',
          { part: 'list' },
          n.history.map((/** @type {any} */ v) =>
            h(
              'button',
              { part: 'history-row', type: 'button', 'data-op': v.op, 'data-head': v.head ? 'true' : null, 'aria-pressed': String(v.id === ui.version), title: `${v.id}${v.reason && v.reason !== 'adopt' ? ` — ${v.reason}` : ''}`, on: { click: () => pickVersion(v.id) } },
              [
                h('span', { part: 'h-time', text: when(v.ts) }),
                h('span', { part: 'h-action', 'data-op': v.op, text: OPS[v.op] || v.op }),
                h('span', { part: 'owner-id', text: v.session === 'external' ? 'no author' : v.op === 'adopt' ? '' : sid8(v.session) }),
                h('span', { part: 'owner-agent', text: v.op === 'external' || v.op === 'adopt' ? '' : agentOf(v) }),
                h('span', { part: 'h-hash', text: v.sha || 'deleted' }),
                v.head ? h('span', { part: 'head-dot', title: 'the version the note has now' }) : null,
              ],
            ),
          ),
        ),
      ]);
      const canRestore = Boolean(version && version.restorable);
      const canDiff = Boolean(version && version.diff);
      const restore = h(
        'button',
        {
          part: 'button',
          'data-variant': 'primary',
          type: 'button',
          disabled: !canRestore,
          title: !version ? 'Choose a version in the history' : version.head ? 'This is the version the note has now' : !version.restorable ? 'This version is not kept' : 'Copies the command; run it in a terminal',
          on: { click: () => version && copy(`${NAME} restore ${q(n.rel)} ${version.id} --reason "…" --root ${q(root.dir)}`, restore) },
        },
        [h('span', { part: 'button-label', text: 'Copy restore command' }), version ? h('span', { part: 'button-hash', text: version.sha || '' }) : null],
      );
      const showDiff = h(
        'button',
        { part: 'button', 'data-variant': 'secondary', type: 'button', disabled: !canDiff, 'aria-pressed': String(ui.diff && canDiff), title: canDiff ? '' : 'No earlier version kept for this one', on: { click: () => ((ui.diff = !ui.diff), renderC()) } },
        [h('span', { part: 'button-label', text: ui.diff && canDiff ? 'Hide diff' : 'Show diff' })],
      );
      const denial = n.denials[0];
      /** @type {HTMLElement|null} */
      const allow = denial
        ? h('button', { part: 'button', 'data-variant': 'tertiary', type: 'button', on: { click: () => copy(`${NAME} allow ${q(n.rel)} --session ${denial.session} --reason "…" --root ${q(root.dir)}`, /** @type {HTMLElement} */ (allow)) } }, [h('span', { part: 'button-label', text: 'Copy allow command…' })])
        : null;
      controls = h('div', { part: 'controls' }, [restore, showDiff, allow]);
      if (ui.diff && canDiff && version) {
        diff = h('div', { part: 'diff' }, [
          h('p', { part: 'diff-head', text: `${version.sha} against the version before it${version.truncated ? ' (first 60 lines)' : ''}` }),
          ...version.diff.map((/** @type {any} */ l) => h('div', { part: 'diff-line', 'data-op': l.op === '+' ? 'add' : l.op === '-' ? 'del' : l.op === '…' ? 'skip' : 'same' }, [h('span', { part: 'diff-op', text: l.op === ' ' ? '' : l.op }), h('span', { part: 'diff-text', text: l.text })])),
        ]);
      }
    }
    const hint = h('div', { part: 'hint', hidden: true });
    zone.C.replaceChildren(...[audit, notices, historyBlock, controls, diff, hint].filter((x) => x !== null));
  }

  function renderD() {
    const root = R();
    const searches = root.searches;
    if (!searches.length) {
      zone.D.replaceChildren(
        h('div', { part: 'panel-header' }, [label('Search results')]),
        h('div', { part: 'nodata' }, [h('p', { text: 'No search in this snapshot. Run one with:' }), cmdButton(`${NAME} gui --query "<what you are looking for>"`)]),
      );
      return;
    }
    const tab = Math.min(ui.tab, searches.length - 1);
    const cur = searches[tab];
    const tabs = h(
      'div',
      { part: 'tabs', role: 'tablist' },
      searches.map((/** @type {any} */ x, /** @type {number} */ i) => h('button', { part: 'tab', type: 'button', role: 'tab', 'aria-selected': String(i === tab), on: { click: () => ((ui.tab = i), renderD()) } }, [x.query])),
    );
    const results = cur.error
      ? [h('p', { part: 'nodata', text: `This search failed: ${cur.error}` })]
      : cur.hits.length
        ? cur.hits.map((/** @type {any} */ x) =>
            h('button', { part: 'result', type: 'button', 'data-st': x.stale ? 'stale' : 'normal', on: { click: () => pickNote(x.rel, x.key) } }, [
              h('span', { part: 'result-head' }, [
                h('span', { part: 'result-path' }, [h('span', { part: 'path', text: x.rel }), x.path.length ? h('span', { part: 'sep', text: ' › ' }) : null, x.path.length ? h('span', { text: x.path.join(' › ') }) : null]),
                x.stale ? h('span', { part: 'legend', 'data-st': 'stale' }, [h('span', { part: 'legend-word', text: 'Stale' }), ` · ${x.stale}`]) : null,
                h('span', { part: 'score', text: x.score.toFixed(3) }),
              ]),
              h('span', { part: 'result-text', text: x.text.replace(/^#+ .*\n+/, '').replace(/\s+/g, ' ').slice(0, 220) }),
            ]),
          )
        : [h('p', { part: 'nodata', text: 'Nothing passed the search floors for this query.' })];
    const notes = [cur.degraded ? h('p', { part: 'counter-sub', text: cur.degraded }) : null, ...(cur.warnings || []).map((/** @type {string} */ w) => h('p', { part: 'counter-sub', text: w }))];
    zone.D.replaceChildren(h('div', { part: 'panel-header' }, [label('Search results'), tabs]), ...notes.filter((x) => x !== null), h('div', { part: 'results' }, results));
  }

  function renderF() {
    const root = R();
    const e = root?.error;
    if (!e) return;
    zone.F.replaceChildren(
      h('div', { part: 'fail' }, [
        s('svg', { part: 'chain', viewBox: '0 0 160 24', width: 160, height: 24, 'aria-hidden': 'true' }, [
          s('path', { part: 'chain-links', d: 'M4 12 h18 m6 0 h18 m6 0 h14' }),
          s('path', { part: 'fracture', d: 'M78 4 l-6 16 M86 4 l-6 16' }),
          s('path', { part: 'chain-links', 'data-tone': 'dim', d: 'M92 12 h18 m6 0 h18 m6 0 h16' }),
        ]),
        h('p', { part: 'fail-text', text: e.message }),
        h('p', { part: 'fail-cmd' }, ['Run: ', cmdButton(e.command)]),
      ]),
    );
  }

  // ── selection: every entry point ends here (gui-mapa.md §②) ──────────────
  /** @param {string} rel @param {string|null} [key] */
  function pickNote(rel, key = null) {
    ui.note = rel;
    ui.section = key;
    ui.version = null;
    ui.diff = false;
    saveHash();
    renderN();
    renderB();
    renderC();
    const target = key ? document.querySelector('[data-part=section][aria-pressed=true]') : null;
    if (target) target.scrollIntoView({ block: 'nearest' });
  }
  /** @param {string} key */
  function pickSection(key) {
    ui.section = ui.section === key ? null : key;
    saveHash();
    renderB();
  }
  /** @param {string} id */
  function pickVersion(id) {
    ui.version = ui.version === id ? null : id;
    renderC();
    renderB();
  }
  /** @param {string} id */
  function pickSession(id) {
    ui.session = ui.session === id ? null : id;
    renderA();
    renderN();
    renderB();
  }
  /** @param {number} i */
  function pickRoot(i) {
    ui.root = i;
    ui.note = R().initial;
    ui.section = null;
    ui.version = null;
    ui.session = null;
    ui.tab = 0;
    saveHash();
    draw();
  }

  function draw() {
    const root = R();
    if (!root) {
      body.dataset.state = 'empty';
      zone.B.replaceChildren();
      renderB();
      return;
    }
    if (!ui.note || !root.notes.some((/** @type {any} */ n) => n.rel === ui.note)) ui.note = root.initial;
    body.dataset.state = root.state;
    renderA();
    renderN();
    renderB();
    renderC();
    renderD();
    renderF();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      /** @type {HTMLInputElement|null} */ (document.querySelector('[data-zone=A] input[type=search]'))?.focus();
    }
  });

  body.dataset.device = body.dataset.device || 'armillary';
  // Let the loading state paint first on a large snapshot.
  requestAnimationFrame(() => setTimeout(draw, 0));
  if (DATA.watch) setTimeout(() => location.reload(), 5000);
})();
