# browser-agent

**Find the bugs in the page you are looking at. Then paste them into Claude or Gemini.**
**For CLI agents too: a real browser, with no MCP server and nothing to install.**

There are two ways to use this, and you may only need the first.

1. **You vibecode.** You had Claude or Gemini write a feature. The code looks
   finished. Something is off and you cannot work out what, because a web AI
   cannot see your page. Run one command and it tells you: this button does
   nothing, this image never loaded, this text is cut off. Copy the list, paste
   it back, get it fixed.
2. **You use an agent in the terminal.** Claude Code, Cursor, Codex. They can
   read files and run commands but they cannot *see* a page, so a blank screen
   or a broken image reaches the user before it reaches the agent. This gives
   them a browser they drive with shell commands, in plain text.

```console
$ node browser.js open http://localhost:3000
$ node browser.js doctor
Checked http://localhost:3000/dashboard
2 problems (1 high, 1 mid)

#1  [high]  A button does nothing when clicked
      "Save changes"  ·  #save
      It is visible and enabled, and there is no click listener on it or on
      anything above it — nothing at all, so pressing it cannot do anything.
      Fix: Attach a click handler, or make it a real link: <a href="/where-it-goes">.

#2  [mid]  Text is cut off with no sign it is there
      Total for March 2026, invoice 2026-0043, paid  ·  div.summary > span.total
      The content is 210px wider than its box and the overflow is hidden, so
      about 61% of it is invisible. Nobody can tell there is more.
      Fix: Let it wrap, or set text-overflow: ellipsis so the cut is visible.
```

Then hand it over:

```console
$ node browser.js doctor --paste --out=bugs.md
OK wrote 2 findings to bugs.md
```

`bugs.md` is written for the AI: every finding numbered, with the selector, the
markup that caused it, and how to fix it. Paste it into claude.ai,
gemini.google.com or ChatGPT and it has something to work on.

---

## Why you should have it

**It finds the bugs the other tools cannot.** HTTP clients and DOM parsers do not
run JavaScript, do not load CSS, do not report a failed request, and cannot tell
you what a button *does*. A real browser does all four. This is not theoretical:
the exact class of bug that shipped past a fully green test suite on the project
this came from was a link whose server-side tests all passed, because the test
asserted the redirect, and the redirect pointed at `localhost` — a machine that
does not exist in the user's browser. Only a browser notices.

**It tells you a button is dead, not that it looks finished.** Generated code is
full of controls with no handler behind them, and they look identical to working
ones. `doctor` asks the browser for the real listener list — including the
ancestors, because React wires every button from the root — and with `--click` it
presses the suspicious ones and watches to see whether anything happened.

**It closes the gap a web AI cannot.** You cannot send a browser tab to
claude.ai. So you describe the bug from memory and it guesses. `--paste` writes
the findings in a form that needs no guessing: what broke, where, the markup, how
to fix it.

**No MCP server.** MCP browsers are a moving target: a server to install, a client
that has to support it, sometimes a paid account. Your agent already runs shell
commands. This is one.

**Nothing to install.** No `npm install`, no `npx`, no 150 MB browser download.
Node 22 and a Chrome that is already on the machine. That is the entire setup.

**It speaks the agent's language.** Output is plain text — no JSON parsing, no
image decoding, no MCP framing. An agent reads it directly. The one thing it
cannot consume is a screenshot, and `state` exists precisely so the agent never
needs one.

**The session survives.** The browser stays alive between commands, so a flow is
`open`, then `click`, then `read` — as separate invocations, which is how an agent
actually works. Log in once, stay logged in.

**It is one file.** `browser.js`, ~1700 lines, zero dependencies. Read it, fork
it, change the look-up table. Nothing to unpick when it breaks.

---

## The doctor

The command you will use most, whether you are a person or an agent.

```console
$ node browser.js doctor
```

It checks what the page can prove about itself, then asks the browser the
questions the page cannot answer. Findings come back numbered, worst first.

| What it finds | How |
|---|---|
| Buttons that do nothing | The real listener list, on the element and up to twelve ancestors |
| Links that lead nowhere | `href="#"`, `href=""`, `javascript:` |
| Links that 404 | Asks the server, six at a time, capped |
| Images that failed | `naturalWidth === 0` after load |
| JavaScript errors | What the page threw while it was open |
| Text cut off | Content wider than its box, overflow hidden, no ellipsis |
| Fields with no label | Including the ones labelled only by a placeholder |
| Fields dropped on submit | No `name` attribute |
| Duplicate ids | The kind that makes `getElementById` and `<label for>` lie |
| Labels pointing at nothing | `<label for="x">` with no element with that id |
| Forms with no action | Submitting reloads and throws the input away |
| Forms posting over http | On an https page |
| Empty boxes | Only ones big enough that a person would notice |
| Images with no alt | — |

### Flags

