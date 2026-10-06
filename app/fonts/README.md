# Fonts

Boustan's guide de style (automne 2025, p. 14-15) names four families. Three of them are commercial or custom, so this folder holds **free stand-ins with the same role**. Nothing here needs a licence.

| Role (CSS variable)            | Brand font                       | Stand-in shipped here                                          | License                   |
| ------------------------------ | -------------------------------- | -------------------------------------------------------------- | ------------------------- |
| Display (`--font-display`)     | Ergon Medium                     | `YoungSerif-Regular-latin.woff2`, Young Serif 3.003            | SIL Open Font License 1.1 |
| Condensed (`--font-condensed`) | Marr Sans Condensed Semibold     | `BarlowCondensed-SemiBold-latin.woff2`, Barlow Condensed 1.408 | SIL Open Font License 1.1 |
| Body (`--font-body`)           | Suisse (Regular, Regular italic) | `Inter-Regular-latin.woff2`, Inter 4.001 (wght 400, opsz 14)   | SIL Open Font License 1.1 |
| Arabic (not loaded yet)        | Lateef Medium                    | -                                                              | SIL Open Font License 1.1 |

Copyright: © 2023 The Young Serif Project Authors (github.com/noirblancrouge/YoungSerif), © 2017 The Barlow Project Authors (github.com/jpt/barlow), © 2016 The Inter Project Authors (github.com/rsms/inter). OFL text: https://openfontlicense.org.

## How the files were made

Each is the upstream font from google/fonts, cut down to Latin plus French (Basic Latin, Latin-1, œ Œ Ÿ, curly quotes, dashes, ellipsis, €, arrows; `fontTools.subset`, no hinting, woff2). Inter is a variable font pinned to weight 400 and optical size 14. Young Serif's default figures are old-style (a "1" reads like an "I"), so the digits are pointed at the font's own lining glyphs (`lnum`) before subsetting. The three files total about 44 KB, which matters because the page has a 250 KB first-load budget (`e2e/budget.spec.ts`). None of them has ✓ (the UI draws it as SVG) or any emoji.

## Brand rules the CSS follows

- **Display (Ergon):** overline and H1/H2. Sentence case, never all caps. Never faux-bold: the only face is weight 400, and `font-synthesis: none` is set.
- **Condensed (Marr):** titles, sub-titles, buttons and labels. Always upper case, applied with `text-transform: uppercase`.
- **Body (Suisse):** running text. Never all caps.

## Switching to the real brand fonts

1. Put the licensed `.woff2` files here (subset them the same way if you want to keep the budget: Ergon and Marr are only used for short strings).
2. In `../fonts.ts` change the `src` of `displayFont`, `condensedFont` and `bodyFont` (and `weight` if the new file differs).
3. Run `npm run check:i18n` and `npx playwright test e2e/cross-browser.spec.ts`: the second one checks that every French character is drawn by the font rather than a fallback.

Add Lateef (free, on Google Fonts) as a fourth `localFont` the day an Arabic phrase is added; the guide says short phrases only, always in Arabic.
