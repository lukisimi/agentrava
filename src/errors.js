// Not every failed tool call is the agent stumbling.
//
// A card's elevation is meant to say how much work had to be redone. Measured
// across 166 real Claude Code errors, 12% were nothing of the sort: the user
// declining a tool call, the permission layer blocking one, a model or an MCP
// server being briefly unavailable. Each of those was adding 120 m of climb and
// a loop in the route, so three circles could be two real failures and one
// moment where the human said no.
//
// These are counted separately and left out of the climb. The test is on the
// error text, which all three clients record: Claude Code in the tool_result,
// Codex in the failed item, Cursor in toolFormerData.result.
//
// Deliberately NOT here: "permission denied" (a real filesystem failure the
// agent has to work around), a bare "timed out" (usually the agent's own command
// hanging), "connection refused" (usually a dev server it forgot to start).
export const ENVIRONMENTAL = [
  // the human, or the permission layer acting for them, said no
  "doesn't want to proceed",
  'tool use was rejected',
  'user rejected',
  'rejected by the user',
  'user declined',
  'not approved',
  'requires approval',
  'tool_use_error>blocked',
  // the other end was not there
  ' unavailable',
  'overloaded',
  'rate limit',
  'quota exceeded',
];

// Only the head of the message is tested. These failures announce themselves in
// their first line, whereas a long command output can mention "rate limit" or
// "unavailable" anywhere — 609 successful Cursor tool results contain the phrase
// "rate limit", and none of them is a rate limit.
export const HEAD = 300;

export function isEnvironmentError(text) {
  if (!text) return false;
  const t = String(text).slice(0, HEAD).toLowerCase();
  return ENVIRONMENTAL.some((p) => t.includes(p));
}

// The same test as SQL, for Cursor — its errors are counted inside one grouped
// pass over a multi-gigabyte table, and pulling them into JS would mean a second
// scan. `expr` must be an SQL expression yielding the error text.
export function sqlEnvironmental(expr) {
  const esc = (p) => p.replace(/'/g, "''");
  const head = `lower(substr(coalesce(${expr},''),1,${HEAD}))`;
  return '(' + ENVIRONMENTAL.map((p) => `${head} LIKE '%${esc(p)}%'`).join(' OR ') + ')';
}