| Flag | What it does |
|---|---|
| `--click` | Also press the suspicious buttons and see which really do nothing. Anything that sounds destructive — *delete*, *pay*, *logout*, *send* — is skipped and reported as untested. |
| `--paste` | Only the text to paste into a web AI |
| `--out=<file>` | Write it to a file instead of the terminal |
| `--no-network` | Skip asking the server about links |
| `--strict` | Exit 1 if anything high-severity is found, for CI |
| `--limit=<n>` | Cap how many buttons it clicks or links it checks |

```console
$ node browser.js doctor --click
4 buttons checked: 2 have a handler, 2 have none.
Clicked 1 suspicious buttons: 1 confirmed dead.
1 left alone because they look destructive: Delete account
```

That last line matters. Pressing buttons is the only way to be certain, and it is
also the fastest way to delete something, so it is opt-in and it refuses to guess.

### For a web AI

```console
$ node browser.js doctor --paste --out=bugs.md
```

```text
A browser opened this page and found problems. Fix them one at a time, most
severe first. For each one, tell me which file you changed and why.

Page: http://localhost:3000/dashboard
Checked: 2026-09-25 23:40 UTC

--- #1 [high] A button does nothing when clicked
Where: "Save changes"  ·  #save
Markup: <button id="save" class="btn">Save changes</button>
It is visible and enabled, and there is no click listener on it or on anything
above it — nothing at all, so pressing it cannot do anything.
How to fix: Attach a click handler, or make it a real link: <a href="/where-it-goes">.
```

---

## Requirements

- **Node 22 or newer.** For the built-in `WebSocket` and `fetch`. Nothing else.
- **A Chrome, Chromium or Edge binary.** Almost every machine that runs a coding
  agent has one. It is found automatically from `$PATH`, the usual install
  locations, and the Playwright and Puppeteer download caches. Override with
  `--browser=/path/to/chrome` or `BROWSER_PATH`.

Check both in one command:

```console
$ node browser.js start
browser ready on port 51234 (session: default)
binary: /usr/bin/google-chrome
```

## Install

**Don't.** Run it in place:

```console
$ node /path/to/browser-agent/browser.js open https://example.com
```

Or make `browser` a command everywhere:

```console
$ cd browser-agent && npm link      # no dependencies, just a symlink
$ browser open https://example.com
```

## Try it without a website

```console
$ cd browser-agent
$ npm test
```

This serves a page with a deliberate console error, a deliberate 404, a form, a
button and a slow JavaScript redirect, then drives all of it and checks the
results. It never touches your apps and needs no network. 27 checks, about 20
seconds. If it passes, your setup works.

---

## The commands

Run `node browser.js help` for the same list.

