export function SimulationLegend() {
  return (
    <footer className="legend">
      <span>
        <span className="legend__swatch legend__swatch--favorable" /> Favorable (&gt;60% win odds)
      </span>
      <span>
        <span className="legend__swatch legend__swatch--coinflip" /> Tight contest (40–60%)
      </span>
      <span>
        <span className="legend__swatch legend__swatch--underdog" /> Underdog (&lt;40% win odds)
      </span>
    </footer>
  );
}
