/**
 * CSS font-family lists for text drawn on the canvas (app/fonts.ts supplies them). The canvas
 * can't read CSS variables, so the page passes the resolved families in.
 */
export interface CanvasFonts {
  /** Display serif (Ergon in the guide): big numbers and titles. Sentence case. */
  display: string;
  /** Condensed sans (Marr Sans Condensed in the guide): banners, floating text, signs. Upper case. */
  condensed: string;
}
