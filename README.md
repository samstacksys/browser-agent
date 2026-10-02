Browser Agent

AI can build your website. Browser Agent checks if it actually works.

A lightweight real-browser tool for developers and AI coding agents.

It finds the problems that are easy to miss after AI generates a page:

- 🔴 Buttons that do nothing
- 🔴 Broken links and 404s
- 🔴 Failed images
- 🔴 JavaScript errors
- 🟠 Text that is cut off
- 🟠 Empty UI elements
- 🟠 Broken or incomplete forms
- 🟠 Missing labels and accessibility problems

Then it turns the findings into plain text that you can give straight back to your AI coding agent.

No MCP server. No dependencies. No complicated setup.

---

🚀 The problem

AI coding agents are getting very good at writing frontend code.

But there is a gap:

«They can read the code. They can run the app. But they don't automatically know what the finished page actually looks and behaves like in a real browser.»

That's how you end up with:

Beautiful dashboard
        ↓
Everything looks finished
        ↓
"Save" button does nothing
        ↓
Image failed to load
        ↓
Mobile layout is broken
        ↓
Nobody noticed

Browser Agent gives your AI a real browser to inspect the result.

---

⚡ Try it in 60 seconds

1. Requirements

You need:

- Node.js 22+
- Chrome, Chromium, or Edge

That's it.

There are zero npm dependencies.

2. Clone the project

git clone https://github.com/samstacksys/browser-agent.git
cd browser-agent

3. Test your setup

npm test

This runs Browser Agent against its own test page.

The test page deliberately contains broken things such as:

- a JavaScript error
- a 404
- a broken interaction
- a form
- a redirect

If the tests pass, your browser setup is working.

4. Open your website

Start your website normally.

For example:

npm run dev

Then:

node browser.js open http://localhost:3000

5. Find the problems

node browser.js doctor

You might get:

Checked http://localhost:3000/dashboard

2 problems (1 high, 1 mid)

#1 [high] A button does nothing when clicked
    "Save changes" · #save

    Fix: Attach a click handler, or make it a real link.

#2 [mid] Text is cut off
    "Total for March 2026..." · .summary > span.total

    Fix: Let it wrap, or use text-overflow: ellipsis.

That's the whole idea.

Open → Inspect → Fix.

---

🤖 Give the bugs back to your AI

This is where Browser Agent becomes especially useful.

Run:

node browser.js doctor --paste --out=bugs.md

Now you have:

bugs.md

The file contains the findings in a format designed for an AI coding agent.

It includes:

- what went wrong
- where it happened
- the selector
- relevant markup
- why it is a problem
- a suggested fix

Give "bugs.md" to Claude, Gemini, ChatGPT, Cursor, Codex, or another coding agent.

Instead of telling the AI:

«"Something on the dashboard doesn't work."»

You can give it:

«"Here are the problems Browser Agent found in the actual rendered page. Fix them one at a time."»

Less guessing. More fixing.

---

🩺 The "doctor" command

"doctor" is the main feature.

node browser.js doctor

It checks the page for things that can be detected from a real browser.

It can find

Problem| What it checks
Dead buttons| Whether buttons appear to have real handlers
Broken links| Empty, "#", JavaScript and unreachable links
404 links| Server responses
Failed images| Images that didn't load
JavaScript errors| Console errors and uncaught exceptions
Cut-off text| Content hidden by its container
Missing labels| Form fields without proper labels
Missing "name"| Fields that won't submit their value
Duplicate IDs| Duplicate HTML IDs
Broken labels| Labels pointing to missing elements
Broken forms| Forms without useful actions
HTTP form posts| Insecure form submissions
Empty UI| Large empty elements that look broken
Missing alt text| Images without alternative text

Findings are numbered and ordered by severity.

---

🖱️ Test suspicious buttons

A button can look completely normal while doing absolutely nothing.

Use:

node browser.js doctor --click

Browser Agent will test suspicious buttons in the real browser.

Example:

4 buttons checked:
2 have a handler
2 have none

Clicked 1 suspicious button:
1 confirmed dead

1 left alone because it looks destructive:
Delete account

Destructive-looking actions are skipped automatically.

"--click" is opt-in because actually pressing a button is the only reliable way to know whether it works.

---

📋 Useful "doctor" options

Generate AI-ready output

node browser.js doctor --paste

Save the report

node browser.js doctor --paste --out=bugs.md

Test buttons

node browser.js doctor --click

Skip network checks

node browser.js doctor --no-network

Use it in CI

node browser.js doctor --strict

"--strict" exits with code "1" when high-severity problems are found.

Limit how many items are checked

node browser.js doctor --limit=20

---

🌐 Use it as a browser

Browser Agent is not only a diagnostic tool.

It can also give an AI coding agent a persistent browser session.

Open a page

node browser.js open https://example.com

See what is on the page

node browser.js state

Read visible text

node browser.js text

