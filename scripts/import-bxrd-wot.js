#!/usr/bin/env node
'use strict';

const Database = require('../services/database');
const BxrdWotSync = require('../services/bxrd-wot-sync');
const { getBxrdConfig } = require('../services/config');

async function main() {
  const config = getBxrdConfig();
  if (!config.bearerToken) {
    console.error('BXRD_ATTESTOR_BEARER_TOKEN is required');
    process.exit(1);
  }

  const database = new Database();
  await database.connect();

  const sync = new BxrdWotSync(database, console);
  const forceSeed = process.argv.includes('--seed');

  try {
    const result = forceSeed
      ? await sync.runSnapshotSeed()
      : await sync.runOnce();
    console.log('BXRD import finished:', result);
  } finally {
    await database.close();
  }
}

main().catch((err) => {
  console.error('BXRD import failed:', err);
  process.exit(1);
});
