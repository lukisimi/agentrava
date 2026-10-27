#!/usr/bin/env node
// One-command setup. Idempotent, backs up anything it edits, and --uninstall
// reverses every change.
//
//   npx agentrava setup                  install or update; offers to log your history
//   node scripts/install.mjs             the same, from a clone
//   ... [--cursor] [--codex] [--hermes] [--yes] [--uninstall]
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

// 5b. Hermes Agent. MCP servers and shell hooks both live in ~/.hermes/config.yaml.
// There is no YAML parser here, so our lines go in as text between marker
// comments — found again by the markers, never by guessing at the YAML.
const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const HERMES_CONF = path.join(HERMES_HOME, 'config.yaml');
const HERMES_ALLOW = path.join(HERMES_HOME, 'shell-hooks-allowlist.json');
const HERMES_HOOK = path.join(ROOT, 'hooks', 'hermes-log.mjs');
// Hermes splits the command with shlex and runs it without a shell, so the
// interpreter is named by absolute path and paths with spaces are quoted.
const shq = (p) => (/\s/.test(p) ? `"${p}"` : p);
const HERMES_CMD = `${shq(process.execPath)} ${shq(HERMES_HOOK)}`;
const BEGIN = '# agentrava:begin', END = '# agentrava:end';

const indentOf = (l) => l.length - l.trimStart().length;
const isContent = (l) => l.trim() && !l.trim().startsWith('#');

// Drop everything between our markers. A key left with nothing under it becomes
// `{}` rather than null, which is what it most likely said before we arrived.
function yamlWithout(body) {
  const out = [];
  let inside = false;
  for (const line of body.split('\n')) {
    if (line.trim() === BEGIN) {
      inside = true;
      const prev = out.length - 1;
      if (prev >= 0 && /^\s*[\w-]+:$/.test(out[prev])) out[prev] = { key: out[prev] };
      continue;
    }
    if (line.trim() === END) { inside = false; continue; }
    if (!inside) out.push(line);
  }
  return out.map((l, i) => {
    if (typeof l === 'string') return l;
    const next = out.slice(i + 1).find((n) => typeof n === 'string' && isContent(n));
    const empty = !next || indentOf(next) < indentOf(l.key)
      || (indentOf(next) === indentOf(l.key) && !next.trimStart().startsWith('- '));
    return empty ? `${l.key} {}` : l.key;
  }).join('\n');
}

// Put `block` (lines relative to the deepest key) under keys[0] → keys[1] → …
// Keys that are missing are created inside the markers, so removing the block
// removes them too. Returns null for a layout it cannot edit safely, such as a
// flow mapping (`hooks: {on_session_end: …}`).
function yamlInsert(body, keys, block) {
  const lines = body.split('\n');
  const pad = (n) => ' '.repeat(n);
  let start = 0, end = lines.length, indent = 0;
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    const at = lines.findIndex((l, i) => i >= start && i < end && indentOf(l) === indent && isContent(l)
      && new RegExp(`^${key}:(\\s|$)`).test(l.trimStart()));
    if (at === -1) {
      const add = keys.slice(k).map((kk, j) => pad(indent + j * 2) + kk + ':');
      const deep = indent + (keys.length - k) * 2;
      let pos = end;
      while (pos > start && !lines[pos - 1].trim()) pos--;
      lines.splice(pos, 0, pad(indent) + BEGIN, ...add, ...block.map((b) => pad(deep) + b), pad(indent) + END);
      return lines.join('\n');
    }
    const rest = lines[at].trimStart().slice(key.length + 1).replace(/\s+#.*$/, '').trim();
    if (rest && !['{}', '~', 'null'].includes(rest)) return null;
    if (rest) lines[at] = pad(indentOf(lines[at])) + key + ':';
    // The key's block runs until the next line at its own indent or less — but
    // a list under it may sit at the key's own indent (`key:\n- item`).
    const inBlock = (l) => !isContent(l) || indentOf(l) > indent
      || (indentOf(l) === indent && l.trimStart().startsWith('- '));
    let stop = at + 1;
    while (stop < end && inBlock(lines[stop])) stop++;
    const child = lines.slice(at + 1, stop).find(isContent);
    const childIndent = child ? indentOf(child) : indent + 2;
    if (k === keys.length - 1) {
      lines.splice(at + 1, 0, pad(childIndent) + BEGIN, ...block.map((b) => pad(childIndent) + b), pad(childIndent) + END);
      return lines.join('\n');
    }
    start = at + 1; end = stop; indent = childIndent;
  }
  return null;
}

