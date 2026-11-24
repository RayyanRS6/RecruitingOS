"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EditPost, SharePost, ShareView } from "@ros/contracts";
import { Alert, Button, Card, ErrorState, Field, Pill, Skeleton } from "@ros/ui";
import { api, errorWords } from "../../api/client";
import { CopyButton } from "../../components/CopyButton";
import { postBox, postPlaceholder, shareRefresh } from "../../jobs";
import { toast } from "../../toast";

/**
 * A job's Share tab: the Apply link (the job page's address) with Copy, then the LinkedIn post and the Indeed post,
 * each in a box a person can change, with Copy, "Write again" and the Apply link that post should carry. The posts are
 * written in the background after a job is published, so the tab asks again every few seconds while they are on their
 * way. The server says in one line when there is nothing to share (a job not published yet, a closed job, whose page
 * stays up and says so), and when the posts could not be written.
 */
export function ShareTab({ roleId }: { roleId: string }) {
  const q = useQuery({ queryKey: ["share", roleId], queryFn: () => api.get<ShareView>(`/api/v1/roles/${roleId}/share`), refetchInterval: (query) => shareRefresh(query.state.data) });
  if (q.isLoading) return <Skeleton lines={5} />;
  if (q.error || !q.data) return <ErrorState message="Could not load the Share tab." onRetry={() => q.refetch()} />;
  const view = q.data;
  return (
    <div className="stack gap-5">
      {!view.public && view.notPublicLine ? <Alert tone="info">{view.notPublicLine}</Alert> : null}
      {view.stateLine ? <Alert tone="caution">{view.stateLine}</Alert> : null}
      <Card title="Apply link">
        <LinkRow id="apply-link" label="Apply link" url={view.jobUrl} />
      </Card>
      {view.posts.map((post) => <PostCard key={post.channel} roleId={roleId} post={post} view={view} />)}
    </div>
  );
}

/** A link in a read-only box (it selects itself when focused) with its Copy button. */
function LinkRow({ id, label, url }: { id: string; label: string; url: string }) {
  return (
    <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <Field label={label} htmlFor={id}><input id={id} className="input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} /></Field>
      <CopyButton text={url} ariaLabel={`Copy: ${label}`} />
    </div>
  );
}

/**
 * One post. What a person types stays in the box until they save it; a saved edit is theirs, and only this post's own
 * "Write again" replaces it, so that asks first when there are words of theirs to lose.
 */
function PostCard({ roleId, post, view }: { roleId: string; post: SharePost; view: ShareView }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const box = postBox(post, typed);
  const writing = view.state === "writing";
  const settle = (next: ShareView) => {
    qc.setQueryData(["share", roleId], next);
    setTyped(undefined);
    setAsking(false);
  };
  const save = useMutation({
    mutationFn: (text: string) => api.put<ShareView>(`/api/v1/roles/${roleId}/share/${post.channel}`, { text } satisfies EditPost),
    onSuccess: (next) => {
      toast("Post saved.");
      settle(next);
    },
  });
  const rewrite = useMutation({
    mutationFn: () => api.post<ShareView>(`/api/v1/roles/${roleId}/share/${post.channel}/rewrite`, {}),
    onSuccess: settle,
  });
  const id = `post-${post.channel}`;
  const failure = save.error ?? rewrite.error;
  return (
    <Card title={post.label} aside={writing ? <Pill size="sm" busy>Writing</Pill> : null}>
      <div className="stack gap-4">
        <Field label="Post" htmlFor={id}>
          <textarea id={id} className="textarea min-h-[180px]" value={box.text} placeholder={postPlaceholder(view.state)} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        {asking ? (
          <Alert tone="caution">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>Writing it again replaces your words.</span>
              <span className="row">
                <Button size="sm" variant="primary" loading={rewrite.isPending} onClick={() => rewrite.mutate()}>Write again</Button>
                <Button size="sm" variant="ghost" disabled={rewrite.isPending} onClick={() => setAsking(false)}>Keep mine</Button>
              </span>
            </div>
          </Alert>
        ) : (
          <div className="row">
            <CopyButton variant="primary" text={box.text} ariaLabel={`Copy the ${post.label}`} disabled={box.empty} />
            {box.dirty ? <Button size="sm" loading={save.isPending} disabled={box.empty} onClick={() => save.mutate(box.text.trim())}>Save</Button> : null}
            <Button size="sm" variant="ghost" icon="refresh" loading={rewrite.isPending} disabled={writing} onClick={() => (post.edited || box.dirty ? setAsking(true) : rewrite.mutate())}>Write again</Button>
          </div>
        )}
        {failure ? <Alert tone="critical">{errorWords(failure)}</Alert> : null}
        <LinkRow id={`${id}-link`} label={`Apply link for the ${post.label}`} url={post.applyUrl} />
      </div>
    </Card>
  );
}
