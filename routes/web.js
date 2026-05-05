'use strict'

const {
  fetchAggregatedNameSearch,
  countAggregatedNameSearch
} = require('../services/aggregated-name-search');

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
    const perspective = request.query.perspective || '';
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
    
    // Get committee members
    const committeeResult = await database.query('SELECT name, pubkey FROM committee_members WHERE is_active = true ORDER BY name');
    const committeeMembers = committeeResult.rows;
    
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
    } else {
      // Default - use precomputed view (fast!)
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
    } else {
      // Count occupied nyms: users with rank >= 35 and name_affinity >= 2
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
        <h1><svg width="210" height="30" alt="NYMRANK" title="NYMRANK" viewBox="0 0 210 30" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M189.564 7.05859H195.423L191.545 17.8727L203.32 7.05859H210L200.206 16.2068L203.263 25.8915H196.81L195.225 20.8092L189.45 25.8915H182.827L189.564 7.05859Z" fill="white"/>
          <path d="M158.897 25.8915L165.634 7.05859H171.861L176.305 17.2233H176.503L180.154 7.05859H186.013L179.277 25.8915H173.022L168.578 15.7551H168.38L164.757 25.8915H158.897Z" fill="white"/>
          <path d="M144.804 10.7009L143.7 7.05859H155.616L157.088 25.8915H150.606L150.437 23.2374H141.322L139.228 25.8915H132.774L144.804 10.7009ZM149.729 12.5362L145.313 18.1268H150.069L149.729 12.5362Z" fill="white"/>
          <path d="M116.069 25.8915H110.21L116.946 7.05859H133.052C133.561 7.05859 134.014 7.1433 134.439 7.28448C134.835 7.45389 135.175 7.65154 135.429 7.93389C135.656 8.21624 135.826 8.5833 135.882 8.97859C135.939 9.37389 135.854 9.82565 135.684 10.3339L133.024 17.7598C132.854 18.2115 132.599 18.6351 132.288 19.0021C131.948 19.3692 131.58 19.6798 131.184 19.9621C130.759 20.2445 130.306 20.4704 129.825 20.6398C129.344 20.8092 128.891 20.9504 128.438 21.0068L131.297 25.8915H124.645L121.588 21.0351H117.796L116.069 25.8915ZM120.994 12.1409L119.635 15.9527H127.815L129.174 12.1409H120.994Z" fill="white"/>
          <path d="M82.7969 25.8915L89.5334 7.05859H96.553L98.4211 15.5292L106.375 7.05859H113.394L106.658 25.8915H100.799L104.28 16.1504L95.0811 25.8915H94.3735L92.1374 16.1504L88.656 25.8915H82.7969Z" fill="white"/>
          <path d="M72.6578 25.8915H66.7987L68.5253 21.0351H65.2986C64.7891 21.0351 64.3079 20.9786 63.9116 20.8092C63.5154 20.668 63.1757 20.4421 62.9493 20.1598C62.6945 19.8774 62.553 19.5386 62.4964 19.1433C62.4398 18.748 62.4964 18.268 62.6945 17.7598L66.5157 7.05859H72.3747L69.2046 15.9527H77.3847L80.5548 7.05859H86.4139L82.5927 17.7598C82.3946 18.268 82.1116 18.748 81.7719 19.1433C81.4322 19.5386 81.036 19.8774 80.5831 20.1598C80.1302 20.4421 79.649 20.668 79.1396 20.8092C78.6301 20.9786 78.1206 21.0351 77.6111 21.0351H74.3844L72.6578 25.8915Z" fill="white"/>
          <path d="M41.7177 10.7009L40.6138 7.05859H49.2468L53.6906 17.2233H53.8887L57.54 7.05859H63.3991L56.6626 25.8915H50.4073L45.9634 15.7551H45.7653L42.1423 25.8915H36.2832L41.7177 10.7009Z" fill="white"/>
          <path d="M27.7982 7.06445C29.2397 9.36639 30.0738 12.0858 30.0738 15C30.0738 23.2843 23.3416 30 15.037 30C10.4823 30 6.40106 27.9796 3.64355 24.7886C4.04814 25.0164 4.51441 25.1471 5.01137 25.1471C6.55772 25.1471 7.81135 23.8896 7.81135 22.3385C7.81133 21.5105 7.454 20.7664 6.8858 20.2524L10.4537 10.4698C10.6815 10.4679 10.9032 10.4387 11.1149 10.3853L17.4478 20.5953C17.0694 21.0742 16.8436 21.6799 16.8436 22.3385C16.8436 23.8895 18.0969 25.147 19.6431 25.1471C21.1895 25.1471 22.4431 23.8896 22.4431 22.3385C22.4431 21.5106 22.0861 20.7664 21.518 20.2524L25.0859 10.4698C26.6215 10.4572 27.8625 9.20489 27.8625 7.66159C27.8625 7.45663 27.8397 7.25693 27.7982 7.06445Z" fill="#59B942"/>
          <path d="M15.0369 0C19.5913 0 23.6724 2.02026 26.4299 5.21097C26.0254 4.9834 25.5592 4.85294 25.0625 4.85294C23.5161 4.85296 22.2625 6.11045 22.2625 7.66156C22.2625 8.57479 22.6973 9.38597 23.3703 9.8989L19.8551 19.5376C19.7852 19.5323 19.7143 19.5298 19.643 19.5298C19.4096 19.5298 19.1826 19.5589 18.9658 19.613L12.6304 9.39913C13.0061 8.92109 13.2302 8.31757 13.2303 7.66156C13.2303 6.11051 11.977 4.85305 10.4307 4.85294C8.88434 4.85294 7.63073 6.11044 7.63073 7.66156C7.63075 8.57485 8.06548 9.38597 8.73854 9.8989L5.22291 19.5376C5.15306 19.5323 5.08247 19.5298 5.01129 19.5298C3.46494 19.5298 2.21134 20.7873 2.21131 22.3384C2.21131 22.5432 2.23374 22.7428 2.27523 22.9351C0.833869 20.6333 0 17.914 0 15C0 6.71573 6.73224 0 15.0369 0Z" fill="#F7FF00"/>
          </svg>
        </h1>
        <div class="subtitle" style="margin-bottom: 0;">Consensus-based namespace, secured by Web-of-Trust</div>
      </a>
      <nav class="top-nav" aria-label="Site links">
        <a href="/faq" style="background: transparent;border: 0px solid transparent;">FAQ</a>
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
        <div class="perspective-select">
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
        </div>
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
                <a href="https://primal.net/p/${fullPubkey}" target="_blank" class="pubkey" title="${fullPubkey}">
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
    <div class="pubkey-full">${pubkey}</div>
    
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

