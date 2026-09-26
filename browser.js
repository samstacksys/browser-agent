#!/usr/bin/env node
'use strict';

/**
 * browser.js — give a CLI coding agent a real browser, with no MCP server.
 *
 * THE PROBLEM IT SOLVES. Most terminal agents can read files, run commands and
 * fetch URLs, but they cannot SEE a page. So when a frontend change breaks
 * something the agent should have noticed — a blank screen, a 404 image, a
 * console error, a button that navigates to localhost instead of the domain —
 * nothing in the agent's toolkit reports it. The usual answers are an MCP
 * browser server (heavy, needs a compatible client, often a paid account) or
 * attaching a human's screen. This file is a third option: no install, no
 * account, no MCP. It drives a Chrome that is already on the machine over the
 * DevTools Protocol and prints plain text, which is the format agents read best.
 *
 * HOW IT WORKS. Two processes.
 *   - A DAEMON owns the browser and keeps it alive between commands, so the
 *     session survives: open, click, type, screenshot, read — as separate
 *     command invocations, which is how an agent actually works.
 *   - The CLI is a thin client. It finds the daemon (a port file in the system
 *     temp dir), posts one JSON command, prints the result, exits.
 * The browser talks CDP over a WebSocket. Node 22 has both `WebSocket` and
 * `fetch` built in, so this file has ZERO npm dependencies.
 *
 * THE ONE REQUIREMENT. A Chrome/Chromium/Edge binary. Almost every machine that
 * runs a coding agent already has one. It is found automatically; override with
 * --browser=<path> or $BROWSER_PATH. A Playwright or Puppeteer download counts,
 * and is looked up too. If none is found, the error says exactly where it looked.
 *
 * Read README.md for the command list, and AGENT-SNIPPET.md for the paragraph to
 * paste into your own agent's instructions.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const VERSION = '1.0.0';
const NAV_TIMEOUT = 15000;
const IDLE_MS = 15 * 60 * 1000;

/* ────────────────────────────── argument parsing ───────────────────────────── */

/**
 * Only these consume the NEXT word as their value. Everything else is boolean,
 * and may still take a value with the `--flag=value` form.
 *
 * The split matters more than it looks: when --json was in this list, it ate the
 * command word, so `browser.js --json title` printed the help text and exit 0.
 * A tool that silently answers the wrong question is worse than no tool, and an
 * agent piping this into a script would never notice.
 */
const VALUE_FLAGS = new Set(['--session', '--timeout', '--browser', '--port', '--out']);

/**
 * Splits argv into flags and a command. Deliberately dumb: this is a tool for
 * agents, and predictable parsing beats clever parsing every time.
 */
