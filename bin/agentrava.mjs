#!/usr/bin/env node
// The `agentrava` command. With no arguments it is the MCP server, so an MCP
// client can launch it as `npx -y agentrava`; with a subcommand it runs the
// matching script, so `npx agentrava setup` needs no clone.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = {
  setup:            ['scripts/install.mjs',        'install, update, --manual, --auto, --uninstall'],
  log:              ['scripts/log-now.mjs',        'log the session you are in (--codex, --cursor, --list)'],
  card:             ['scripts/card.mjs',           'render one card (--best, --title, --share, --photo)'],
  snap:             ['scripts/snap.mjs',           'weekly or monthly snap: snap week | snap month last30'],
  recap:            ['scripts/recap.js',           'season recap card, optional from and to dates'],
  backfill:         ['scripts/backfill.mjs',       'log every past Claude Code session'],
  'codex-backfill': ['scripts/codex-backfill.mjs', 'log every past Codex CLI session'],
  'cursor-backfill':['scripts/cursor-backfill.mjs','log every past Cursor conversation'],
  rename:           ['scripts/rename.mjs',         'rename sessions and projects, or hide a project'],
  whoami:           ['scripts/whoami.mjs',         'the name and avatar on your cards'],
  privacy:          ['scripts/privacy.mjs',        'find and strip subtitles that name people or companies'],
  logo:             ['scripts/logo.mjs',           'install a client logo for the card header'],
};

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd) {
  await import(pathToFileURL(path.join(ROOT, 'src', 'index.js')).href);
} else if (cmd === '--version' || cmd === '-v') {
  console.log(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
} else if (COMMANDS[cmd]) {
  const script = path.join(ROOT, COMMANDS[cmd][0]);
  // Scripts read their own arguments from process.argv, and print hints in
  // the form that was used to run them.
  process.argv = [process.argv[0], script, ...rest];
  process.env.AGENTRAVA_VIA ||= 'npx agentrava';
  await import(pathToFileURL(script).href);
} else {
  const known = cmd === 'help' || cmd === '--help' || cmd === '-h';
  if (!known) console.error(`Unknown command: ${cmd}\n`);
  console.log('agentrava — Strava for coding agents · agentrava.com\n');
  console.log('  agentrava                 run the MCP server (what MCP clients launch)');
  for (const [name, [, what]] of Object.entries(COMMANDS)) console.log(`  agentrava ${name.padEnd(16)}${what}`);
  process.exit(known ? 0 : 1);
}
