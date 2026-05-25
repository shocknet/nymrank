'use strict'

const {
  fetchAggregatedNameSearch,
  countAggregatedNameSearch
} = require('../services/aggregated-name-search');
const {
  isBxrdPrimarySource,
  bxrdSourceFilterSql,
  bxrdUserProfileUrl
} = require('../services/bxrd-source');

/** Hide default/perspective listings when last-seen is older than this (still shown if unknown). */
const LISTING_HIDE_LAST_SEEN_OLDER_THAN_DAYS = 365;

module.exports = async function (fastify, opts) {
  const database = fastify.database;

  // Home page - rankings browser (uses precomputed_rankings materialized view)
  fastify.get('/', async (request, reply) => {
    reply.header('Cache-Control', 'no-cache');
    const page = parseInt(request.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;
    const search = (request.query.search || '').trim();
    const bxrdPrimary = isBxrdPrimarySource();
    const bxrdSourceSql = bxrdPrimary ? bxrdSourceFilterSql('ur') : '';
    const perspective = bxrdPrimary ? '' : (request.query.perspective || '');
    const includeStale =
      request.query.include_stale === '1' ||
      request.query.all === '1';

    const listingStaleAnd = includeStale
      ? ''
      : ` AND (
      COALESCE(prq.last_activity_timestamp, un.profile_timestamp) IS NULL
      OR (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)::bigint))
          < INTERVAL '${LISTING_HIDE_LAST_SEEN_OLDER_THAN_DAYS} days'
    )`;

    const listingStaleWhere = includeStale
      ? ''
      : `WHERE (
      COALESCE(prq.last_activity_timestamp, un.profile_timestamp) IS NULL
      OR (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)::bigint))
          < INTERVAL '${LISTING_HIDE_LAST_SEEN_OLDER_THAN_DAYS} days'
    )`;
    
    const committeeMembers = bxrdPrimary
      ? []
      : (
          await database.query(
            'SELECT name, pubkey FROM committee_members WHERE is_active = true ORDER BY name'
          )
        ).rows;
    
    let query, params;
    let queryParams = [];
    
    if (search) {
      // Search query - always use user_rankings to support perspective filtering
      // If no perspective, aggregate across all committee members
      if (perspective) {
        // Search with perspective - filter by specific committee member
        query = `
          SELECT * FROM (
            SELECT 
              ur.ranked_user_pubkey,
              un.name,
              un.nip05,
              un.lud16,
              ur.rank_value,
              ur.influence_score,
              ur.hops::INTEGER as hops,
              ur.follower_count::INTEGER as follower_count,
              COALESCE(prq.last_activity_timestamp, un.profile_timestamp) as last_seen,
              (
                ur.influence_score * 
                CASE 
                  WHEN EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) < 180 * 86400 THEN 1.0
                  WHEN EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) < 365 * 86400 THEN 0.9
                  WHEN EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) < 730 * 86400 THEN 0.7
                  ELSE 0.5
                END *
                LOG(GREATEST(ur.follower_count, 1) + 1)
              ) * (
                CASE 
                  WHEN LOWER(un.name) = LOWER($1) THEN 2 
                  WHEN LOWER(un.name) LIKE LOWER($1) || ' %' THEN 1
                  ELSE 0 
                END +
                CASE WHEN LOWER(un.nip05) = LOWER($1) THEN 1 ELSE 0 END +
                CASE WHEN LOWER(un.lud16) = LOWER($1) THEN 1 ELSE 0 END
              ) as blended_score,
              (
                CASE 
                  WHEN LOWER(un.name) = LOWER($1) THEN 2 
                  WHEN LOWER(un.name) LIKE LOWER($1) || ' %' THEN 1
                  ELSE 0 
                END +
                CASE WHEN LOWER(un.nip05) = LOWER($1) THEN 1 ELSE 0 END +
                CASE WHEN LOWER(un.lud16) = LOWER($1) THEN 1 ELSE 0 END
              ) as match_affinity
            FROM user_rankings ur
            LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
            LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
            WHERE ur.committee_member_pubkey = $2
            AND ur.rank_value >= 35
            AND (
              LOWER(un.name) = LOWER($1) OR
              LOWER(un.name) LIKE LOWER($1) || ' %' OR
              LOWER(un.nip05) = LOWER($1) OR
              LOWER(un.lud16) = LOWER($1)
            )
          ) ranked
          WHERE match_affinity >= 2
          ORDER BY blended_score DESC NULLS LAST
          LIMIT $3 OFFSET $4
        `;
        params = [search, perspective, limit, offset];
        queryParams = [search, perspective];
      } else {
        query = null;
        params = null;
        queryParams = [search];
      }
    } else if (perspective) {
      // Perspective filter - need to query user_rankings directly for committee member filter
      query = `
        SELECT 
          ur.ranked_user_pubkey,
          un.name,
          un.nip05,
          un.lud16,
          ur.rank_value,
          ur.influence_score,
          ur.hops,
          ur.follower_count,
          COALESCE(prq.last_activity_timestamp, un.profile_timestamp) as last_seen,
          (ur.influence_score * LOG(GREATEST(ur.follower_count, 1) + 1)) as effective_score
        FROM user_rankings ur
        LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
        LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
        WHERE ur.committee_member_pubkey = $1
        ${listingStaleAnd}
        ORDER BY effective_score DESC NULLS LAST
        LIMIT $2 OFFSET $3
      `;
      params = [perspective, limit, offset];
      queryParams = [perspective];
    } else if (bxrdPrimary) {
      query = `
        SELECT 
          ur.ranked_user_pubkey,
          un.name,
          un.nip05,
          un.lud16,
          ur.rank_value,
          ur.influence_score,
          ur.hops,
          ur.follower_count,
          COALESCE(prq.last_activity_timestamp, un.profile_timestamp) as last_seen,
          (ur.influence_score * LOG(GREATEST(ur.follower_count, 1) + 1)) as effective_score
        FROM user_rankings ur
        LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
        LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
        WHERE 1=1${bxrdSourceSql}
        ${listingStaleAnd}
        ORDER BY effective_score DESC NULLS LAST
        LIMIT $1 OFFSET $2
      `;
      params = [limit, offset];
    } else {
      query = `
        SELECT 
          pr.ranked_user_pubkey,
          pr.name,
          pr.nip05,
          pr.lud16,
          pr.rank_value,
          pr.influence_score,
          pr.hops,
          pr.follower_count,
          COALESCE(prq.last_activity_timestamp, un.profile_timestamp) as last_seen,
          pr.effective_score
        FROM precomputed_rankings pr
        LEFT JOIN user_names un ON pr.ranked_user_pubkey = un.pubkey
        LEFT JOIN profile_refresh_queue prq ON pr.ranked_user_pubkey = prq.pubkey
        ${listingStaleWhere}
        ORDER BY pr.effective_score DESC NULLS LAST
        LIMIT $1 OFFSET $2
      `;
      params = [limit, offset];
    }
    
    const result =
      search && !perspective
        ? { rows: await fetchAggregatedNameSearch(database, search, limit, offset) }
        : await database.query(query, params);
    
    // Count query - also use precomputed view when possible
    let countQuery;
    if (search) {
      if (perspective) {
        // Search with perspective - count from user_rankings with affinity filter
        countQuery = `
          SELECT COUNT(*) FROM (
            SELECT 
              ur.ranked_user_pubkey,
              (
                CASE 
                  WHEN LOWER(un.name) = LOWER($1) THEN 2 
                  WHEN LOWER(un.name) LIKE LOWER($1) || ' %' THEN 1
                  ELSE 0 
                END +
                CASE WHEN LOWER(un.nip05) = LOWER($1) THEN 1 ELSE 0 END +
                CASE WHEN LOWER(un.lud16) = LOWER($1) THEN 1 ELSE 0 END
              ) as match_affinity
            FROM user_rankings ur
            LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
            WHERE ur.committee_member_pubkey = $2
            AND ur.rank_value >= 35
            AND (
              LOWER(un.name) = LOWER($1) OR
              LOWER(un.name) LIKE LOWER($1) || ' %' OR
              LOWER(un.nip05) = LOWER($1) OR
              LOWER(un.lud16) = LOWER($1)
            )
          ) ranked
          WHERE match_affinity >= 2
        `;
      } else {
        countQuery = null;
      }
    } else if (perspective) {
      // Count occupied nyms for this perspective: users with rank >= 35 and name_affinity >= 2
      // (not filtered by last-seen — that only affects which rows appear in the list)
      countQuery = `
        SELECT COUNT(DISTINCT ur.ranked_user_pubkey)
        FROM user_rankings ur
        LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
        WHERE ur.committee_member_pubkey = $1
        AND ur.rank_value >= 35
        AND COALESCE(un.name_affinity, 0) >= 2
      `;
    } else if (bxrdPrimary) {
      countQuery = `
        SELECT COUNT(DISTINCT ur.ranked_user_pubkey)
        FROM user_rankings ur
        LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
        WHERE 1=1${bxrdSourceSql}
        AND ur.rank_value >= 35
        AND COALESCE(un.name_affinity, 0) >= 2
      `;
      queryParams = [];
    } else {
      countQuery = `
        SELECT COUNT(DISTINCT ur.ranked_user_pubkey)
        FROM user_rankings ur
        LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
        WHERE ur.rank_value >= 35
        AND COALESCE(un.name_affinity, 0) >= 2
      `;
      queryParams = [];
    }
    
    const total =
      search && !perspective
        ? await countAggregatedNameSearch(database, search)
        : parseInt((await database.query(countQuery, queryParams)).rows[0].count, 10);

    let listTotal = total;
    if (!search && !includeStale) {
      if (perspective) {
        const listed = await database.query(
          `
          SELECT COUNT(DISTINCT ur.ranked_user_pubkey)::bigint AS c
          FROM user_rankings ur
          LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
          LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
          WHERE ur.committee_member_pubkey = $1
          ${listingStaleAnd}
        `,
          [perspective]
        );
        listTotal = parseInt(listed.rows[0].c, 10);
      } else if (bxrdPrimary) {
        const listed = await database.query(
          `
          SELECT COUNT(DISTINCT ur.ranked_user_pubkey)::bigint AS c
          FROM user_rankings ur
          LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
          LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
          WHERE 1=1${bxrdSourceSql}
          ${listingStaleAnd}
        `
        );
        listTotal = parseInt(listed.rows[0].c, 10);
      } else {
        const listed = await database.query(
          `
          SELECT COUNT(*)::bigint AS c
          FROM (
            SELECT pr.ranked_user_pubkey
            FROM precomputed_rankings pr
            LEFT JOIN user_names un ON pr.ranked_user_pubkey = un.pubkey
            LEFT JOIN profile_refresh_queue prq ON pr.ranked_user_pubkey = prq.pubkey
            ${listingStaleWhere}
          ) listed
        `);
        listTotal = parseInt(listed.rows[0].c, 10);
      }
    }

    const totalPages = Math.max(1, Math.ceil(listTotal / limit));
    
    // Pre-calculate effective scores and filter grey results when greens exist (for search)
    const rowsWithScores = result.rows.map(row => {
      const influence = row.influence_score ? parseFloat(row.influence_score) : 0;
      const followers = parseInt(row.follower_count || 0);
      const effectiveScore = row.effective_score || (influence * Math.log10(Math.max(followers, 1) + 1));
      return { ...row, _effectiveScore: effectiveScore };
    });
    
    const hasGreenResults = rowsWithScores.some(r => r._effectiveScore >= 3.0);
    const displayRows = (search && hasGreenResults)
      ? rowsWithScores.filter(r => r._effectiveScore >= 1.0)  // Filter out grey when greens exist in search
      : rowsWithScores;

    const perspectiveControl = bxrdPrimary
      ? '<div class="perspective-select" style="padding:12px;color:#888;font-size:14px;">Source: BXRD WoT</div>'
      : `<div class="perspective-select">
          <select name="perspective" onchange="this.form.submit()">
            <option value="">Average</option>
            ${committeeMembers.map(m => {
              let label = m.name;
              if (m.name.toLowerCase() === 'straycat') label += ' (Default)';
              else if (m.name.toLowerCase() === 'justin') label += ' (Permissive)';
              else if (m.name.toLowerCase() === 'vinny') label += ' (Restrictive)';
              return `<option value="${m.pubkey}" ${perspective === m.pubkey ? 'selected' : ''}>${label}</option>`;
            }).join('')}
          </select>
        </div>`;
    
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>NymRank - Rankings Browser</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" href="/public/nymrank_sm.png">
  <meta property="og:title" content="NymRank - Nostr Name Rankings">
  <meta property="og:description" content="Reputation-weighted namespace for Nostr. Discover who occupies which names and optimize your profile to claim your desired slug.">
  <meta property="og:image" content="/public/nymrank.png">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="NymRank">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="NymRank - Nostr Name Rankings">
  <meta name="twitter:description" content="Reputation-weighted namespace for Nostr. Discover who occupies which names and optimize your profile to claim your desired slug.">
  <meta name="twitter:image" content="/public/nymrank.png">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; width: 100%; }
    .page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 8px; flex-wrap: wrap; }
    .page-header .brand { text-decoration: none; color: inherit; flex: 1; min-width: 200px; }
    .page-header .brand:hover { opacity: 0.95; }
    .top-nav { display: flex; gap: 10px; align-items: center; flex-shrink: 0; margin-top: 4px; }
    .top-nav a {
      padding: 8px 14px;
      background: #2a2a2a;
      color: #4CAF50;
      text-decoration: none;
      border: 1px solid #4CAF50;
      border-radius: 6px;
      font-weight: 600;
      font-size: 14px;
      white-space: nowrap;
    }
    .top-nav a:hover { background: #333; text-decoration: none; }
    h1 { margin-bottom: 10px; color: #fff; }
    .subtitle { color: #888; margin-bottom: 30px; }
    .controls { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .search-box { flex-grow: 1; display: flex; gap: 8px; }
    .search-box input { flex-grow: 1; padding: 12px; font-size: 16px; border: 1px solid #333; background: #1a1a1a; color: #fff; border-radius: 8px; }
    .search-box input:focus { outline: none; border-color: #555; }
    .search-btn { padding: 12px 20px; font-size: 16px; border: none; background: #4CAF50; color: #000; border-radius: 8px; cursor: pointer; font-weight: 600; white-space: nowrap; }
    .search-btn:hover { background: #45a049; }
    .search-btn:active { background: #3d8b40; }
    .perspective-select { min-width: 200px; }
    .perspective-select select { width: 100%; padding: 12px; font-size: 16px; border: 1px solid #333; background: #1a1a1a; color: #fff; border-radius: 8px; cursor: pointer; }
    @media (max-width: 768px) {
      body { padding: 12px; }
      .page-header .top-nav { width: 100%; justify-content: flex-end; margin-top: 8px; }
      h1 { font-size: 20px; }
      .subtitle { font-size: 12px; margin-bottom: 12px; }
      .stats { gap: 8px; margin-bottom: 20px; }
      .stat-card { flex: 1; min-width: 80px; padding: 8px 10px; }
      .stat-card .value { font-size: 16px; }
      .stat-card .label { font-size: 11px; }
      .controls { flex-direction: column; gap: 8px; }
      .search-box { width: 100%; }
      .search-box input { padding: 10px; font-size: 16px; min-width: 0; }
      .search-btn { padding: 10px 16px; }
      .perspective-select { width: 100%; min-width: unset; }
      .perspective-select select { padding: 10px; }
      .table-wrapper { 
        width: 100%;
        overflow-x: auto; 
        -webkit-overflow-scrolling: touch;
      }
      table { 
        width: 100%;
        min-width: 500px;
        font-size: 12px; 
      }
      th, td { padding: 8px 6px; }
      th { font-size: 11px; }
      .hide-mobile { display: none !important; }
      .pubkey { font-size: 10px; max-width: 90px; }
      .pubkey-desktop { display: none !important; }
      .pubkey-mobile { display: inline !important; }
      td:nth-child(4) { max-width: 90px; }
      .rank { padding: 3px 6px; font-size: 11px; }
      .small-text { display: none; }
      .pagination { gap: 5px; margin-top: 15px; }
      .pagination a, .pagination span { padding: 6px 10px; font-size: 12px; }
      .tooltip .tooltip-text { width: 260px; font-size: 11px; padding: 10px; right: 0; left: auto; margin-left: 0; transform: none; }
      .no-profile { font-size: 10px; }
    }
    .stats { display: flex; gap: 20px; margin-bottom: 30px; flex-wrap: wrap; }
    .stat-card { background: #1a1a1a; padding: 15px 20px; border-radius: 8px; border: 1px solid #333; }
    .stat-card .label { color: #888; font-size: 14px; margin-bottom: 5px; }
    .stat-card .value { color: #fff; font-size: 24px; font-weight: bold; }
    .table-wrapper { width: 100%; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; background: #1a1a1a; border-radius: 8px; table-layout: auto; }
    th, td { padding: 12px 8px; text-align: left; border-bottom: 1px solid #333; white-space: nowrap; }
    th { background: #252525; color: #fff; font-weight: 600; position: relative; }
    tr:hover { background: #252525; }
    td:nth-child(1), td:nth-child(2), td:nth-child(3) { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pubkey {
      font-family: monospace;
      font-size: 12px;
      color: #888;
      display: inline-block;
      max-width: 240px;
      white-space: nowrap;
    }
    .pubkey-desktop { display: inline; }
    .pubkey-mobile { display: none; }
    td:nth-child(4) { max-width: 240px; vertical-align: top; overflow: hidden; }
    @media (max-width: 1200px) {
      td:nth-child(4) { max-width: 150px; }
    }
    .score { font-weight: bold; color: #4CAF50; }
    .rank { display: inline-block; padding: 4px 8px; background: #333; border-radius: 4px; font-size: 12px; white-space: nowrap; }
    .rank.high { background: #4CAF50; color: #000; }
    .rank.med { background: #FF9800; color: #000; }
    .rank.low { background: #666; }
    .pagination { margin-top: 30px; display: flex; gap: 10px; justify-content: center; align-items: center; flex-wrap: wrap; }
    .pagination a, .pagination span { padding: 8px 16px; background: #1a1a1a; border: 1px solid #333; border-radius: 4px; text-decoration: none; color: #fff; }
    .pagination a:hover { background: #333; }
    .pagination .current { background: #4CAF50; color: #000; border-color: #4CAF50; }
    .no-profile { color: #666; font-style: italic; }
    a { color: #4CAF50; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .small-text { font-size: 11px; color: #888; display: block; margin-top: 2px; }
    .tooltip-trigger { cursor: pointer; margin-left: 5px; color: #888; font-size: 14px; }
    .tooltip-trigger:hover { color: #4CAF50; }
    .tooltip-popup {
      display: none;
      position: fixed;
      z-index: 10000;
      width: 280px;
      background: #1a1a1a;
      color: #eee;
      padding: 16px;
      border-radius: 8px;
      border: 1px solid #444;
      box-shadow: 0 8px 24px rgba(0,0,0,0.8);
      font-size: 13px;
      line-height: 1.5;
    }
    .tooltip-popup.show { display: block; }
  </style>
</head>
<body>
  <div class="container">
    <div class="page-header">
      <a href="/" class="brand">
        <h1>NymRank</h1>
        <div class="subtitle" style="margin-bottom: 0;">Consensus-based namespace, secured by Web-of-Trust</div>
      </a>
      <nav class="top-nav" aria-label="Site links">
        <a href="/api-docs">API Docs</a>
      </nav>
    </div>
    
    <div class="stats">
      <div class="stat-card">
        <div class="label">Total Occupied Nyms</div>
        <div class="value">${total.toLocaleString()}</div>
      </div>
      <div class="stat-card">
        <div class="label">Current Page</div>
        <div class="value">${page} / ${totalPages}</div>
      </div>
    </div>
    
    <div style="padding: 12px 16px; background: #1a3a1a; border: 1px solid #4CAF50; border-radius: 8px; margin-bottom: 20px; display: flex; align-items: center; gap: 12px;">
      <span style="color: #4CAF50; font-size: 18px;">💡</span>
      <div style="flex: 1;">
        <strong style="color: #4CAF50;">Want to occupy a name?</strong>
        <span style="color: #ccc; margin-left: 8px;">Learn how to optimize your profile →</span>
      </div>
      <a href="/faq" style="padding: 8px 16px; background: #4CAF50; color: #000; text-decoration: none; border-radius: 6px; font-weight: 600; white-space: nowrap;">FAQ</a>
    </div>
    
    <form method="get" action="/">
      <div class="controls">
        <div class="search-box">
          <input type="text" name="search" placeholder="Check slug availability (e.g., 'jack')..." value="${search}">
          <button type="submit" class="search-btn">Search</button>
        </div>
        ${perspectiveControl}
      </div>
    </form>
    
    ${search && displayRows.length === 0 ? `
    <div style="padding: 20px; background: #1a1a1a; border-radius: 8px; border: 1px solid #333; margin-bottom: 20px; text-align: center;">
      <div style="color: #4CAF50; font-size: 18px; font-weight: bold; margin-bottom: 10px;">✓ "${search}" is available!</div>
      <div style="color: #888;">No users currently occupy this name.</div>
    </div>
    ` : ''}
    ${search && displayRows.length > 0 ? `
    <div style="padding: 20px; background: #1a1a1a; border-radius: 8px; border: 1px solid #333; margin-bottom: 20px; text-align: center;">
      <div style="color: #FF5252; font-size: 18px; font-weight: bold; margin-bottom: 10px;">⚠ "${search}" is occupied</div>
      <div style="color: #888;">${displayRows.length} user(s) currently have this name. Showing highest reputation:</div>
    </div>
    ` : ''}
    
    <div class="table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>NIP-05</th>
          <th class="hide-mobile">LUD-16</th>
          <th>Pubkey</th>
          <th>
            Score
            <span class="tooltip-trigger" onclick="toggleTooltip(event)">ⓘ</span>
          </th>
          <th class="hide-mobile">Hops</th>
          <th>Followers</th>
          <th class="hide-mobile">Last Seen</th>
        </tr>
      </thead>
      <tbody>
        ${displayRows.map(row => {
          const influence = row.influence_score ? parseFloat(row.influence_score) : 0;
          const followers = parseInt(row.follower_count || 0);
          
          // Use pre-calculated effective score
          const effectiveScore = row._effectiveScore;
          
          // Color based on effective score (occupation strength)
          // Score >= 3.0 indicates firm occupation (Green)
          // Score >= 1.0 indicates partial occupation (Orange)
          // Score < 1.0 indicates weak occupation (Grey)
          const rankClass = effectiveScore >= 3.0 ? 'high' : effectiveScore >= 1.0 ? 'med' : 'low';
          const scoreDisplay = effectiveScore ? effectiveScore.toFixed(2) : '0.00';
          const influenceDisplay = influence ? influence.toFixed(4) : '0.0000';
          const fullPubkey = row.ranked_user_pubkey || '';
          const desktopPubkey = fullPubkey.length > 24
            ? `${fullPubkey.substring(0, 12)}..${fullPubkey.slice(-12)}`
            : fullPubkey;
          const mobilePubkey = fullPubkey.length > 10
            ? `${fullPubkey.substring(0, 4)}..${fullPubkey.slice(-4)}`
            : fullPubkey;
          
          let lastSeenDisplay = 'N/A';
          if (row.last_seen) {
            const lastSeenDate = new Date(row.last_seen * 1000);
            const now = new Date();
            const daysAgo = Math.floor((now - lastSeenDate) / (1000 * 60 * 60 * 24));
            if (daysAgo < 7) {
              lastSeenDisplay = 'Recently';
            } else if (daysAgo < 30) {
              lastSeenDisplay = daysAgo + 'd ago';
            } else {
              lastSeenDisplay = Math.floor(daysAgo / 30) + 'mo ago';
            }
          }
          
          return `
            <tr>
              <td>${row.name ? row.name : '<span class="no-profile">-</span>'}</td>
              <td>${row.nip05 || '-'}</td>
              <td class="hide-mobile">${row.lud16 || '-'}</td>
              <td>
                <a href="${bxrdUserProfileUrl(fullPubkey)}" target="_blank" rel="noopener noreferrer" class="pubkey" title="${fullPubkey}">
                  <span class="pubkey-desktop">${desktopPubkey}</span>
                  <span class="pubkey-mobile">${mobilePubkey}</span>
                </a>
              </td>
              <td>
                <span class="rank ${rankClass}">${scoreDisplay}</span>
                <span class="small-text hide-mobile">Base: ${influenceDisplay}</span>
              </td>
              <td class="hide-mobile">${row.hops || 0}</td>
              <td>${row.follower_count ? row.follower_count.toLocaleString() : 0}</td>
              <td class="hide-mobile" style="font-size: 12px; color: #888;">${lastSeenDisplay}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    </div>
    
    <div class="pagination">
      ${page > 1 ? `<a href="/?page=${page - 1}${search ? '&search=' + encodeURIComponent(search) : ''}${perspective ? '&perspective=' + encodeURIComponent(perspective) : ''}">← Previous</a>` : '<span>← Previous</span>'}
      <span class="current">Page ${page}</span>
      ${page < totalPages ? `<a href="/?page=${page + 1}${search ? '&search=' + encodeURIComponent(search) : ''}${perspective ? '&perspective=' + encodeURIComponent(perspective) : ''}">Next →</a>` : '<span>Next →</span>'}
    </div>
  </div>
  
  <div id="score-tooltip" class="tooltip-popup">
    <strong>NymRank Scoring Algorithm</strong><br><br>
    This score is derived from <strong>GrapeRank</strong> influence scores calculated via the <strong>Web of Trust</strong>.<br><br>
    <strong>Weighting:</strong> The raw score is multiplied by the log of verified followers to surface notable accounts.<br><br>
    <strong>Affinity:</strong> During search, results must have a minimum affinity score of 2 to appear.
    <ul style="margin-left: 20px; margin-top: 5px;">
      <li>Exact Name Match: +2</li>
      <li>Name Starts With: +1</li>
      <li>Exact NIP-05 Match: +1</li>
      <li>Exact LUD-16 Match: +1</li>
    </ul>
  </div>
  
  <script>
    function toggleTooltip(e) {
      e.stopPropagation();
      const tooltip = document.getElementById('score-tooltip');
      if (tooltip.classList.contains('show')) {
        tooltip.classList.remove('show');
      } else {
        const rect = e.target.getBoundingClientRect();
        tooltip.style.top = (rect.bottom + 8) + 'px';
        tooltip.style.left = Math.max(10, Math.min(rect.left - 120, window.innerWidth - 290)) + 'px';
        tooltip.classList.add('show');
      }
    }
    document.addEventListener('click', function(e) {
      if (!e.target.classList.contains('tooltip-trigger')) {
        document.getElementById('score-tooltip').classList.remove('show');
      }
    });
  </script>
  <script type="module">
    import { init } from '/public/plausible.js';
    init({ domain: 'nymrank.dev' });
  </script>
</body>
</html>
    `;
    
    reply.type('text/html').send(html);
  });

  // User detail page
  fastify.get('/user/:pubkey', async (request, reply) => {
    const pubkey = request.params.pubkey;
    
    // Get user profile
    const profileResult = await database.query(
      'SELECT * FROM user_names WHERE pubkey = $1',
      [pubkey]
    );
    const profile = profileResult.rows[0];
    
    // Get ranking data
    const rankingResult = await database.query(
      'SELECT * FROM user_rankings WHERE ranked_user_pubkey = $1',
      [pubkey]
    );
    const ranking = rankingResult.rows[0];
    
    if (!ranking) {
      return reply.code(404).send('User not found');
    }
    
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>NymRank - ${profile?.name || pubkey.substring(0, 16)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    .back { display: inline-block; margin-bottom: 20px; color: #4CAF50; text-decoration: none; }
    .back:hover { text-decoration: underline; }
    h1 { margin-bottom: 10px; color: #fff; }
    .pubkey-full { font-family: monospace; font-size: 12px; color: #888; margin-bottom: 30px; word-break: break-all; }
    .section { background: #1a1a1a; padding: 20px; border-radius: 8px; border: 1px solid #333; margin-bottom: 20px; }
    .section h2 { color: #fff; margin-bottom: 15px; font-size: 18px; }
    .field { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #333; }
    .field:last-child { border-bottom: none; }
    .field-label { color: #888; }
    .field-value { color: #fff; font-weight: 500; }
    .score-big { font-size: 48px; font-weight: bold; color: #4CAF50; text-align: center; margin: 20px 0; }
    .rank-badge { display: inline-block; padding: 8px 16px; background: #333; border-radius: 4px; font-size: 20px; font-weight: bold; }
    .rank-badge.high { background: #4CAF50; color: #000; }
    .rank-badge.med { background: #FF9800; color: #000; }
    .rank-badge.low { background: #666; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back">← Back to Rankings</a>
    
    <h1>${profile?.name || 'Unknown User'}</h1>
    <div class="pubkey-full"><a href="${bxrdUserProfileUrl(pubkey)}" target="_blank" rel="noopener noreferrer" style="color: #888;">${pubkey}</a></div>
    
    ${profile ? `
    <div class="section">
      <h2>Profile</h2>
      <div class="field">
        <span class="field-label">Name</span>
        <span class="field-value">${profile.name || '-'}</span>
      </div>
      <div class="field">
        <span class="field-label">NIP-05</span>
        <span class="field-value">${profile.nip05 || '-'}</span>
      </div>
      <div class="field">
        <span class="field-label">LUD-16</span>
        <span class="field-value">${profile.lud16 || '-'}</span>
      </div>
      <div class="field">
        <span class="field-label">Name Affinity</span>
        <span class="field-value">${profile.name_affinity || 0} / 4</span>
      </div>
    </div>
    ` : ''}
    
    <div class="section">
      <h2>Reputation</h2>
      <div style="text-align: center; margin-bottom: 20px;">
        <div class="score-big">${parseFloat(ranking.influence_score).toFixed(6)}</div>
        <div style="color: #888;">Influence Score</div>
      </div>
      <div class="field">
        <span class="field-label">Rank Value</span>
        <span class="field-value">
          <span class="rank-badge ${ranking.rank_value >= 90 ? 'high' : ranking.rank_value >= 70 ? 'med' : 'low'}">
            ${ranking.rank_value}
          </span>
        </span>
      </div>
      <div class="field">
        <span class="field-label">Average Score</span>
        <span class="field-value">${parseFloat(ranking.average_score).toFixed(6)}</span>
      </div>
      <div class="field">
        <span class="field-label">Confidence Score</span>
        <span class="field-value">${parseFloat(ranking.confidence_score).toFixed(6)}</span>
      </div>
      <div class="field">
        <span class="field-label">Input Value</span>
        <span class="field-value">${parseFloat(ranking.input_value).toFixed(2)}</span>
      </div>
      <div class="field">
        <span class="field-label">PageRank Score</span>
        <span class="field-value">${parseFloat(ranking.pagerank_score).toFixed(8)}</span>
      </div>
    </div>
    
    <div class="section">
      <h2>Network Metrics</h2>
      <div class="field">
        <span class="field-label">Hops</span>
        <span class="field-value">${ranking.hops}</span>
      </div>
      <div class="field">
        <span class="field-label">Verified Followers</span>
        <span class="field-value">${ranking.follower_count.toLocaleString()}</span>
      </div>
      <div class="field">
        <span class="field-label">Verified Muters</span>
        <span class="field-value">${ranking.muter_count.toLocaleString()}</span>
      </div>
      <div class="field">
        <span class="field-label">Verified Reporters</span>
        <span class="field-value">${ranking.reporter_count.toLocaleString()}</span>
      </div>
    </div>
  </div>
  <script type="module">
    import { init } from '/public/plausible.js';
    init({ domain: 'nymrank.dev' });
  </script>
</body>
</html>
    `;
    
    reply.type('text/html').send(html);
  });

  // FAQ page - How to optimize your profile (served from static HTML file)
  fastify.get('/faq', async (request, reply) => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../public/faq.html'), 'utf8');
    reply.type('text/html').send(html);
  });
}

