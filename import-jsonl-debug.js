const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('./services/database');
const EventProcessor = require('./services/event-processor');
const pino = require('pino');

const log = pino({ level: 'warn' }); // Less verbose

async function importAttestations() {
  const database = new Database();
  await database.connect();
  console.log('Database connected');

  await database.ensureAttestationEventsTable();
  
  const eventProcessor = new EventProcessor(database, log);

  const inputPath = process.argv[2] || path.join(__dirname, 'attestations.jsonl');

  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath),
    crlfDelay: Infinity
  });

  let processed = 0;
  let inserted = 0;
  let errors = 0;
  const uniquePubkeys = new Set();

  for await (const line of rl) {
    try {
      const event = JSON.parse(line);
      const dTag = event.tags.find(t => t[0] === 'd');
      if (dTag) uniquePubkeys.add(dTag[1]);
      
      // Process one event at a time to catch errors
      try {
        await eventProcessor.handleRankingEvent(event);
        inserted++;
      } catch (err) {
        errors++;
        if (errors < 10) {
          console.log('Error processing event:', err.message);
        }
      }
      
      processed++;
      
      if (processed % 10000 === 0) {
        const dbCount = await database.query('SELECT COUNT(*) FROM user_rankings');
        console.log(`Processed: ${processed}, Inserted: ${inserted}, Errors: ${errors}, DB count: ${dbCount.rows[0].count}, Unique source pubkeys: ${uniquePubkeys.size}`);
      }
    } catch (error) {
      console.error('Failed to parse line:', error.message);
    }
  }

  const finalCount = await database.query('SELECT COUNT(*) FROM user_rankings');
  console.log('\n=== FINAL RESULTS ===');
  console.log(`Total processed: ${processed}`);
  console.log(`Successful inserts: ${inserted}`);
  console.log(`Errors: ${errors}`);
  console.log(`Unique source pubkeys: ${uniquePubkeys.size}`);
  console.log(`Final DB count: ${finalCount.rows[0].count}`);

  await database.close();
}

importAttestations().catch(error => {
  console.error('Import failed:', error);
  process.exit(1);
});

