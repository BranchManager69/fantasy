import "./week.css";

export default function LoadingReport() {
  return <main className="week-page"><div className="week-wrap"><section className="week-empty" aria-busy="true" aria-label="Loading the weekly report">
    <p>Opening the weekly report...</p><div className="week-loading-block" /><div className="week-loading-line" /><div className="week-loading-line" />
  </section></div></main>;
}