const hermesBody = fs.existsSync(HERMES_CONF) ? fs.readFileSync(HERMES_CONF, 'utf8') : null;
const hermesHad = !!hermesBody && hermesBody.includes(BEGIN);
let withHermes = argv.includes('--hermes');
if (INSTALL && !withHermes && hermesBody !== null && !hermesHad) {
  console.log('');
  withHermes = await ask('Hermes Agent found — let it use Agentrava and log its sessions?', false);
}
// --manual and --auto reach an existing entry too: they add or drop its hook.
if (withHermes || hermesHad) {
  console.log('\nHermes Agent');
  const allow = readJson(HERMES_ALLOW, { approvals: [] });
  const approvals = Array.isArray(allow.approvals) ? allow.approvals : [];
  const ourApproval = (a) => a && a.event === 'on_session_end' && isOurs(String(a.command || '').replace(/"/g, ''), 'hermes-log.mjs');
  if (UNINSTALL) {
    if (!hermesHad) skip('no Hermes entry to remove');
    else { const b = backup(HERMES_CONF); fs.writeFileSync(HERMES_CONF, yamlWithout(hermesBody)); ok(`Hermes MCP entry and hook removed (backup ${b})`); }
    if (approvals.some(ourApproval)) writeJson(HERMES_ALLOW, { ...allow, approvals: approvals.filter((a) => !ourApproval(a)) });
  } else if (hermesBody === null) warn(`no ${HERMES_CONF} — run Hermes once, then re-run with --hermes`);
  else if (hermesHad && hermesBody.includes(SERVER) && hermesBody.includes(HERMES_HOOK) === !MANUAL) {
    skip('Hermes MCP entry and hook already installed');
  } else {
    let body = yamlWithout(hermesBody);
    body = yamlInsert(body, ['mcp_servers'], [
      'agentrava:',
      `  command: ${JSON.stringify(process.execPath)}`,
      `  args: [${JSON.stringify(SERVER)}]`,
      '  env:',
      '    AGENTRAVA_CLIENT: hermes',
    ]);
    // --manual keeps the tools and drops the per-turn hook, as it does for Claude Code.
    if (body !== null && !MANUAL) {
      body = yamlInsert(body, ['hooks', 'on_session_end'], [
        `- command: ${JSON.stringify(HERMES_CMD)}`,
        '  timeout: 60',
      ]);
    }
    if (body === null) {
      warn(`${HERMES_CONF} writes mcp_servers or hooks in a form setup cannot edit safely. Add by hand:`);
      console.log(`\n    mcp_servers:\n      agentrava:\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(SERVER)}]\n` +
        `        env:\n          AGENTRAVA_CLIENT: hermes\n    hooks:\n      on_session_end:\n        - command: ${JSON.stringify(HERMES_CMD)}\n`);
    } else {
      const b = backup(HERMES_CONF);
      fs.writeFileSync(HERMES_CONF, body);
      ok(`Hermes MCP entry${MANUAL ? '' : ' and on_session_end hook'} ${hermesHad ? 'updated' : 'added'} (backup ${b})`);
      // Hermes asks before running a new shell hook — but only in a foreground
      // `hermes chat`; the gateway behind Telegram, Discord and the desktop app
      // never asks and silently skips it. Saying yes above is that approval.
      const kept = approvals.filter((a) => !ourApproval(a));
      if (!MANUAL) kept.push({ event: 'on_session_end', command: HERMES_CMD });
      writeJson(HERMES_ALLOW, { ...allow, approvals: kept });
      if (!MANUAL) ok('hook approved in shell-hooks-allowlist.json — restart Hermes to pick both up');
    }
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
  if (fs.existsSync(path.join(HERMES_HOME, 'state.db'))) {
    if (!found.length && !fs.existsSync(cursorDb)) console.log('\nHistory');
    if (await ask('Hermes history found — log it too?', true)) {
      logged = run('hermes-backfill.mjs') || logged;
    } else skip(`later: ${cli('hermes-backfill', 'hermes-backfill.mjs')}`);
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
