import { Card, numHead, Table } from "@ros/ui";
import { headerCounts, snapshotPlace, type BoardSnapshot } from "./board-model";

/**
 * "Have a recruiter check this" (plan F9), as the ITS recruiter reads it once they accept the request: the pool board
 * as it stood when the team asked, the summary and where each person was placed and why. It is a picture of that
 * moment; the team applies the board themselves.
 */
export function BoardSnapshotCard({ snapshot }: { snapshot: BoardSnapshot }) {
  const at = new Date(snapshot.capturedAt);
  return (
    <Card title="The pool board when they asked" aside={<span className="small muted">{Number.isNaN(at.getTime()) ? "" : at.toLocaleString()}</span>}>
      <p className="small muted">{headerCounts({ counts: snapshot.summary.counts ?? {}, done: snapshot.summary.done })}</p>
      <p className="small" style={{ marginTop: 4 }}>{snapshot.summary.sentences.join(" ")}</p>
      {snapshot.people.length ? (
        <div style={{ marginTop: 10 }}>
          <Table head={["Candidate", "Where the board put them", numHead("Score"), "Why", "Suggested next step"]} label="The pool board when they asked">
            {snapshot.people.map((p) => (
              <tr key={p.applicationId}>
                <td>{p.name}</td>
                <td className="small">{snapshotPlace(p)}</td>
                <td className="small num">{p.score === null ? "No score yet" : `${p.score}/100`}</td>
                <td className="small">{p.needsYourEye ? `Needs a person's eye: ${p.needsYourEye}` : p.reason}</td>
                <td className="small">{p.nextStep ?? ""}</td>
              </tr>
            ))}
          </Table>
        </div>
      ) : null}
      <p className="small muted" style={{ marginTop: 8 }}>The board only suggests. The team applies it themselves, privately, in Review and apply.</p>
    </Card>
  );
}
