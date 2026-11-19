"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AdminCompany, CustomerAccessAnswer, CustomerAccessChange } from "@ros/contracts";
import { Button } from "@ros/ui";
import { api } from "../../api/client";
import { toast } from "../../toast";
import { adminKeys, adminReason } from "./admin-api";
import { type AccessDecision, accessButton, accessPress, accessPressRefused, accessQuestion, accessToast, type LineFact } from "./company-facts";

/** Facts in one line that wraps like a sentence; a website is a link that opens apart and tells search engines nothing. */
export function FactsLine({ facts }: { facts: readonly LineFact[] }) {
  return (
    <>
      {facts.map((f, i) => (
        <Fragment key={`${i}-${f.text}`}>
          {i ? " · " : null}
          {f.href ? <a href={f.href} target="_blank" rel="noopener noreferrer nofollow">{f.text}<span className="sr-only"> (opens in a new tab)</span></a> : f.text}
        </Fragment>
      ))}
    </>
  );
}

/**
 * The decisions a company takes now, a button each (Accept and Decline for a request, Accept for a declined company,
 * Take away access for an accepted one), or the second press in their place: "Accept Harbor Dental?" with Yes and No.
 */
export function AccessChoice(props: { company: Pick<AdminCompany, "name" | "accessDecisions">; asking: AccessDecision | null; pending: boolean; onPress: (decision: AccessDecision) => void; onYes: () => void; onNo: () => void }) {
  const { company, asking, pending } = props;
  if (asking) {
    const question = accessQuestion(asking, company.name);
    return (
      <>
        <span className="min-w-0 text-sm font-semibold text-ink wrap-anywhere">{question.ask}</span>
        <span className="row">
          <Button size="sm" variant={asking === "remove" ? "destructive" : "primary"} loading={pending} ariaLabel={question.yes} onClick={props.onYes}>Yes</Button>
          <Button size="sm" variant="quiet" disabled={pending} ariaLabel={question.no} onClick={props.onNo}>No</Button>
        </span>
      </>
    );
  }
  return (
    <>
      {company.accessDecisions.map((decision) => {
        const button = accessButton(decision, company.name);
        return <Button key={decision} size="sm" variant={decision === "accept" ? "primary" : "quiet"} ariaLabel={button.name} onClick={() => props.onPress(decision)}>{button.label}</Button>;
      })}
    </>
  );
}

/**
 * The press on a company's access, from its row under "Waiting for approval" and from its drawer alike (POST
 * /admin/customers/:id/access): the question, then a toast in the API's own words, and the list read again, so the row
 * leaves. Another administrator who got there first reads the API's calm answer and the row refreshes the same way. An
 * error is a toast and the row stays. `onDecided` runs once the new list is drawn, either way, for the place around it
 * to look after focus should the row have left with it. Swapping the buttons removes the one that had focus: it goes to
 * Yes, and after No back to the button that asked.
 *
 * The question keeps what its first press sends, `from` included: where the request stood then. It stands only while
 * the request still stands there, so the list read again under it with another administrator's decision takes it
 * away, and its Yes never sends where the row stands now.
 */
export function AccessButtons({ company, onDecided }: { company: Pick<AdminCompany, "id" | "name" | "accessRequest" | "accessDecisions">; onDecided?: () => void }) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState<CustomerAccessChange | null>(null);
  if (asking && asking.from !== company.accessRequest?.status) setAsking(null);
  const box = useRef<HTMLSpanElement>(null);
  const focusButton = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asking` is what swaps the buttons, and this runs once they are drawn
  useEffect(() => {
    if (focusButton.current === null) return;
    box.current?.querySelectorAll("button")[focusButton.current]?.focus();
    focusButton.current = null;
  }, [asking]);
  const ask = (decision: AccessDecision | null) => {
    focusButton.current = decision || !asking ? 0 : Math.max(0, company.accessDecisions.indexOf(asking.decision));
    setAsking(decision ? accessPress(company, decision) : null);
  };
  const decide = useMutation({
    mutationFn: (press: CustomerAccessChange) => api.post<CustomerAccessAnswer>(`/api/v1/admin/customers/${encodeURIComponent(company.id)}/access`, press, adminReason(press.decision === "remove" ? "take away access" : "access request")),
    onSuccess: async (answer) => {
      const said = accessToast(answer);
      toast(said.title, said.detail);
      await qc.invalidateQueries({ queryKey: adminKeys.companies });
      setAsking(null);
      onDecided?.();
    },
    onError: async (e) => {
      const refused = accessPressRefused(e);
      toast(refused.title, refused.tone ? { tone: refused.tone } : undefined);
      ask(null);
      await qc.invalidateQueries({ queryKey: adminKeys.companies });
      onDecided?.();
    },
  });
  return (
    <span ref={box} className="flex max-w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <AccessChoice company={company} asking={asking?.decision ?? null} pending={decide.isPending} onPress={ask} onYes={() => asking && decide.mutate(asking)} onNo={() => ask(null)} />
    </span>
  );
}
