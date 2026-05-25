'use strict'

const fastify = require('fastify')
const pino = require('pino')
const stream = require('stream')
const path = require('path');
const Database = require('./services/database');
const RelayListener = require('./services/relay-listener');
const BxrdWotSync = require('./services/bxrd-wot-sync');
const { getRelayConfig, getBxrdConfig } = require('./services/config');

// --- In-memory logger setup ---
const logBuffer = []
const logThroughStream = new stream.PassThrough()

logThroughStream.on('data', (chunk) => {
  if (logBuffer.length >= 100) {
    logBuffer.shift()
  }
  logBuffer.push(chunk.toString())
})

const streams = pino.multistream([
  { stream: process.stdout },
  { stream: logThroughStream }
])

const server = fastify({
  disableRequestLogging: true,
  trustProxy: true,
  logger: {
    level: 'info',
    stream: streams
  },
  pluginTimeout: 30000
})

// --- Services ---
const database = new Database();
const relayConfig = getRelayConfig();
const bxrdConfig = getBxrdConfig();
const relayListener = bxrdConfig.disableRelays
  ? null
  : new RelayListener(
      relayConfig.rankingRelayUrls,
      relayConfig.socialRelayUrls,
      database,
      server.log
    );
let bxrdWotSync = null;
if (bxrdConfig.syncEnabled) {
  bxrdWotSync = new BxrdWotSync(database, server.log);
}

// --- Hooks ---
server.addHook('onReady', async () => {
  try {
    await database.connect();
    server.log.info('Database connected successfully');

    if (process.argv.includes('--fresh')) {
      server.log.info('"--fresh" flag detected. Starting fresh backfill...');
    }

    if (bxrdWotSync) {
      const syncOnStart = bxrdConfig.syncOnStart;
      if (syncOnStart) {
        bxrdWotSync
          .runOnce()
          .catch((err) => server.log.error({ err }, 'BXRD initial sync failed'));
      }
      bxrdWotSync.startPoller({ skipImmediate: syncOnStart });
    } else if (relayListener) {
      relayListener.start();
    }
  } catch (dbError) {
    server.log.warn('Database connection failed:', dbError.message);
  }
});

server.addHook('onClose', (instance, done) => {
  database.close().then(() => {
    if (bxrdWotSync) {
      bxrdWotSync.stopPoller();
    }
    if (relayListener) {
      relayListener.close();
    }
    done();
  }).catch(done);
});

// Custom request logging - only log legitimate API queries, not health checks or static pages
server.addHook('onRequest', async (request, reply) => {
  // Use routerPath if available, otherwise fall back to URL
  const path = request.routerPath || request.url.split('?')[0];
  
  // Whitelist: only log these specific routes - everything else (including '/') is ignored
  if (
    path === '/stats' ||
    path === '/api/users/:pubkey/activity' ||
    (path && path.startsWith('/user/') && path.length > 6)
  ) {
    request.log.info({
      req: {
        method: request.method,
        url: request.url,
        host: request.hostname,
        remoteAddress: request.ip,
        remotePort: request.socket.remotePort
      }
    }, 'incoming request');
  }
});

server.addHook('onResponse', async (request, reply) => {
  // Use routerPath if available, otherwise fall back to URL
  const path = request.routerPath || request.url.split('?')[0];
  
  // Whitelist: only log these specific routes - everything else (including '/') is ignored
  if (
    path === '/stats' ||
    path === '/api/users/:pubkey/activity' ||
    (path && path.startsWith('/user/') && path.length > 6)
  ) {
    request.log.info({
      res: {
        statusCode: reply.statusCode
      },
      responseTime: reply.getResponseTime()
    }, 'request completed');
  }
});

// --- Decorate server with database ---
server.decorate('database', database);

// --- Register static file serving ---
server.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  prefix: '/public/',
});

// --- Register routes ---
server.register(require('./routes/web'));
server.register(require('./routes/api'));

server.get('/api-docs', async (request, reply) => {
  return reply.sendFile('api-docs.html');
});

// --- Routes ---
let statsCache = { data: null, expires: 0 };
const STATS_CACHE_TTL = 600000; // 10 minutes

server.get('/stats', async (request, reply) => {
  try {
    // Return cached stats if valid
    if (statsCache.data && Date.now() < statsCache.expires) {
      return statsCache.data;
    }
    
    // Ensure database is connected
    if (!database.client) {
      server.log.warn('Database not connected, attempting to connect...');
      await database.connect();
    }
    
    const rankingsResult = await database.query('SELECT COUNT(*) FROM user_rankings;');
    const attestationsEventResult = await database.query('SELECT COUNT(*) FROM attestation_events;');
    const namesResult = await database.query('SELECT COUNT(*) FROM user_names;');
    const delegationsResult = await database.query('SELECT COUNT(*) FROM delegations;');

    const rankingsCount = parseInt(rankingsResult.rows[0].count, 10);
    const attestationEventsCount = parseInt(attestationsEventResult.rows[0].count, 10);
    const namesCount = parseInt(namesResult.rows[0].count, 10);
    const delegationsCount = parseInt(delegationsResult.rows[0].count, 10);

    const stats = {
      user_rankings: rankingsCount,
      attestation_events: attestationEventsCount,
      user_names: namesCount,
      delegations: delegationsCount
    };
    
    // Cache the result
    statsCache = { data: stats, expires: Date.now() + STATS_CACHE_TTL };
    
    return stats;
  } catch (error) {
    server.log.error(error, 'Error fetching stats');
    reply.status(500).send({ error: 'Internal Server Error' });
  }
});

server.get('/log', async (request, reply) => {
  reply.header('Content-Type', 'text/plain');
  return logBuffer.join('');
});

// --- Start and Shutdown ---
const start = async () => {
  try {
    const port = process.env.PORT || 3333;
    await server.listen({ port })
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

let isShuttingDown = false;

const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('\nShutting down...');
  
  // Force exit after 5 seconds (querySync default timeout is 4s)
  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
  
  // Stop accepting new work
  if (bxrdWotSync) {
    bxrdWotSync.stopPoller();
  }
  if (relayListener) {
    relayListener.close();
  }
  
  // Close database
  try {
    await database.disconnect();
  } catch (e) {
    // Ignore errors during shutdown
  }
  
  try {
    await server.close();
  } catch (e) {
    // Ignore
  }
  
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the process alive indefinitely, but don't block exit
const keepAliveInterval = setInterval(() => {}, 1 << 30);
process.on('exit', () => clearInterval(keepAliveInterval));

start()
