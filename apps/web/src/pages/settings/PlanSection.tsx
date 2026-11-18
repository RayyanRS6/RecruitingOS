"use client";

import type { PlanView } from "@ros/contracts";
import { Alert, Card } from "@ros/ui";
import { Upgrade } from "../../components/Upgrade";
import { planLines } from "../../settings";

/**
 * Settings, Plan: the plan's name, where a trial stands, one line of what is used of each limit in the server's words
 * (AI help as a percentage, never money), the notice when the AI help is running low or used up, and the way to ask for
 * a bigger plan. While a request is with ITS, the day it was sent stands in place of the button.
 */
export function PlanSection({ plan, timeZone }: { plan: PlanView; timeZone: string }) {
  const lines = planLines(plan, timeZone);
  return (
    <Card title="Plan" aside={plan.mayUpgrade ? <Upgrade size="sm" requestedAt={plan.upgradeRequestedAt} /> : null}>
      <div className="stack gap-3">
        <p className="text-[15px]"><strong>{lines.name}</strong>{lines.trial ? <span className="text-ink-2"> · {lines.trial}</span> : null}</p>
        {lines.usage ? <p className="text-[14.5px] text-ink-2">{lines.usage}</p> : null}
        {plan.aiCredit?.notice ? <Alert tone="caution"><strong>{plan.aiCredit.notice.title}</strong> {plan.aiCredit.notice.body}</Alert> : null}
      </div>
    </Card>
  );
}
