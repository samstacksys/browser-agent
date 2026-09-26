# For your agent

Paste the block below into your agent's instructions — `AGENTS.md`, `CLAUDE.md`,
`.cursorrules`, whatever your agent reads. It is written for the agent, not for
you. Replace `BROWSER` with the path to `browser.js`.

---

## You have a browser

You can drive a real browser from the command line. There is no MCP server to set
up and nothing to install. Run `node BROWSER/browser.js help` for the full list.

```console
node BROWSER/browser.js open https://example.com
node BROWSER/browser.js state
node BROWSER/browser.js doctor
```

**`state` is the command to reach for.** One call returns the url, the title, the
visible text, every button, every link and every form field. Read that before you
guess at a selector. Guessing selectors wastes turns; `state` gives you the real
ones.

**`doctor` is the one that finds bugs.** One call tells you what is wrong with the
page: buttons with no handler, images that failed, text cut off, fields with no
label, errors the page threw.

### The workflow

1. `open <url>`
2. `state` — see what is actually there
3. `fill` / `click` / `press` / `select`
4. `state` again — see what changed
5. **`doctor` before you report success**

Step 5 is the one that matters. A command that exits 0 means the click happened,
not that the page worked. `doctor` is what tells you the page is broken, and it is
the whole reason this tool exists. Run it after every change you make to a page,
every time, even when the change looks unrelated to the frontend.

`doctor` returns findings numbered and worst first, and it is the strongest check
here: it asks the browser for the real event listeners, so it catches a button
that looks finished and does nothing — the single most common bug in generated
code. Fix what it reports, then run it again.

It can also write itself out for a web AI, which cannot see the page:

```console
node BROWSER/browser.js doctor --paste --out=bugs.md
```

Use that when the fix is not yours to make — when a human is going to paste it
into claude.ai or gemini.google.com. `bugs.md` has every finding with its
selector, the markup that caused it and how to fix it.

### Things that will trip you up

- **A successful `click` is not a successful action.** It reports the url it
  landed on. Read it. If the app redirects to `localhost` and the user is on a
  domain, the click "worked" and the feature is broken. This is a real bug that
  passed a real test suite.
- **`doctor --click` presses real buttons.** Do not reach for it on a page where
  clicking something spends money or deletes data. It skips what sounds
  destructive and tells you what it skipped, but that list is a word list.
- **A clean `doctor` is not a clean page.** It is a heuristic. It reads one page
  at a time, so a bug that only appears three steps into a flow needs the flow.
- **`fill` does not submit.** It types and fires `input` and `change`. You still
  need to `click` the submit button or `press Enter`.
- **Read `state`, do not guess.** The fields list gives you real `id` and `name`
  values. A selector you invented will not exist and the error will say so.
- **Never pass a password as a command argument.** It ends up in shell history and
  in the process list. Read it from the environment instead.
- **`text` is the page as a user sees it.** `html` is the source. Use `text` to
  check whether something is visible; use `html` when you need the markup.
- **Do not `screenshot` to check something.** You cannot read the image. Use
  `state` and `doctor`. Screenshots are for the human.
- **`console --clear` when you change tack**, so old errors are not mistaken for
  new ones.
- **Sessions are separate browsers.** `node BROWSER/browser.js --session=login ...`
  keeps its own cookies. Use one session per user or flow, and `stop` them when
  you are done so nothing is left running.

### When to reach for this

Any time you are about to report that you changed something on a page and it
works. If you touched HTML, CSS, a redirect, a link, a form or a build config,
open the page and check. If you did not touch any of those, this tool probably is
not needed for this change.

### Cleanup

When you are finished, run `node BROWSER/browser.js stop`. It closes the browser
and deletes its temporary profile. Leaving sessions running costs memory.
