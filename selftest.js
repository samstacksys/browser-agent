#!/usr/bin/env node
'use strict';

/**
 * selftest.js — prove browser.js works on THIS machine, in about 20 seconds.
 *
 * The whole point of this tool is that it touches a real browser, so the only
 * honest way to test it is with a real browser. This serves a page with a
 * deliberate console error, a deliberate 404, a form, a button and a JavaScript
 * redirect, then drives the same commands an agent would use and checks what
 * came back. It never touches your apps and needs no network.
 *
 *   npm test
 *
 * Exits non-zero on the first thing that is broken, and says which.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SESSION = 'selftest';
const CLI = path.join(__dirname, 'browser.js');

const PAGE_ONE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Selftest one</title></head>
<body>
  <h1 id="title">Test page</h1>
  <p id="intro">This text exists so the agent can read it.</p>
  <a id="to-two" href="/two">Go to page two</a>
  <a id="late" href="/two" data-late>Go with a late redirect</a>
  <button id="shout" type="button">Do it</button>
  <button id="dead" type="button">Save changes</button>
  <div id="host"><button id="delegated" type="button">Delegated action</button></div>
  <button id="nuke" type="button">Delete account</button>
  <div id="output">nothing yet</div>
  <form>
    <input id="who" name="who" type="text" placeholder="your name">
    <select id="pick" name="pick"><option value="a">A</option><option value="b">B</option></select>
    <input id="secret" name="secret" type="password">
  </form>
  <img id="missing" src="/definitely-not-here.png" alt="breaks on purpose">
  <script>
    document.getElementById('shout').addEventListener('click', function () {
      document.getElementById('output').textContent = 'SHOUTED';
    });
    // No listener on the button itself: the handler lives one level up, which
    // is what React does. The doctor must not call this one dead.
    document.getElementById('host').addEventListener('click', function (e) {
      if (e.target.id === 'delegated') document.getElementById('output').textContent = 'DELEGATED';
    });
    document.getElementById('to-two').addEventListener('click', function (e) { e.preventDefault(); });
    document.getElementById('late').addEventListener('click', function (e) {
      e.preventDefault();
      // A redirect that lands late is what naive waiting gets wrong.
      setTimeout(function () { location.href = '/two'; }, 900);
    });
    fetch('/definitely-not-here.json');
    console.log('an ordinary message');
    console.error('a deliberate error');
    // A real throw, so the doctor's exception path is covered and not just
    // the console path.
    window.__boom = null;
    window.__boom.explode();
  </script>
</body></html>`;

const PAGE_TWO = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Selftest two</title></head>
<body><h1 id="title">Second page</h1><p id="intro">You made it to the second one.</p></body></html>`;

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
}

/**
 * Runs the CLI and returns its output.
 *
 * Deliberately async. spawnSync would block this process's event loop, and the
 * page under test is served BY this process: the browser would wait for a
 * response that could never arrive, and the first navigation would time out.
 * That is not a bug in the browser tool, it is a bug in a test harness that
 * stops serving while it waits.
 */
function browser(args, { expectFailure = false, expectStatus = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, `--session=${SESSION}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    const timer = setTimeout(() => {
      // A bare kill, not a signal. On Windows SIGKILL is emulated, and killing
      // a child there is a well-known way to trip libuv's UV_HANDLE_CLOSING
      // assertion, which aborts the test run instead of failing one check.
      child.kill();
      reject(new Error(`browser.js ${args.join(' ')} did not finish in 120s\n${out}`));
    }, 120000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      // A command can answer correctly and still exit non-zero — `doctor
      // --strict` found something, which is a result, not a crash. So the
      // expected status is checked separately from success.
      if (expectStatus !== null && status !== expectStatus) {
        reject(new Error(`browser.js ${args.join(' ')} exited ${status}, expected ${expectStatus}\n${out}`));
        return;
      }
      if (!expectFailure && status !== 0) {
        reject(new Error(`browser.js ${args.join(' ')} exited ${status}\n${out}`));
        return;
      }
      resolve(out);
    });
  });
}

function main() {
  const server = http.createServer((req, res) => {
    if (req.url === '/two') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE_TWO);
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE_ONE);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.listen(0, '127.0.0.1', async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await run(base);
    } catch (err) {
      console.error(`\n${err.stack || err.message}`);
      failures += 1;
    } finally {
      try { await browser(['stop'], { expectFailure: true }); } catch { /* nothing running */ }
      server.close();
      console.log(failures ? `\n${failures} checks failed.` : '\nAll good.');
      process.exit(failures ? 1 : 0);
    }
  });
}

