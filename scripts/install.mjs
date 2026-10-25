#!/usr/bin/env node
// One-command setup. Idempotent, backs up anything it edits, and --uninstall
// reverses every change.
//
//   npx agentrava setup                  install or update; offers to log your history
//   node scripts/install.mjs             the same, from a clone
//   ... [--cursor] [--codex] [--yes] [--uninstall]
//   ... --manual    remove the Stop hook, keep everything else
//   ... --auto      put the Stop hook back
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.AGENTRAVA_HOME || path.join(os.homedir(), '.agentrava');
// npx runs a package from a cache npm may clear at any time, and the hook and
// server are registered by absolute path. Outside a clone, the package copies
// itself here first and is registered from here.
const APP = path.join(DATA, 'app');
const FROM_CLONE = fs.existsSync(path.join(ROOT, '.git'));

const SERVER = path.join(ROOT, 'src', 'index.js');
const HOOK = path.join(ROOT, 'hooks', 'session-log.mjs');
const STAMP = path.join(ROOT, 'hooks', 'day-stamp.sh');
const CURSOR_HOOK = path.join(ROOT, 'hooks', 'cursor-probe.mjs');
const HOOK_CMD = `node ${HOOK}`;
const STAMP_CMD = `sh ${STAMP}`;
const CURSOR_CMD = `node ${CURSOR_HOOK}`;

const argv = process.argv.slice(2);
const UNINSTALL = argv.includes('--uninstall');
const WITH_CURSOR = argv.includes('--cursor');
// --manual keeps the MCP server and CLI but stops logging on every turn.
const MANUAL = argv.includes('--manual');
const AUTO = argv.includes('--auto');
// Manual mode still records which days you worked, unless asked not to.
const NO_STAMP = argv.includes('--no-stamp');
const YES = argv.includes('--yes') || argv.includes('-y');
const INSTALL = !UNINSTALL && !MANUAL && !AUTO;
const ok = (s) => console.log(`  ✓ ${s}`);
const skip = (s) => console.log(`  · ${s}`);
const warn = (s) => console.log(`  ! ${s}`);
// How to run a script, in the form that works for this install.
const cli = (sub, file) => (FROM_CLONE ? `node scripts/${file}` : `npx agentrava ${sub}`);
const row = (cmd, what) => `  ${cmd.padEnd(32)} ${what}`;
// Scripts run from here print their hints in the same form.
if (!FROM_CLONE) process.env.AGENTRAVA_VIA = 'npx agentrava';

// 0. Outside a clone, copy to the stable folder and finish the setup from there.
if (!FROM_CLONE && !UNINSTALL && ROOT !== APP) {
  if (INSTALL || !fs.existsSync(path.join(APP, 'scripts', 'install.mjs'))) {
    fs.rmSync(APP, { recursive: true, force: true });
    fs.cpSync(ROOT, APP, {
      recursive: true,
      filter: (src) => path.relative(ROOT, src).split(path.sep)[0] !== 'node_modules',
    });
  }
  const r = spawnSync(process.execPath, [path.join(APP, 'scripts', 'install.mjs'), ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function backup(file) {
  const b = `${file}.agentrava-${Date.now()}.bak`;
  fs.copyFileSync(file, b);
  return path.basename(b);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
// One of our hooks, wherever it was installed from: a clone, or an older copy.
// Matching the exact command only would stack a second hook on every move.
const isOurs = (cmd, file) => typeof cmd === 'string' && cmd.includes('agentrava')
  && cmd.replace(/\\/g, '/').endsWith(`/hooks/${file}`);
// Claude Code nests hooks one level deeper than Cursor does.
function dropOurs(entries, file, keep) {
  return entries
    .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => h.command === keep || !isOurs(h.command, file)) }))
    .filter((e) => e.hooks.length);
}

const interactive = process.stdin.isTTY && !YES;
let rl = null;
async function ask(question, fallback) {
  if (YES) return true;
  if (!interactive) return false;
  rl ||= readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`  ? ${question} ${fallback ? '(Y/n)' : '(y/N)'} `)).trim().toLowerCase();
  return a ? a.startsWith('y') : fallback;
}

