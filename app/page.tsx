import { GameApp } from "@/game/ui/GameApp";
import { parseAllowedHosts } from "@/lib/embed/allowed-hosts";
import { pixelFont } from "./fonts";

/** The game route (PRD §15.1). Static: ALLOWED_HOSTS is read at build time, as in next.config. */
export default function Home() {
  const { patterns } = parseAllowedHosts(process.env.ALLOWED_HOSTS);
  return <GameApp font={pixelFont.style.fontFamily} patterns={patterns} />;
}
