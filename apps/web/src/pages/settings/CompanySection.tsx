"use client";

import { type ChangeEvent, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AboutDraftRequest, AboutInput, CompanyView, HiringContactInput } from "@ros/contracts";
import { Alert, Button, Card, Field } from "@ros/ui";
import { api, errorWords } from "../../api/client";
import { ZONE_CHOICES, zoneName } from "../../company-setup";
import { CopyButton } from "../../components/CopyButton";
import { placeWords } from "../../jobs";
import { ABOUT_MAX, LOGO_TYPES, SIZE_BANDS, aboutProblem, companyEdit, companyFormFrom, companyFormProblem, contactLine, logoProblem, type CompanyForm } from "../../settings";
import { toast } from "../../toast";
import { SUBHEAD } from "../look";

/** Every change of the company answers the company again: the page shows that answer, and Home's and the builder's reads follow. */
function useCompanySaved() {
  const qc = useQueryClient();
  return (view: CompanyView) => {
    qc.setQueryData(["company"], view);
    qc.invalidateQueries({ queryKey: ["me"] });
  };
}

/**
 * Settings, Company: the details candidates and the job builder read (name, website, places, time zone, size, the
 * benefits line), the logo, the text about the company on its job pages, the address candidates write to, and the
 * careers page's link. An owner or an admin changes them; a member reads them.
 */
export function CompanySection({ company: c, mayEdit }: { company: CompanyView; mayEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card title="Company" aside={mayEdit && !editing ? <Button size="sm" icon="edit" onClick={() => setEditing(true)}>Edit</Button> : null}>
      <div className="stack gap-6">
        {editing ? <DetailsForm company={c} onClose={() => setEditing(false)} /> : (
          <dl className="glance">
            <dt>Name</dt><dd>{c.name}</dd>
            <dt>Website</dt><dd>{c.website || "None"}</dd>
            <dt>{c.locations.length === 1 ? "Location" : "Locations"}</dt><dd>{c.locations.map(placeWords).join(" · ")}</dd>
            <dt>Time zone</dt><dd>{zoneName(c.timezone)}</dd>
            <dt>People</dt><dd>{c.sizeBand}</dd>
            <dt>Benefits</dt><dd className="whitespace-pre-wrap">{c.benefitsSummary || "None written"}</dd>
          </dl>
        )}
        <Logo company={c} mayEdit={mayEdit} />
        <About company={c} mayEdit={mayEdit} />
        <Contact company={c} mayEdit={mayEdit} />
        <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field label="Careers page" htmlFor="careers-link"><input id="careers-link" className="input" readOnly value={c.careersUrl} onFocus={(e) => e.currentTarget.select()} /></Field>
          <CopyButton text={c.careersUrl} ariaLabel="Copy the careers page's link" />
        </div>
      </div>
    </Card>
  );
}

/** The details in one form. Save sends only what changed. */
function DetailsForm({ company: c, onClose }: { company: CompanyView; onClose: () => void }) {
  const saved = useCompanySaved();
  const [form, setForm] = useState<CompanyForm>(() => companyFormFrom(c));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (part: Partial<CompanyForm>) => setForm((f) => ({ ...f, ...part }));
  const save = useMutation({
    mutationFn: () => api.patch<CompanyView>("/api/v1/companies/current", companyEdit(c, form)),
    onSuccess: (view) => {
      saved(view);
      toast("Saved.");
      onClose();
    },
    onError: (e) => setProblem(errorWords(e, "Could not save.")),
  });
  const submit = () => {
    const wrong = companyFormProblem(form);
    setProblem(wrong);
    if (wrong) return;
    if (!Object.keys(companyEdit(c, form)).length) return onClose();
    save.mutate();
  };
  // a zone the form does not offer (set by hand) stays a choice, so opening the form never changes it
  const zones = ZONE_CHOICES.some((z) => z.value === form.timezone) ? ZONE_CHOICES : [...ZONE_CHOICES, { value: form.timezone, label: zoneName(form.timezone), short: zoneName(form.timezone, "short") }];
  return (
    <form className="stack gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="co-name"><input id="co-name" className="input" value={form.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Website" htmlFor="co-web"><input id="co-web" className="input" value={form.website} maxLength={200} placeholder="acme.com" onChange={(e) => set({ website: e.target.value })} /></Field>
        <Field label="Time zone" htmlFor="co-zone"><select id="co-zone" className="select" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })}>{zones.map((z) => <option key={z.value} value={z.value}>{z.label}</option>)}</select></Field>
        <Field label="People" htmlFor="co-size"><select id="co-size" className="select" value={form.sizeBand} onChange={(e) => set({ sizeBand: e.target.value })}>{SIZE_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}</select></Field>
      </div>
      <Field label="Locations" htmlFor="co-places" hint="One a line, as City, ST."><textarea id="co-places" className="textarea" rows={3} value={form.locations} onChange={(e) => set({ locations: e.target.value })} /></Field>
      <Field label="Benefits" htmlFor="co-benefits" hint="A job with no benefits of its own shows these."><textarea id="co-benefits" className="textarea" rows={3} maxLength={2000} value={form.benefits} onChange={(e) => set({ benefits: e.target.value })} /></Field>
      {problem ? <Alert tone="critical">{problem}</Alert> : null}
      <div className="row">
        <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        <Button variant="ghost" disabled={save.isPending} onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

