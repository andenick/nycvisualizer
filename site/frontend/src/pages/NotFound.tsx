import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div style={{ padding: "2rem 0" }}>
      <h1>Not found</h1>
      <p>That page doesn't exist yet.</p>
      <p>
        <Link to="/">← Back to the NYC Visualizer hub</Link>
      </p>
    </div>
  );
}
