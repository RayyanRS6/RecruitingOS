import { Card, numHead, Table } from "@ros/ui";
import { headerCounts, snapshotPlace, snapshotScore, type BoardSnapshot } from "./board-model";

/**
 * "Have a recruiter check this" (plan F9), as the ITS recruiter reads it once they accept the request: the pool board
 * as it stood when the team asked, the summary and where each person was placed and why. It is a picture of that
 * moment; the team applies the board themselves, and the closing line says so (people make every hiring decision; the
 * team's request is their own words and may not). The table keeps each person's name in view while it scrolls sideways
 * on a narrow screen, and the scores sit right-aligned.
 */
export function BoardSnapshotCard({ snapshot }: { snapshot: BoardSnapshot }) {
  const at = new Date(snapshot.capturedAt);
  return (
    <Card title="The pool board when they asked" aside={<span className="small muted">{Number.isNaN(at.getTime()) ? "" : at.toLocaleString()}</span>}>
      <p className="small muted">{headerCounts({ counts: snapshot.summary.counts ?? {}, done: snapshot.summary.done })}</p>
      <p className="small mt-1 text-ink-2">{snapshot.summary.sentences.join(" ")}</p>
      {snapshot.people.length ? (
        <div className="mt-4">
          <Table head={["Candidate", "Where the board put them", numHead("Score"), "Why", "Suggested next step"]} label="The pool board when they asked" pinFirst>
            {snapshot.people.map((p) => {
              // R20-9: a résumé-only score says so, the full label on hover
              const score = snapshotScore(p);
              return (
                <tr key={p.applicationId}>
                  <td className="font-semibold">{p.name}</td>
                  <td className="small">{snapshotPlace(p)}</td>
                  <td className="small num" title={score.title}>{score.text}</td>
                  <td className="small">{p.needsYourEye ? `Needs a person's eye: ${p.needsYourEye}` : p.reason}</td>
                  <td className="small">{p.nextStep ?? ""}</td>
                </tr>
              );
            })}
          </Table>
        </div>
      ) : null}
      <p className="small muted mt-3">The board only suggests. The team applies it themselves, privately, in Review and apply.</p>
    </Card>
  );
}
