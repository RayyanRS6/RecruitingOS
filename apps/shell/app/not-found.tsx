import { Link } from "@ros/web/src/nav";

/** Unknown paths anywhere in the shell (the API and candidate pages return their own 404s). */
export default function NotFound() {
  return (
    <main className="main" style={{ maxWidth: 560, margin: "8vh auto" }}>
      <div className="empty">
        <h1>That page does not exist</h1>
        <p style={{ marginTop: 6 }}>It may have moved, or the link is old.</p>
        <div style={{ marginTop: 14 }}><Link to="/" className="btn primary">Go to Today</Link></div>
      </div>
    </main>
  );
}
