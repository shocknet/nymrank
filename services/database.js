const { Pool, Client } = require('pg');

class Database {
  constructor() {
    this.pool = null;
    this.dbConfig = null;
    this.isConnected = false;
    this.isShuttingDown = false;
    this.listenClient = null;
    this.listenKeepAliveInterval = null;
    this.listenReconnectTimer = null;
    this.refreshInProgress = false;
    this.refreshPending = false;
    this.refreshDebounceTimer = null;
  }

  buildDbConfig() {
    return {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'nymrank',
      user: process.env.DB_USER || 'nymrank_user',
      password: process.env.DB_PASSWORD || 'nymrank_password'
    };
  }

  buildPoolConfig() {
    return {
      ...this.dbConfig,
      max: Number(process.env.DB_POOL_MAX) || 10,
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 60000,
      connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS) || 10000,
      maxLifetimeSeconds: Number(process.env.DB_MAX_LIFETIME_SECONDS) || 1800,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000
    };
  }

  async connect() {
    try {
      this.dbConfig = this.buildDbConfig();
      const config = this.buildPoolConfig();

      this.pool = new Pool(config);
      
      // Handle pool errors - remove dead connections
      this.pool.on('error', (err, client) => {
        console.error('[DB Pool] Error on client:', {
          message: err.message,
          code: err.code,
          clientProcessId: client?.processID,
          timestamp: new Date().toISOString()
        });
        // The pool will automatically remove the dead client
      });
      
      // Track connection lifecycle for debugging
      this.pool.on('connect', (client) => {
        console.log('[DB Pool] New client connected:', {
          processId: client.processID,
          timestamp: new Date().toISOString(),
          totalCount: this.pool.totalCount,
          idleCount: this.pool.idleCount,
          waitingCount: this.pool.waitingCount
        });
      });
      
      this.pool.on('remove', (client) => {
        console.log('[DB Pool] Client removed:', {
          processId: client?.processID,
          timestamp: new Date().toISOString(),
          totalCount: this.pool.totalCount,
          idleCount: this.pool.idleCount
        });
      });
      
      // Test the connection and check database timeout settings
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      
      // Check PostgreSQL timeout settings that might cause connection drops
      try {
        const timeoutSettings = await client.query(`
          SELECT name, setting, unit 
          FROM pg_settings 
          WHERE name IN (
            'idle_in_transaction_session_timeout',
            'statement_timeout',
            'tcp_keepalives_idle',
            'tcp_keepalives_interval',
            'tcp_keepalives_count',
            'max_connections'
          )
          ORDER BY name
        `);
        
        console.log('[DB] ===== PostgreSQL Timeout Settings =====');
        if (timeoutSettings.rows.length === 0) {
          console.log('[DB] WARNING: No timeout settings found!');
        } else {
          timeoutSettings.rows.forEach(row => {
            const value = row.setting === '0' ? 'disabled' : `${row.setting}${row.unit || ''}`;
            console.log(`[DB]   ${row.name}: ${value}`);
          });
        }
        
        // Check current connection count
        const connCount = await client.query(`
          SELECT count(*) as active_connections 
          FROM pg_stat_activity 
          WHERE datname = current_database()
        `);
        console.log(`[DB] Active connections to database: ${connCount.rows[0].active_connections}`);
        console.log('[DB] =========================================');
      } catch (diagError) {
        console.error('[DB] ERROR: Failed to fetch timeout diagnostics:', diagError.message);
        console.error('[DB] Error stack:', diagError.stack);
      }
      
      client.release();
      
      this.isConnected = true;
      console.log('Connected to PostgreSQL database');
      // Ensure auxiliary tables exist
      await this.ensureAttestationEventsTable();
      await this.ensureBxrdSchema();
      
      // Set up listener for rankings refresh notifications
      await this.setupRankingsRefreshListener();
      
    } catch (error) {
      console.error('Failed to connect to PostgreSQL:', error);
      throw error;
    }
  }
  
  clearListenKeepalive() {
    if (this.listenKeepAliveInterval) {
      clearInterval(this.listenKeepAliveInterval);
      this.listenKeepAliveInterval = null;
    }
  }

  scheduleListenReconnect(setupListener, delayMs = 5000) {
    if (this.isShuttingDown || this.listenReconnectTimer) return;
    this.listenReconnectTimer = setTimeout(() => {
      this.listenReconnectTimer = null;
      if (!this.isShuttingDown) {
        console.log('[DB] Reconnecting dedicated LISTEN client...');
        setupListener();
      }
    }, delayMs);
  }

  async teardownListenClient() {
    this.clearListenKeepalive();
    const client = this.listenClient;
    this.listenClient = null;
    if (!client) return;
    try {
      client.removeAllListeners();
      await client.end();
    } catch (_) {
      // Ignore teardown errors on dead connections
    }
  }

  startListenKeepalive() {
    const intervalMs = Number(process.env.DB_LISTEN_KEEPALIVE_MS) || 60000;
    this.clearListenKeepalive();
    console.log(`[DB] LISTEN keepalive every ${intervalMs}ms (dedicated connection, not from pool)`);
    this.listenKeepAliveInterval = setInterval(() => {
      if (this.isShuttingDown || !this.listenClient) {
        this.clearListenKeepalive();
        return;
      }
      this.listenClient.query('SELECT 1').catch((err) => {
        console.error('[DB] LISTEN keepalive failed:', err.message);
      });
    }, intervalMs);
    if (this.listenKeepAliveInterval.unref) {
      this.listenKeepAliveInterval.unref();
    }
  }

  scheduleRankingsRefresh() {
    if (this.refreshDebounceTimer) clearTimeout(this.refreshDebounceTimer);
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = null;
      this.refreshPrecomputedRankings().catch((err) => {
        console.error('[DB] Debounced materialized view refresh failed:', err.message);
      });
    }, 5000);
  }

  async setupRankingsRefreshListener() {
    const setupListener = async () => {
      if (this.isShuttingDown) return;
      try {
        await this.teardownListenClient();

        const client = new Client(this.dbConfig);
        await client.connect();
        await client.query('LISTEN rankings_changed');

        client.on('notification', (msg) => {
          if (msg.channel === 'rankings_changed') {
            this.scheduleRankingsRefresh();
          }
        });

        client.on('error', (err) => {
          console.error('[DB] LISTEN connection error:', err.message);
          this.teardownListenClient().finally(() => {
            this.scheduleListenReconnect(setupListener);
          });
        });

        this.listenClient = client;
        this.startListenKeepalive();
        console.log('[DB] Listening for rankings_changed (dedicated connection)');
      } catch (error) {
        console.error('[DB] Failed to setup rankings refresh listener:', error.message);
        this.scheduleListenReconnect(setupListener, 10000);
      }
    };

    await setupListener();
  }
  
  async refreshRankings() {
    return this.refreshPrecomputedRankings();
  }

  async setRankingsRefreshEnabled(enabled) {
    const sql = enabled
      ? 'ALTER TABLE user_rankings ENABLE TRIGGER rankings_changed_trigger'
      : 'ALTER TABLE user_rankings DISABLE TRIGGER rankings_changed_trigger';
    await this.query(sql);
  }

  async refreshPrecomputedRankings() {
    if (this.refreshInProgress) {
      this.refreshPending = true;
      return;
    }
    this.refreshInProgress = true;
    try {
      console.log('[DB] Refreshing precomputed_rankings materialized view...');
      await this.query('REFRESH MATERIALIZED VIEW CONCURRENTLY precomputed_rankings');
      console.log('[DB] Materialized view refreshed successfully');
    } finally {
      this.refreshInProgress = false;
      if (this.refreshPending) {
        this.refreshPending = false;
        await this.refreshPrecomputedRankings();
      }
    }
  }

  connectionRetryDelayMs(attempt, maxRetries) {
    const attemptIndex = maxRetries - attempt;
    return Math.min(100 * (2 ** attemptIndex), 2000);
  }

  async query(text, params, retries = 3) {
    if (!this.isConnected || this.isShuttingDown) {
      return { rows: [], rowCount: 0 }; // Return empty result during shutdown
    }
    
    // Try pool.query first (fast path)
    try {
      const result = await this.pool.query(text, params);
      return result;
    } catch (error) {
      if (this.isShuttingDown) {
        return { rows: [], rowCount: 0 }; // Suppress errors during shutdown
      }
      
      // Check if this is a connection error
      const isConnectionError = error.message.includes('Connection terminated') ||
                                error.message.includes('connection timeout') ||
                                error.message.includes('Connection terminated unexpectedly') ||
                                error.message.includes('Client has encountered a connection error') ||
                                (error.cause && error.cause.message && (
                                  error.cause.message.includes('Connection terminated') ||
                                  error.cause.message.includes('ECONNRESET') ||
                                  error.cause.message.includes('EPIPE')
                                ));
      
      // Log connection state when connection errors occur
      if (isConnectionError) {
        console.warn('[DB Connection Error] Pool state:', {
          totalCount: this.pool.totalCount,
          idleCount: this.pool.idleCount,
          waitingCount: this.pool.waitingCount,
          error: error.message,
          errorCode: error.code,
          cause: error.cause?.message,
          timestamp: new Date().toISOString()
        });
      }
      
      if (isConnectionError && retries > 0) {
        const attemptsLeft = retries - 1;
        const delayMs = this.connectionRetryDelayMs(attemptsLeft, retries);
        console.warn(
          `Database connection error, retrying in ${delayMs}ms (${attemptsLeft} attempts left):`,
          error.message
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        
        try {
          // Get a fresh client explicitly - this forces pool to create new connection if needed
          const client = await this.pool.connect();
          try {
            const result = await client.query(text, params);
            if (attemptsLeft < retries) {
              console.log(`Database connection recovered successfully after ${retries - attemptsLeft} retry(ies)`);
            }
            return result;
          } finally {
            client.release(); // Always release the client
          }
        } catch (retryError) {
          // If getting a fresh client also fails, retry recursively
          if (attemptsLeft > 0) {
            return this.query(text, params, attemptsLeft);
          }
          // Out of retries, throw the original error
          throw error;
        }
      }
      
      // For non-connection errors or out of retries, throw
      console.error('Database query error:', error);
      throw error;
    }
  }
  
  async ensureAttestationEventsTable() {
    if (!this.isConnected) {
      throw new Error('Database not connected');
    }
    const ddl = `
      CREATE TABLE IF NOT EXISTS attestation_events (
        event_id TEXT PRIMARY KEY,
        ranked_user_pubkey TEXT NOT NULL,
        service_pubkey TEXT NOT NULL,
        committee_member_pubkey TEXT,
        event_timestamp TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attestation_events_service_ts
        ON attestation_events (service_pubkey, event_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_attestation_events_ranked
        ON attestation_events (ranked_user_pubkey);
    `;
    await this.pool.query(ddl);
    
    // Ensure profile_refresh_queue has new columns
    await this.pool.query(`
      ALTER TABLE profile_refresh_queue 
      ADD COLUMN IF NOT EXISTS last_profile_fetch TIMESTAMP;
    `);
    await this.pool.query(`
      ALTER TABLE profile_refresh_queue 
      ADD COLUMN IF NOT EXISTS last_activity_check TIMESTAMP;
    `);
    
    // Ensure precomputed_rankings materialized view exists
    await this.ensurePrecomputedRankings();
  }
  
  async ensurePrecomputedRankings() {
    // Check if materialized view exists
    const checkResult = await this.pool.query(`
      SELECT EXISTS (
        SELECT FROM pg_matviews WHERE matviewname = 'precomputed_rankings'
      ) as exists
    `);
    
    if (!checkResult.rows[0].exists) {
      console.log('[DB] Creating precomputed_rankings materialized view...');
      
      await this.pool.query(`
        CREATE MATERIALIZED VIEW precomputed_rankings AS
        SELECT 
          ur.ranked_user_pubkey,
          un.name,
          un.nip05,
          un.lud16,
          AVG(ur.rank_value)::INTEGER as rank_value,
          AVG(ur.influence_score) as influence_score,
          AVG(ur.hops)::INTEGER as hops,
          AVG(ur.follower_count)::INTEGER as follower_count,
          COALESCE(MAX(prq.last_activity_timestamp), MAX(un.profile_timestamp)) as last_seen,
          (AVG(ur.influence_score) * LOG(GREATEST(AVG(ur.follower_count), 1) + 1)) as effective_score
        FROM user_rankings ur
        LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
        LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
        GROUP BY ur.ranked_user_pubkey, un.pubkey, un.name, un.nip05, un.lud16
      `);
      
      await this.pool.query(`CREATE UNIQUE INDEX idx_precomputed_pubkey ON precomputed_rankings(ranked_user_pubkey)`);
      await this.pool.query(`CREATE INDEX idx_precomputed_effective_score ON precomputed_rankings(effective_score DESC NULLS LAST)`);
      await this.pool.query(`CREATE INDEX idx_precomputed_name ON precomputed_rankings(name)`);
      await this.pool.query(`CREATE INDEX idx_precomputed_nip05 ON precomputed_rankings(nip05)`);
      await this.pool.query(`CREATE INDEX idx_precomputed_lud16 ON precomputed_rankings(lud16)`);
      
      console.log('[DB] Materialized view created with indexes');
    }
    
    // Ensure trigger function exists
    await this.pool.query(`
      CREATE OR REPLACE FUNCTION trigger_rankings_refresh()
      RETURNS TRIGGER AS $$
      BEGIN
        PERFORM pg_notify('rankings_changed', '');
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    
    // Ensure trigger exists
    await this.pool.query(`
      DROP TRIGGER IF EXISTS rankings_changed_trigger ON user_rankings
    `);
    await this.pool.query(`
      CREATE TRIGGER rankings_changed_trigger
      AFTER INSERT OR UPDATE ON user_rankings
      FOR EACH STATEMENT
      EXECUTE FUNCTION trigger_rankings_refresh()
    `);
    
    console.log('[DB] Precomputed rankings view and triggers ready');
  }

  async disconnect() {
    this.isShuttingDown = true;
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = null;
    }
    if (this.listenReconnectTimer) {
      clearTimeout(this.listenReconnectTimer);
      this.listenReconnectTimer = null;
    }
    await this.teardownListenClient();
    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
      console.log('Disconnected from PostgreSQL database');
    }
  }

  async clearData() {
    if (!this.isConnected) {
      throw new Error('Database not connected');
    }
    try {
      // Clear tables in reverse order of foreign key dependencies
      await this.pool.query('TRUNCATE TABLE user_rankings, delegations, user_names RESTART IDENTITY CASCADE');
      console.log('Database tables (user_rankings, delegations, user_names) cleared.');
    } catch (error) {
      console.error('Failed to clear database tables:', error);
      throw error;
    }
  }

  async close() {
    this.isShuttingDown = true;
    if (this.listenKeepAliveInterval) {
      clearInterval(this.listenKeepAliveInterval);
      this.listenKeepAliveInterval = null;
    }
    if (this.listenClient) {
      try {
        this.listenClient.removeAllListeners();
        this.listenClient.release();
      } catch (e) {
        // Ignore errors
      }
      this.listenClient = null;
    }
    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
      console.log('Disconnected from PostgreSQL database');
    }
  }

  // Insert ranking data from kind 30382 events
  async insertRanking(data) {
    const query = `
      INSERT INTO user_rankings (
        ranked_user_pubkey, service_pubkey, committee_member_pubkey,
        rank_value, hops, influence_score, average_score, confidence_score,
        input_value, pagerank_score, follower_count, muter_count, reporter_count,
        event_timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (ranked_user_pubkey, service_pubkey, committee_member_pubkey)
      DO UPDATE SET
        rank_value = EXCLUDED.rank_value,
        hops = EXCLUDED.hops,
        influence_score = EXCLUDED.influence_score,
        average_score = EXCLUDED.average_score,
        confidence_score = EXCLUDED.confidence_score,
        input_value = EXCLUDED.input_value,
        pagerank_score = EXCLUDED.pagerank_score,
        follower_count = EXCLUDED.follower_count,
        muter_count = EXCLUDED.muter_count,
        reporter_count = EXCLUDED.reporter_count,
        event_timestamp = EXCLUDED.event_timestamp,
        last_updated = CURRENT_TIMESTAMP
      WHERE EXCLUDED.event_timestamp > user_rankings.event_timestamp
    `;
    
    const params = [
      data.ranked_user_pubkey,
      data.service_pubkey,
      data.committee_member_pubkey,
      data.rank_value,
      data.hops,
      data.influence_score,
      data.average_score,
      data.confidence_score,
      data.input_value,
      data.pagerank_score,
      data.follower_count,
      data.muter_count,
      data.reporter_count,
      data.event_timestamp
    ];
    
    await this.query(query, params);
  }

  async insertAttestationEvent(eventId, data) {
    const query = `
      INSERT INTO attestation_events (
        event_id, ranked_user_pubkey, service_pubkey, committee_member_pubkey, event_timestamp
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (event_id) DO NOTHING
    `;
    const params = [
      eventId,
      data.ranked_user_pubkey,
      data.service_pubkey,
      data.committee_member_pubkey || null,
      data.event_timestamp
    ];
    await this.query(query, params);
  }

  // Insert delegation data from kind 10040 events
  async insertDelegation(data) {
    const query = `
      INSERT INTO delegations (
        delegator_pubkey, service_pubkey, source_relay,
        event_timestamp
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (delegator_pubkey, service_pubkey)
      DO UPDATE SET
        source_relay = EXCLUDED.source_relay,
        event_timestamp = EXCLUDED.event_timestamp,
        last_updated = CURRENT_TIMESTAMP
      WHERE EXCLUDED.event_timestamp > delegations.event_timestamp
    `;
    
    const params = [
      data.delegator_pubkey,
      data.service_pubkey,
      data.source_relay,
      data.event_timestamp
    ];
    
    await this.query(query, params);
  }

  async insertUserName(data) {
    // Calculate name affinity: name=2, nip05=1, lud16=1 (max 4 points)
    let nameAffinity = 0;
    if (data.name) nameAffinity += 2;
    if (data.nip05) nameAffinity += 1;
    if (data.lud16) nameAffinity += 1;
    
    // Determine primary name (prefer name field, fallback to nip05, then lud16)
    const primaryName = data.name || data.nip05 || data.lud16 || null;
    
    const query = `
      INSERT INTO user_names (pubkey, name, nip05, lud16, name_affinity, primary_name, profile_timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (pubkey) DO UPDATE SET
        name = EXCLUDED.name,
        nip05 = EXCLUDED.nip05,
        lud16 = EXCLUDED.lud16,
        name_affinity = EXCLUDED.name_affinity,
        primary_name = EXCLUDED.primary_name,
        profile_timestamp = EXCLUDED.profile_timestamp,
        last_updated = CURRENT_TIMESTAMP
      WHERE EXCLUDED.profile_timestamp > user_names.profile_timestamp
    `;
    const params = [data.pubkey, data.name, data.nip05, data.lud16, nameAffinity, primaryName, data.profile_timestamp];
    await this.query(query, params);
  }

  async filterNewPubkeys(pubkeys) {
    if (pubkeys.length === 0) {
      return [];
    }
    
    // Split into chunks to avoid postgres parameter limit (max ~32k parameters)
    const CHUNK_SIZE = 10000;
    const existingPubkeys = new Set();
    
    for (let i = 0; i < pubkeys.length; i += CHUNK_SIZE) {
      const chunk = pubkeys.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
      
      // Skip if we fetched the profile recently (within last 1 day)
      const query = `
        SELECT pubkey FROM profile_refresh_queue
        WHERE pubkey IN (${placeholders})
          AND last_profile_fetch > NOW() - INTERVAL '1 day'
      `;
      const result = await this.query(query, chunk);
      result.rows.forEach(row => existingPubkeys.add(row.pubkey));
    }
    
    return pubkeys.filter(p => !existingPubkeys.has(p));
  }
  
  // Record profile fetch (for kind-0 fetches) - sets profile_timestamp and last_profile_fetch
  async recordProfileTimestamp(pubkeys, profileTimestamps) {
    if (pubkeys.length === 0) return;
    
    const CHUNK_SIZE = 1000;
    const now = new Date();
    
    for (let i = 0; i < pubkeys.length; i += CHUNK_SIZE) {
      const chunk = pubkeys.slice(i, i + CHUNK_SIZE);
      
      const values = chunk.map((pubkey, idx) => {
        return `($${idx * 3 + 1}, $${idx * 3 + 2}, $${idx * 3 + 3})`;
      }).join(',');
      
      const params = chunk.flatMap(pubkey => {
        const profileTs = profileTimestamps.get(pubkey) || 0;
        return [pubkey, profileTs, now];
      });
      
      const query = `
        INSERT INTO profile_refresh_queue (pubkey, profile_timestamp, last_profile_fetch)
        VALUES ${values}
        ON CONFLICT (pubkey) DO UPDATE SET
          profile_timestamp = GREATEST(profile_refresh_queue.profile_timestamp, EXCLUDED.profile_timestamp),
          last_profile_fetch = EXCLUDED.last_profile_fetch
      `;
      
      await this.query(query, params);
    }
  }
  
  // Record activity check results - sets last_activity_timestamp and last_activity_check
  async recordActivityCheck(pubkeys, activityTimestamps) {
    if (pubkeys.length === 0) return;
    
    const CHUNK_SIZE = 500;
    const now = new Date();
    
    for (let i = 0; i < pubkeys.length; i += CHUNK_SIZE) {
      const chunk = pubkeys.slice(i, i + CHUNK_SIZE);
      
      // Split into pubkeys with activity and without
      const withActivity = chunk.filter(p => activityTimestamps.has(p));
      const withoutActivity = chunk.filter(p => !activityTimestamps.has(p));
      
      // Update pubkeys WITH activity (set both last_activity_timestamp and last_activity_check)
      if (withActivity.length > 0) {
        // Use unnest for batch update
        const activityValues = withActivity.map(p => activityTimestamps.get(p));
        await this.query(`
          UPDATE profile_refresh_queue prq
          SET last_activity_timestamp = GREATEST(COALESCE(prq.last_activity_timestamp, 0), v.activity_ts),
              last_activity_check = $3
          FROM (SELECT unnest($1::text[]) as pubkey, unnest($2::bigint[]) as activity_ts) v
          WHERE prq.pubkey = v.pubkey
        `, [withActivity, activityValues, now]);
      }
      
      // Update pubkeys WITHOUT activity (just set last_activity_check)
      if (withoutActivity.length > 0) {
        await this.query(`
          UPDATE profile_refresh_queue
          SET last_activity_check = $2
          WHERE pubkey = ANY($1::text[])
        `, [withoutActivity, now]);
      }
    }
  }

  async getServicePubkeys() {
    const query = 'SELECT DISTINCT service_pubkey FROM delegations WHERE service_pubkey IS NOT NULL AND service_pubkey != \'\'';
    const result = await this.query(query);
    return result.rows.map(row => row.service_pubkey);
  }

  async getDelegatorForService(servicePubkey) {
    const query = 'SELECT delegator_pubkey FROM delegations WHERE service_pubkey = $1';
    const result = await this.query(query, [servicePubkey]);
    return result.rows.length > 0 ? result.rows[0].delegator_pubkey : null;
  }

  async ensureBxrdSchema() {
    const fs = require('fs');
    const path = require('path');
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    for (const file of ['002_bxrd_sentinel.sql', '003_bxrd_ranking_source.sql']) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await this.pool.query(sql);
    }
  }

  async getBxrdSyncState() {
    const result = await this.query(
      'SELECT last_since_ms, last_snapshot_etag, last_snapshot_at, last_delta_at FROM bxrd_sync_state WHERE id = 1'
    );
    return result.rows[0] || {
      last_since_ms: null,
      last_snapshot_etag: null,
      last_snapshot_at: null,
      last_delta_at: null
    };
  }

  async setBxrdSyncState(partial) {
    const fields = [];
    const params = [];
    let i = 1;

    if (partial.last_since_ms !== undefined) {
      fields.push(`last_since_ms = $${i++}`);
      params.push(partial.last_since_ms);
    }
    if (partial.last_snapshot_etag !== undefined) {
      fields.push(`last_snapshot_etag = $${i++}`);
      params.push(partial.last_snapshot_etag);
    }
    if (partial.last_snapshot_at !== undefined) {
      fields.push(`last_snapshot_at = $${i++}`);
      params.push(partial.last_snapshot_at);
    }
    if (partial.last_delta_at !== undefined) {
      fields.push(`last_delta_at = $${i++}`);
      params.push(partial.last_delta_at);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    await this.query(
      `UPDATE bxrd_sync_state SET ${fields.join(', ')} WHERE id = 1`,
      params
    );
  }

  async bulkUpsertBxrdRankings(rankings) {
    if (!rankings.length) return;

    const CHUNK = 500;
    for (let i = 0; i < rankings.length; i += CHUNK) {
      const chunk = rankings.slice(i, i + CHUNK);
      const pubkeys = chunk.map((r) => r.ranked_user_pubkey);
      const sources = chunk.map((r) => r.ranking_source);
      const services = chunk.map((r) => r.service_pubkey);
      const committees = chunk.map((r) => r.committee_member_pubkey);
      const ranks = chunk.map((r) => r.rank_value);
      const hops = chunk.map((r) => r.hops);
      const influences = chunk.map((r) => r.influence_score);
      const averages = chunk.map((r) => r.average_score);
      const confidences = chunk.map((r) => r.confidence_score);
      const inputs = chunk.map((r) => r.input_value);
      const pageranks = chunk.map((r) => r.pagerank_score);
      const followers = chunk.map((r) => r.follower_count);
      const muters = chunk.map((r) => r.muter_count);
      const reporters = chunk.map((r) => r.reporter_count);
      const timestamps = chunk.map((r) => r.event_timestamp);

      await this.query(
        `
        INSERT INTO user_rankings (
          ranked_user_pubkey, ranking_source, service_pubkey, committee_member_pubkey,
          rank_value, hops, influence_score, average_score, confidence_score,
          input_value, pagerank_score, follower_count, muter_count, reporter_count,
          event_timestamp
        )
        SELECT * FROM UNNEST(
          $1::text[], $2::text[], $3::text[], $4::text[],
          $5::int[], $6::int[], $7::float8[], $8::float8[], $9::float8[],
          $10::float8[], $11::float8[], $12::int[], $13::int[], $14::int[],
          $15::timestamptz[]
        )
        ON CONFLICT (ranked_user_pubkey, service_pubkey, committee_member_pubkey)
        DO UPDATE SET
          ranking_source = EXCLUDED.ranking_source,
          rank_value = EXCLUDED.rank_value,
          hops = EXCLUDED.hops,
          influence_score = EXCLUDED.influence_score,
          average_score = EXCLUDED.average_score,
          confidence_score = EXCLUDED.confidence_score,
          input_value = EXCLUDED.input_value,
          pagerank_score = EXCLUDED.pagerank_score,
          follower_count = EXCLUDED.follower_count,
          muter_count = EXCLUDED.muter_count,
          reporter_count = EXCLUDED.reporter_count,
          event_timestamp = EXCLUDED.event_timestamp,
          last_updated = CURRENT_TIMESTAMP
        `,
        [
          pubkeys, sources, services, committees, ranks, hops, influences, averages,
          confidences, inputs, pageranks, followers, muters, reporters, timestamps
        ]
      );
    }
  }

  async bulkUpsertBxrdProfiles(profiles) {
    if (!profiles.length) return;

    const CHUNK = 500;
    for (let i = 0; i < profiles.length; i += CHUNK) {
      const chunk = profiles.slice(i, i + CHUNK);

      for (const p of chunk) {
        let nameAffinity = 0;
        if (p.name) nameAffinity += 2;
        if (p.nip05) nameAffinity += 1;
        if (p.lud16) nameAffinity += 1;
        const primaryName = p.name || p.nip05 || p.lud16 || null;
        const profileTs = p.profile_timestamp || p.last_seen_at || 0;

        await this.query(
          `
          INSERT INTO user_names (pubkey, name, nip05, lud16, name_affinity, primary_name, profile_timestamp)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (pubkey) DO UPDATE SET
            name = EXCLUDED.name,
            nip05 = EXCLUDED.nip05,
            lud16 = EXCLUDED.lud16,
            name_affinity = EXCLUDED.name_affinity,
            primary_name = EXCLUDED.primary_name,
            profile_timestamp = CASE
              WHEN EXCLUDED.profile_timestamp > 0 THEN GREATEST(COALESCE(user_names.profile_timestamp, 0), EXCLUDED.profile_timestamp)
              ELSE user_names.profile_timestamp
            END,
            last_updated = CURRENT_TIMESTAMP
          `,
          [p.pubkey, p.name, p.nip05, p.lud16, nameAffinity, primaryName, profileTs]
        );

        const queueProfileTs = profileTs > 0 ? profileTs : p.last_seen_at || 0;
        const activityTs = p.last_seen_at || queueProfileTs;

        await this.query(
          `
          INSERT INTO profile_refresh_queue (pubkey, profile_timestamp, last_activity_timestamp)
          VALUES ($1, $2, $3)
          ON CONFLICT (pubkey) DO UPDATE SET
            profile_timestamp = GREATEST(profile_refresh_queue.profile_timestamp, EXCLUDED.profile_timestamp),
            last_activity_timestamp = GREATEST(COALESCE(profile_refresh_queue.last_activity_timestamp, 0), EXCLUDED.last_activity_timestamp)
          `,
          [p.pubkey, queueProfileTs, activityTs]
        );
      }
    }
  }
}

module.exports = Database;


