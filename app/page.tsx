import { GameApp } from "@/game/ui/GameApp";
import { parseAllowedHosts } from "@/lib/embed/allowed-hosts";
import { condensedFont, displayFont } from "./fonts";

/** The game route (PRD §15.1). Static: ALLOWED_HOSTS is read at build time, as in next.config. */
export default function Home() {
  const { patterns } = parseAllowedHosts(process.env.ALLOWED_HOSTS);
  return (
    <GameApp
      fonts={{ display: displayFont.style.fontFamily, condensed: condensedFont.style.fontFamily }}
      patterns={patterns}
    />
  );
}
