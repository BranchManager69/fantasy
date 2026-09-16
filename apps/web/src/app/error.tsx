"use client";

import "./week.css";

export default function ReportError({ reset }: { reset: () => void }) {
  return <main className="week-page"><div className="week-wrap"><section className="week-empty">
    <h1>The report could not be opened.</h1>
    <p>Try loading the league results again.</p>
    <button className="week-retry" type="button" onClick={reset}>Try again</button>
  </section></div></main>;
}
