import type { Metadata } from "next";
import { LeagueStudio } from "@/components/league-studio";
import "./studio.css";

export const metadata: Metadata = { title: "League studio | Mod League", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function StudioPage() {
  return <LeagueStudio />;
}
