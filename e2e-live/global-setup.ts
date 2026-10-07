import { createDb } from "../db/client";
import { migrateDb } from "../db/migrate";
import { COLLECTIONS, newCampaignSettings } from "../db/schema";
import { LIVE_MONGODB_URI } from "../playwright.live.config";

/** A fresh e2e database: migrated, emptied, contest open. */
export default async function globalSetup() {
  await migrateDb(LIVE_MONGODB_URI);
  const { db, client } = createDb(LIVE_MONGODB_URI, { max: 1 });
  try {
    for (const name of Object.values(COLLECTIONS)) {
      await db.mongo.collection(name).deleteMany({});
    }
    const now = Date.now();
    await db.campaignSettings.insertOne(
      newCampaignSettings({
        startsAt: new Date(now - 3_600_000),
        endsAt: new Date(now + 86_400_000),
        leaderboardOpen: true,
      }),
    );
  } finally {
    await client.close();
  }
}
