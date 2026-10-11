"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Icon, Skeleton } from "@ros/ui";
import { api, ApiError, type PostingsResponse, type SharePlace, type ShareLinkResponse, type ShareTarget } from "../api/client";
import { SHARE_BUTTONS, SHARE_PLACES_TO_COPY, opensOwnApp, shareSubject, shareTargetsFor, shareTextFor, visitsWords } from "../publishing";
import { toast } from "../toast";

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}.`), () => toast("Could not copy. Select the text and copy it by hand."));
}

/**
 * "Share it now" (plan D8): the job's address with Copy, one button per place people share (email, a text message,
 * WhatsApp, LinkedIn, Facebook, X) and the ready-made places that get a link of their own to copy (a referral from the
 * team, a school or training program, a community group). Each place gets its own tracked link the first time it is
 * used, so the Talent page can say where applicants came from; the same link is used every time after.
 *
 * Plain links only: a share opens the person's own email or text app, or the network's own share page in a new tab.
 * Nothing from those networks ever loads on our pages. The first tap on a place makes its link and opens the share in
 * the same tap (a new tab is opened at once and pointed at the share page once the link exists, so no pop-up blocker
 * stops it); after that the button is an ordinary link.
 */
export function ShareJob(props: { roleId: string; roleTitle: string; companyName: string | null; compact?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["postings", props.roleId], queryFn: () => api.get<PostingsResponse>(`/api/v1/roles/${props.roleId}/postings`) });
  const make = useMutation({ mutationFn: (place: SharePlace) => api.post<ShareLinkResponse>(`/api/v1/roles/${props.roleId}/share-links`, { place }) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["postings", props.roleId] });

  if (q.isLoading) return <Skeleton lines={2} />;
  if (q.error || !q.data) return <Alert tone="critical">Could not load the share links. Reload the page to try again.</Alert>;
  const d = q.data;
  if (d.role.status === "closed") return <p className="small muted">The role is closed, so there is nothing to share.</p>;
  if (d.role.status !== "open" && d.role.status !== "paused") return <p className="small muted">{d.publishing.state === "preparing" ? "Getting the job ready. The share links appear here in a moment." : "Sharing opens once the role is approved and live."}</p>;
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
    <div className="share">
      <div className="share-link">
        <Icon name="link" size={16} />
        <code title={share.jobUrl}>{share.jobUrl}</code>
        <Button size="sm" icon="copy" onClick={() => copy(share.jobUrl, "the job's address")}>Copy</Button>
      </div>
      <fieldset className="share-buttons" aria-label="Share the job">
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
      {props.compact ? null : (
        <>
          <p className="small muted" style={{ margin: 0 }}>Each place gets its own link, so you can see where applicants come from. The message starts with:</p>
          <p className="share-text" style={{ margin: 0 }}>{share.text}</p>
          <p className="small muted" style={{ margin: 0 }}>You see it in your own app before anything is sent, and can change it there.</p>
        </>
      )}
      <ul className="share-places" aria-label="Places with a link of their own">
        {SHARE_PLACES_TO_COPY.map((place) => {
          const row = placeOf(place);
          const label = row?.label ?? place;
          return (
            <li key={place} className="share-place">
              <div className="share-place-head">
                <strong className="small">{label}</strong>
                {row?.link ? (
                  <span className="row">
                    <span className="small muted">{visitsWords(row.link.visits)}</span>
                    <Button size="sm" icon="copy" onClick={() => copy(shareTextFor(share, row.link!.url), "the link and a message to go with it")}>Copy</Button>
                  </span>
                ) : <Button size="sm" icon="link" disabled={make.isPending} onClick={() => void makePlace(place)}>Make a link to copy</Button>}
              </div>
              {row?.link ? <code className="small" style={{ overflowWrap: "anywhere" }}>{row.link.url}</code> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
