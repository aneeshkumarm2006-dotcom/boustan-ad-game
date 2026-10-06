import type { Metadata, Viewport } from "next";
import { monoFont, pixelFont } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Boustan | Sauvez le poulet / Save the Chicken",
  description: "Jeu bilingue Boustan : sauvez le poulet et gagnez des récompenses.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0e0b1e",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className={`${pixelFont.variable} ${monoFont.variable}`}>
      <body>{children}</body>
    </html>
  );
}
