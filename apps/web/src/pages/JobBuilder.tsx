"use client";

import { useQuery } from "@tanstack/react-query";
import type { IntakeSessionList } from "@ros/contracts";
import { Card, Icon, SectionHeader } from "@ros/ui";
import { api } from "../api/client";
import { DraftRows } from "../components/DraftRows";
import { useSearchParams } from "../nav";
import { Builder } from "./builder/Builder";
import { AI_LINE } from "./builder/Conversation";
import { StartBox } from "./builder/StartBox";

/**
 * The job builder's page, /roles/new, reached from "Start a hire". Without `?session=` it is the one way in: a box for
 * a sentence or a pasted job ad, with this person's unfinished drafts under it. With `?session=`, the conversation and
 * the job side by side. The address names the draft only, never the person's words, which may hold pay.
 */
export function JobBuilder() {
  const [params] = useSearchParams();
  const sessionId = params.get("session");
  return sessionId ? <Builder key={sessionId} sessionId={sessionId} /> : <BuilderStart />;
}

function BuilderStart() {
  const drafts = useQuery({ queryKey: ["intake", "sessions", "mine"], queryFn: () => api.get<IntakeSessionList>("/api/v1/intake/sessions?mine=1") });
  const mine = drafts.data?.sessions ?? [];
  return (
    <div className="mx-auto grid w-full max-w-[880px] gap-6">
      {/* the bare h1, at the page's large size */}
      <header className="md:[&>h1]:text-[44px]">
        <h1>Who are you hiring?</h1>
      </header>
      <Card className="grid gap-4 border-line-tint bg-linear-170 from-tint/70 via-surface via-45% to-surface">
        <StartBox size="lg" room={drafts.data?.room} />
        {/* who drafts, and that a person decides */}
        <p className="flex items-start gap-1.5 border-t border-line pt-3.5 text-[12.5px] leading-snug text-ink-3"><Icon name="sparkle" size={14} className="mt-px text-accent" /> {AI_LINE}</p>
      </Card>
      {mine.length ? (
        <section className="min-w-0">
          <SectionHeader title="Your drafts" />
          <DraftRows drafts={mine} label="Your drafts" />
        </section>
      ) : null}
    </div>
  );
}
