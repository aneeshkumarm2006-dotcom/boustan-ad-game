import { POINTS_PER_GARLIC, POINTS_PER_METRE, WINNERS, pointsOf } from "@/game-core";
import { retentionDue, purgeDate } from "@/lib/server/admin/retention";
import { loadSettings, toForm } from "@/lib/server/admin/settings";
import { formatMontreal } from "@/lib/server/admin/time";
import { db } from "@/lib/server/db";
import { ActionForm, Submit } from "../forms";
import { saveCampaignAction } from "../actions";
import { ContestTags } from "../contest";
import { n } from "../format";

export const metadata = { title: "Campaign · Boustan game admin" };

const points = (value: number) => `${n(value)} ${value === 1 ? "point" : "points"}`;

/** The worked example on the "How points work" card. */
const EXAMPLE = { distanceM: 250, garlic: 12 };

export default async function CampaignPage() {
  const settings = await loadSettings(db());
  const form = toForm(settings);
  const purge = await purgeDate(db());
  const due = await retentionDue(db());

  return (
    <>
      <div className="adm-head">
        <div>
          <h1>Campaign</h1>
          <p>
            The contest dates, the leaderboard switch and data retention. Every change is logged.
            The game keeps working while you edit: it is never taken offline.
          </p>
        </div>
        <div className="adm-row">
          <ContestTags contest={settings} now={new Date()} />
        </div>
      </div>

      <ActionForm action={saveCampaignAction} className="adm-form">
        <section className="adm-card" aria-labelledby="window-title">
          <h2 id="window-title">Dates and leaderboard</h2>
          <div className="adm-row">
            <div className="adm-field">
              <label htmlFor="startsAt">Starts (Montréal time)</label>
              <input
                id="startsAt"
                type="datetime-local"
                name="startsAt"
                defaultValue={form.startsAt}
              />
            </div>
            <div className="adm-field">
              <label htmlFor="endsAt">Ends (Montréal time)</label>
              <input id="endsAt" type="datetime-local" name="endsAt" defaultValue={form.endsAt} />
            </div>
          </div>
          <p className="adm-note">
            Before the start and after the end the game can still be played, but nothing is saved or
            ranked. When the end passes, the top {WINNERS} on the leaderboard at that moment are the
            winners. Leave both blank for no dates: the contest then never ends.
          </p>
          <label className="adm-check">
            <input type="checkbox" name="leaderboardOpen" defaultChecked={form.leaderboardOpen} />
            <span>
              <b>Leaderboard is on.</b> Untick to stop all new scores at once (emergency switch).
              Players can keep playing, but nothing is saved or ranked until you tick it again.
            </span>
          </label>
        </section>

        <section className="adm-card" aria-labelledby="points-title">
          <header>
            <h2 id="points-title">How points work</h2>
            <span className="adm-note">Read only</span>
          </header>
          <dl className="adm-dl">
            <dt>Distance</dt>
            <dd>{points(POINTS_PER_METRE)} per metre run, in whole metres</dd>
            <dt>Garlic</dt>
            <dd>{points(POINTS_PER_GARLIC)} each</dd>
            <dt>Ties</dt>
            <dd>Whoever reached the score first ranks higher</dd>
            <dt>Winners</dt>
            <dd>The top {WINNERS} on the leaderboard</dd>
            <dt>Example</dt>
            <dd>
              {n(EXAMPLE.distanceM)} m and {n(EXAMPLE.garlic)} garlic make{" "}
              {points(pointsOf(EXAMPLE))}
            </dd>
          </dl>
          <p className="adm-note">
            These rules are part of the game itself: changing them means a code change and a deploy.
          </p>
        </section>

        <section className="adm-card" aria-labelledby="privacy-title">
          <h2 id="privacy-title">Data retention</h2>
          <div className="adm-field" style={{ maxWidth: 260 }}>
            <label htmlFor="retentionDays">Days after the contest ends</label>
            <input
              id="retentionDays"
              type="number"
              name="retentionDays"
              defaultValue={form.retentionDays}
              min={1}
              max={3650}
              step={1}
              required
            />
          </div>
          <p className="adm-note">
            After this, players who did not opt in to offers are anonymized automatically (their
            email, nickname and consent records are removed; anonymous totals stay). The current top{" "}
            {WINNERS} are kept, so the winners can still be reached. Opted-in contacts are kept for
            Boustan&rsquo;s own policy.{" "}
            {purge
              ? `With the current end date this starts ${formatMontreal(purge)}${
                  due > 0 ? ` and ${n(due)} players are waiting` : ""
                }.`
              : "Set an end date for this to take effect."}
          </p>
        </section>

        <div>
          <Submit className="adm-btn main" pending="Saving…">
            Save changes
          </Submit>
        </div>
      </ActionForm>
    </>
  );
}
