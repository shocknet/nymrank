'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const Fastify = require('fastify')
const apiRoutes = require('../../routes/api')

async function buildApiApp (overrides = {}) {
  const app = Fastify()
  app.decorate('database', {
    query: overrides.query || (async () => ({ rows: [] }))
  })
  app.register(apiRoutes)
  await app.ready()
  return app
}

test('GET /api/names/:name returns available when no occupant', async (t) => {
  const app = await buildApiApp()
  t.after(() => app.close())

  const res = await app.inject({
    method: 'GET',
    url: '/api/names/alice'
  })

  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.payload)
  assert.equal(body.name, 'alice')
  assert.equal(body.available, true)
  assert.equal(body.occupant, null)
})

test('GET /api/users/:pubkey/rank returns aggregate when found', async (t) => {
  const hex = 'e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f'
  let call = 0
  const app = await buildApiApp({
    query: async (sql) => {
      call += 1
      if (call === 1) {
        return {
          rows: [{
            pubkey: hex,
            average_rank: 82,
            average_influence_score: 0.74,
            average_hops: 2,
            average_follower_count: 318,
            perspective_count: 1,
            name: 'alice',
            nip05: 'alice@example.com',
            lud16: 'alice@wallet.com',
            name_affinity: 4
          }]
        }
      }
      return {
        rows: [{
          committee_member_pubkey: 'bxrd',
          rank_value: 82,
          influence_score: 0.74,
          hops: 2,
          follower_count: 318
        }]
      }
    }
  })
  t.after(() => app.close())

  const res = await app.inject({
    method: 'GET',
    url: `/api/users/${hex}/rank`
  })

  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.payload)
  assert.equal(body.pubkey, hex)
  assert.equal(body.average_rank, 82)
  assert.equal(body.committee_breakdown.length, 1)
})

test('GET /api/users/:pubkey/rank validates pubkey', async (t) => {
  const app = await buildApiApp()
  t.after(() => app.close())
  const res = await app.inject({
    method: 'GET',
    url: '/api/users/not-a-pubkey/rank'
  })

  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.payload)
  assert.equal(body.error.code, 'invalid_pubkey')
})

test('GET /api/users/:pubkey/activity validates pubkey', async (t) => {
  const app = await buildApiApp()
  t.after(() => app.close())
  const res = await app.inject({
    method: 'GET',
    url: '/api/users/not-a-pubkey/activity'
  })

  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.payload)
  assert.equal(body.error.code, 'invalid_pubkey')
})

test('GET /api/status returns ok when db query succeeds', async (t) => {
  const app = await buildApiApp({
    query: async (sql) => {
      if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] }
      if (String(sql).includes('bxrd_sync_state')) {
        return {
          rows: [{
            last_since_ms: Date.now(),
            last_snapshot_etag: 'etag',
            last_snapshot_at: new Date(),
            last_delta_at: new Date()
          }]
        }
      }
      if (String(sql).includes('COUNT(*)') && String(sql).includes('ranking_source')) {
        return { rows: [{ count: 5000 }] }
      }
      if (String(sql).includes('precomputed_rankings')) {
        return { rows: [{ count: 5000 }] }
      }
      if (String(sql).includes('LIMIT 1')) {
        return { rows: [{ pubkey: 'a'.repeat(64) }] }
      }
      if (String(sql).includes('perspective_count')) {
        return { rows: [{ average_rank: 40, perspective_count: 1 }] }
      }
      return { rows: [] }
    }
  })
  t.after(() => app.close())

  const prev = {
    primary: process.env.BXRD_PRIMARY_SOURCE,
    sync: process.env.BXRD_SYNC_ENABLED,
    token: process.env.BXRD_ATTESTOR_BEARER_TOKEN,
    url: process.env.BXRD_API_BASE_URL
  }
  process.env.BXRD_PRIMARY_SOURCE = 'false'
  process.env.BXRD_SYNC_ENABLED = 'false'

  const res = await app.inject({
    method: 'GET',
    url: '/api/status'
  })

  process.env.BXRD_PRIMARY_SOURCE = prev.primary
  process.env.BXRD_SYNC_ENABLED = prev.sync
  process.env.BXRD_ATTESTOR_BEARER_TOKEN = prev.token
  process.env.BXRD_API_BASE_URL = prev.url

  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.payload)
  assert.equal(body.ok, true)
  assert.equal(body.service, 'nymrank-api')
  assert.equal(body.checks.database.ok, true)
})
