'use strict';

const { getBxrdConfig } = require('../services/config');
const { fetchBxrdStats, parseHours } = require('../services/bxrd-stats-queries');

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().replace('T', ' ').slice(0, 19);
}

function shortPk(pk) {
  if (!pk || pk.length < 16) return pk || '—';
  return `${pk.slice(0, 8)}…${pk.slice(-8)}`;
}

function deltaCell(n) {
  if (n == null || n === 0) return '<span class="muted">0</span>';
  const cls = n > 0 ? 'up' : 'down';
  const sign = n > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${n}</span>`;
}

function renderPage(stats) {
  const cfg = getBxrdConfig();
  const note = stats.historyLogged.inserts + stats.historyLogged.updates === 0
    && stats.syncRuns.length === 0
    ? `<div class="warn">No <code>bxrd_sync_runs</code> / <code>bxrd_rank_history</code> rows in this window — logging started with this deploy. Use <code>bxrd_touched_recent</code> as a rough proxy until history fills in.</div>`
    : '';

  const syncRows = stats.syncRuns.map((r) => `
    <tr>
      <td>${fmtTime(r.created_at)}</td>
      <td><code>${escapeHtml(r.run_type)}</code></td>
      <td>${r.entries_count}</td>
      <td class="mono">${r.since_ms ?? '—'}</td>
      <td class="mono">${r.next_since_ms ?? '—'}</td>
      <td>${r.duration_ms != null ? `${r.duration_ms}ms` : '—'}</td>
      <td class="mono">${escapeHtml(r.snapshot_etag ? r.snapshot_etag.slice(0, 12) + '…' : '—')}</td>
    </tr>`).join('');

  const insertRows = stats.recentInserts.map((r) => `
    <tr>
      <td>${fmtTime(r.recorded_at)}</td>
      <td title="${escapeHtml(r.ranked_user_pubkey)}">${escapeHtml(r.name || shortPk(r.ranked_user_pubkey))}</td>
      <td>${r.rank_value}</td>
      <td>${r.follower_count?.toLocaleString() ?? '—'}</td>
      <td>${r.influence_score != null ? Number(r.influence_score).toFixed(4) : '—'}</td>
    </tr>`).join('');

  const updateRows = stats.recentUpdates.map((r) => `
    <tr>
      <td>${fmtTime(r.recorded_at)}</td>
      <td title="${escapeHtml(r.ranked_user_pubkey)}">${escapeHtml(r.name || shortPk(r.ranked_user_pubkey))}</td>
      <td>${r.prev_rank_value ?? '—'} → <strong>${r.rank_value}</strong></td>
      <td>${deltaCell(r.rank_delta)}</td>
      <td>${r.prev_follower_count ?? '—'} → ${r.follower_count}</td>
      <td>${deltaCell(r.follower_delta)}</td>
    </tr>`).join('');

  const hourlyRows = stats.hourly.map((r) => `
    <tr>
      <td>${fmtTime(r.hour)}</td>
      <td><code>${escapeHtml(r.run_type)}</code></td>
      <td>${r.runs}</td>
      <td>${r.entries}</td>
    </tr>`).join('');

  const st = stats.syncState;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>BXRD sync stats</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; margin: 0; padding: 20px; line-height: 1.5; }
    .wrap { max-width: 1200px; margin: 0 auto; }
    h1 { color: #fff; margin: 0 0 8px; font-size: 1.5rem; }
    .meta { color: #888; font-size: 13px; margin-bottom: 20px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 14px; }
    .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #888; }
    .card .val { font-size: 22px; font-weight: 600; color: #4CAF50; margin-top: 4px; }
    section { margin-bottom: 28px; }
    h2 { font-size: 1rem; color: #4CAF50; border-bottom: 1px solid #333; padding-bottom: 8px; margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #2a2a2a; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { color: #888; font-weight: 600; background: #141414; position: sticky; top: 0; }
  .scroll { overflow-x: auto; max-height: 420px; overflow-y: auto; border: 1px solid #333; border-radius: 6px; }
    .mono { font-family: Monaco, monospace; font-size: 11px; color: #aaa; }
    .warn { background: #3a2a1a; border-left: 4px solid #FF9800; padding: 12px; margin-bottom: 20px; font-size: 13px; }
    .up { color: #4CAF50; }
    .down { color: #f44336; }
    .muted { color: #666; }
    form { margin-bottom: 16px; }
    input, button { background: #111; color: #e0e0e0; border: 1px solid #444; border-radius: 6px; padding: 8px 12px; }
    button { background: #4CAF50; color: #000; font-weight: 600; cursor: pointer; border: none; }
    a { color: #4CAF50; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>BXRD sync stats</h1>
    <p class="meta">Unlisted ops view · last ${stats.hours}h · generated ${escapeHtml(stats.generatedAt)} · API ${escapeHtml(cfg.apiBaseUrl)}</p>
    <form method="get">
      <label>Hours <input type="number" name="hours" min="1" max="168" value="${stats.hours}"></label>
      <button type="submit">Refresh</button>
    </form>
    ${note}
    <div class="cards">
      <div class="card"><div class="label">BXRD rankings</div><div class="val">${stats.counts.bxrd_rankings?.toLocaleString() ?? 0}</div></div>
      <div class="card"><div class="label">Touched (${stats.hours}h)</div><div class="val">${stats.counts.bxrd_touched_recent?.toLocaleString() ?? 0}</div></div>
      <div class="card"><div class="label">New (logged)</div><div class="val">${stats.historyLogged.inserts}</div></div>
      <div class="card"><div class="label">Updates (logged)</div><div class="val">${stats.historyLogged.updates}</div></div>
      <div class="card"><div class="label">Snapshot runs</div><div class="val">${stats.snapshotRuns}</div></div>
      <div class="card"><div class="label">Delta polls</div><div class="val">${stats.deltaRuns}</div></div>
    </div>
    <section>
      <h2>Cursor</h2>
      <table>
        <tr><th>last_since_ms</th><td class="mono">${st.last_since_ms ?? '—'}</td></tr>
        <tr><th>last_delta_at</th><td>${fmtTime(st.last_delta_at)}</td></tr>
        <tr><th>last_snapshot_at</th><td>${fmtTime(st.last_snapshot_at)}</td></tr>
        <tr><th>snapshot etag</th><td class="mono">${escapeHtml(st.last_snapshot_etag || '—')}</td></tr>
      </table>
    </section>
    <section>
      <h2>Sync runs</h2>
      <div class="scroll"><table>
        <thead><tr><th>Time</th><th>Type</th><th>Entries</th><th>Since</th><th>Next</th><th>Duration</th><th>ETag</th></tr></thead>
        <tbody>${syncRows || '<tr><td colspan="7">No runs logged in window</td></tr>'}</tbody>
      </table></div>
    </section>
    <section>
      <h2>Hourly activity</h2>
      <div class="scroll"><table>
        <thead><tr><th>Hour</th><th>Type</th><th>Runs</th><th>Entries</th></tr></thead>
        <tbody>${hourlyRows || '<tr><td colspan="4">—</td></tr>'}</tbody>
      </table></div>
    </section>
    <section>
      <h2>New BXRD rows (logged inserts)</h2>
      <div class="scroll"><table>
        <thead><tr><th>Time</th><th>Name</th><th>Rank</th><th>Followers</th><th>Influence</th></tr></thead>
        <tbody>${insertRows || '<tr><td colspan="5">None in window</td></tr>'}</tbody>
      </table></div>
    </section>
    <section>
      <h2>Score / follower changes (logged updates)</h2>
      <div class="scroll"><table>
        <thead><tr><th>Time</th><th>Name</th><th>Rank</th><th>Δ</th><th>Followers</th><th>Δ</th></tr></thead>
        <tbody>${updateRows || '<tr><td colspan="6">None in window</td></tr>'}</tbody>
      </table></div>
    </section>
  </div>
</body>
</html>`;
}

function checkAccess(request, reply) {
  const required = process.env.BXRD_STATS_KEY;
  if (!required) return true;
  const key = request.query.key;
  if (key === required) return true;
  reply.code(401).type('text/plain').send('Unauthorized');
  return false;
}

module.exports = async function (fastify) {
  fastify.get('/bxrd-stats', async (request, reply) => {
    if (!checkAccess(request, reply)) return;

    const hours = parseHours(request.query);
    try {
      const stats = await fetchBxrdStats(fastify.database, hours);
      reply.type('text/html').send(renderPage(stats));
    } catch (err) {
      request.log.error({ err }, 'BXRD stats page failed');
      reply.code(500).type('text/plain').send('Failed to load stats');
    }
  });
};
