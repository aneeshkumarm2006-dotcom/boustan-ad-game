import { WORDMARK } from "@/lib/brand";

/**
 * The Boustan logotype, the guide's own vector artwork (lib/brand.ts). It takes the colour of the
 * text around it, which admin.css sets to Toum on Vert: the only two colours the guide allows.
 * Size it with CSS (height; the width follows the artwork).
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${WORDMARK.w} ${WORDMARK.h}`}
      role="img"
      aria-label="Boustan"
    >
      <path d={WORDMARK.d} fill="currentColor" />
    </svg>
  );
}