/** The logo on the careers page and the job pages: a picture to upload, change or remove. */
function Logo({ company: c, mayEdit }: { company: CompanyView; mayEdit: boolean }) {
  const saved = useCompanySaved();
  const [problem, setProblem] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return api.post<CompanyView>("/api/v1/companies/current/logo", body);
    },
    onSuccess: (view) => { saved(view); toast("Logo saved."); },
    onError: (e) => setProblem(errorWords(e, "Could not save the logo.")),
  });
  const remove = useMutation({
    mutationFn: () => api.delete<CompanyView>("/api/v1/companies/current/logo"),
    onSuccess: (view) => { saved(view); toast("Logo removed."); },
    onError: (e) => setProblem(errorWords(e, "Could not remove the logo.")),
  });
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const wrong = logoProblem(file);
    setProblem(wrong);
    if (!wrong) upload.mutate(file);
  };
  if (!mayEdit && !c.logoUrl) return null;
  return (
    <div className="grid gap-2.5">
      <h3 className={SUBHEAD}>Logo</h3>
      <div className="flex flex-wrap items-end gap-4">
        {/* the stored picture, from this site's own address */}
        {c.logoUrl ? <img src={c.logoUrl} alt={`${c.name} logo`} className="h-14 max-w-[180px] rounded-xl border border-line bg-surface object-contain p-1.5" /> : null}
        {mayEdit ? (
          <>
            <div className="min-w-0 flex-[1_1_16rem]">
              <Field label={c.logoUrl ? "Change the picture" : "Picture"} htmlFor="co-logo" hint="PNG, JPG or WebP, up to 2 MB.">
                <input id="co-logo" className="input" type="file" accept={LOGO_TYPES.join(",")} disabled={upload.isPending} onChange={pick} />
              </Field>
            </div>
            {c.logoUrl ? <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>Remove</Button> : null}
          </>
        ) : null}
      </div>
      {upload.isPending ? <p className="small muted" role="status">Saving the logo…</p> : null}
      {problem ? <Alert tone="critical">{problem}</Alert> : null}
    </div>
  );
}

/**
 * The text about the company on its job pages. A person approves every word of it: their own text, or a draft the
 * assistant wrote from their notes, which is never public until someone approves it.
 */
