"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Icon, Skeleton } from "@ros/ui";
import { api, ApiError, type PostingsResponse, type SharePlace, type ShareLinkResponse, type ShareTarget } from "../api/client";
import { linkedInPostHref } from "../linkedin-post";
import { SHARE_BUTTONS, SHARE_PLACES_TO_COPY, opensOwnApp, shareSubject, shareTargetsFor, shareTextFor, visitsWords } from "../publishing";
import { toast } from "../toast";

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}.`), () => toast("Could not copy. Select the text and copy it by hand."));
}

/**
 * The job's address as an input-like row (screenshot 5's fields) with Copy and Open at its end; the Share tab's "Your job
 * link" draws the same row. On a phone the address takes the first line and the buttons wrap under it, at the right.
 */
export const SHARE_LINK_ROW = "share-link flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 rounded-xl border border-line-2 bg-surface py-1.5 pr-1.5 pl-3.5 shadow-xs";
/** The address inside that row: one line, cut short with an ellipsis (the full address is its title). */
export const SHARE_LINK_TEXT = "min-w-0 flex-1 basis-[calc(100%-1.5rem)] truncate text-[14px] text-ink sm:basis-0";

/**
 * "Share it now" (plan D8): the job's address with Copy and Open, one button per place people share (email, a text
 * message, WhatsApp, LinkedIn, Facebook, X) and the ready-made places that get a link of their own to copy (a referral
 * from the team, a school or training program, a community group). Each place gets its own tracked link the first time
 * it is used, so Candidates can say where applicants came from; the same link is used every time after. The message
 * that goes with a share and the ready-made places are one click away, each under its own "Show more".
 *
 * Plain links only: a share opens the person's own email or text app, or the network's own share page in a new tab.
 * Nothing from those networks ever loads on our pages. The first tap on a place makes its link and opens the share in
 * the same tap (a new tab is opened at once and pointed at the share page once the link exists, so no pop-up blocker
 * stops it); after that the button is an ordinary link.
 *
 * Away from the Share tab (`compact`: the screen after approval, an empty applicant list) it also links to the Share
 * tab's LinkedIn post (Wave S2), ready-made words to copy and post; on the Share tab that card sits right under this one.
 */
export function ShareJob(props: { roleId: string; roleTitle: string; companyName: string | null; compact?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["postings", props.roleId], queryFn: () => api.get<PostingsResponse>(`/api/v1/roles/${props.roleId}/postings`) });
  const make = useMutation({ mutationFn: (place: SharePlace) => api.post<ShareLinkResponse>(`/api/v1/roles/${props.roleId}/share-links`, { place }) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["postings", props.roleId] });

  if (q.isLoading) return <Skeleton lines={2} />;
  if (q.error || !q.data) return <Alert tone="critical">Could not load the share links. Reload the page to try again.</Alert>;
  const d = q.data;
  if (d.role.status === "closed") return <p className="small muted">The job is closed, so there is nothing to share.</p>;
  if (d.role.status !== "open" && d.role.status !== "paused") return <p className="small muted">{d.publishing.state === "preparing" ? "Getting the job ready. The share links appear here in a moment." : "Sharing opens once the job is approved and live."}</p>;
  if (d.publishing.state === "waiting_for_company_check") return <Alert tone="info">The job goes public as soon as ITS confirms your company. Share it then: until that moment the link shows "not found".</Alert>;
  const share = d.share;
  const subject = shareSubject(props.companyName, props.roleTitle);
  const placeOf = (place: SharePlace) => share.places.find((p) => p.place === place) ?? null;
  const targetFor = (key: ShareTarget["key"], linkUrl: string) => shareTargetsFor({ url: linkUrl, text: shareTextFor(share, linkUrl), subject }).find((t) => t.key === key)!;

  // The first tap on a share button: a tab is opened straight away (inside the click, so it is never blocked), then
  // pointed at the share page once the place has its link. Email and text messages open the person's own app.
  const tap = async (key: ShareTarget["key"]) => {
    const own = opensOwnApp(key);
    const tab = own ? null : window.open("about:blank", "_blank");
    try {
      const r = await make.mutateAsync(key);
      const target = r.targets.find((t) => t.key === key) ?? targetFor(key, r.link.url);
      if (own) window.location.href = target.url;
      else if (tab) {
        tab.opener = null;
        tab.location.href = target.url;
      } else window.open(target.url, "_blank", "noopener,noreferrer");
      await refresh();
    } catch (e) {
      tab?.close();
      toast(e instanceof ApiError ? e.message : "Could not make the share link. Try again.");
    }
  };
  const makePlace = async (place: SharePlace) => {
    try {
      const r = await make.mutateAsync(place);
      copy(r.text, "the link and a message to go with it");
      await refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not make the link. Try again.");
    }
  };

  return (
    <div className="share stack gap-4">
      <div className={SHARE_LINK_ROW}>
        <Icon name="link" size={16} className="text-ink-3" />
        <span className={SHARE_LINK_TEXT}><code title={share.jobUrl}>{share.jobUrl}</code></span>
        <Button size="sm" icon="copy" onClick={() => copy(share.jobUrl, "the job's address")}>Copy</Button>
        <a className="btn secondary sm" href={share.jobUrl} target="_blank" rel="noopener noreferrer"><Icon name="external" />Open<span className="sr-only"> the job page (opens in a new tab)</span></a>
      </div>
      {/* one secondary pill per place people share */}
      <fieldset className="share-buttons flex min-w-0 flex-wrap gap-2" aria-label="Share the job">
        {SHARE_BUTTONS.map((b) => {
          const link = placeOf(b.key)?.link ?? null;
          if (link) {
            const target = targetFor(b.key, link.url);
            return opensOwnApp(b.key)
              ? <a key={b.key} className="btn secondary sm" href={target.url}><Icon name={b.icon} />{b.label}</a>
              : <a key={b.key} className="btn secondary sm" href={target.url} target="_blank" rel="noopener noreferrer"><Icon name={b.icon} />{b.label}<span className="sr-only"> (opens in a new tab)</span></a>;
          }
          return <Button key={b.key} size="sm" icon={b.icon} disabled={make.isPending} onClick={() => void tap(b.key)}>{b.label}</Button>;
        })}
      </fieldset>
      <p className="small muted -mt-1">Each place gets its own link, so you see where applicants come from.</p>
      {/* Away from the Share tab (the screen after approval, an empty applicant list): the way to its LinkedIn post. A
          plain link, so the page it leaves (a dialog included) is left behind and the Share tab opens at the post. */}
      {props.compact && d.role.status === "open" ? <p className="small"><a href={linkedInPostHref(props.roleId)}>Post on LinkedIn</a></p> : null}
      {props.compact ? null : (
        <details className="more">
          <summary>The message that goes with it</summary>
          <p className="share-text rounded-xl border border-line bg-surface-2 px-4 py-3 text-[14px] whitespace-pre-wrap wrap-anywhere text-ink">{share.text}</p>
          <p className="small muted mt-2">You see it in your own app before anything is sent, and can change it there.</p>
        </details>
      )}
      {/* the ready-made places with a link of their own, one click away (Wave S1) */}
      <details className="more">
        <summary>Links for a referral, a school or a group</summary>
        <ul className="share-places list-card divide-y divide-line" aria-label="Places with a link of their own">
          {SHARE_PLACES_TO_COPY.map((place) => {
            const row = placeOf(place);
            const label = row?.label ?? place;
            return (
              <li key={place} className="share-place grid min-w-0 gap-1.5 px-4 py-3">
                <div className="share-place-head flex flex-wrap items-center justify-between gap-2">
                  <strong className="small text-ink">{label}</strong>
                  {row?.link ? (
                    <span className="row">
                      <span className="small muted">{visitsWords(row.link.visits)}</span>
                      <Button size="sm" icon="copy" onClick={() => copy(shareTextFor(share, row.link!.url), "the link and a message to go with it")}>Copy</Button>
                    </span>
                  ) : <Button size="sm" icon="link" disabled={make.isPending} onClick={() => void makePlace(place)}>Make a link to copy</Button>}
                </div>
                {row?.link ? <code className="small wrap-anywhere text-ink-2">{row.link.url}</code> : null}
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}
