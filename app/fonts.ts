import localFont from "next/font/local";

/** Pixel display font: headings, buttons, HUD and canvas text. */
export const pixelFont = localFont({
  src: "./fonts/PressStart2P-latin.woff2",
  variable: "--font-pixel",
  display: "swap",
  fallback: ["ui-monospace", "monospace"],
});

/** Terminal font for body copy. Not preloaded: it isn't needed for the first playable frame. */
export const monoFont = localFont({
  src: "./fonts/VT323-latin.woff2",
  variable: "--font-mono",
  display: "swap",
  preload: false,
  fallback: ["ui-monospace", "monospace"],
});
