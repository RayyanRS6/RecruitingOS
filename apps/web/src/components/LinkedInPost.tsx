"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, cn, Skeleton } from "@ros/ui";
import { api, type RoleDetail, type ShareLinkResponse } from "../api/client";
import { LINKEDIN_OPEN_URL, POST_TONES, linkedInPostText, postFactsOf, postLengthLine, previewParts, withTrackedLink, type PostTone } from "../linkedin-post";
import { toast } from "../toast";

/**
 * "Post on LinkedIn" on the Share tab (Wave S2, slice K3): three tones of ready-made words from the job's own facts,
 * a box to change them, a preview, the character count, and "Copy and open LinkedIn". Nothing is posted for anyone:
 * the words are copied, LinkedIn opens in a new tab, and the person pastes and posts from their own account. No AI and
 * no LinkedIn API; no script from LinkedIn ever loads here.
 *
 * The link in the words is the job's own LinkedIn link when it has one (the same tracked link the LinkedIn share button
 * uses, so applicants from the post show LinkedIn as their source). Someone who may share makes it with their first
 * copy; anyone else, or a link that cannot be made, gets the job page's address.
 */
export function LinkedInPost(props: { roleId: string; roleTitle: string; companyName: string | null; jobUrl: string; linkedInUrl: string | null; canMakeLink: boolean; accepting: boolean }) {
  const qc = useQueryClient();
  // the job as its page reads it (the same query, so nothing is fetched twice): the live version's facts
  const role = useQuery({ queryKey: ["role", props.roleId], queryFn: () => api.get<RoleDetail>(`/api/v1/roles/${props.roleId}`) });
  const make = useMutation({ mutationFn: () => api.post<ShareLinkResponse>(`/api/v1/roles/${props.roleId}/share-links`, { place: "linkedin" }) });
  const [tone, setTone] = useState<PostTone>("proud");
  // null while the words are the tone's own; the person's words once they change anything
  const [edited, setEdited] = useState<string | null>(null);
  // the LinkedIn link made by this card, used until the share block is read again
  const [madeUrl, setMadeUrl] = useState<string | null>(null);
  // a copy under way (a second press meanwhile is ignored)
  const busy = useRef(false);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const making = useRef<Promise<string | null> | null>(null);

  const current = role.data?.currentPacket ?? null;
  const url = props.linkedInUrl ?? madeUrl ?? props.jobUrl;
  const facts = postFactsOf({ title: role.data?.title ?? props.roleTitle, companyName: props.companyName, packet: current?.packet ?? null, payShown: current?.payShown ?? null, url });
  const text = edited ?? linkedInPostText(tone, facts);
  const count = postLengthLine(text);
  const company = props.companyName ?? "Your company";

  // The LinkedIn link, made once (a second press while it is on its way waits for the same one). Null when this
  // person may not make links or it could not be made: the post then carries the job page's address.
  const linkFor = (): Promise<string | null> => {
    if (props.linkedInUrl || madeUrl) return Promise.resolve(props.linkedInUrl ?? madeUrl);
    if (!props.canMakeLink) return Promise.resolve(null);
    if (!making.current) {
      making.current = make.mutateAsync().then(
        (r) => {
          setMadeUrl(r.link.url);
          void qc.invalidateQueries({ queryKey: ["postings", props.roleId] });
          return r.link.url;
        },
        () => {
          making.current = null;
          return null;
        },
      );
    }
    return making.current;
  };

  // The words as they go out: the job page's address swapped for the LinkedIn link once it exists.
  const wordsToCopy = async (): Promise<string> => {
    const link = await linkFor();
    if (!link || link === props.jobUrl) return text;
    if (edited === null) return linkedInPostText(tone, { ...facts, url: link });
    // the person's own words keep everything they wrote; only the job page's address changes
    const next = withTrackedLink(edited, props.jobUrl, link);
    if (next !== edited) setEdited(next);
    return next;
  };

  // The clipboard when the browser allows it; otherwise the words are selected in the box, ready for Ctrl+C.
  const copyOut = async (words: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(words);
        return true;
      }
    } catch {
      // blocked or not allowed here: the box below is the way
    }
    const el = box.current;
    if (!el) return false;
    el.focus();
    el.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  };

  const run = async (open: boolean) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const words = await wordsToCopy();
      const copied = await copyOut(words);
      let opened = true;
      if (open) {
        // after the copy, so the copy happens while this page still has the focus
        let tab: Window | null = null;
        try {
          tab = window.open(LINKEDIN_OPEN_URL, "_blank");
          if (tab) tab.opener = null;
        } catch {
          tab = null;
        }
        opened = !!tab;
      }
      if (!copied) toast("Could not copy by itself.", "The words are selected in the box: press Ctrl+C (Cmd+C on a Mac).");
      else if (open && !opened) toast("Copied the post.", "Your browser stopped the new tab. Open linkedin.com and paste it into a new post.");
      else toast(open ? "Copied. Paste it into your new LinkedIn post." : "Copied the post.");
    } finally {
      busy.current = false;
    }
  };

  // A press on either button starts making the LinkedIn link, so the copy rarely waits for it.
  const prepare = () => {
    if (props.canMakeLink && !props.linkedInUrl && !madeUrl) void linkFor();
  };

  if (role.isLoading) return <Skeleton lines={4} />;
  return (
    <div className="stack gap-4">
      <p className="small muted">Pick a tone, check the words, then post it yourself.</p>
      {props.accepting ? null : <Alert tone="caution">This job is not taking applications right now. Hold the post until it is.</Alert>}
      {/* The tones as cards to pick (the legend is floated so it is a grid item above them, not set into a border) */}
      <fieldset className="wording-picker grid min-w-0 gap-2.5 sm:grid-cols-3">
        <legend className="small float-left col-span-full w-full font-semibold text-ink">Tone</legend>
        {POST_TONES.map((t) => (
          <label key={t.key} className="wording-option check data-checked:border-primary data-checked:shadow-xs" data-checked={tone === t.key ? "true" : undefined}>
            <input type="radio" name={`linkedin-tone-${props.roleId}`} value={t.key} checked={tone === t.key} onChange={() => { setTone(t.key); setEdited(null); }} />
            <span className="min-w-0 leading-snug"><strong>{t.label}</strong><br /><span className="small muted">{t.hint}</span></span>
          </label>
        ))}
      </fieldset>
      {/* The words and how they look in a feed, side by side on a wide screen */}
      <div className="grid-2 items-start">
        <div className="field">
          <label htmlFor="linkedin-text">Your post</label>
          <textarea ref={box} id="linkedin-text" className="textarea" rows={14} value={text} onChange={(e) => setEdited(e.target.value)} aria-describedby="linkedin-count linkedin-hint" />
          <span id="linkedin-count" className={cn("hint tabular", count.over && "font-semibold text-critical")}>{count.line}</span>
          <span id="linkedin-hint" className="hint">Change anything you like. Picking a tone starts the words again.</span>
        </div>
        {/* What the post looks like in a feed: for the eye only, the box beside it holds the same words */}
        <div className="stack gap-1.5" aria-hidden="true">
          <span className="small muted">Preview</span>
          <div className="share-place grid gap-3 rounded-2xl border border-line bg-surface p-4 shadow-xs">
            <div className="flex items-center gap-2.5">
              <Avatar name={company} shape="square" tone="ink" />
              <span className="small min-w-0"><strong>{company}</strong><br /><span className="muted">Just now</span></span>
            </div>
            <p className="share-text text-[14px] leading-relaxed whitespace-pre-wrap wrap-anywhere text-ink">
              {previewParts(text).map((part, i) => <span key={`${i}-${part.link}`} className={part.link ? "font-semibold text-primary" : undefined}>{part.text}</span>)}
            </p>
          </div>
        </div>
      </div>
      <div className="row" onPointerDown={prepare}>
        {/* never disabled while at work (that would drop a keyboard user's focus); a second press meanwhile is ignored */}
        <Button variant="primary" icon="external" disabled={!text.trim()} onClick={() => void run(true)}>Copy and open LinkedIn</Button>
        <Button icon="copy" disabled={!text.trim()} onClick={() => void run(false)}>Copy text</Button>
        {/* the button goes once the words are the tone's own again, so the keyboard lands back in the box */}
        {edited !== null ? <Button variant="ghost" onClick={() => { if (busy.current) return; setEdited(null); box.current?.focus(); }}>Start again</Button> : null}
      </div>
      <p className="small muted -mt-1">Nothing is posted for you. LinkedIn opens in a new tab: paste, then post.</p>
    </div>
  );
}