List buttons

node browser.js buttons

List links

node browser.js links

Click something

node browser.js click "#login"

Fill a form

node browser.js fill "#email" "me@example.com"

Press a key

node browser.js press Enter

Take a screenshot

node browser.js screenshot

Check errors

node browser.js errors

Get the current URL

node browser.js url

The browser stays alive between commands.

That means an agent can do:

open
   ↓
fill
   ↓
click
   ↓
state
   ↓
errors
   ↓
doctor

The session keeps its cookies and page state.

---

📱 Test desktop and mobile layouts

Use a specific viewport:

node browser.js --viewport=1440x900 open https://example.com

Or use the built-in mobile size:

node browser.js --mobile open https://example.com

Mobile uses a 390×844 viewport.

---

🤖 For AI coding agents

Browser Agent works particularly well with terminal-based coding agents such as:

- Claude Code
- Cursor
- Codex
- Gemini-based coding workflows
- Other agents that can run shell commands

The agent can control the browser using normal shell commands and read the results as plain text.

No MCP server is required.

For agent-specific instructions, see:

""AGENT-SNIPPET.md"" (./AGENT-SNIPPET.md)

You can copy the instructions into:

AGENTS.md
CLAUDE.md
.cursorrules

---

🧠 Why a real browser?

A normal HTTP request can tell you that a page returned "200".

It cannot reliably tell you:

«"The Save button looks real but does nothing."»

A DOM parser can inspect HTML.

It cannot reliably tell you:

«"This image failed to load."»

A test can pass.

The production page can still be broken.

Browser Agent uses an actual Chromium-based browser, so it can inspect the rendered page, execute JavaScript, observe errors and interact with the UI.

That's the important difference.

---

🛠️ Requirements

Node.js

Node 22 or newer.

Browser Agent uses Node's built-in "WebSocket" and "fetch", so there are no runtime npm dependencies.

Browser

One of:

- Chrome
- Chromium
- Edge

Browser Agent searches common locations automatically.

You can also specify one manually:

node browser.js --browser=/path/to/chrome open https://example.com

Or:

BROWSER_PATH=/path/to/chrome

Check that everything is available:

node browser.js start

---

📚 All commands

Run:

node browser.js help

Inspect

state
text [selector]
html [selector]
links
buttons
forms
count <selector>
screenshot [file]

Interact

click <selector>
fill <selector> <text>
select <selector> <value>
press <key>
scroll [px|up|down|top|bottom]
eval <expression>
wait <selector>

Navigate

open <url>
reload
back
forward
url
title

Diagnose

doctor
errors
console

Tabs

tabs
newtab [url]
use <n>
closetab <n>

Browser lifecycle

start
stop
status
help

---

🔐 Sessions

You can run multiple independent browser sessions.

node browser.js --session=signup open https://example.com/signup

And another:

node browser.js --session=checkout open https://example.com/cart

Each session has its own browser and cookies.

---

⚠️ Important limitations

Browser Agent is designed to be useful, not magical.

"doctor" is a heuristic

A clean report means:

«"Browser Agent didn't find anything it knows how to detect."»

It does not mean:

«"This website is guaranteed to be perfect."»

Clicks are DOM clicks

"click" works well with normal HTML and frameworks such as React and Vue.

It is not a replacement for real mouse interaction with:

- drag-and-drop
- hover-only interfaces
- canvas applications
- pointer-only widgets

One viewport at a time

Browser Agent can test different viewport sizes, but it is not a complete device emulator.

Authentication

Browser Agent does not bypass authentication.

Log in through the real application like a normal user.

Headless browser

Browser Agent uses a headless browser.

The browser is running, but there is no visible Chrome window.

---

🏗️ How it works

The project intentionally keeps the architecture small.

AI agent
   │
   │ shell commands
   ▼
browser.js
   │
   │ WebSocket / CDP
   ▼
Chrome / Chromium / Edge
   │
   ▼
Your actual website

There is:

- no Puppeteer
- no Playwright
- no "ws"
- no MCP server
- no runtime dependency stack

The browser stays alive between commands so agents can work with a real session instead of starting from zero every time.

---

📁 Project structure

browser-agent/
├── browser.js
├── selftest.js
├── index.html
├── AGENT-SNIPPET.md
├── README.md
└── LICENSE

"browser.js" contains the main CLI, browser communication and helpers.

"selftest.js" runs the project's own browser tests.

"AGENT-SNIPPET.md" contains instructions designed specifically for AI coding agents.

---

🎯 The idea

AI-generated software is getting faster.

The next problem is making sure the software it generates actually works.

Browser Agent is a small step toward closing that gap.

«AI builds the page.
Browser Agent checks the page.
AI fixes the page.»

---

🤝 Contributing

Issues, ideas and pull requests are welcome.

If you find a type of frontend bug that Browser Agent should detect, open an issue or contribute a detector.

---

📄 License

MIT