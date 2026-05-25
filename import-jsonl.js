const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('./services/database');
const EventProcessor = require('./services/event-processor');
const pino = require('pino');

const log = pino({ level: 'info' });

async function importAttestations() {
  const database = new Database();
  await database.connect();
  log.info('Database connected');

  // Ensure attestation_events table exists
  await database.ensureAttestationEventsTable();
  
  const eventProcessor = new EventProcessor(database, log);

  const inputPath =
    process.argv[2] || path.join(__dirname, 'attestations120325.jsonl');

  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath),
    crlfDelay: Infinity
  });

  let count = 0;
  let batch = [];
  const BATCH_SIZE = 10000; // Larger batches for speed
  const pubkeys = new Set();

  for await (const line of rl) {
    try {
      const event = JSON.parse(line);
      const dTag = event.tags.find(t => t[0] === 'd');
      if (dTag) pubkeys.add(dTag[1]);
      
      batch.push(event);
      
      if (batch.length >= BATCH_SIZE) {
        await eventProcessor.processEvents(batch, 30382);
        count += batch.length;
        log.info(`Processed ${count} events (${pubkeys.size} unique pubkeys so far)...`);
        batch = [];
      }
    } catch (error) {
      log.error({ error, line }, 'Failed to process event');
    }
  }
  
  log.info(`Total unique pubkeys in source: ${pubkeys.size}`);

  // Process remaining batch
  if (batch.length > 0) {
    await eventProcessor.processEvents(batch, 30382);
    count += batch.length;
  }

  log.info(`Import complete! Processed ${count} total events.`);
  await database.close();
}

importAttestations().catch(error => {
  console.error('Import failed:', error);
  process.exit(1);
});

