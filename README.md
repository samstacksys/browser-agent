<div align="center">

# Browser Agent

### AI can build your website. Browser Agent checks if it actually works.

A lightweight, dependency-free real-browser tool for developers and AI coding agents.

[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Zero dependencies](https://img.shields.io/badge/runtime_dependencies-0-7C3AED?style=flat-square)](./package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563EB?style=flat-square)](./LICENSE)
[![GitHub](https://img.shields.io/badge/source-GitHub-181717?style=flat-square&logo=github)](https://github.com/samstacksys/browser-agent)

<br>

<a href="https://t.me/samstacksys">
  <img src="https://img.shields.io/badge/Join_Samstack_Systems-Telegram-229ED9?style=for-the-badge&logo=telegram&logoColor=white" alt="Join Samstack Systems on Telegram">
</a>

**Software • Automation • Managed Infrastructure**

*You run your business. We build and manage the technology behind it. ⚡*

</div>

---

## What Browser Agent catches

AI coding agents can read code and run an app. They do not automatically know what the finished page looks like or how it behaves inside a real browser.

Browser Agent closes that gap by finding problems such as:

- Buttons that do nothing
- Broken links and 404 responses
- Images that fail to load
- JavaScript and console errors
- Cut-off or hidden text
- Empty UI elements
- Broken or incomplete forms
- Missing labels and accessibility issues

It converts those findings into plain text that you can send directly back to Claude, ChatGPT, Codex, Cursor, Gemini, or another coding agent.

> **No MCP server. No runtime dependencies. No complicated setup.**

## The workflow

| 1. Build | 2. Inspect | 3. Report | 4. Fix |
|:--:|:--:|:--:|:--:|
| Your AI generates the page | Browser Agent checks the rendered UI | It creates an agent-ready bug report | Your AI fixes concrete issues |

```text
AI builds the page  →  Browser Agent checks it  →  AI fixes the page
```

## Try it in 60 seconds

### 1. Clone and test

You need Node.js 22+ and Chrome, Chromium, or Edge.

```bash
git clone https://github.com/samstacksys/browser-agent.git
cd browser-agent
npm test
```

The self-test uses a deliberately broken page to verify JavaScript errors, 404s, interactions, forms, and redirects.

### 2. Open your website

Start your website normally, then open it with Browser Agent:

```bash
npm run dev
node browser.js open http://localhost:3000
```

### 3. Find the problems

```bash
node browser.js doctor
```

Example output:

```text
Checked http://localhost:3000/dashboard

2 problems (1 high, 1 mid)

#1 [high] A button does nothing when clicked
    "Save changes" · #save

    Fix: Attach a click handler, or make it a real link.

#2 [mid] Text is cut off
    "Total for March 2026..." · .summary > span.total

    Fix: Let it wrap, or use text-overflow: ellipsis.
```

That is the core loop: **Open → Inspect → Fix.**

## Give the bugs back to your AI

Generate a report designed for an AI coding agent:

```bash
node browser.js doctor --paste --out=bugs.md
```

The generated `bugs.md` includes:

- What went wrong
- Where it happened
- The relevant selector and markup
- Why it is a problem
- A suggested fix

Give that file to your coding agent with a simple instruction:

> Here are the problems Browser Agent found in the rendered page. Fix them one at a time.

Less guessing. More fixing.

## The `doctor` command

`doctor` inspects the page in a real browser and orders findings by severity.

```bash
node browser.js doctor
```

| Problem | What it checks |
|---|---|
| Dead buttons | Whether buttons appear to have real handlers |
| Broken links | Empty, `#`, JavaScript, and unreachable links |
| 404 links | Server responses |
| Failed images | Images that did not load |
| JavaScript errors | Console errors and uncaught exceptions |
| Cut-off text | Content hidden by its container |
| Missing labels | Form fields without proper labels |
| Missing `name` | Fields that will not submit their value |
| Duplicate IDs | Duplicate HTML IDs |
| Broken labels | Labels pointing to missing elements |
| Broken forms | Forms without useful actions |
| HTTP form posts | Insecure form submissions |
| Empty UI | Large empty elements that look broken |
| Missing alt text | Images without alternative text |

### Test suspicious buttons

```bash
node browser.js doctor --click
```

Browser Agent tests suspicious buttons while automatically skipping actions that look destructive, such as **Delete account**. Clicking is opt-in because pressing a button is the only reliable way to confirm whether it works.

### Useful options

| Goal | Command |
|---|---|
| Generate AI-ready output | `node browser.js doctor --paste` |
| Save the report | `node browser.js doctor --paste --out=bugs.md` |
| Test suspicious buttons | `node browser.js doctor --click` |
| Skip network checks | `node browser.js doctor --no-network` |
| Fail CI on high-severity issues | `node browser.js doctor --strict` |
| Limit inspected items | `node browser.js doctor --limit=20` |

## Use it as a persistent browser

Browser Agent is also a lightweight browser interface for terminal-based AI agents. The browser remains alive between commands, preserving cookies and page state.

```bash
# Navigate
node browser.js open https://example.com
node browser.js reload
node browser.js back

# Inspect
node browser.js state
node browser.js text
node browser.js buttons
node browser.js links
node browser.js errors

# Interact
node browser.js click "#login"
node browser.js fill "#email" "me@example.com"
node browser.js press Enter

# Capture
node browser.js screenshot
node browser.js url
```

A coding agent can run a complete browser flow:

```text
open → fill → click → state → errors → doctor
```

## Desktop and mobile layouts

Use a custom viewport:

```bash
node browser.js --viewport=1440x900 open https://example.com
```

Or use the built-in `390×844` mobile viewport:

```bash
node browser.js --mobile open https://example.com
```

## For AI coding agents

Browser Agent works well with terminal-based tools including Claude Code, Cursor, Codex, Gemini-based workflows, and other agents that can run shell commands.

Copy the project instructions from [`AGENT-SNIPPET.md`](./AGENT-SNIPPET.md) into one of the configuration files used by your agent:

```text
AGENTS.md
CLAUDE.md
.cursorrules
```

## Why a real browser?

| Method | What it misses |
|---|---|
| HTTP request | A Save button that looks real but does nothing |
| DOM parser | An image that failed to load after rendering |
| Unit test | A production layout that breaks at a real viewport |

Browser Agent uses an actual Chromium-based browser. It renders the page, executes JavaScript, observes errors, and interacts with the UI through the Chrome DevTools Protocol.

## Requirements and configuration

### Node.js

Node.js 22 or newer. Browser Agent uses the built-in `WebSocket` and `fetch` APIs, so it has no runtime npm dependencies.

### Browser

Install one of:

- Chrome
- Chromium
- Edge

Browser Agent searches common locations automatically. You can also provide the browser path manually:

```bash
node browser.js --browser=/path/to/chrome open https://example.com
```

Or set it through the environment:

```bash
export BROWSER_PATH=/path/to/chrome
```

Check that everything is available:

```bash
node browser.js start
```

## Command reference

Run `node browser.js help` for the complete built-in reference.

| Category | Commands |
|---|---|
| Inspect | `state`, `text [selector]`, `html [selector]`, `links`, `buttons`, `forms`, `count <selector>`, `screenshot [file]` |
| Interact | `click <selector>`, `fill <selector> <text>`, `select <selector> <value>`, `press <key>`, `scroll`, `eval <expression>`, `wait <selector>` |
| Navigate | `open <url>`, `reload`, `back`, `forward`, `url`, `title` |
| Diagnose | `doctor`, `errors`, `console` |
| Tabs | `tabs`, `newtab [url]`, `use <n>`, `closetab <n>` |
| Lifecycle | `start`, `stop`, `status`, `help` |

## Independent sessions

Run multiple browser sessions with separate cookies and state:

```bash
node browser.js --session=signup open https://example.com/signup
node browser.js --session=checkout open https://example.com/cart
```

## Important limitations

- **`doctor` is heuristic.** A clean report means it did not find a problem it knows how to detect—not that the site is guaranteed to be perfect.
- **Clicks are DOM clicks.** They work well with normal HTML, React, and Vue, but do not replace real pointer interaction for drag-and-drop, hover-only interfaces, canvas apps, or pointer-only widgets.
- **One viewport is tested at a time.** Browser Agent is not a complete device emulator.
- **Authentication is respected.** It does not bypass sign-in or access controls.
- **The browser is headless.** Chromium runs without a visible browser window.

## How it works

```text
AI coding agent
      │
      │ shell commands
      ▼
  browser.js
      │
      │ WebSocket / Chrome DevTools Protocol
      ▼
Chrome / Chromium / Edge
      │
      ▼
Your rendered website
```

The architecture stays intentionally small:

- No Puppeteer
- No Playwright
- No `ws` package
- No MCP server
- No runtime dependency stack

## Project structure

```text
browser-agent/
├── browser.js          # CLI, browser communication, and helpers
├── selftest.js         # Browser-based self-test
├── index.html          # Deliberately broken self-test page
├── AGENT-SNIPPET.md    # Instructions for AI coding agents
├── README.md
└── LICENSE
```

## Contributing

Issues, ideas, and pull requests are welcome. If you find a frontend bug type that Browser Agent should detect, [open an issue](https://github.com/samstacksys/browser-agent/issues) or contribute a detector.

## License

Released under the [MIT License](./LICENSE).

---

<div align="center">

### Built by Samstack Systems

**Software • Automation • Managed Infrastructure**

You run your business. We build and manage the technology behind it. ⚡

<a href="https://t.me/samstacksys">
  <img src="https://img.shields.io/badge/Join_the_Telegram_Channel-229ED9?style=for-the-badge&logo=telegram&logoColor=white" alt="Join the Samstack Systems Telegram channel">
</a>

</div>