| | |
|---|---|
| **Look** | |
| `state` | everything at once: url, title, visible text, buttons, links, form fields. **Start here.** |
| `text [selector]` | the visible text of the page, or of one element |
| `html [selector]` | the HTML of the page, or of one element |
| `links` / `buttons` / `forms` | clickable things, buttons, form fields |
| `count <selector>` | how many elements match |
| `screenshot [file]` | save a PNG and print its path (`--full` for the whole page) |
| **Act** | |
| `click <selector>` | click, then report where the page ended up |
| `fill <selector> <text>` | type into an input (fires `input` and `change`) |
| `select <selector> <value>` | choose an option |
| `press <key>` | `Enter`, `Tab`, `Escape`, `ArrowDown`, or a character |
| `scroll [px\|up\|down\|top\|bottom]` | |
| `eval <expression>` | run JavaScript in the page, print the result |
| `wait <selector>` | block until a selector appears (`--timeout=ms`) |
| **Navigate** | |
| `open <url>` | `https://` omitted is assumed |
| `reload` / `back` / `forward` | |
| `url` / `title` | |
| **Diagnose** | |
| `doctor` | find the bugs in this page, numbered, worst first. [Above.](#the-doctor) |
| `errors` | console errors, uncaught exceptions, HTTP 4xx/5xx, failed requests |
| `console` | the same, plus normal logging |
| **Tabs** | `tabs`, `newtab [url]`, `use <n>`, `closetab <n>` |
| **Lifecycle** | `start`, `stop`, `status`, `help` |

**Flags:** `--session=<name>` for independent sessions, `--browser=<path>`,
`--viewport=1280x900` to set a real screen size (or `--mobile` for 390×844),
`--json` for machine-readable output, `--text=<n>` to cap the text in `state`,
`--limit=<n>` to cap lists, `--full` for a full-page screenshot, `--timeout=<ms>`.
For `doctor`: `--click`, `--paste`, `--out=<file>`, `--no-network`, `--strict`.

### A real session

```console
$ browser open https://app.example.com/dashboard
$ browser state                          # what is this page, what can I do?
$ browser fill "#email" "me@example.com"
$ browser fill "#password" "$PASSWORD"   # read from the environment, not typed literally
$ browser click "button[type=submit]"
navigated: yes
$ browser url
https://app.example.com/dashboard
$ browser errors
(no console output, no exceptions, no failed requests)
$ browser screenshot /tmp/after.png
OK screenshot saved: /tmp/after.png
$ browser stop
```

Pass secrets through the environment, not as arguments — arguments land in shell
history and in the process list. Note that `forms` and `state` never print a
password field's value; it is reported as `(set)`.

### Several sessions at once

```console
$ browser --session=signup open https://example.com/signup
$ browser --session=checkout open https://example.com/cart
```

Each session is a separate browser with its own cookies, which is how you test two
users or two flows without them contaminating each other.

### Two screen sizes

```console
$ browser --viewport=1440x900 open https://example.com    # a desktop
$ browser --mobile open https://example.com              # 390x844, a phone
```

The size sticks to the session, so every command after it — and every tab you open
— uses that size. A layout that has collapsed shows up at one width and hides at
another, so when a page looks wrong, check it at both.

---

## Project layout

| | |
|---|---|
| `browser.js` | the whole tool: CLI, daemon, browser discovery, page helpers |
| `selftest.js` | 40 checks against a real browser, no network |
| `index.html` | this project's landing page, for GitHub Pages |
| `AGENT-SNIPPET.md` | the text to paste into your agent's instructions |
| `README.md` | this file |

---

## Wiring it into your agent

Copy [`AGENT-SNIPPET.md`](./AGENT-SNIPPET.md) into your `AGENTS.md`, `CLAUDE.md` or
`.cursorrules`. It is a short set of instructions written for the agent, not for
you, including the mistakes that make agents waste turns: forgetting `errors`
after a change, trusting a `click` whose url it did not read, and reading
`localhost` while the user is on a domain.

---

## How it works

Two processes, and nothing in between:

```
node browser.js click "#submit"
        │  reads the port file for the session, starts the daemon if needed
        ▼
   daemon (holds the browser open between commands)
        │  CDP over a WebSocket on 127.0.0.1
        ▼
   Chrome --headless --remote-debugging-port=0
```

- **Zero dependencies.** Node 22 ships `WebSocket` and `fetch`, which is the whole
  protocol client. There is no Puppeteer, no Playwright, no `ws`.
- **The browser is found, not assumed.** `$BROWSER_PATH`, then `$PATH`, then the
  standard install paths, then the Playwright and Puppeteer caches. The headless
  flag is chosen from the binary's actual version, so old and new Chromium both
  work.
- **Port 0.** The browser picks a free port and writes it to a file, so two
  sessions — or you and a colleague — never collide.
- **Nothing in the page is disturbed.** The page helpers are installed with
  `Page.addScriptToEvaluateOnNewDocument` and every one of them returns a
  description of a problem instead of throwing, so the tool never becomes the
  reason a page breaks.
- **It cleans up after itself.** Idle for 15 minutes and the browser closes. A
  `SIGTERM` removes the temporary profile. Nothing is left running.

## Limitations

Stated plainly, because a tool that hides these wastes your time:

- **Clicks are DOM click events**, not synthesised mouse input. They trigger
  navigation and they work with React and Vue. They will not drag, hover, or
  satisfy a canvas or a pointer-only widget. `eval` is the escape hatch.
- **No waiting for network idleness.** `wait <selector>` and `waitfor <ms>` are
  what you have. If a page is slow, wait longer.
- **No authentication bypass, no cookie injection from outside.** You sign in
  through the real form, which is the honest way to test it anyway.
- **One viewport at a time.** Chrome's headless default is 780×437, which is
  nobody's idea of a screen. Set a real one with `--viewport=1280x900`, or
  `--mobile` for 390×844, and check a second width when a layout is in doubt. It
  is not a device emulator: no touch, no GPU, no throttling.
- **Headless only.** No headed mode, so there is nothing to watch. If you want to
  see it, run Chrome yourself.
- **`doctor` is a heuristic, not a proof.** It is very good at "this control has
  no handler" and "this text does not fit", and deliberately quiet about anything
  it cannot be sure of. A clean report means nothing it could see was wrong, not
  that the page is right. It reads one page: a bug that only appears three steps
  into a flow is only found when you run it on the step where it happens.
- **`doctor --click` presses real buttons.** It skips the ones whose text sounds
  destructive, but "destructive" is a word list. On a page where clicking costs
  money, read the list before running it.
- **`screenshot` output is a file path.** An agent that cannot read images should
  use `state` instead; that is what it is for.

## Troubleshooting

**"no Chrome/Chromium/Edge found"** — install one, or point at it:
`--browser=/path/to/chrome`. The error lists every directory that was searched.

**The first command takes a few seconds** — it is starting the browser. Later
commands reuse it. If a session is stale after a crash, `browser stop` clears it.

**An element is not found** — the page has not rendered it yet. `wait` for it, or
check `state` to see what is actually on the page. If `state` shows the page is
still empty, the failure is upstream of the selector.

**"the browser did not start within 45s"** — run the daemon in the foreground to
see why: `node browser.js __daemon --session=default`.

**Port already in use** — each session picks its own free port; this only happens
if something else is squatting on the port file. `browser stop`, then retry.

## License

MIT — see `LICENSE`. Add your own copyright line before publishing.
