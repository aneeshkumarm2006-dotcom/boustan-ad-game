import { retentionDue, purgeDate } from "@/lib/server/admin/retention";
import { LIMITS, loadSettings, toForm } from "@/lib/server/admin/settings";
import { formatMontreal } from "@/lib/server/admin/time";
import { db } from "@/lib/server/db";
import { ActionForm, Submit } from "../forms";
import { saveCampaignAction } from "../actions";
import { n } from "../format";

export const metadata = { title: "Campaign · Boustan game admin" };

const STATUS = {
  not_started: ["Not started", "warn"],
  active: ["Live", ""],
  ended: ["Ended", "mute"],
} as const;

export default async function CampaignPage() {
  const settings = await loadSettings(db());
  const form = toForm(settings);
  const now = new Date();
  const status =
    settings.startsAt && now < settings.startsAt
      ? "not_started"
      : settings.endsAt && now >= settings.endsAt
        ? "ended"
        : "active";
  const [label, tone] = STATUS[status];
  const live = status === "active" && settings.claimsEnabled;
  const purge = await purgeDate(db());
  const due = await retentionDue(db());

  return (
    <>
      <div className="adm-head">
        <div>
          <h1>Campaign</h1>
          <p>
            Dates, the claims switch and each reward&rsquo;s settings. Every change is logged. The
            game keeps working while you edit: it is never taken offline.
          </p>
        </div>
        <div className="adm-row">
          <span className={`adm-tag ${tone}`}>{label}</span>
          <span className={`adm-tag ${live ? "" : "warn"}`}>
            {live ? "claims open" : "claims closed"}
          </span>
        </div>
      </div>

      <ActionForm action={saveCampaignAction} className="adm-form">
        <section className="adm-card" aria-labelledby="window-title">
          <h2 id="window-title">Dates and claims</h2>
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
            Before the start and after the end the game can still be played, but nobody can claim a
            reward. Leave both blank for no dates.
          </p>
          <label className="adm-check">
            <input type="checkbox" name="claimsEnabled" defaultChecked={form.claimsEnabled} />
            <span>
              <b>Claims are on.</b> Untick to stop all claims at once (emergency switch). Players
              can keep playing and saving scores.
            </span>
          </label>
        </section>

        <section className="adm-grid two" aria-label="Rewards">
          {(["free_coke", "free_garlic_sauce"] as const).map((id) => {
            const r = form.rewards[id];
            const limit = LIMITS[id];
            const title =
              id === "free_coke"
                ? "Free Coke / Coke gratuit"
                : "Free garlic sauce / Sauce à l'ail gratuite";
            return (
              <article className="adm-card" key={id}>
                <h2>{title}</h2>
                <label className="adm-check">
                  <input type="checkbox" name={`${id}_active`} defaultChecked={r.active} />
                  <span>
                    <b>Reward is on.</b> Untick to pause it: the card shows &ldquo;All gone for
                    now&rdquo;.
                  </span>
                </label>
                <div className="adm-field">
                  <label htmlFor={`${id}_threshold`}>
                    {id === "free_coke" ? "Distance to unlock (metres)" : "Garlic to unlock"}
                  </label>
                  <input
                    id={`${id}_threshold`}
                    type="number"
                    name={`${id}_threshold`}
                    defaultValue={r.threshold}
                    min={limit.min}
                    max={limit.max}
                    step={1}
                    required
                  />
                  <small>
                    {limit.min} to {limit.max}. Applies to runs started after you save.
                  </small>
                </div>
                <div className="adm-field">
                  <label htmlFor={`${id}_validity`}>Code valid for (days after it is issued)</label>
                  <input
                    id={`${id}_validity`}
                    type="number"
                    name={`${id}_validity`}
                    defaultValue={r.validityDays}
                    min={1}
                    max={365}
                    step={1}
                    required
                  />
                  <small>A code with its own expiry date in the CSV keeps that date.</small>
                </div>
              </article>
            );
          })}
        </section>

        <section className="adm-card" aria-labelledby="privacy-title">
          <h2 id="privacy-title">Data retention</h2>
          <div className="adm-field" style={{ maxWidth: 260 }}>
            <label htmlFor="retentionDays">Days after the campaign ends</label>
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
            email, nickname and consent records are removed; anonymous totals stay). Players who
            still hold a code that hasn&rsquo;t expired wait until it does. Opted-in contacts are
            kept for Boustan&rsquo;s own policy.{" "}
            {purge
              ? `With the current end date this starts ${formatMontreal(purge)}${
                  due > 0 ? ` and ${n(due)} players are waiting` : ""
                }.`
              : "Set an end date for this to take effect."}
          </p>
        </section>

        <div>
          <Submit pending="Saving…">Save changes</Submit>
        </div>
      </ActionForm>
    </>
  );
}