async function run(base) {
  console.log('Starting the test page...');
  await browser(['stop'], { expectFailure: true });
  await browser(['open', base]);

  console.log('\nRead the page:');
  const state = await browser(['state', '--text=400']);
  check('state returns the url', state.includes(base), state.slice(0, 200));
  check('state returns the title', state.includes('Selftest one'));
  check('state includes the visible text', state.includes('Test page'));
  check('state lists the button', state.includes('Do it'));
  check('state lists the fields', state.includes('id=who'), state);

  check('text of one selector', (await browser(['text', '#intro'])).includes('This text exists'));
  check('title', (await browser(['title'])).includes('Selftest one'));
  check('url', (await browser(['url'])).includes('127.0.0.1'));
  check('count', (await browser(['count', 'a[href]'])).trim() === '2');
  check('links', (await browser(['links'])).includes('/two'));
  check('html', (await browser(['html', '#title'])).includes('Test page'));

  console.log('\nDiagnose:');
  const errors = await browser(['errors']);
  check('sees the console error', errors.includes('a deliberate error'), errors);
  check('sees the image 404', errors.includes('404'), errors);
  check('sees the failed request', errors.includes('not-here.json') || errors.includes('404'), errors);

  console.log('\nAct on the page:');
  await browser(['fill', '#who', 'Ada Lovelace']);
  check('fill writes the value',
    (await browser(['eval', 'document.querySelector("#who").value'])).includes('Ada Lovelace'));
  await browser(['click', '#shout']);
  check('click runs the JavaScript', (await browser(['text', '#output'])).includes('SHOUTED'));
  check('fill never leaks the password', (await browser(['forms'])).includes('value=(set)'),
    'a password must never be printed');
  check('select picks an option', (await browser(['select', '#pick', 'b'])).includes('"b"'));

  console.log('\nNavigate:');
  await browser(['click', '#late']);
  const landed = await browser(['url']);
  check('a click with a late redirect reports the final url', landed.includes('/two'),
    `la url real es ${landed.trim()}`);
  check('the redirect really happened', (await browser(['text', '#title'])).includes('Second page'));
  await browser(['back']);
  check('back goes back', (await browser(['text', '#title'])).includes('Test page'));

  console.log('\nTabs and screenshots:');
  await browser(['newtab', base]);
  const tabs = await browser(['tabs']);
  check('tabs lists two tabs', tabs.trim().split('\n').length === 2, tabs);
  await browser(['use', '0']);
  const shot = path.join(os.tmpdir(), `browser-agent-selftest-${Date.now()}.png`);
  const shotOut = await browser(['screenshot', shot]);
  check('screenshot writes a file', fs.existsSync(shot) && fs.statSync(shot).size > 1000, shotOut);
  check('screenshot says where it is', shotOut.includes(shot));
  fs.rmSync(shot, { force: true });

  console.log('\nThe doctor:');
  const report = await browser(['doctor', '--no-network']);
  check('doctor finds the dead button', report.includes('Save changes') && report.includes('does nothing'), report.slice(0, 600));
  check('doctor finds the broken image', report.includes('did not load'), report.slice(0, 600));
  check('doctor finds the JavaScript error', report.includes('threw an error') && report.includes('explode'), report.slice(0, 600));
  check('doctor finds the logged console error', report.includes('logged an error') && report.includes('a deliberate error'), report.slice(0, 600));
  // The log is a session-wide buffer, so a second doctor run would otherwise
  // report every error from the first one all over again.
  const twice = await browser(['doctor', '--no-network']);
  check('doctor does not repeat the same error twice',
    (twice.match(/a deliberate error/g) || []).length === 1, twice.slice(0, 900));
  // The two that must NOT appear. A tool that cries wolf gets ignored, and the
  // delegated one is the interesting case: no listener on the button, but the
  // handler is one level up, which is how every React button is wired.
  check('doctor does not accuse the button that works', !report.includes('"Do it"'), report.slice(0, 900));
  check('doctor does not accuse the delegated button', !report.includes('Delegated action'), report.slice(0, 900));
  check('doctor numbers its findings', /#1\s+\[high\]/.test(report), report.slice(0, 200));

  const clicked = await browser(['doctor', '--click', '--no-network']);
  check('doctor --click proves it is dead', clicked.includes('confirmed dead'), clicked.slice(0, 900));
  check('doctor --click does not press anything destructive', clicked.includes('destructive') && clicked.includes('Delete account'), clicked.slice(0, 900));

  const pasted = await browser(['doctor', '--paste', '--no-network']);
  check('doctor --paste makes text to paste', pasted.includes('How to fix') && pasted.includes('Where:'), pasted.slice(0, 400));

  const bugsFile = path.join(os.tmpdir(), `browser-agent-selftest-bugs-${Date.now()}.md`);
  const wrote = await browser(['doctor', '--paste', `--out=${bugsFile}`, '--no-network']);
  check('doctor --out writes the file', fs.existsSync(bugsFile) && wrote.includes(bugsFile), wrote);
  fs.rmSync(bugsFile, { force: true });

  await browser(['doctor', '--strict', '--no-network'], { expectFailure: true, expectStatus: 1 });
  check('doctor --strict exits 1 when something high is found', true);

  await browser(['open', `${base}/two`]);
  const clean = await browser(['doctor', '--strict']);
  check('doctor --strict exits 0 on a clean page', clean.includes('No problems found'), clean);
  check('doctor finds nothing wrong with clean page two',
    !clean.includes('does nothing') && !clean.includes('did not load'), clean);
  // The log is session-wide, so the errors from page one are still in it. A
  // clean page must not inherit them: this is the bug that would make every
  // page after a broken one look broken.
  check('doctor does not blame the clean page for the previous page errors',
    !clean.includes('a deliberate error') && !clean.includes('explode'), clean);
  await browser(['open', base]);

  console.log('\nHelp and errors:');
  check('help does not fail', (await browser(['help'])).includes('USAGE'));
  check('an invented command fails with a message',
    (await browser(['nonsense'], { expectFailure: true })).includes('unknown command'));
  check('a missing selector fails with a message',
    (await browser(['click', '#nope'], { expectFailure: true })).includes('no element matches'));
}

main();