function parseArgv(argv) {
  const flags = {};
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (!word.startsWith('--')) { words.push(word); continue; }
    const eq = word.indexOf('=');
    if (eq !== -1) {
      flags[word.slice(2, eq)] = word.slice(eq + 1);
    } else if (VALUE_FLAGS.has(word)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${word} needs a value, e.g. ${word}=something`);
      flags[word.slice(2)] = value;
    } else {
      flags[word.replace(/^--/, '')] = true;
    }
  }
  return { flags, words };
}

/* ───────────────────────────── finding a browser ───────────────────────────── */

const BROWSER_NAMES = [
  'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser',
  'chrome', 'chrome.exe', 'microsoft-edge', 'microsoft-edge-stable',
  'msedge', 'msedge.exe', 'brave-browser', 'brave.exe'
];

const BROWSER_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
];

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

function exists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Glob-ish scan of a cache directory, one level deep. */
function scanCache(root, depth, match) {
  const found = [];
  const walk = (dir, level) => {
    if (level > depth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, level + 1);
      else if (match(entry.name, full) && isExecutable(full)) found.push(full);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * Returns the path of a usable browser, or null. The search order is the
 * explicit env var, then PATH, then the usual install locations, then the
 * browser downloads Playwright and Puppeteer already keep on disk — the last
 * one matters because a machine set up for frontend work often has one of those
 * cached but no system Chrome.
 */
function findBrowser(forced) {
  const env = forced || process.env.BROWSER_PATH || process.env.CHROME_PATH;
  if (env) {
    if (!isExecutable(env)) throw new Error(`--browser is not executable: ${env}`);
    return env;
  }

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of BROWSER_NAMES) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }

  for (const candidate of BROWSER_PATHS) if (isExecutable(candidate)) return candidate;

  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const chromiumish = (name, full) =>
    /^(chrome|chromium|headless_shell|msedge|brave)(\.exe)?$/i.test(name) ||
    /^chrome(-linux.*|-mac.*|-win.*)?$/i.test(name);

  // Playwright downloads to ~/.cache on macOS and Linux but to %LOCALAPPDATA% on
  // Windows, and a frontend machine often has that cache instead of a system
  // Chrome. Missing that path is how the tool ends up saying "no browser" on a
  // machine that has one.
  for (const root of [
    path.join(home, '.cache', 'ms-playwright'),
    path.join(home, '.cache', 'puppeteer'),
    path.join(localAppData, 'ms-playwright')
  ]) {
    const hits = scanCache(root, 2, chromiumish);
    // Prefer the full browser over the stripped headless shell.
    hits.sort((a, b) => Number(/headless_shell/.test(b)) - Number(/headless_shell/.test(a)));
    if (hits.length) return hits[0];
  }

  return null;
}

/** Major version, used to pick the headless flag. Chrome 112+ understands =new. */
function browserMajor(binary) {
  try {
    const raw = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
    const m = raw.match(/(\d+)\./);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/* ──────────────────────────── page-side helper code ─────────────────────────── */

/**
 * Installed into every document with Page.addScriptToEvaluateOnNewDocument, so it
 * exists before the page's own scripts run and survives every navigation. It is
 * the "what can I see" layer: text, links, buttons, fields, click, fill.
 *
 * Everything is defensive on purpose. This code runs inside somebody else's page
 * and must never be the reason that page breaks, so no method throws: they return
 * a value describing what went wrong instead.
 */
const PAGE_HELPERS = `
(() => {
  if (window.__ba) return;
  const ok = (v) => ({ ok: true, value: v });
  const err = (e) => ({ ok: false, error: String((e && e.message) || e) });
  const one = (sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('no element matches ' + sel);
    return el;
  };
  const label = (el) => (
    el.getAttribute('aria-label') || el.innerText || el.value ||
    el.getAttribute('placeholder') || el.getAttribute('title') || el.tagName.toLowerCase()
  ).replace(/\\s+/g, ' ').trim().slice(0, 90);

  window.__ba = {
    info: () => ok({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
    }),

    text: (sel) => {
      try {
        const el = sel ? one(sel) : document.body;
        if (!el) return err('the document has no body yet');
        return ok((el.innerText || el.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim());
      } catch (e) { return err(e); }
    },

    html: (sel) => {
      try {
        const el = sel ? one(sel) : document.documentElement;
        if (!el) return err('no element to serialise');
        return ok(el.outerHTML);
      } catch (e) { return err(e); }
    },

    count: (sel) => {
      try { return ok(document.querySelectorAll(sel).length); } catch (e) { return err(e); }
    },

    links: (limit) => {
      const out = [...document.querySelectorAll('a[href]')].map((a) => ({
        text: label(a),
        href: a.href,
        target: a.getAttribute('target') || '',
      })).filter((l) => l.href && !l.href.startsWith('javascript:'));
      return ok(out.slice(0, limit || 100));
    },

    buttons: (limit) => {
      const out = [...document.querySelectorAll(
        'button, [role=button], input[type=submit], input[type=button], a.btn, a.button'
      )].map((b) => ({
        text: label(b),
        tag: b.tagName.toLowerCase(),
        disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true',
        type: b.getAttribute('type') || '',
      }));
      return ok(out.slice(0, limit || 60));
    },

    fields: (limit) => {
      const out = [...document.querySelectorAll('input, textarea, select')].map((f) => ({
        tag: f.tagName.toLowerCase(),
        type: f.getAttribute('type') || '',
        name: f.getAttribute('name') || '',
        id: f.id || '',
        placeholder: f.getAttribute('placeholder') || '',
        // Never echo a password back to the agent or into a log file.
        value: f.type === 'password' ? '(set)' : (f.value || ''),
        required: !!f.required,
      }));
      return ok(out.slice(0, limit || 60));
    },

    click: (sel) => {
      try {
        const el = one(sel);
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        // The DOM click event, not synthesised mouse events. It triggers the
        // default action (including navigation) and is what frameworks listen
        // for. Apps that need real pointer input — drag, hover, canvas — are
        // out of scope; README says so.
        el.click();
        return ok({ clicked: label(el), url: location.href });
      } catch (e) { return err(e); }
    },

    fill: (sel, value) => {
      try {
        const el = one(sel);
        el.focus();
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        // The native setter, so frameworks that wrap value still see the change.
        if (desc && desc.set) desc.set.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return ok({ filled: label(el), value: el.type === 'password' ? '(set)' : el.value });
      } catch (e) { return err(e); }
    },

    select: (sel, value) => {
      try {
        const el = one(sel);
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return ok({ selected: el.value });
      } catch (e) { return err(e); }
    },

    scroll: (where) => {
      if (where === 'bottom') window.scrollTo(0, document.body.scrollHeight);
      else if (where === 'top') window.scrollTo(0, 0);
      else if (where === 'down') window.scrollBy(0, window.innerHeight * 0.9);
      else if (where === 'up') window.scrollBy(0, -window.innerHeight * 0.9);
      else window.scrollBy(0, Number(where) || 400);
      return ok({ y: window.scrollY, height: document.body.scrollHeight });
    },

    /** One call that tells an agent where it is and what it can do next. */
    state: (textLimit) => {
      const body = document.body;
      const visible = (body ? (body.innerText || '') : '').replace(/\\n{3,}/g, '\\n\\n').trim();
      return ok({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        text: visible.slice(0, textLimit || 1500),
        textLength: visible.length,
        links: [...document.querySelectorAll('a[href]')].slice(0, 30).map((a) => ({
          text: label(a), href: a.href, target: a.getAttribute('target') || '',
        })),
        buttons: [...document.querySelectorAll('button, [role=button], input[type=submit]')]
          .slice(0, 20).map((b) => ({ text: label(b), disabled: !!b.disabled })),
        fields: [...document.querySelectorAll('input, textarea, select')].slice(0, 20)
          .map((f) => ({ tag: f.tagName.toLowerCase(), type: f.getAttribute('type') || '',
                          id: f.id || '', name: f.getAttribute('name') || '',
                          placeholder: f.getAttribute('placeholder') || '' })),
      });
    },
  };
})();
`;

/* ──────────────────────────── the doctor (one page audit) ──────────────────── */

/**
 * Everything the page can prove about itself, in one evaluation.
 *
 * Runs in the page, returns plain data. Anything that needs the protocol — the
 * real answer to "does this button have a click handler", whether a link is
 * alive — is left to the Node side as `candidates`, because a page cannot see
 * its own event listeners.
 *
 * Written as one string on purpose: a separate file would need installing, and
 * this tool's whole promise is that there is nothing to install.
 */
const DOCTOR_PROBE = `
(() => {
  const findings = [];
  const candidates = [];

  // Some checks are only interesting a handful of times. Past the cap they
  // collapse into one line, because a report of 300 identical warnings is a
  // report nobody reads.
  const CAPS = {
    'text-clipped': 6, 'image-no-alt': 8, 'field-no-name': 8, 'field-no-label': 8,
    'field-without-name': 8, 'control-not-visible': 8, 'empty-container': 5,
    'control-no-name': 8, 'placeholder-is-the-label': 8, 'dead-link': 10,
  };
  const seen = {};

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = node.tagName.toLowerCase();
      const cls = (node.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean)[0];
      if (cls && cls.length < 32) part += '.' + CSS.escape(cls);
      const parent = node.parentElement;
      if (parent) {
        const twins = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (twins.length > 1) part += ':nth-of-type(' + (twins.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const snippet = (el, max) => {
    const html = (el && el.outerHTML) || '';
    return html.length > max ? html.slice(0, max) + ' [...]' : html;
  };

  const name = (el) => (el.getAttribute('aria-label') || el.innerText || el.value ||
    el.getAttribute('title') || el.getAttribute('placeholder') || '')
    .replace(/\\s+/g, ' ').trim().slice(0, 60);

  const rendered = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  const chain = (el) => {
    const out = [];
    let node = el;
    while (node && node.nodeType === 1 && out.length < 12) {
      out.push(cssPath(node));
      node = node.parentElement;
    }
    return out.filter(Boolean);
  };

  const add = (kind, severity, selector, title, detail, fix, html, subject) => {
    if (CAPS[kind] !== undefined && seen[kind] !== undefined) {
      seen[kind] += 1;
      if (seen[kind] > CAPS[kind]) return;
    }
    seen[kind] = (seen[kind] || 0) + 1;
    if (CAPS[kind] !== undefined && seen[kind] === CAPS[kind] + 1) return;
    findings.push({
      kind, severity, selector: selector || '', title,
      where: (subject ? subject + '  ·  ' : '') + (selector || ''),
      detail, fix, html: (html || '').slice(0, 300),
    });
  };

  /* ── controls that might do nothing ──
     Not a verdict: a button with no inline handler may still be wired through
     delegation. These go out as candidates and the Node side asks the browser
     for the real listener list. */
  const CONTROL = 'button, [role=button], input[type=submit], input[type=button], input[type=reset]';
  Array.prototype.slice.call(document.querySelectorAll(CONTROL)).slice(0, 150).forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const text = name(el);
    const sel = cssPath(el);
    const subject = text ? '"' + text + '"' : tag;

    if (!text) {
      add('control-no-name', 'mid', sel, 'A button has no readable name',
        'No text, no aria-label, no title. A person using a screen reader, and any agent reading this page, cannot tell what it does.',
        'Put text inside it, or an aria-label that says what it does.', snippet(el), subject);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    if (!rendered(el)) {
      add('control-not-visible', 'low', sel, 'A button is in the code but not on screen',
        'It has no size or is hidden, so nobody can click it. Either it is dead markup or the CSS that should show it is broken.',
        'Delete it, or fix the CSS that hides it.', snippet(el), subject);
      return;
    }
    // Anchors with a real href, and anything that submits a form, have work to do.
    if (el.tagName === 'A' && el.getAttribute('href')) return;
    if (el.hasAttribute('formaction')) return;
    if (el.tagName === 'INPUT' && el.form) return;
    if (tag === 'button') {
      const type = (el.getAttribute('type') || (el.closest('form') ? 'submit' : '')).toLowerCase();
      if (type === 'submit' || type === 'reset') return;
    }
    if (typeof el.onclick === 'function') return;
    const inline = (el.getAttribute('onclick') || '').trim();
    if (inline && !/^return\\s+false\\s*;?$/i.test(inline)) return;
    candidates.push({ selector: sel, chain: chain(el), text: text || tag, html: snippet(el) });
  });

  /* ── links that go nowhere ── */
  Array.prototype.slice.call(document.querySelectorAll('a[href]')).forEach((a) => {
    const raw = (a.getAttribute('href') || '').trim();
    if (raw === '' || raw === '#' || /^javascript:/i.test(raw)) {
      add('dead-link', 'high', cssPath(a), 'A link goes nowhere',
        'href=' + JSON.stringify(raw) + '. Clicking it cannot lead anywhere — this is usually a button that was written as a link.',
        'Point href at the real page, or make it a <button> and handle the click.', snippet(a), name(a) || '(no text)');
    }
  });

  /* ── images ── */
  Array.prototype.slice.call(document.querySelectorAll('img')).forEach((img) => {
    if (img.complete && img.naturalWidth === 0) {
      add('image-broken', 'high', cssPath(img), 'An image did not load',
        'The browser asked for ' + (img.currentSrc || img.src || '(no src)') + ' and got nothing usable. Wrong path, or the file is not there.',
        'Check the path against the file on disk.', snippet(img), img.getAttribute('alt') || img.getAttribute('src') || '(no src)');
    }
    if (!img.hasAttribute('alt')) {
      add('image-no-alt', 'low', cssPath(img), 'An image has no alt text',
        'A screen reader will read the file name out loud instead of describing the image.',
        'Add alt="" if it is decorative, or a short description if it carries meaning.', snippet(img), img.getAttribute('src') || '');
    }
  });

  /* ── duplicate ids ── */
  const idCount = {};
  Array.prototype.slice.call(document.querySelectorAll('[id]')).forEach((el) => {
    const id = el.id;
    if (!id || /^(radix|headlessui|react-|ember|mui-|css-[a-z0-9]{4,})/i.test(id)) return;
    idCount[id] = (idCount[id] || 0) + 1;
    if (idCount[id] === 2) {
      add('duplicate-id', 'mid', cssPath(el), 'Two elements share the id "' + id + '"',
        'getElementById("' + id + '") can only ever return the first one, so any script or <label for="' + id + '"> that means the second one reaches the wrong element.',
        'Make every id unique. Use a class for styling instead.', snippet(el), id);
    }
  });

  /* ── fields and their labels ── */
  Array.prototype.slice.call(document.querySelectorAll('label[for]')).forEach((l) => {
    const target = l.getAttribute('for');
    if (target && !document.getElementById(target)) {
      add('label-points-nowhere', 'mid', cssPath(l), 'A label points at a field that does not exist',
        '<label for="' + target + '"> and no element has that id, so clicking the label does nothing and screen readers announce nothing.',
        'Give the field that id, or drop the for attribute.', snippet(l), target);
    }
  });

  Array.prototype.slice.call(document.querySelectorAll('input, select, textarea')).forEach((f) => {
    if (['hidden', 'submit', 'button', 'reset', 'image'].indexOf(f.type) >= 0) return;
    const sel = cssPath(f);
    const subject = name(f) || f.getAttribute('name') || f.getAttribute('placeholder') || f.type;
    const labelled = f.closest('label') ||
      (f.id && document.querySelector('label[for="' + CSS.escape(f.id) + '"]')) ||
      f.getAttribute('aria-label') || f.getAttribute('aria-labelledby');
    if (!labelled) {
      const ph = (f.getAttribute('placeholder') || '').trim();
      if (ph) {
        add('placeholder-is-the-label', 'mid', sel, 'A field is labelled only by its placeholder',
          '"' + ph + '" vanishes the moment somebody types, it is not announced by screen readers, and it is easy to mistake for a value.',
          'Add a real <label> above the field.', snippet(f), subject);
      } else {
        add('field-no-label', 'mid', sel, 'A field has no label',
          'Nothing says what belongs in it. That is a guess for the user and an unreadable field for a screen reader.',
          'Add a <label for="..."> next to it.', snippet(f), subject);
      }
    }
    if (!f.name) {
      add('field-no-name', 'mid', sel, 'A field has no name attribute',
        'A form only sends the fields that have a name, so whatever is typed here is dropped silently on submit.',
        'Add name="..." to it.', snippet(f), subject);
    }
  });

  /* ── text that does not fit its box ── */
  Array.prototype.slice.call(document.querySelectorAll(
    'h1, h2, h3, h4, p, span, td, th, li, a, button, label, div, summary')).forEach((el) => {
    if (!rendered(el)) return;
    const s = getComputedStyle(el);
    if (s.overflowX !== 'hidden' && s.overflowX !== 'clip') return;
    if (s.textOverflow === 'ellipsis') return;
    if (s.webkitLineClamp && s.webkitLineClamp !== 'none') return;
    if (el.scrollWidth <= el.clientWidth + 4) return;
    const lost = Math.round((1 - el.clientWidth / el.scrollWidth) * 100);
    add('text-clipped', 'mid', cssPath(el), 'Text is cut off with no sign it is there',
      'The content is ' + (el.scrollWidth - el.clientWidth) + 'px wider than its box and the overflow is hidden, so about ' +
      lost + '% of it is invisible. Nobody can tell there is more.',
      'Let it wrap, or set text-overflow: ellipsis so the cut is visible.', snippet(el), (el.textContent || '').trim().slice(0, 60));
  });

  /* ── boxes that hold nothing ──
     Only boxes big enough that a person would notice them empty. A 16px spacer
     div is deliberate and fires on every page ever built; a 220x90 hole in the
     middle of a card is a template that never got filled in. */
  Array.prototype.slice.call(document.querySelectorAll('div, section, article, aside')).forEach((el) => {
    if (!rendered(el)) return;
    if (el.children.length || el.textContent.trim()) return;
    const box = el.getBoundingClientRect();
    if (box.height < 24 || (box.width < 120 && box.height < 60)) return;
    const s = getComputedStyle(el);
    // borderTopWidth is 3px on every element by default even with no border, so
    // the style has to be checked too — otherwise nothing is ever reported.
    const painted = s.backgroundImage !== 'none' ||
      (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') ||
      (s.borderTopStyle !== 'none' && parseFloat(s.borderTopWidth) > 0);
    if (painted) return;
    add('empty-container', 'low', cssPath(el), 'A box on the page with nothing in it',
      'It is ' + Math.round(box.width) + 'x' + Math.round(box.height) + 'px of nothing, with no border or background to explain it. Usually a template or a card that never got filled in.',
      'Fill it in, or take it out of the markup.', snippet(el), '');
  });

  /* ── forms ── */
  Array.prototype.slice.call(document.querySelectorAll('form')).forEach((f) => {
    const sel = cssPath(f);
    if (!f.getAttribute('action') && !f.getAttribute('onsubmit')) {
      add('form-no-action', 'mid', sel, 'A form has no action',
        'Submitting it reloads the page and throws away everything that was typed, unless JavaScript catches it first.',
        'Give it an action, or prevent the default in a submit handler.', snippet(f), '');
    }
    const action = f.getAttribute('action') || '';
    if (location.protocol === 'https:' && /^http:/i.test(action)) {
      add('insecure-form', 'high', sel, 'A form on an https page posts over http',
        'Whatever is typed into this form would be sent unencrypted, and the browser will warn before it does.',
        'Change the action to https.', snippet(f), action);
    }
  });

  if (!document.documentElement.getAttribute('lang')) {
    add('no-lang', 'low', 'html', 'The page does not say what language it is',
      'Screen readers have to guess, and they usually guess badly for anything but plain English.',
      'Add lang="..." to the <html> tag.', snippet(document.documentElement, 200), '');
  }

  /* ── the links worth asking the server about ── */
  const links = [];
  const seenHref = {};
  Array.prototype.slice.call(document.querySelectorAll('a[href]')).forEach((a) => {
    let url;
    try { url = new URL(a.href, location.href); } catch (e) { return; }
    if (url.origin !== location.origin) return;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (seenHref[url.href]) return;
    seenHref[url.href] = 1;
    links.push({ href: url.href, text: name(a) || '(no text)' });
  });

  return { findings, candidates, links: links.slice(0, 60) };
})()
`;

/* ───────────────────────────── the CDP connection ───────────────────────────── */

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
    socket.addEventListener('message', (event) => this.#onMessage(event.data));
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('the browser closed the connection'));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onFail = (e) => { cleanup(); reject(new Error(`cannot open the browser socket: ${e.message || e.type}`)); };
      const cleanup = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onFail);
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onFail);
    });
    return new Cdp(socket);
  }

  #onMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }

    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || 'CDP error'));
      else entry.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) {
      if (listener.method === message.method) listener.handler(message.params, message.sessionId);
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`the browser did not answer ${method} in time`));
      }, NAV_TIMEOUT + 10000);
    });
  }

  on(method, handler) {
    const entry = { method, handler };
    this.listeners.push(entry);
    return () => {
      const i = this.listeners.indexOf(entry);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }
}

/* ──────────────────────────────── the session ──────────────────────────────── */

/** Everything the daemon knows about one browser session. */
class Session {
  constructor(browser, cdp, userDataDir) {
    this.browser = browser;
    this.cdp = cdp;
    this.userDataDir = userDataDir;
    this.tabs = [];
    this.current = null;
    this.viewport = null;
    this.logs = [];
    this.requests = new Map();
    // Bumped on every navigation. The log is session-wide on purpose, so the
    // doctor needs a way to tell "this page complained" from "some page we
    // visited two minutes ago complained" — otherwise a clean page inherits
    // the faults of the broken one you came from.
    this.epoch = 0;
  }

  /**
   * Resizes the page. Chrome's headless default is 780x437, which is nobody's
   * idea of a screen: a layout that has collapsed shows up at one width and
   * hides at another, so the size is a flag rather than a fixed constant.
   * --mobile is the common case: 390x844, the width of a phone.
   */
  async setViewport({ width, height, mobile }) {
    this.viewport = { width, height, mobile: !!mobile };
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile,
    }, this.current.sessionId);
    return this.viewport;
  }

  static async launch(opts) {
    const binary = findBrowser(opts.browser);
    if (!binary) {
      throw new Error(
        'no Chrome/Chromium/Edge found.\n' +
        'Looked in $PATH, the usual install folders, and the Playwright/Puppeteer caches.\n' +
        'Install one, or point at it:  --browser=/path/to/chrome  or  BROWSER_PATH=/path/to/chrome'
      );
    }

    const major = browserMajor(binary);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-profile-'));
    const args = [
      major >= 112 ? '--headless=new' : '--headless',
      '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--hide-scrollbars', '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank'
    ];
    // windowsHide stops a console window flashing for every headless browser.
    const browser = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    browser.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    browser.on('exit', (code) => {
      if (code) console.error(`[browser-agent] the browser exited with ${code}\n${stderr.slice(-800)}`);
    });

    // Chrome writes the port it actually bound to here. Port 0 means "pick one",
    // which is how nothing else on the machine can collide with us.
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + 30000;
    let port = null;
    while (Date.now() < deadline) {
      if (browser.exitCode !== null) throw new Error(`the browser refused to start:\n${stderr.slice(-800)}`);
      try {
        const raw = fs.readFileSync(portFile, 'utf8');
        const first = Number(raw.split('\n')[0]);
        if (first > 0) { port = first; break; }
      } catch { /* not written yet */ }
      await sleep(100);
    }
    if (!port) throw new Error('the browser started but never reported a debugging port');

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const session = new Session(browser, cdp, userDataDir);
    session.binary = binary;
    session.version = version.Browser;
    session.port = port;

    cdp.on('Runtime.consoleAPICalled', (params, sid) => {
      if (sid !== session.current?.sessionId) return;
      const text = (params.args || [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ')
        .slice(0, 600);
      session.logs.push({ kind: `console.${params.type}`, text, url: session.current.url, epoch: session.epoch });
    });
    cdp.on('Runtime.exceptionThrown', (params, sid) => {
      if (sid !== session.current?.sessionId) return;
      const d = params.exceptionDetails || {};
      session.logs.push({
        kind: 'exception',
        text: (d.exception && (d.exception.description || d.exception.value)) || d.text || 'uncaught error',
        url: session.current.url,
        epoch: session.epoch,
      });
    });
    cdp.on('Network.requestWillBeSent', (params, sid) => {
      if (sid !== session.current?.sessionId) return;
      session.requests.set(params.requestId, params.request.url);
    });
    cdp.on('Network.responseReceived', (params, sid) => {
      if (sid !== session.current?.sessionId) return;
      const status = params.response.status;
      if (status >= 400) {
        session.logs.push({
          kind: 'http',
          text: `${status} ${params.response.statusText || ''} ${params.response.url}`.trim(),
          url: session.current.url,
          epoch: session.epoch,
        });
      }
    });
    cdp.on('Network.loadingFailed', (params, sid) => {
      if (sid !== session.current?.sessionId) return;
      const from = session.requests.get(params.requestId) || '(unknown url)';
      session.logs.push({ kind: 'request', text: `failed: ${from} (${params.errorText})`, url: session.current.url, epoch: session.epoch });
    });

    await session.addTab('about:blank');
    return session;
  }

  async addTab(url) {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = { targetId, sessionId, url: 'about:blank' };
    this.tabs.push(tab);
    this.current = tab;
    await this.cdp.send('Page.enable', {}, sessionId);
    await this.cdp.send('Runtime.enable', {}, sessionId);
    await this.cdp.send('Network.enable', {}, sessionId);
    // Runs before the page's own scripts on every document from now on.
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPERS }, sessionId);
    // ...but the tab was already blank when that was registered, so the helper
    // never executed there. Install it inline for the document we have now.
    await this.cdp.send('Runtime.evaluate', { expression: PAGE_HELPERS }, sessionId);
    if (this.viewport) await this.setViewport(this.viewport);
    if (url && url !== 'about:blank') await this.navigate(url);
    return tab;
  }

  async useTab(index) {
    const tab = this.tabs[index];
    if (!tab) throw new Error(`there is no tab ${index}; try: browser.js tabs`);
    this.current = tab;
    return tab;
  }

  /** Evaluate a function from the page helpers, unwrapping their ok/err envelope. */
  async helper(method, ...args) {
    const expression = `window.__ba.${method}(${args.map((a) => JSON.stringify(a)).join(',')})`;
    const result = await this.cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    }, this.current.sessionId);
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || 'the page threw');
    }
    const value = result.result.value;
    if (!value || value.ok !== true) throw new Error((value && value.error) || 'the page helper failed');
    return value.value;
  }

  /** Runs arbitrary JS. Used by `eval`, and by the waiting helpers. */
  async evaluate(expression) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    }, this.current.sessionId);
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || 'the page threw');
    }
    return result.result.value;
  }

  /**
   * The event types actually bound to one element, or null if it cannot be read.
   *
   * A page cannot introspect its own listeners, so this is the only honest way
   * to answer "does this button do anything". The nearest ancestor is the
   * interesting one: React 17+ and every delegated library attach a single
   * listener at the root and dispatch by target, so a button can be perfectly
   * wired up with nothing on it.
   */
  async listenersFor(selector) {
    const handle = await this.cdp.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    }, this.current.sessionId);
    const objectId = handle.result && handle.result.objectId;
    if (!objectId) return null;
    try {
      const res = await this.cdp.send('DOMDebugger.getEventListeners', { objectId }, this.current.sessionId);
      return (res.listeners || []).map((l) => l.type);
    } catch {
      return null;
    } finally {
      await this.cdp.send('Runtime.releaseObject', { objectId }, this.current.sessionId).catch(() => {});
    }
  }

  /**
   * A cheap fingerprint of what the page is showing.
   *
   * Used to tell "the click did nothing" from "the click worked": compare this
   * before and after. A hash of the body, not the body itself, so a big page
   * costs the same as a small one to compare.
   */
  async fingerprint() {
    return this.evaluate(`(() => {
      const html = document.body ? document.body.innerHTML : '';
      let h = 2166136261;
      for (let i = 0; i < html.length; i++) { h ^= html.charCodeAt(i); h = (h * 16777619) >>> 0; }
      return JSON.stringify({ url: location.href, hash: h, len: html.length });
    })()`);
  }

  /** Waits for readyState, which survives redirects better than the load event. */
  async settle(timeout = NAV_TIMEOUT) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState');
        if (state === 'interactive' || state === 'complete') return;
      } catch { /* mid-navigation, the context is being replaced */ }
      await sleep(120);
    }
  }

  /**
   * The url once it has genuinely stopped moving.
   *
   * Apps that redirect from JavaScript (a sign-in POST resolves, then the page
   * replaces itself with /dashboard/) settle well after the document reports
   * itself "complete". Two identical reads were not enough: they both landed in
   * the gap before the redirect fired, so `click` reported the sign-in page for
   * a run that had actually succeeded. Four identical reads means 600ms of real
   * stillness. Reporting the wrong url is worse than reporting none, because an
   * agent will act on it.
   */
  async stableUrl(timeout = 12000) {
    const deadline = Date.now() + timeout;
    const QUIET_READS = 4;
    let previous = null;
    let quiet = 0;
    while (Date.now() < deadline) {
      let current = null;
      try { current = await this.evaluate('location.href'); } catch { /* navigating */ }
      if (current && current === previous) {
        quiet += 1;
        if (quiet >= QUIET_READS) return current;
      } else {
        quiet = 0;
      }
      previous = current;
      await sleep(200);
    }
    return previous;
  }

  async navigate(url) {
    this.epoch += 1;
    // Only guess a scheme when there is none at all. Checking for https? misses
    // file://, about: and data:, which then became "http://file:///..." and died
    // with ERR_NAME_NOT_RESOLVED.
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(url);
    const target = hasScheme ? url : `http://${url}`;
    const result = await this.cdp.send('Page.navigate', { url: target }, this.current.sessionId);
    if (result.errorText) throw new Error(`the browser refused to navigate: ${result.errorText}`);
    this.current.url = target;
    await this.settle();
    this.current.url = await this.evaluate('location.href').catch(() => target);
  }

  async key(name) {
    const special = {
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    };
    const sid = this.current.sessionId;
    if (special[name]) {
      const k = special[name];
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: k.text ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code,
        windowsVirtualKeyCode: k.windowsVirtualKeyCode, text: k.text,
      }, sid);
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode,
      }, sid);
    } else {
      const key = name.length === 1 ? name : name;
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key }, sid);
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, sid);
    }
    await sleep(150);
  }

  async screenshot(file, fullPage) {
    const params = { format: 'png' };
    if (fullPage) params.captureBeyondViewport = true;
    const { data } = await this.cdp.send('Page.captureScreenshot', params, this.current.sessionId);
    const out = file || path.join(process.cwd(), `screenshot-${stamp()}.png`);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    return out;
  }

  async close() {
    try { this.cdp.socket.close(); } catch { /* already gone */ }
    try { this.browser.kill('SIGTERM'); } catch { /* already gone */ }
    await sleep(300);
    try { this.browser.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/* ──────────────────────────────── the daemon ──────────────────────────────── */

async function runDaemon(flags) {
  const portFile = portFilePath(flags.session || 'default');
  let session;
  try {
    session = await Session.launch({ browser: flags.browser });
  } catch (err) {
    console.error(`[browser-agent] ${err.message}`);
    process.exit(1);
  }

  let closing = false;
  let idle = null;
  // Declared before the server because the /shutdown route below calls it.
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    if (idle) clearInterval(idle);
    server.close();
    await session.close();
    try { fs.unlinkSync(portFile); } catch { /* already removed */ }
    // Everything is closed, so the event loop is empty and the process leaves on
    // its own. That is the point: calling process.exit() while libuv is still
    // closing a handle is what aborts Windows with a UV_HANDLE_CLOSING
    // assertion. The safety net is unref'd, so it never holds the loop open —
    // it only fires if something did.
    const backstop = setTimeout(() => { process.exit(0); }, 2000);
    backstop.unref();
  };

  const server = http.createServer((req, res) => {
    // The CLI polls this to find out whether a session is alive. Without it the
    // health check would fall through to the command handler and report the
    // browser as broken.
    if (req.url === '/health') return respond(res, { ok: true, version: VERSION, pid: process.pid });

    // A graceful shutdown over HTTP, rather than a signal.
    //
    // On Windows process.kill(pid, 'SIGTERM') is TerminateProcess: there is no
    // signal to deliver, so the daemon is killed outright and never runs its
    // cleanup. The temp profile is left on disk and the port file goes stale,
    // and the next command starts a second browser. It also trips a libuv
    // assertion (UV_HANDLE_CLOSING) that aborts the process doing the killing.
    // Asking the daemon to close itself works the same on every platform.
    if (req.url === '/shutdown') {
      respond(res, { ok: true, stopping: true });
      setImmediate(() => { shutdown(); });
      return;
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
      catch { return respond(res, { ok: false, error: 'bad JSON in the request' }); }
      try {
        const result = await dispatch(session, payload);
        // A command may want a non-zero exit without being a failure: `doctor
        // --strict` found something, which is an answer, not an error.
        const shaped = typeof result === 'string' ? { text: result } : result;
        server.lastActivity = Date.now();
        respond(res, { ok: true, text: shaped.text, code: shaped.code || 0, data: payload.data ?? null });
      } catch (err) {
        respond(res, { ok: false, error: err.message });
      }
    });
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // An orphaned headless browser eats memory forever. If nobody asks for
  // anything for IDLE_MS, close the shop.
  idle = setInterval(async () => {
    if (Date.now() - server.lastActivity > IDLE_MS) { clearInterval(idle); await shutdown(); }
  }, 60000);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.lastActivity = Date.now();
  fs.writeFileSync(portFile, JSON.stringify({
    port: server.address().port,
    pid: process.pid,
    browser: session.binary,
    version: session.version,
    startedAt: new Date().toISOString(),
  }));
  console.error(`[browser-agent] ready on port ${server.address().port} (${session.version})`);
}

function respond(res, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}

/* ─────────────────────────── command implementations ───────────────────────── */

const line = (k, v) => `${k}: ${v}`;

/** Pretty-prints a value as text an agent can read without a JSON parser. */
function render(label_, value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (typeof item === 'string') return `- ${item}`;
      const parts = Object.entries(item)
        .filter(([, v]) => v !== '' && v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
      return `- ${parts.join('  ')}`;
    }).join('\n');
  }
  return Object.entries(value)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((i) => `  - ${JSON.stringify(i)}`).join('\n')}`;
      if (v && typeof v === 'object') return `${k}:\n${JSON.stringify(v, null, 2)}`;
      return `${k}: ${v}`;
    })
    .join('\n');
}

/* ──────────────────────────────── the doctor ───────────────────────────────── */

/**
 * Words that make a click expensive. The click probe is opt-in because it
 * presses real buttons; anything that sounds like it could delete something,
 * spend money or sign you out is reported as untested rather than pressed.
 */
const DESTRUCTIVE = /delete|remove|erase|drop|trash|logout|log\s?out|sign\s?out|deactivate|unsubscribe|pay|checkout|purchase|buy|submit|send|confirm|publish|archive|reset|cancel|revoke|invite/i;

const SEVERITY_ORDER = { high: 0, mid: 1, low: 2, info: 3 };
const LINK_TIMEOUT = 8000;

/** Asks the server about each link, six at a time, with a hard cap. */
async function probeLinks(hrefs, cap) {
  const queue = hrefs.slice(0, cap);
  const out = [];
  const worker = async () => {
    while (queue.length) {
      const href = queue.shift();
      try {
        let res = await fetch(href, {
          method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(LINK_TIMEOUT),
        });
        // Plenty of servers answer HEAD with 405, and a few with 403. Neither
        // means the page is broken, so fall back to asking for the body.
        if (res.status === 405 || res.status === 501 || res.status === 403) {
          res = await fetch(href, {
            method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(LINK_TIMEOUT),
          });
        }
        out.push({ href, status: res.status });
      } catch (err) {
        out.push({ href, status: 0, error: String((err && err.message) || err) });
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

/** One report, two renderings: for the person reading the terminal, and for a web AI. */
function doctorReport(url, findings, extra) {
  const counts = { high: 0, mid: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  const text = [`Checked ${url}`];
  if (!findings.length) {
    text.push('No problems found. Nothing dead, nothing broken, nothing invisible.');
  } else {
    const tally = ['high', 'mid', 'low', 'info']
      .filter((s) => counts[s])
      .map((s) => `${counts[s]} ${s}`)
      .join(', ');
    text.push(`${findings.length} problems (${tally})`);
    text.push('');
    for (const f of findings) {
      text.push(`#${f.id}  [${f.severity}]  ${f.title}`);
      if (f.where) text.push(`      ${f.where}`);
      text.push(`      ${f.detail}`);
      text.push(`      Fix: ${f.fix}`);
      text.push('');
    }
  }
  if (extra && extra.length) {
    text.push(...extra);
    text.push('');
  }
  text.push(findings.length
    ? 'To hand this to a web AI:   browser.js doctor --paste --out=bugs.md'
    : 'Nothing to fix. Carry on.');
  return { text: text.join('\n'), counts, findings };
}

