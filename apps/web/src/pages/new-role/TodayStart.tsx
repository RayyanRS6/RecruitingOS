"use client";

import { useState } from "react";
import { Alert, Card } from "@ros/ui";
import { Link } from "../../nav";
import { START_HIRE_HREF } from "../../start-hire";
import { Composer } from "./Composer";
import { AssistantMark, Thinking } from "./Conversation";
import { RoomAlert } from "./StartView";
import { useStartDraft } from "./use-start-draft";

/**
 * Today's "Who are you hiring?" box (plan C4, founder decision Q5: labelled, and it hands off). What is typed here starts
 * a draft and opens the job builder on it; Today itself keeps no conversation. Shown only to people who may start a hire.
 */
export function TodayStart() {
  const [text, setText] = useState("");
  const { start, pending, notARole, problem, limit, clearProblem } = useStartDraft();
  return (
    <Card className="today-start" title="Who are you hiring?" aside={<Link to={START_HIRE_HREF} className="small">Open the job builder</Link>}>
      <p className="small muted" style={{ marginBottom: 10 }}>Describe the role in a sentence or paste a job ad. The job builder opens with your draft, and an AI assistant asks a few questions. Nothing is posted until someone approves it.</p>
      {limit?.room && !limit.room.ok ? <RoomAlert room={limit.room} ask={limit.ask} /> : null}
      {notARole ? (
        <div className="chat-msg assistant" style={{ marginBottom: 10 }}>
          <AssistantMark />
          <div className="bubble assistant">{notARole}</div>
        </div>
      ) : null}
      <Composer
        first
        value={text}
        onChange={(v) => { setText(v); clearProblem(); }}
        onSend={start}
        sending={pending}
        label="Who are you hiring?"
        sendLabel="Start drafting"
        placeholder="For example: a dental assistant for our Irvine office, full time, $24 to $28 an hour"
      />
      {pending ? <Thinking label="Reading what you wrote…" /> : null}
      {problem ? <Alert tone="critical">{problem}</Alert> : null}
    </Card>
  );
}
