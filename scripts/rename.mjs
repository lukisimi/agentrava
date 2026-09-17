#!/usr/bin/env node
// Rename sessions and projects. Cards are redrawn immediately.
//
//   node scripts/rename.mjs session 4e374e0a "Chasing the photo bug"
//   node scripts/rename.mjs session 4e374e0a --reset
//   node scripts/rename.mjs project "acme-api-service" "API"
//   node scripts/rename.mjs project API --reset
//   node scripts/rename.mjs project API --hide           # keep it off shared cards
//   node scripts/rename.mjs project API --show
//   node scripts/rename.mjs projects                      # list them
import { renameSession, renameProject, listProjects, describeProject } from '../src/names.js';

const [kind, target, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const value = rest.find((a) => !a.startsWith('--'));

try {
  if (kind === 'projects') {
    const list = listProjects();
    if (!list.length) console.log('No projects recorded yet.');
    for (const p of list) console.log(describeProject(p));
  } else if (kind === 'session') {
    if (!flags.has('--reset') && value === undefined) throw new Error('Give a new title, or --reset.');
    const r = renameSession(target, flags.has('--reset') ? null : value);
    console.log(r.reset ? `Reset to "${r.after}"` : `"${r.before}" → "${r.after}"`);
    console.log(`Redrew ${r.cards.length} card: ${r.cards[0] || '(none on disk)'}`);
  } else if (kind === 'project') {
    const opts = {};
    if (flags.has('--reset')) opts.name = null; else if (value !== undefined) opts.name = value;
    if (flags.has('--hide')) opts.hidden = true;
    if (flags.has('--show')) opts.hidden = false;
    const r = renameProject(target, opts);
    console.log(`"${r.before}" → "${r.after}"${r.hidden ? '  [hidden on cards]' : ''}`);
    console.log(`Redrew ${r.cards.length} card${r.cards.length === 1 ? '' : 's'} for this project.`);
  } else {
    throw new Error('usage: rename.mjs session <id> "title" | --reset\n' +
                    '       rename.mjs project <name|path> "name" | --reset | --hide | --show\n' +
                    '       rename.mjs projects');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
