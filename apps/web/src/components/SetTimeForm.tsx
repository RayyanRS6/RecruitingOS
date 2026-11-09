"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import type { SetInterviewTime } from "@ros/contracts";
import { Alert, Button, Field } from "@ros/ui";
import { ApiError, type InterviewBooked } from "../api/client";
import { PLACE_LABEL, bookLabel, durationChoices, durationWords, meetingLinkFor, setTimeBody, setTimeMissing, timeLabel, todayIn, whenLine, type LinkChoice, type MissingField, type PlaceKind, type SetTimeForm as Form } from "../interview-time";
import { interviewSetToast } from "../talent-actions";
import { toast } from "../toast";
import { useCompanyCheck } from "./use-company-check";

const PLACES: readonly PlaceKind[] = ["link", "address", "phone"];

/**
 * "Set a date and time" (the owner's words, 6 November 2026: "nadine sets date and time"), the one form on the candidate's
 * panel and the interview's sheet: a date, a time on the company's clock (named beside it, never the browser's), how long
 * and where, said back in one line, and one button that books it and emails the candidate. No calendar and no declared
 * hours are needed. It is controlled (`form`, `onChange`) so the panel can change the round under it without losing the day.
 *
 * `submit` posts it (a new interview, or the one in motion); its answer says what may be said about the email, and the toast
 * says exactly that, never that it left. An interviewer already booked then is named, with "Book anyway". The button is
 * greyed only with the reason beside it, and a press then takes the keyboard to what is missing. `before` and `after` are
 * the panel's own parts (the round, who interviews, a personal line); `footer` sits under the button (the old path, folded).
 */
