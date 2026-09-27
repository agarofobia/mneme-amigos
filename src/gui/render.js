// The GUI page (contracts §4.17): one self-contained HTML file. Base structure + the pack's
// tokens and CSS + the snapshot as JSON + the renderer, under a CSP that allows only that
// renderer (by its hash) and nothing from the network.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { NAME } from '../name.js';

/** @typedef {import('./data.js').GuiData} GuiData */
/** @typedef {import('./packs.js').Pack} Pack */

const BASE_CSS = fs.readFileSync(new URL('./base.css', import.meta.url), 'utf8');
const APP = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

/** @param {string} text */
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * JSON that can sit inside a <script> element: every `<` (and the two line separators
 * JavaScript once treated as newlines) is escaped, so no note can close the element.
 * @param {unknown} value
 */
export function scriptSafeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * @param {GuiData} data
 * @param {Pack} pack
 * @param {{ allowRemote?: boolean }} [options]
 * @returns {string}
 */
export function renderGui(data, pack, options = {}) {
  const remote = options.allowRemote ? ' https:' : '';
  const hash = createHash('sha256').update(APP, 'utf8').digest('base64');
  const csp = [
    "default-src 'none'",
    `style-src 'unsafe-inline'${remote}`,
    `font-src data:${remote}`,
    `img-src data:${remote}`,
    `script-src 'sha256-${hash}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const tokens = Object.entries(pack.tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  const first = data.roots[0];
  const notes = data.roots.reduce((n, r) => n + r.notes.length, 0);
  const sections = data.roots.reduce((n, r) => n + r.notes.reduce((m, x) => m + x.sections.length, 0), 0);
  const title = `${NAME[0].toUpperCase()}${NAME.slice(1)}${first ? ` · ${first.label}` : ''}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${NAME} gui · pack ${escapeHtml(pack.chain.join(' → '))} ${escapeHtml(pack.version)}">
<title>${escapeHtml(title)}</title>
<style data-origin="base">
${BASE_CSS}</style>
<style data-origin="pack" data-pack="${escapeHtml(pack.name)}">
:root {
${tokens}
}
${pack.css}
</style>
</head>
<body data-part="window" data-state="loading" data-device="${escapeHtml(pack.device)}" data-pack="${escapeHtml(pack.name)}">
<div data-part="loading" role="status">
  <div data-part="progress">
    <svg data-part="alidade" viewBox="0 0 120 64" width="120" height="64" aria-hidden="true"><path data-part="scale-arc" d="M8 60 A52 52 0 0 1 112 60"/><path data-part="scale-done" d="M8 60 A52 52 0 0 1 112 60"/></svg>
    <p data-part="progress-readout">Reading ${notes} notes · ${sections} sections</p>
    <noscript><p data-part="progress-meta">This page needs JavaScript to draw the snapshot; the data is inside it, and nothing is loaded from the network.</p></noscript>
  </div>
</div>
<header data-zone="A" data-part="titlebar"></header>
<nav data-zone="N" data-part="panel" aria-label="Notes"></nav>
<main data-zone="B" data-part="panel"></main>
<aside data-zone="C" data-part="panel" aria-label="Notices, history and audit"></aside>
<section data-zone="D" data-part="panel" aria-label="Search results"></section>
<div data-zone="F" role="alert"><div data-part="fail"><p data-part="fail-text"></p></div></div>
<script type="application/json" id="mneme-data">${scriptSafeJson(data)}</script>
<script>${APP}</script>
</body>
</html>
`;
}