function About({ company: c, mayEdit }: { company: CompanyView; mayEdit: boolean }) {
  const saved = useCompanySaved();
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const editing = text !== null;
  const draft = c.aboutDraft;
  const close = () => { setText(null); setProblem(null); };
  const write = useMutation({
    mutationFn: (notes: string) => api.post<CompanyView>("/api/v1/companies/current/about/draft", (notes ? { notes: notes.slice(0, 1000) } : {}) satisfies AboutDraftRequest),
    onSuccess: (view) => {
      saved(view);
      setProblem(null);
      if (view.aboutDraft) setText(view.aboutDraft.text);
    },
    onError: (e) => setProblem(errorWords(e, "Could not draft it.")),
  });
  const approve = useMutation({
    mutationFn: (body: AboutInput) => api.post<CompanyView>("/api/v1/companies/current/about", body),
    onSuccess: (view, body) => {
      saved(view);
      toast(body.text === null ? "Taken off your job pages." : "Saved. It shows on your job pages.");
      close();
    },
    onError: (e) => setProblem(errorWords(e, "Could not save.")),
  });
  const submit = () => {
    const wrong = aboutProblem(text ?? "");
    setProblem(wrong);
    if (!wrong) approve.mutate({ text: (text ?? "").trim() });
  };
  if (!mayEdit && !c.about) return null;
  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={SUBHEAD}>About the company</h3>
        {mayEdit && !editing ? <Button size="sm" variant="ghost" icon="edit" onClick={() => setText(draft?.text ?? c.about?.text ?? "")}>{c.about || draft ? "Edit" : "Write it"}</Button> : null}
      </div>
      {editing ? (
        <form className="stack gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <Field label="Shown on your job pages" htmlFor="co-about" hint={`${(text ?? "").trim().length} of ${ABOUT_MAX} characters`}>
            <textarea id="co-about" className="textarea min-h-[160px]" value={text ?? ""} onChange={(e) => setText(e.target.value)} />
          </Field>
          {draft?.check && (text ?? "").includes(draft.check.text) ? (
            <Alert tone="caution"><strong>"{draft.check.text}"</strong> {draft.check.reason} Try: {draft.check.alternative}</Alert>
          ) : null}
          {problem ? <Alert tone="critical">{problem}</Alert> : null}
          <div className="row">
            <Button type="submit" variant="primary" loading={approve.isPending}>Approve for the job pages</Button>
            <Button icon="sparkle" loading={write.isPending} disabled={approve.isPending} onClick={() => write.mutate((text ?? "").trim())}>Draft it for me</Button>
            <Button variant="ghost" disabled={approve.isPending || write.isPending} onClick={close}>Cancel</Button>
          </div>
          <p className="small muted">"Draft it for me" has an AI assistant write from what you typed. Nothing shows on a job page until you approve it.</p>
        </form>
      ) : c.about ? (
        <>
          <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink-2 wrap-anywhere">{c.about.text}</p>
          {mayEdit ? <div className="row"><Button size="sm" variant="ghost" loading={approve.isPending} onClick={() => approve.mutate({ text: null })}>Take it off the job pages</Button></div> : null}
          {problem ? <Alert tone="critical">{problem}</Alert> : null}
        </>
      ) : <p className="small muted">{draft ? "A draft is waiting for you to approve it." : "Nothing yet. Your job pages show the job alone."}</p>}
    </div>
  );
}

/** The address candidates can write to. Until the company sets its own, the ITS inbox answers. */
function Contact({ company: c, mayEdit }: { company: CompanyView; mayEdit: boolean }) {
  const saved = useCompanySaved();
  const [form, setForm] = useState<{ email: string; name: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: HiringContactInput) => api.put<CompanyView>("/api/v1/companies/current/hiring-contact", body),
    onSuccess: (view) => {
      saved(view);
      toast("Saved.");
      setForm(null);
      setProblem(null);
    },
    onError: (e) => setProblem(errorWords(e, "Could not save.")),
  });
  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={SUBHEAD}>Candidates write to</h3>
        {mayEdit && !form ? <Button size="sm" variant="ghost" icon="edit" onClick={() => setForm({ email: c.hiringContact?.email ?? "", name: c.hiringContact?.name ?? "" })}>Edit</Button> : null}
      </div>
      {form ? (
        <form className="stack gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate({ email: form.email.trim(), name: form.name.trim() || null }); }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email" htmlFor="co-contact-email"><input id="co-contact-email" className="input" type="email" required maxLength={254} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Name (optional)" htmlFor="co-contact-name"><input id="co-contact-name" className="input" maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          </div>
          {problem ? <Alert tone="critical">{problem}</Alert> : null}
          <div className="row">
            <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
            {c.hiringContact ? <Button disabled={save.isPending} onClick={() => save.mutate({ email: null })}>Use the ITS inbox</Button> : null}
            <Button variant="ghost" disabled={save.isPending} onClick={() => { setForm(null); setProblem(null); }}>Cancel</Button>
          </div>
        </form>
      ) : <p className="text-[14.5px] text-ink-2 wrap-anywhere">{contactLine(c)}</p>}
    </div>
  );
}
