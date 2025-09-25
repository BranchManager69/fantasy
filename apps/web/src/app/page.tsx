import Link from "next/link";

const sections = [
  {
    heading: "Pipeline status",
    body: "The Python CLI generates deterministic ESPN/nflverse artifacts under data/out/. Once those files exist for the active season, this frontend will surface them live (try GET /api/league).",
    href: "/api/league",
    cta: "Fetch league teams",
  },
  {
    heading: "Upcoming API routes",
    body: "Next API endpoints (e.g., /api/league, /api/matchups, /api/roster) will read the CSV outputs directly. No mock data, no stubs—only real league history.",
    href: "https://github.com/BranchManager69/fantasy/blob/main/docs/frontend-ux-data-contract.md",
    cta: "Inspect data contract",
  },
  {
    heading: "Design targets",
    body: "League Home will highlight live matchups, hot moments, and manager capsules driven by the real-time feeds. Wireframes and module breakdowns live in the UX doc while we nail the data bridge.",
    href: "https://github.com/BranchManager69/fantasy/blob/main/docs/frontend-ux-data-contract.md#23-core-modules-league-home-candidates",
    cta: "View module plan",
  },
];

export default function Home() {
  return (
    <main
      style={{
        margin: "0 auto",
        maxWidth: "960px",
        padding: "80px 24px",
        display: "flex",
        flexDirection: "column",
        gap: "48px",
      }}
    >
      <header style={{ textAlign: "center", display: "grid", gap: "16px" }}>
        <p style={{
          textTransform: "uppercase",
          letterSpacing: "0.24em",
          fontSize: "0.8rem",
          color: "#6B7280",
        }}>
          Fantasy League Engine
        </p>
        <h1 style={{ fontSize: "2.75rem", fontWeight: 700 }}>
          Real data. Real hype. Real receipts.
        </h1>
        <p style={{ fontSize: "1.1rem", color: "#9CA3AF" }}>
          This UI shell is wired to the deterministic backend. As soon as the season artifacts land, widgets here will source them live.
        </p>
      </header>

      <section
        style={{
          display: "grid",
          gap: "24px",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        }}
      >
        {sections.map((section) => (
          <article
            key={section.heading}
            style={{
              borderRadius: "18px",
              border: "1px solid rgba(148, 163, 184, 0.24)",
              padding: "24px",
              display: "grid",
              gap: "12px",
              background: "rgba(30, 41, 59, 0.45)",
              backdropFilter: "blur(12px)",
            }}
          >
            <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>{section.heading}</h2>
            <p style={{ lineHeight: 1.5, color: "#E2E8F0" }}>{section.body}</p>
            <Link
              href={section.href}
              style={{
                justifySelf: "flex-start",
                fontWeight: 600,
                color: "#34D399",
              }}
            >
              {section.cta} →
            </Link>
          </article>
        ))}
      </section>

      <footer style={{ textAlign: "center", color: "#6B7280", fontSize: "0.95rem" }}>
        Need fresh data? Run the CLI again (`poetry run fantasy espn pull` & friends) and hot reload will pick up the regenerated artifacts.
      </footer>
    </main>
  );
}
