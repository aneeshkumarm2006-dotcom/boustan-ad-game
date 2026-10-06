import { createDb } from "../db/client";
import { migrateDb } from "../db/migrate";
import { COLLECTIONS, newCampaignSettings, newCode, newReward } from "../db/schema";
import { LIVE_MONGODB_URI } from "../playwright.live.config";

/** A fresh e2e database: migrated, emptied, campaign open, 20 test codes per reward. */
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
        claimsEnabled: true,
      }),
    );
    await db.rewards.insertMany([
      newReward({
        _id: "free_coke",
        names: { fr: "Coke gratuit", en: "Free Coke" },
        terms: { fr: "", en: "" },
        rule: { distanceM: 100 },
        validityDays: 30,
      }),
      newReward({
        _id: "free_garlic_sauce",
        names: { fr: "Sauce à l'ail gratuite", en: "Free garlic sauce" },
        terms: { fr: "", en: "" },
        rule: { garlic: 10 },
        validityDays: 30,
      }),
    ]);
    for (const reward of ["free_coke", "free_garlic_sauce"] as const) {
      await db.codes.insertMany(
        Array.from({ length: 20 }, (_, i) =>
          newCode({
            rewardId: reward,
            code: `E2E-${reward === "free_coke" ? "COKE" : "GARL"}-${String(i).padStart(3, "0")}`,
          }),
        ),
      );
    }
  } finally {
    await client.close();
  }
}
