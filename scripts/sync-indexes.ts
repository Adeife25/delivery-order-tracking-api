import 'dotenv/config';
import mongoose from 'mongoose';
import { allModels } from '../src/database/models';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to sync indexes');
  }

  await mongoose.connect(databaseUrl);

  try {
    for (const model of allModels) {
      const collection = model.collection.collectionName;
      const indexes = await model.syncIndexes();
      console.log(
        `${collection}: ${indexes.length} index(es) [${indexes.join(', ')}]`,
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    `Index sync failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
