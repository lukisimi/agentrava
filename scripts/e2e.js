import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';

const home = path.join(os.tmpdir(), 'agentrava-e2e-' + Date.now());
const client = new Client({ name: 'e2e', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: ['src/index.js'],
  env: { ...process.env, AGENTRAVA_HOME: home },
}));

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '), '\n');

const r1 = await client.callTool({ name: 'log_activity', arguments: {
  type: 'refactor', repo: 'agentrava', summary: 'Split the card renderer out of the server.',
  duration_seconds: 900, tool_calls: 22, files_changed: 4,
  lines_added: 210, lines_removed: 340, tokens: 88000, tests_passed: 12,
  languages: ['JavaScript'],
} });
console.log(r1.content.map((c) => c.type === 'image' ? `[image ${c.mimeType} ${c.data.length}b64]` : c.text).join('\n'));

const r2 = await client.callTool({ name: 'log_activity', arguments: {
  type: 'debug', repo: 'agentrava', duration_seconds: 11000, tool_calls: 140,
  files_changed: 9, lines_added: 900, lines_removed: 120, tokens: 700000,
  errors_recovered: 5, tests_passed: 30, tests_failed: 2, languages: ['Go','SQL','Bash'],
} });
console.log('\n' + r2.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));

console.log('\n' + (await client.callTool({ name: 'get_profile' })).content[0].text);
console.log('\n' + (await client.callTool({ name: 'leaderboard', arguments: { metric: 'effort' } })).content[0].text);
console.log('\n' + (await client.callTool({ name: 'list_activities' })).content[0].text);

// error path
const bad = await client.callTool({ name: 'log_activity', arguments: { duration_seconds: 'banana', tool_calls: -5 } });
console.log('\nGARBAGE INPUT ->', bad.isError ? 'ERROR' : 'handled: ' + bad.content[0].text.split('\n')[1]);

await client.close();
console.log('\ncards:', fs.readdirSync(path.join(home, 'cards')).join(' '));
console.log('E2E OK');
