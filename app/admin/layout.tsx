import type { Metadata } from "next";
import "./admin.css";

export const metadata: Metadata = {
  title: "Boustan game admin",
  robots: { index: false, follow: false },
};

/**
 * Shell for every /admin page, login included: the stylesheet and a scroll container. The admin
 * is English only, while the root layout declares the game's language (fr).
 */
export default function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="adm" lang="en">
      {children}
    </div>
  );
}
