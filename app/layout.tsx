import type { Metadata, Viewport } from "next";
import { bodyFont, condensedFont, displayFont } from "./fonts";
import "./globals.css";

/** Public base URL (APP_URL), so the social preview image resolves to an absolute address. */
function baseUrl(): URL {
  try {
    return new URL(process.env.APP_URL || "http://localhost:3000");
  } catch {
    return new URL("http://localhost:3000");
  }
}

const TITLE = "Boustan | Sauvez le poulet / Save the Chicken";
const DESCRIPTION =
  "Jeu bilingue Boustan : sauvez le poulet, marquez des points et visez les 3 premières places du classement.";

export const metadata: Metadata = {
  metadataBase: baseUrl(),
  title: TITLE,
  description: DESCRIPTION,
  // The preview image (opengraph-image.png, twitter-image.png) is the brand card in this folder.
  openGraph: {
    type: "website",
    siteName: "Boustan",
    title: TITLE,
    description: DESCRIPTION,
    locale: "fr_CA",
    alternateLocale: ["en_CA"],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Vert Boustan: the browser chrome matches the page.
  themeColor: "#073F36",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="fr"
      className={`${displayFont.variable} ${condensedFont.variable} ${bodyFont.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
