import type { Metadata } from "next";
import "./admin.css";

export const metadata: Metadata = {
  title: "Boustan game admin",
  robots: { index: false, follow: false },
};

/** Shell for every /admin page, login included: the stylesheet and a scroll container. */
export default function AdminShell({ children }: { children: React.ReactNode }) {
  return <div className="adm">{children}</div>;
}
