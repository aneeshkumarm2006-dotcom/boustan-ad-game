import { WINNERS } from "@/game-core";
import { campaignStatus, type Campaign } from "@/lib/server/campaign";

const STATUS = {
  not_started: ["Not started", "warn"],
  active: ["Live", ""],
  ended: ["Ended", "mute"],
} as const;

/** The contest's status and the leaderboard switch, as tags. */
export function ContestTags({ contest, now }: { contest: Campaign; now: Date }) {
  const [label, tone] = STATUS[campaignStatus(contest, now)];
  return (
    <>
      <span className={`adm-tag ${tone}`}>{label}</span>
      <span className={`adm-tag ${contest.leaderboardOpen ? "" : "warn"}`}>
        {contest.leaderboardOpen ? "leaderboard on" : "leaderboard off"}
      </span>
    </>
  );
}

/** "Winners" once the end date has passed; until then the top of the board can still change. */
export function winnersTitle(contest: Campaign, now: Date): string {
  return campaignStatus(contest, now) === "ended" ? "Winners" : `Top ${WINNERS} right now`;
}
