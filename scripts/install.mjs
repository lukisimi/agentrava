#!/usr/bin/env node
// One-command setup. Idempotent, backs up anything it edits, and --uninstall
// reverses every change.
//
//   node scripts/install.mjs [--cursor] [--uninstall]
//   node scripts/install.mjs --manual    remove the Stop hook, keep everything else
//   node scripts/install.mjs --auto      put the Stop hook back
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'index.js');
const HOOK = path.join(ROOT, 'hooks', 'session-log.mjs');
const STAMP = path.join(ROOT, 'hooks', 'day-stamp.sh');
const CURSOR_HOOK = path.join(ROOT, 'hooks', 'cursor-probe.mjs');
const HOOK_CMD = `node ${HOOK}`;
const STAMP_CMD = `sh ${STAMP}`;

const argv = process.argv.slice(2);
const UNINSTALL = argv.includes('--uninstall');
const WITH_CURSOR = argv.includes('--cursor');
// --manual keeps the MCP server and CLI but stops logging on every turn.
const MANUAL = argv.includes('--manual');
const AUTO = argv.includes('--auto');
// Manual mode still records which days you worked, unless asked not to.
const NO_STAMP = argv.includes('--no-stamp');
const ok = (s) => console.log(`  ✓ ${s}`);
const skip = (s) => console.log(`  · ${s}`);
const warn = (s) => console.log(`  ! ${s}`);

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

const MODE = UNINSTALL ? 'uninstall' : MANUAL ? 'switch to manual' : AUTO ? 'switch to auto' : 'install';
console.log(`\nAgentrava ${MODE}\n${'─'.repeat(46)}`);

// 1. dependencies
if (!UNINSTALL && !MANUAL && !AUTO) {
  if (fs.existsSync(path.join(ROOT, 'node_modules', '@modelcontextprotocol'))) skip('dependencies already installed');
  else {
    process.stdout.write('  installing dependencies… ');
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'ignore' });
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
  let present = false;
  try { present = execFileSync(CLAUDE, ['mcp', 'list'], { encoding: 'utf8', timeout: 30000 }).includes('agentrava'); } catch { /* fall through */ }
  if (present) skip('agentrava already registered');
  else {
    execFileSync(CLAUDE, ['mcp', 'add', 'agentrava', '-s', 'user', '--', 'node', SERVER], { stdio: 'ignore' });
    ok('registered at user scope');
  }
}

// 3. Claude Code Stop hook
console.log('\nClaude Code auto-logging');
const settings = path.join(os.homedir(), '.claude', 'settings.json');
const cfg = readJson(settings, {});
const stop = (cfg.hooks ||= {}).Stop ||= [];
const has = stop.some((e) => (e.hooks || []).some((h) => h.command === HOOK_CMD));
if (UNINSTALL || MANUAL) {
  if (!has) skip('no Stop hook to remove — already manual');
  else {
    const b = backup(settings);
    cfg.hooks.Stop = stop
      .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => h.command !== HOOK_CMD) }))
      .filter((e) => e.hooks.length);
    if (!cfg.hooks.Stop.length) delete cfg.hooks.Stop;
    if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
    writeJson(settings, cfg);
    ok(`Stop hook removed (backup ${b})`);
  }
} else if (has) skip('Stop hook already installed');
else {
  const b = fs.existsSync(settings) ? backup(settings) : null;
  stop.push({ hooks: [{ type: 'command', command: HOOK_CMD, async: true, timeout: 30, statusMessage: 'Logging to Agentrava' }] });
  writeJson(settings, cfg);
  ok(`Stop hook installed${b ? ` (backup ${b})` : ''}`);
}

// 3b. Day stamp: keeps streaks honest in manual mode for ~1% of the cost.
{
  const cfg2 = readJson(settings, {});
  const stopList = (cfg2.hooks ||= {}).Stop ||= [];
  const hasStamp = stopList.some((e) => (e.hooks || []).some((h) => h.command === STAMP_CMD));
  const wantStamp = MANUAL && !NO_STAMP;

  if (wantStamp && !hasStamp) {
    stopList.push({ hooks: [{ type: 'command', command: STAMP_CMD, async: true, timeout: 5 }] });
    writeJson(settings, cfg2);
    ok('day-stamp hook installed (records the date only, ~10ms)');
  } else if (wantStamp && hasStamp) {
    skip('day-stamp hook already installed');
  } else if ((UNINSTALL || AUTO) && hasStamp) {
    cfg2.hooks.Stop = stopList
      .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => h.command !== STAMP_CMD) }))
      .filter((e) => e.hooks.length);
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
  const cmd = `node ${CURSOR_HOOK}`;
  const had = Object.values(ccfg.hooks || {}).some((l) => l.some((h) => h.command === cmd));
  if (UNINSTALL) {
    if (!had) skip('no Cursor hook to remove');
    else {
      const b = backup(ch);
      for (const k of Object.keys(ccfg.hooks)) {
        ccfg.hooks[k] = ccfg.hooks[k].filter((h) => h.command !== cmd);
        if (!ccfg.hooks[k].length) delete ccfg.hooks[k];
      }
      writeJson(ch, ccfg); ok(`Cursor hook removed (backup ${b})`);
    }
  } else if (had) skip('Cursor probe already installed');
  else {
    const b = fs.existsSync(ch) ? backup(ch) : null;
    for (const ev of ['stop']) ((ccfg.hooks ||= {})[ev] ||= []).push({ command: cmd });
    writeJson(ch, ccfg);
    ok(`Cursor probe installed${b ? ` (backup ${b})` : ''}`);
  }
}

console.log(`\n${'─'.repeat(46)}`);
if (MANUAL) {
  console.log(`Manual mode. Sessions are logged only when you ask:

  npm run log                    the session you are in
  node scripts/card.mjs --best   your biggest session
  node scripts/recap.js          season recap

A day-stamp hook still records which days you worked (~10ms, one line a day),
so streaks stay honest without logging every session. Skip it with --no-stamp.

The MCP tools still work; ask for a snapshot in chat.
Put automatic logging back with: npm run setup -- --auto
`);
} else if (UNINSTALL) {
  console.log(`Done. Your activities and cards are untouched in ~/.agentrava —\ndelete that directory yourself if you want them gone.\n`);
} else {
  console.log(`Done. Restart Claude Code, then:

  node scripts/backfill.mjs      log every past session
  node scripts/recap.js          season recap card
  node scripts/card.mjs --best   your biggest session
`);
}