const MODE = UNINSTALL ? 'uninstall' : MANUAL ? 'switch to manual' : AUTO ? 'switch to auto' : 'install';
console.log(`\nAgentrava ${MODE}\n${'─'.repeat(46)}`);
if (INSTALL && !FROM_CLONE) ok(`installed to ${ROOT.replace(os.homedir(), '~')}`);

// 1. dependencies
if (INSTALL) {
  if (fs.existsSync(path.join(ROOT, 'node_modules', '@modelcontextprotocol'))) skip('dependencies already installed');
  else {
    process.stdout.write('  installing dependencies… ');
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'ignore' });
    console.log('done');
  }
}

// 2. MCP server registration, via the CLI when it exists so its config format is authoritative
console.log('\nMCP server');
// The CLI is not always on PATH — notably inside the desktop app's shell — so
// check the usual install locations before giving up on registering the server.
function findClaude() {
  const candidates = ['claude',
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
    path.join(os.homedir(), '.claude', 'local', 'claude')];
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 15000 }); return c; } catch { /* next */ }
  }
  return null;
}
const CLAUDE = findClaude();
if (MANUAL || AUTO) {
  skip('MCP server left as it is');
} else if (!CLAUDE) {
  warn('`claude` CLI not found — add this to your MCP client config yourself:');
  console.log(`      {"mcpServers":{"agentrava":{"command":"node","args":["${SERVER}"]}}}`);
} else if (UNINSTALL) {
  try { execFileSync(CLAUDE, ['mcp', 'remove', 'agentrava', '-s', 'user'], { stdio: 'ignore' }); ok('removed agentrava'); }
  catch { skip('agentrava was not registered'); }
} else {
  let current = null;
  try { current = execFileSync(CLAUDE, ['mcp', 'get', 'agentrava'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* not registered */ }
  if (current && current.includes(SERVER)) skip('agentrava already registered');
  else {
    // Registered from somewhere else — an old clone or copy. Point it here.
    if (current) execFileSync(CLAUDE, ['mcp', 'remove', 'agentrava', '-s', 'user'], { stdio: 'ignore' });
    execFileSync(CLAUDE, ['mcp', 'add', 'agentrava', '-s', 'user', '--', 'node', SERVER], { stdio: 'ignore' });
    ok(current ? 'moved to this install' : 'registered at user scope');
  }
}

// 3. Claude Code Stop hook
console.log('\nClaude Code auto-logging');
const settings = path.join(os.homedir(), '.claude', 'settings.json');
const cfg = readJson(settings, {});
const stop = (cfg.hooks ||= {}).Stop ||= [];
const has = stop.some((e) => (e.hooks || []).some((h) => h.command === HOOK_CMD));
const stale = stop.some((e) => (e.hooks || []).some((h) => h.command !== HOOK_CMD && isOurs(h.command, 'session-log.mjs')));
const ourHooks = has || stale;
if (UNINSTALL || MANUAL) {
  if (!ourHooks) skip('no Stop hook to remove — already manual');
  else {
    const b = backup(settings);
    cfg.hooks.Stop = dropOurs(stop, 'session-log.mjs');
    if (!cfg.hooks.Stop.length) delete cfg.hooks.Stop;
    if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
    writeJson(settings, cfg);
    ok(`Stop hook removed (backup ${b})`);
  }
} else if (has && !stale) skip('Stop hook already installed');
else {
  const b = fs.existsSync(settings) ? backup(settings) : null;
  cfg.hooks.Stop = dropOurs(stop, 'session-log.mjs', HOOK_CMD);
  if (!has) cfg.hooks.Stop.push({ hooks: [{ type: 'command', command: HOOK_CMD, async: true, timeout: 30, statusMessage: 'Logging to Agentrava' }] });
  writeJson(settings, cfg);
  ok(`Stop hook ${stale ? 'moved to this install' : 'installed'}${b ? ` (backup ${b})` : ''}`);
}

// 3b. Day stamp: keeps streaks honest in manual mode for ~1% of the cost.
{
  const cfg2 = readJson(settings, {});
  const stopList = (cfg2.hooks ||= {}).Stop ||= [];
  const hasStamp = stopList.some((e) => (e.hooks || []).some((h) => h.command === STAMP_CMD));
  const anyStamp = stopList.some((e) => (e.hooks || []).some((h) => isOurs(h.command, 'day-stamp.sh')));
  const wantStamp = MANUAL && !NO_STAMP;

  if (wantStamp && !hasStamp) {
    cfg2.hooks.Stop = dropOurs(stopList, 'day-stamp.sh');
    cfg2.hooks.Stop.push({ hooks: [{ type: 'command', command: STAMP_CMD, async: true, timeout: 5 }] });
    writeJson(settings, cfg2);
    ok('day-stamp hook installed (records the date only, ~10ms)');
  } else if (wantStamp && hasStamp) {
    skip('day-stamp hook already installed');
  } else if ((UNINSTALL || AUTO) && anyStamp) {
    cfg2.hooks.Stop = dropOurs(stopList, 'day-stamp.sh');
    if (!cfg2.hooks.Stop.length) delete cfg2.hooks.Stop;
    if (!Object.keys(cfg2.hooks).length) delete cfg2.hooks;
    writeJson(settings, cfg2);
    ok('day-stamp hook removed');
  }
}

// 4. Cursor probe, opt-in
if (WITH_CURSOR || UNINSTALL) {
  console.log('\nCursor');
  const ch = path.join(os.homedir(), '.cursor', 'hooks.json');
  const ccfg = readJson(ch, { version: 1, hooks: {} });
  const lists = Object.values(ccfg.hooks || {});
  const had = lists.some((l) => l.some((h) => h.command === CURSOR_CMD));
  const any = lists.some((l) => l.some((h) => isOurs(h.command, 'cursor-probe.mjs')));
  const staleCursor = lists.some((l) => l.some((h) => h.command !== CURSOR_CMD && isOurs(h.command, 'cursor-probe.mjs')));
  const clear = (keep) => {
    for (const k of Object.keys(ccfg.hooks || {})) {
      ccfg.hooks[k] = ccfg.hooks[k].filter((h) => h.command === keep || !isOurs(h.command, 'cursor-probe.mjs'));
      if (!ccfg.hooks[k].length) delete ccfg.hooks[k];
    }
  };
  if (UNINSTALL) {
    if (!any) skip('no Cursor hook to remove');
    else { const b = backup(ch); clear(); writeJson(ch, ccfg); ok(`Cursor hook removed (backup ${b})`); }
  } else if (had && !staleCursor) skip('Cursor probe already installed');
  else {
    const b = fs.existsSync(ch) ? backup(ch) : null;
    clear(CURSOR_CMD);
    ((ccfg.hooks ||= {}).stop ||= []).push({ command: CURSOR_CMD });
    writeJson(ch, ccfg);
    ok(`Cursor probe installed${b ? ` (backup ${b})` : ''}`);
  }
}

// 5. Codex CLI. Codex reads MCP servers from config.toml, and has no per-turn
// hook to spare — `notify` takes a single program and is usually already
// claimed — so Codex logging is manual: the snapshot tool, or `log --codex`.
const CODEX_CONF = path.join(os.homedir(), '.codex', 'config.toml');
const CODEX_HEADER = '[mcp_servers.agentrava]';
const codexBody = fs.existsSync(CODEX_CONF) ? fs.readFileSync(CODEX_CONF, 'utf8') : null;
let withCodex = argv.includes('--codex');
// Offered rather than assumed: Codex being installed is not a request to change its config.
if (INSTALL && !withCodex && codexBody !== null && !codexBody.includes(CODEX_HEADER)) {
  console.log('');
  withCodex = await ask('Codex CLI found — let it use Agentrava too?', false);
}
if (withCodex || UNINSTALL || (INSTALL && codexBody && codexBody.includes(CODEX_HEADER))) {
  console.log('\nCodex CLI');
  const body = codexBody || '';
  const had = body.includes(CODEX_HEADER);
  // Drop from our header to the next top-level table, leaving the rest alone.
  const without = () => {
    const lines = body.split('\n');
    const start = lines.findIndex((l) => l.trim() === CODEX_HEADER);
    let end = start + 1;
    while (end < lines.length && !/^\[/.test(lines[end])) end++;
    lines.splice(start, end - start);
    return lines.join('\n');
  };
  const block = `\n${CODEX_HEADER}\ncommand = "${process.execPath}"\nargs = ["${SERVER}"]\n`;
  if (UNINSTALL) {
    if (!had) skip('no Codex entry to remove');
    else { const b = backup(CODEX_CONF); fs.writeFileSync(CODEX_CONF, without()); ok(`Codex MCP entry removed (backup ${b})`); }
  } else if (had && body.includes(SERVER)) skip('Codex MCP entry already installed');
  else if (codexBody === null) warn(`no ${CODEX_CONF} — start Codex once, then re-run with --codex`);
  else {
    const b = backup(CODEX_CONF);
    const base = had ? without() : body;
    fs.writeFileSync(CODEX_CONF, (base.endsWith('\n') ? base : base + '\n') + block);
    ok(`Codex MCP entry ${had ? 'moved to this install' : 'added'} (backup ${b}) — restart Codex to pick it up`);
  }
}

// 6. History. The first card someone sees should be one of their own sessions.
let logged = false;
if (INSTALL) {
  const count = (dir, test) => {
    let n = 0;
    const walk = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (test(e.name)) n++;
      }
    };
    walk(dir);
    return n;
  };
  const claudeN = count(path.join(os.homedir(), '.claude', 'projects'), (f) => f.endsWith('.jsonl'));
  const codexN = count(path.join(os.homedir(), '.codex', 'sessions'), (f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));
  const cursorDb = path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  const run = (file, extra = []) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', file), ...extra], { stdio: 'inherit' }).status === 0;

  const found = [claudeN && `${claudeN} Claude Code`, codexN && `${codexN} Codex`].filter(Boolean);
  if (found.length) {
    console.log('\nHistory');
    if (await ask(`Found ${found.join(' and ')} session logs — log them now? Short ones are skipped.`, true)) {
      if (claudeN) logged = run('backfill.mjs') || logged;
      if (codexN) logged = run('codex-backfill.mjs') || logged;
    } else skip(`later: ${cli('backfill', 'backfill.mjs')}`);
  }
  if (fs.existsSync(cursorDb)) {
    if (!found.length) console.log('\nHistory');
    if (await ask('Cursor history found — log it too? Takes about a minute.', false)) {
      logged = run('cursor-backfill.mjs') || logged;
    } else skip(`later: ${cli('cursor-backfill', 'cursor-backfill.mjs')}`);
  }
  if (logged) {
    console.log('\nYour biggest session');
    run('card.mjs', ['--best']);
  }
}
if (rl) rl.close();

// 7. An uninstall from a copy takes the copy with it; the data stays.
if (UNINSTALL && fs.existsSync(path.join(APP, 'package.json')) && !fs.existsSync(path.join(APP, '.git'))) {
  fs.rmSync(APP, { recursive: true, force: true });
  ok(`removed ${APP.replace(os.homedir(), '~')}`);
}

console.log(`\n${'─'.repeat(46)}`);
if (MANUAL) {
  console.log(`Manual mode. Sessions are logged only when you ask:

${row(cli('log', 'log-now.mjs'), 'the session you are in')}
${row(cli('card', 'card.mjs') + ' --best', 'your biggest session')}
${row(cli('recap', 'recap.js'), 'season recap')}

A day-stamp hook still records which days you worked (~10ms, one line a day),
so streaks stay honest without logging every session. Skip it with --no-stamp.

The MCP tools still work; ask for a snapshot in chat.
Put automatic logging back with: ${cli('setup', 'install.mjs')} --auto
`);
} else if (UNINSTALL) {
  console.log(`Done. Your activities and cards are untouched in ${DATA.replace(os.homedir(), '~')} —\ndelete that directory yourself if you want them gone.\n`);
} else if (AUTO) {
  console.log('Automatic logging is back on.\n');
} else {
  console.log(`Done. Restart Claude Code, then ask: "show my agentrava"
${logged ? '' : `\n${row(cli('backfill', 'backfill.mjs'), 'log every past session')}`}
${row(cli('card', 'card.mjs') + ' --best', 'your biggest session')}
${row(cli('snap', 'snap.mjs') + ' week', 'this week on one card')}

Update any time with: ${FROM_CLONE ? 'git pull && node scripts/install.mjs' : 'npx agentrava@latest setup'}
`);
}