/**
 * The version a person pastes into claude.ai, gemini.google.com or ChatGPT.
 *
 * This is the point of the whole command. A web AI cannot see your page, and
 * the person using it does not know what an error is; but a numbered list with
 * the markup and the selector is something either of them can act on.
 */
function doctorPaste(url, findings, when) {
  const out = [
    'A browser opened this page and found problems. Fix them one at a time, most',
    'severe first. For each one, tell me which file you changed and why.',
    '',
    `Page: ${url}`,
    `Checked: ${when}`,
    '',
  ];
  for (const f of findings) {
    out.push(`--- #${f.id} [${f.severity}] ${f.title}`);
    if (f.where) out.push(`Where: ${f.where}`);
    if (f.html) out.push(`Markup: ${f.html}`);
    out.push(f.detail);
    out.push(`How to fix: ${f.fix}`);
    out.push('');
  }
  return out.join('\n');
}

async function runDoctor(session, flags) {
  const probe = await session.evaluate(DOCTOR_PROBE);
  const findings = Array.isArray(probe.findings) ? probe.findings.slice() : [];
  const candidates = Array.isArray(probe.candidates) ? probe.candidates.slice(0, 40) : [];
  const extra = [];

  /* Does the button actually do anything? Ask the browser, not the markup.
     A missing onclick proves nothing on a React page, so the whole ancestor
     chain is checked before calling a button dead. */
  const dead = [];
  let wired = 0;
  for (const candidate of candidates) {
    let found = null;
    for (const selector of candidate.chain) {
      const types = await session.listenersFor(selector).catch(() => null);
      if (types && types.length) { found = types; break; }
    }
    if (found) { wired += 1; continue; }
    dead.push(candidate);
    findings.push({
      kind: 'button-dead',
      severity: 'high',
      selector: candidate.selector,
      title: 'A button does nothing when clicked',
      where: `"${candidate.text}"  ·  ${candidate.selector}`,
      detail: 'It is visible and enabled, and there is no click listener on it or on anything above it — nothing at all, so pressing it cannot do anything. It looks finished and is not.',
      fix: 'Attach a click handler, or make it a real link: <a href="/where-it-goes">.',
      html: candidate.html,
    });
  }
  if (candidates.length) {
    extra.push(`${candidates.length} buttons checked: ${wired} have a handler, ${dead.length} have none.`);
  }

  /* Prove it, if asked. Pressing a real button is the only way to be sure, and
     it is opt-in because it can also submit forms and navigate away. */
  if (flags.click && dead.length) {
    const before = await session.fingerprint().catch(() => null);
    const beforeUrl = before ? JSON.parse(before).url : null;
    const proven = [];
    const skipped = [];
    for (const candidate of dead.slice(0, Number(flags.limit) || 10)) {
      if (DESTRUCTIVE.test(candidate.text) || /<form|type="submit"/i.test(candidate.html)) {
        skipped.push(candidate);
        continue;
      }
      try {
        await session.evaluate(`document.querySelector(${JSON.stringify(candidate.selector)}).click()`);
      } catch {
        skipped.push(candidate);
        continue;
      }
      await sleep(450);
      const now = await session.fingerprint().catch(() => null);
      if (now === before) { proven.push(candidate); continue; }
      const finding = findings.find((f) => f.selector === candidate.selector && f.kind === 'button-dead');
      if (finding) {
        // It was wired after all. Saying so is as useful as the false alarm.
        finding.severity = 'info';
        finding.title = 'A button looked dead but works';
        finding.detail = 'It has no listener of its own, but pressing it changed the page, so the handler lives further up the tree. Nothing to fix.';
        finding.fix = 'Nothing. This one is fine.';
      }
      const moved = now && beforeUrl && JSON.parse(now).url !== beforeUrl;
      if (moved) break;   // the page changed underneath us; the rest would be noise
    }
    for (const candidate of proven) {
      const finding = findings.find((f) => f.selector === candidate.selector && f.kind === 'button-dead');
      if (finding) {
        finding.detail = 'I pressed it: the url did not change and the page did not change. It is confirmed dead, not just suspicious.';
      }
    }
    const notes = [`Clicked ${proven.length} suspicious buttons: ${proven.length} confirmed dead.`];
    if (skipped.length) {
      notes.push(`${skipped.length} left alone because they look destructive: ${skipped.map((c) => c.text).join(', ')}`);
    }
    extra.push(notes.join('\n'));
  }

  /* Ask the server about its own links. */
  let linksChecked = 0;
  if (!flags['no-network']) {
    // links arrive as {href, text}; the fetcher wants the urls themselves.
    const urls = (probe.links || []).map((l) => (typeof l === 'string' ? l : l.href)).filter(Boolean);
    const results = await probeLinks(urls, Number(flags.limit) || 40);
    linksChecked = results.length;
    for (const r of results) {
      if (r.status < 400 && r.status !== 0) continue;
      findings.push({
        kind: 'link-broken',
        severity: 'high',
        selector: r.href,
        title: 'A link on this page does not work',
        where: r.href,
        detail: r.status === 0
          ? `The server could not be reached: ${r.error}`
          : `The server answered ${r.status} ${r.status === 404 ? '(not found)' : ''}`.trim(),
        fix: 'Fix the path, or point the link at a page that exists.',
        html: '',
      });
    }
  }

  /* What the page itself complained about while it was open. The log is a
     session-wide buffer, so a second doctor run sees the same entries again —
     the same error reported twice reads as two bugs. */
  const reported = new Set();
  for (const entry of session.logs) {
    // Only what happened while THIS page was open. The log outlives the page
    // on purpose, and a report that blames the wrong url is worse than none.
    if (entry.epoch !== session.epoch) continue;
    if (entry.kind === 'console.log' || entry.kind === 'console.info' || entry.kind === 'console.debug') continue;
    // The browser asks for a favicon unprompted. Missing one is not a bug in
    // the page, and listing it on every run trains people to ignore the list.
    if (/favicon\.ico/.test(entry.text)) continue;
    if (reported.has(entry.kind + entry.text)) continue;
    reported.add(entry.kind + entry.text);
    findings.push({
      kind: 'runtime',
      severity: 'high',
      selector: entry.url || '',
      title: entry.kind === 'exception' ? 'JavaScript threw an error on this page'
        : entry.kind === 'http' ? 'The page asked for something that failed'
        : entry.kind === 'request' ? 'A request the page made never completed'
        : 'The page logged an error',
      where: '',
      detail: entry.text,
      fix: 'This is what the page itself reported. Open it in a browser with the console open and start there.',
      html: '',
    });
  }

  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  findings.forEach((f, i) => { f.id = i + 1; });

  if (linksChecked) extra.push(`${linksChecked} links asked about over the network (--no-network to skip).`);

  const report = doctorReport(await session.evaluate('location.href').catch(() => '(unknown url)'), findings, extra);
  report.paste = findings.length
    ? doctorPaste(report.text.split('\n')[0].replace(/^Checked /, ''), findings, new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC')
    : 'I checked this page in a real browser and found no problems:\n' + report.text.split('\n')[0];
  return report;
}

async function dispatch(session, payload) {
  const { command, args = [], flags = {} } = payload;
  session.current = session.current || session.tabs[0];

  // The viewport is session-wide, so it can be set once and every later command
  // inherits it — including tabs opened afterwards.
  if (flags.viewport || flags.mobile) {
    if (flags.mobile) {
      await session.setViewport({ width: 390, height: 844, mobile: true });
    } else {
      const m = String(flags.viewport).match(/^(\d+)\s*[x×]\s*(\d+)$/);
      if (!m) throw new Error('--viewport wants WIDTHxHEIGHT, e.g. --viewport=1280x900');
      await session.setViewport({ width: Number(m[1]), height: Number(m[2]), mobile: false });
    }
  }

  switch (command) {
    case 'status': {
      const info = await session.helper('info').catch(() => ({}));
      return render('', {
        browser: session.binary,
        version: session.version,
        url: info.url || '(unknown)',
        title: info.title || '(untitled)',
        viewport: session.viewport
          ? `${session.viewport.width}x${session.viewport.height}${session.viewport.mobile ? ' (mobile)' : ''}`
          : 'default (780x437)',
        tabs: session.tabs.length,
        bufferedMessages: session.logs.length,
      });
    }

    case 'open': {
      if (!args[0]) throw new Error('open needs a url, e.g. browser.js open https://example.com');
      await session.navigate(args[0]);
      return `OK opened ${await session.stableUrl(3000)}`;
    }

    case 'url':
      return await session.evaluate('location.href');

    case 'title':
      return (await session.evaluate('document.title')) || '(untitled)';

    case 'state': {
      const state = await session.helper('state', Number(flags.text) || 1500);
      const out = [render('', { url: state.url, title: state.title, readyState: state.readyState })];
      out.push(`text (${state.textLength} chars):\n${state.text}`);
      if (state.buttons.length) out.push(`buttons:\n${render('', state.buttons)}`);
      if (state.links.length) out.push(`links:\n${render('', state.links)}`);
      if (state.fields.length) out.push(`fields:\n${render('', state.fields)}`);
      if (session.logs.length) out.push(`messages so far: ${session.logs.length} (see: console)`);
      return out.join('\n\n');
    }

    case 'text': {
      const text = await session.helper('text', args[0] || null);
      return text || '(the page has no visible text)';
    }

    case 'html': {
      const html = await session.helper('html', args[0] || null);
      return flags.full ? html : html.slice(0, Number(flags.limit) || 20000);
    }

    case 'links':
      return render('', await session.helper('links', Number(flags.limit) || 100));

    case 'buttons':
      return render('', await session.helper('buttons', Number(flags.limit) || 60));

    case 'fields':
    case 'forms':
      return render('', await session.helper('fields', Number(flags.limit) || 60));

    case 'count':
      return String(await session.helper('count', args[0] || 'body'));

    case 'click': {
      if (!args[0]) throw new Error('click needs a selector');
      const before = await session.evaluate('location.href');
      const result = await session.helper('click', args[0]);
      // A click may navigate, possibly after a beat (a JS redirect, a POST).
      // Wait for the url to stop moving before reporting it.
      const after = await session.stableUrl();
      const out = [`OK clicked "${result.clicked}"`, line('url', after)];
      if (before !== after) out.push(line('navigated', 'yes'));
      return out.join('\n');
    }

    case 'fill': {
      if (args.length < 2) throw new Error('fill needs a selector and a value');
      const result = await session.helper('fill', args[0], args.slice(1).join(' '));
      return `OK filled "${result.filled}" with ${JSON.stringify(result.value)}`;
    }

    case 'select': {
      if (args.length < 2) throw new Error('select needs a selector and a value');
      const result = await session.helper('select', args[0], args[1]);
      return `OK selected ${JSON.stringify(result.selected)}`;
    }

    case 'press': {
      if (!args[0]) throw new Error('press needs a key, e.g. Enter');
      await session.key(args[0]);
      return `OK pressed ${args[0]}\n${line('url', await session.stableUrl())}`;
    }

    case 'scroll': {
      const result = await session.helper('scroll', args[0] || 'down');
      return render('', result);
    }

    case 'wait': {
      if (!args[0]) throw new Error('wait needs a selector');
      const deadline = Date.now() + (Number(flags.timeout) || NAV_TIMEOUT);
      while (Date.now() < deadline) {
        const n = await session.helper('count', args[0]).catch(() => 0);
        if (n > 0) return `OK ${args[0]} is present (${n} match)`;
        await sleep(200);
      }
      throw new Error(`${args[0]} did not appear within ${flags.timeout || NAV_TIMEOUT}ms`);
    }

    case 'waitfor':
      await sleep(Number(args[0]) || 1000);
      return `OK waited ${args[0] || 1000}ms`;

    case 'reload':
      await session.navigate(await session.evaluate('location.href'));
      return 'OK reloaded';

    case 'back':
    case 'forward': {
      const delta = command === 'back' ? -1 : 1;
      const history = await session.evaluate('String(history.length)');
      // history.go() tears down the execution context it was called from, so CDP
      // answers with "Inspected target navigated or closed". That is the call
      // succeeding, not failing: wait for the url instead of reading the error.
      try {
        session.epoch += 1;
      await session.evaluate(`history.go(${delta})`);
      } catch { /* the navigation happened; that is the point */ }
      const url = await session.stableUrl();
      return `OK ${command}\n${line('url', url)}\nhistory length: ${history}`;
    }

    case 'console': {
      if (flags.clear) {
        const n = session.logs.length;
        session.logs.length = 0;
        return `OK cleared ${n} messages`;
      }
      if (!session.logs.length) return '(no console output, no exceptions, no failed requests)';
      return session.logs
        .map((entry) => `[${entry.kind}] ${entry.text}`)
        .join('\n');
    }

    case 'errors': {
      const bad = session.logs.filter((l) => l.kind !== 'console.log' && l.kind !== 'console.info');
      if (!bad.length) return '0 errors, exceptions or failed requests';
      return `${bad.length} problems:\n${bad.map((e) => `[${e.kind}] ${e.text}`).join('\n')}`;
    }

    case 'doctor': {
      const report = await runDoctor(session, flags);
      const failed = report.counts.high > 0;
      if (flags.out) {
        const file = path.resolve(String(flags.out));
        fs.writeFileSync(file, (flags.paste ? report.paste : report.text) + '\n', 'utf8');
        return { text: `OK wrote ${report.findings.length} findings to ${file}`, code: 0 };
      }
      const text = flags.paste ? report.paste : report.text;
      return flags.strict && failed ? { text, code: 1 } : text;
    }

    case 'screenshot': {
      const file = await session.screenshot(args[0] || null, !!flags.full);
      return `OK screenshot saved: ${file}\n(view it with your image reader; the text of the page is better read with: state)`;
    }

    case 'eval': {
      if (!args.length) throw new Error('eval needs a JavaScript expression');
      const value = await session.evaluate(args.join(' '));
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }

    case 'tabs': {
      const rows = [];
      for (let i = 0; i < session.tabs.length; i++) {
        const tab = session.tabs[i];
        const current = tab === session.current ? '*' : ' ';
        let title = '';
        try { title = await session.cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, tab.sessionId).then((r) => r.result.value); }
        catch { title = '(not readable)'; }
        rows.push(`${current} ${i}  ${title}  ${tab.url}`);
      }
      return rows.join('\n');
    }

    case 'newtab': {
      const tab = await session.addTab(args[0] || 'about:blank');
      return `OK new tab on index ${session.tabs.indexOf(tab)}: ${tab.url}`;
    }

    case 'use': {
      const index = Number(args[0]);
      if (!Number.isInteger(index)) throw new Error('use needs a tab index; see: browser.js tabs');
      const tab = await session.useTab(index);
      return `OK switched to tab ${index}: ${tab.url}`;
    }

    case 'closetab': {
      const index = Number(args[0]);
      const tab = session.tabs[index];
      if (!tab) throw new Error(`there is no tab ${index}`);
      await session.cdp.send('Target.closeTarget', { targetId: tab.targetId });
      session.tabs.splice(index, 1);
      if (!session.tabs.length) await session.addTab('about:blank');
      session.current = session.tabs[Math.min(index, session.tabs.length - 1)];
      return `OK closed tab ${index}`;
    }

    default:
      throw new Error(`unknown command "${command}". Try: browser.js help`);
  }
}

