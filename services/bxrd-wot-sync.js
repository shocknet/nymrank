'use strict';

const BxrdWotClient = require('./bxrd-wot-client');
const { mapAttestorRows } = require('./bxrd-wot-mapper');
const {
  computeNextSinceMs,
  trackMaxAttestorChangedSec,
  sinceMsFromMaxSec
} = require('./bxrd-wot-cursor');
const { getBxrdConfig } = require('./config');

class BxrdWotSync {
  constructor(database, log) {
    this.database = database;
    this.log = log || console;
    this.config = getBxrdConfig();
    this.client = new BxrdWotClient(this.config);
    this.pollTimer = null;
    this.running = false;
    this.lastDeltaPubkeys = null;
  }

  async runOnce() {
    if (!this.config.bearerToken) {
      this.log.warn('[BXRD] BXRD_ATTESTOR_BEARER_TOKEN not set; skipping sync');
      return { skipped: true, reason: 'no_token' };
    }

    await this.database.ensureBxrdSchema();
    const state = await this.database.getBxrdSyncState();
    const etag = state.last_snapshot_etag;

    if (!etag) {
      this.log.info('[BXRD] No snapshot etag — seeding from gzip export');
      return this.runSnapshotSeed();
    }

    const snapshot = await this.client.openSnapshotGz({ etag });

    if (snapshot.status === 304) {
      return this.runDeltaPoll(state);
    }

    this.log.info('[BXRD] Snapshot etag changed — full reconcile (delta cursor unchanged)');
    return this.ingestSnapshotStream(snapshot, { seedCursor: false });
  }

  async runSnapshotSeed() {
    const snapshot = await this.client.openSnapshotGz({ etag: null });
    if (snapshot.status === 304) {
      this.log.warn('[BXRD] Seed requested but got 304');
      return { seeded: false };
    }
    return this.ingestSnapshotStream(snapshot, { seedCursor: true });
  }

  /**
   * @param {{ seedCursor: boolean }} opts
   * seedCursor: true only on first gzip seed — sets last_since_ms from export.
   * Nightly reconcile (seedCursor false) refreshes rows but keeps last_since_ms from delta polls.
   */
  async ingestSnapshotStream(snapshot, { seedCursor }) {
    const snapshotStarted = Date.now();
    const batch = [];
    const BATCH = 500;
    let lineCount = 0;
    let maxAttestorSec = 0;

    await this.database.setRankingsRefreshEnabled(false);
    try {
      for await (const row of this.client.iterateNdjsonLines(snapshot.stream)) {
        batch.push(row);
        lineCount++;
        if (batch.length >= BATCH) {
          await this.upsertBatch(batch);
          maxAttestorSec = trackMaxAttestorChangedSec(batch, maxAttestorSec);
          batch.length = 0;
        }
      }
      if (batch.length > 0) {
        await this.upsertBatch(batch);
        maxAttestorSec = trackMaxAttestorChangedSec(batch, maxAttestorSec);
      }
    } finally {
      await this.database.setRankingsRefreshEnabled(true);
      await this.database.refreshPrecomputedRankings();
    }

    const syncPatch = {
      last_snapshot_etag: snapshot.etag,
      last_snapshot_at: snapshot.computedAt ? new Date(snapshot.computedAt) : new Date()
    };
    if (seedCursor) {
      syncPatch.last_since_ms = sinceMsFromMaxSec(maxAttestorSec);
    }
    await this.database.setBxrdSyncState(syncPatch);

    this.log.info(
      { lines: lineCount, etag: snapshot.etag, seedCursor, deltaSinceMs: syncPatch.last_since_ms ?? null },
      '[BXRD] Snapshot ingest complete (single materialized view refresh)'
    );

    await this.logSyncRun('snapshot', {
      entriesCount: lineCount,
      snapshotEtag: snapshot.etag,
      sinceMs: syncPatch.last_since_ms ?? null,
      durationMs: Date.now() - snapshotStarted
    });

    return { snapshot: true, lines: lineCount, etag: snapshot.etag };
  }

  async logSyncRun(runType, fields) {
    try {
      await this.database.logBxrdSyncRun({ runType, ...fields });
    } catch (err) {
      this.log.warn({ err, runType }, '[BXRD] Failed to log sync run');
    }
  }

  async runDeltaPoll(state) {
    const started = Date.now();
    let sinceMs = state.last_since_ms;
    if (sinceMs == null || sinceMs <= 0) {
      sinceMs = 0;
    }

    try {
      const data = await this.client.fetchDelta(sinceMs);
      const entries = data.entries || [];
      const pubkeys = entries.map((e) => String(e.pubkey || '').toLowerCase()).filter(Boolean);
      const repeatCount =
        this.lastDeltaPubkeys && pubkeys.length > 0
          ? pubkeys.filter((p) => this.lastDeltaPubkeys.has(p)).length
          : 0;

      if (entries.length > 0) {
        await this.upsertBatch(entries);
      }

      const nextSinceMs = computeNextSinceMs(entries, sinceMs);

      await this.database.setBxrdSyncState({
        last_since_ms: nextSinceMs,
        last_delta_at: new Date()
      });

      this.lastDeltaPubkeys = new Set(pubkeys);

      const logPayload = {
        entries: entries.length,
        since: sinceMs,
        sinceSec: data.since_sec ?? Math.floor(sinceMs / 1000),
        nextSince: nextSinceMs,
        sinceUnchanged: nextSinceMs === sinceMs,
        repeatPubkeys: repeatCount
      };
      if (entries.length > 0 && repeatCount === entries.length) {
        this.log.warn(
          logPayload,
          '[BXRD] Delta poll: all returned keys were in the previous poll (active cohort or cursor — check nextSince)'
        );
      } else {
        this.log.info(logPayload, '[BXRD] Delta poll complete');
      }

      await this.logSyncRun('delta', {
        entriesCount: entries.length,
        sinceMs,
        nextSinceMs,
        durationMs: Date.now() - started
      });

      return { delta: true, entries: entries.length, repeatPubkeys: repeatCount };
    } catch (err) {
      if (err.statusCode === 400) {
        this.log.warn({ err }, '[BXRD] Delta since invalid — resetting cursor to bootstrap');
        await this.database.setBxrdSyncState({ last_since_ms: 0 });
      }
      throw err;
    }
  }

  async upsertBatch(rows) {
    const { rankings, profiles } = mapAttestorRows(rows);
    await this.database.bulkUpsertBxrdRankings(rankings);
    await this.database.bulkUpsertBxrdProfiles(profiles);
  }

  startPoller({ skipImmediate = false } = {}) {
    if (!this.config.syncEnabled || this.pollTimer) return;

    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch((err) => this.log.error({ err }, '[BXRD] Sync tick failed'))
        .finally(() => {
          this.running = false;
        });
    };

    this.log.info(
      { intervalMs: this.config.deltaPollMs },
      '[BXRD] Starting WoT sync poller'
    );
    if (!skipImmediate) tick();
    this.pollTimer = setInterval(tick, this.config.deltaPollMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  stopPoller() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

module.exports = BxrdWotSync;