export function SetTimeForm(p: {
  /** Unique on the page: each field's id starts with it. */
  idBase: string;
  firstName: string;
  hasEmail: boolean;
  phone?: string | null;
  timeZone: string | null;
  form: Form;
  onChange: (form: Form) => void;
  roundMinutes?: number | null;
  videoRound?: boolean;
  /** An interviewer's working calendar can make the video link (`meetingLinkFor`). */
  calendarLive?: boolean;
  /** A booked time is being moved: the reason field, and "Move". */
  moving?: boolean;
  /** How many people interview, when the form asks (the panel); left out on an interview that already has them. */
  interviewers?: number;
  /** The panel's team is still loading, so nobody can be ticked yet: Book waits, saying so. */
  teamLoading?: boolean;
  onMissingInterviewers?: () => void;
  before?: ReactNode;
  after?: ReactNode;
  footer?: ReactNode;
  autoFocus?: boolean;
  submit: (body: SetInterviewTime) => Promise<InterviewBooked>;
  onDone: (r: InterviewBooked) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const check = useCompanyCheck();
  const id = (x: string) => `${p.idBase}-${x}`;
  const first = p.firstName || "the candidate";
  const [clash, setClash] = useState<string | null>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (p.autoFocus) dateRef.current?.focus();
  }, [p.autoFocus]);
  const set = (patch: Partial<Form>) => {
    setClash(null);
    p.onChange({ ...p.form, ...patch });
  };
  const missing = setTimeMissing(p.form, { interviewers: p.interviewers, teamLoading: p.teamLoading, timeZone: p.timeZone, calendarLive: p.calendarLive });
  const link = meetingLinkFor({ calendarLive: !!p.calendarLive, picked: p.form.linkPicked ?? null, url: p.form.url });
  const said = whenLine(p.form.date, p.form.time, p.timeZone);
  // the usual lengths, the round's own, and whatever the form holds now (a booked time of another length being moved)
  const lengths = [...new Set([...durationChoices(p.roundMinutes), p.form.durationMinutes])].sort((x, y) => x - y);
  const book = useMutation({
    mutationFn: (allowClash: boolean) => p.submit(setTimeBody(p.form, { allowClash, calendarLive: p.calendarLive })),
    onSuccess: async (r) => {
      const t = interviewSetToast(r, p.firstName, { moving: p.moving });
      toast(t.title, t.detail);
      setClash(null);
      await p.onDone(r);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "interviewer_busy") setClash(e.message);
      else toast(e instanceof ApiError ? e.message : "Could not book it. Try again.");
    },
  });
  const focusMissing = (m: MissingField) => {
    if (m.field === "interviewers") return p.onMissingInterviewers?.();
    document.getElementById(id(m.field))?.focus();
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (book.isPending) return;
    if (missing) focusMissing(missing);
    else book.mutate(false);
  };
  // Nothing is sent now: the email waits for the ITS check, or there is no address. Said before the press, not only after.
  const emailNote = check === "waiting" ? `The email to ${first} waits for ITS to confirm your company.` : !p.hasEmail ? "There is no email address on file: tell them yourself." : null;
  return (
    <form className="grid gap-3" onSubmit={onSubmit} noValidate>
      {p.before}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date" htmlFor={id("date")}><input ref={dateRef} id={id("date")} className="input" type="date" min={todayIn(p.timeZone)} value={p.form.date} onChange={(e) => set({ date: e.target.value })} /></Field>
        <Field label={timeLabel(p.timeZone)} htmlFor={id("time")}><input id={id("time")} className="input" type="time" value={p.form.time} onChange={(e) => set({ time: e.target.value })} /></Field>
      </div>
      <Field label="How long" htmlFor={id("length")}>
        <select id={id("length")} className="select" value={p.form.durationMinutes} onChange={(e) => set({ durationMinutes: Number(e.target.value) })}>
          {lengths.map((m) => <option key={m} value={m}>{durationWords(m)}</option>)}
        </select>
      </Field>
      <fieldset className="grid gap-2">
        <legend className="small muted mb-2">Where</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {PLACES.map((k) => (
            <label key={k} className="option-row">
              <input type="radio" name={id("place")} value={k} checked={p.form.place === k} onChange={() => set({ place: k })} />
              <span className="min-w-0">{PLACE_LABEL[k]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {p.form.place === "link" ? (
        <>
          {link.offerCalendar ? <Field label="Meeting link" htmlFor={id("link-source")}><select id={id("link-source")} className="select" value={link.mode} onChange={(e) => set({ linkPicked: e.target.value as LinkChoice })}><option value="calendar">Create it with the calendar event</option><option value="pasted">I'll paste a link</option></select></Field> : null}
          {link.mode === "pasted" ? (
            <Field label={link.urlRequired ? "Link" : "Meeting link (optional)"} htmlFor={id("url")}>
              <input id={id("url")} className="input" type="url" value={p.form.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://" />
            </Field>
          ) : null}
          {!link.offerCalendar && !p.form.url.trim() ? <p className="small muted">{p.videoRound ? "This round is a video call. " : ""}Without a link here, the invitation names the format only, so send {first} the link yourself.</p> : null}
          {!link.offerCalendar ? (
            <details className="more">
              <summary>Why no calendar link?</summary>
              <p className="small muted">A link is made with the calendar event only for an interviewer who connected their calendar in Settings.</p>
            </details>
          ) : null}
        </>
      ) : p.form.place === "address" ? (
        <Field label="Address" htmlFor={id("address")}><input id={id("address")} className="input" value={p.form.address} maxLength={300} onChange={(e) => set({ address: e.target.value })} placeholder="For example: 120 Main Street, Tustin" /></Field>
      ) : (
        <p className="small muted">{p.phone ? `You call ${first} at ${p.phone}.` : p.phone === null ? `The email asks ${first} for a number to call.` : `The email tells ${first} you will call them.`}</p>
      )}
      {p.moving ? <Field label={`Reason (optional, ${first} sees it)`} htmlFor={id("reason")}><input id={id("reason")} className="input" value={p.form.reason ?? ""} maxLength={500} onChange={(e) => set({ reason: e.target.value })} /></Field> : null}
      {p.after}
      {said ? <p className="small"><strong>{said}</strong></p> : null}
      {clash ? (
        <Alert tone="caution">
          <div className="row justify-between">
            <span>{clash}</span>
            <Button size="sm" variant="quiet" loading={book.isPending} onClick={() => book.mutate(true)}>Book anyway</Button>
          </div>
        </Alert>
      ) : null}
      <div className="row">
        <Button type="submit" variant="primary" size="sm" loading={book.isPending} ariaDisabled={!!missing} describedBy={missing ? id("missing") : undefined}>{bookLabel(p.firstName, { check, hasEmail: p.hasEmail, moving: p.moving })}</Button>
        {p.onCancel ? <Button size="sm" variant="quiet" onClick={p.onCancel}>Not now</Button> : null}
      </div>
      {missing ? <p id={id("missing")} className="small muted">{missing.text}</p> : emailNote ? <p className="small muted">{emailNote}</p> : null}
      {p.footer}
    </form>
  );
}