/* ─────────────────────────────────── the CLI ───────────────────────────────── */

function portFilePath(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(os.tmpdir(), `browser-agent-${safe}.json`);
}

function readPortFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function daemonAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Starts the daemon if it is not already up, and returns its port. */
async function ensureDaemon(flags) {
  const name = flags.session || 'default';
  const file = portFilePath(name);

  if (flags.port) return Number(flags.port);

  const existing = readPortFile(file);
  if (existing && await daemonAlive(existing.port)) return existing.port;
  if (existing) { try { fs.unlinkSync(file); } catch { /* raced with another start */ } }

  const args = [__filename, '__daemon', `--session=${name}`];
  if (flags.browser) args.push(`--browser=${flags.browser}`);
  // On Windows a detached child gets its own console, and a detached+unref'd
  // spawn that races the parent's exit can abort libuv. Keeping it attached
  // there costs nothing — a child on Windows outlives its parent anyway, which
  // is the whole point of detaching on the platforms that would kill it.
  const detached = process.platform !== 'win32';
  const child = spawn(process.execPath, args, {
    detached,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const info = readPortFile(file);
    if (info && await daemonAlive(info.port)) return info.port;
    await sleep(200);
  }
  throw new Error(
    'the browser did not start within 45s.\n' +
    'Run it in the foreground to see why:  node browser.js __daemon --session=default'
  );
}

const HELP = `browser.js ${VERSION} — a real browser for a CLI agent, no MCP needed.

USAGE
  node browser.js <command> [args] [flags]

NAVIGATE
  open <url>              go to a url (https:// omitted is assumed http://)
  reload                  load the current url again
  back | forward          move through history
  url | title             print the current url or title

SEE
  state                   everything at once: url, title, visible text,
                          buttons, links, form fields. Start here.
  text [selector]         the visible text of the page, or of one element
  html [selector]         the HTML of the page, or of one element
  links | buttons | forms  clickable things, buttons, form fields
  count <selector>        how many elements match
  screenshot [file]       save a PNG and print its path (--full for the
                          whole page, not just the viewport)

ACT
  click <selector>        click, then report where the page ended up
  fill <selector> <text>  type into an input (fires input + change)
  select <selector> <val> choose an option in a <select>
  press <key>             Enter, Tab, Escape, ArrowDown, or a character
  scroll [px|up|down|top|bottom]
  eval <expression>       run JavaScript in the page, print the result
  wait <selector>         block until a selector appears (--timeout=ms)
  waitfor <ms>            sleep

TABS
  tabs | newtab [url] | use <n> | closetab <n>

DIAGNOSTICS
  console                 console messages, uncaught exceptions, HTTP 4xx/5xx
                          and failed requests since the session started
  errors                  only the problems, without the noise
  console --clear         forget what was collected
  status                  which browser, which version, which url

  doctor                  find the bugs in the page you are looking at:
                          buttons that do nothing, broken images and links,
                          fields with no label, text cut off, duplicate ids,
                          errors the page logged. Numbered, worst first.
                            --click          also press the suspicious buttons
                                              and see which really do nothing
                            --paste          only the text to paste into a
                                              web AI (claude, gemini, chatgpt)
                            --out=<file>     write it to a file
                            --no-network     skip asking the server about links
                            --strict         exit 1 if anything high is found
                                              (for CI)

LIFECYCLE
  start                   start the browser and report it
  stop                    close the browser and forget the session
  help                    this text

FLAGS
  --session=<name>   keep several independent sessions (default: default)
  --browser=<path>   the Chrome/Chromium/Edge to use (or $BROWSER_PATH)
  --timeout=<ms>     navigation timeout, default ${NAV_TIMEOUT}
  --viewport=WxH     page size, e.g. --viewport=1280x900. Stays for the session.
  --mobile           390x844, the size of a phone
  --json             machine-readable output
  --full             full-page screenshot
  --limit=<n>        cap list output
  --text=<n>         cap the text in \`state\`

NOTES
  The browser stays alive between commands, so a session is: open, then click,
  then read. One Chrome/Chromium/Edge must exist; it is found automatically.
`;

async function main() {
  const { flags, words } = parseArgv(process.argv.slice(2));

  if (flags.version || words[0] === 'version') { console.log(VERSION); return; }
  if (!words.length || words[0] === 'help' || flags.help) { console.log(HELP); return; }

  const command = words[0];
  const args = words.slice(1);

  if (command === '__daemon') { await runDaemon(flags); return; }

  if (command === 'start') {
    const port = await ensureDaemon(flags);
    const info = readPortFile(portFilePath(flags.session || 'default')) || { port };
    console.log(`browser ready on port ${port} (session: ${flags.session || 'default'})`);
    if (info.browser) console.log(`binary: ${info.browser}`);
    return;
  }

  if (command === 'stop') {
    const name = flags.session || 'default';
    const file = portFilePath(name);
    const info = readPortFile(file);
    if (!info) { console.log('no session to stop'); return; }
    // Ask nicely over HTTP. The daemon then closes its browser and deletes its
    // own temp profile before leaving. A signal cannot do that on Windows,
    // where SIGTERM is just "kill it now" — that is how orphaned Chrome
    // processes and stale port files happen.
    let asked = false;
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/shutdown`, { method: 'POST' });
      asked = res.ok;
    } catch { /* nothing listening: it is already dead or wedged */ }

    if (asked) {
      // Give it a moment to finish tidying up, then confirm it actually left.
      const gone = Date.now() + 4000;
      while (Date.now() < gone && readPortFile(file)) await sleep(100);
    }
    if (readPortFile(file)) {
      // It did not go. Fall back to the hard way, and be honest about it.
      try { process.kill(info.pid, 'SIGTERM'); } catch { /* already dead */ }
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
    console.log(`stopped session ${name}`);
    return;
  }

  const port = await ensureDaemon(flags);
  const res = await fetch(`http://127.0.0.1:${port}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, args, flags }),
  });
  const payload = await res.json();

  if (!payload.ok) {
    console.error(`error: ${payload.error}`);
    process.exit(1);
  }
  if (flags.json) {
    console.log(JSON.stringify({ command, ok: true, text: payload.text }, null, 2));
  } else {
    console.log(payload.text);
  }
  if (payload.code) process.exit(payload.code);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { findBrowser, portFilePath };
