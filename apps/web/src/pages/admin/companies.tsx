"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { appPaths, type AdminCompany } from "@ros/contracts";
import { Avatar, Button, Card, ErrorState, Icon, IconChip, numHead, Pill, Skeleton, Table } from "@ros/ui";
import { api } from "../../api/client";
import { verticalWords } from "../../company-setup";
import { focusLost } from "../../focus-after";
import { KEEP_CURRENT } from "../../home";
import { Link, useNavigate, useSearchParams } from "../../nav";
import { useSignInWhenSessionEnds } from "../../session-ended";
import { AccessButtons, FactsLine } from "./access";
import { adminKeys, reason } from "./admin-api";
import { exactWhen, whenWords } from "./admin-words";
import { CompanyDrawer } from "./company";
import { COMPANY_FILTERS, type CompanyFilter, companiesSearch, companyFilterFrom, companyInFilter, companyMatches, companyStatusTone, jobsWords, requestFacts } from "./company-facts";

/** A company's name, which opens its drawer: a plain button that reads as the row's title (40 px tall under a finger). */
const NAME = "inline-flex items-center border-0 bg-transparent p-0 text-left font-sans text-[15px] leading-snug font-semibold text-ink wrap-anywhere transition-colors duration-150 ease-soft hover:text-primary hover:underline pointer-coarse:min-h-10";

/**
 * Companies (`/admin`): the requests waiting for an answer, each with who is asking and Accept and Decline; the
 * companies that asked to upgrade; and every company in one table (name and kind of business, status, plan, jobs open
 * of all, applicants, last active) with a search box and the filters All, Waiting and Declined, over the list already
 * loaded, in the order the API lists it. A company's name opens its drawer, kept in the address (`?open=<id>`), so a
 * reload or a link lands on it.
 *
 * A tab left open stays true: the list is asked for again on focus and every minute while the tab is visible, never in
 * a hidden one, because each read is recorded and a request may be waiting.
 */
export function Companies() {
  const [search] = useSearchParams();
  const nav = useNavigate();
  const q = useQuery({ queryKey: adminKeys.companies, queryFn: () => api.get<AdminCompany[]>("/api/v1/admin/customers", reason), ...KEEP_CURRENT });
  useSignInWhenSessionEnds([q.error]);
  const [filter, setFilter] = useState<CompanyFilter>(() => companyFilterFrom(search.get("show")));
  const [query, setQuery] = useState("");

  // The company drawer, mirrored in the address with replace, so Back leaves the page as before.
  const openParam = search.get("open");
  const [openId, setOpenId] = useState<string | null>(openParam);
  // A link followed while this page is open ("Asked to upgrade") changes only the address: follow it.
  useEffect(() => {
    setOpenId(openParam);
  }, [openParam]);
  const go = (patch: Parameters<typeof companiesSearch>[1]) => nav(`${window.location.pathname}${companiesSearch(search, patch)}`, { replace: true });
  const show = (id: string | null) => {
    setOpenId(id);
    go({ open: id });
  };
  const pick = (next: CompanyFilter) => {
    setFilter(next);
    go({ show: next });
  };

  const rows = q.data ?? [];
  const now = Date.now();
  const waiting = rows.filter((c) => c.status === "waiting");
  const asking = rows.filter((c) => c.planRequest);
  const shown = rows.filter((c) => companyInFilter(c, filter) && companyMatches(c, query));
  const narrowed = filter !== "all" || query.trim() !== "";
  const showAll = () => {
    setQuery("");
    pick("all");
  };
  const opened = openId ? (rows.find((c) => c.id === openId) ?? null) : null;
  // A request that was decided leaves with the button that had focus: it goes to the next thing in the list, not to the page.
  const requests = useRef<HTMLUListElement>(null);
  const afterDecided = () => requestAnimationFrame(() => {
    if (focusLost(document.activeElement, document.body)) (requests.current?.querySelector<HTMLElement>("button:not(:disabled)") ?? requests.current)?.focus();
  });

  if (q.error && !q.data) return <ErrorState message="Could not load the companies." onRetry={() => q.refetch()} />;
  return (
    <div className="stack gap-6">
      <Card title="Waiting for approval" flush>
        {!q.data ? (
          // in line with the flush card's title: 16px sides on a phone, 24px from 640px
          <div className="px-4 py-5 sm:px-6"><Skeleton lines={2} /></div>
        ) : (
          <ul ref={requests} tabIndex={-1} className="focus:outline-none">
            {waiting.map((c) => (
              // The facts run on as one line that wraps, and from a tablet up the buttons (or the question, however long
              // a name it holds) sit beside at least 20rem of them, or on a line of their own.
              <li key={c.id} className="list-row flex-wrap">
                <span className="list-row-lead"><Avatar name={c.name} shape="square" /></span>
                <span className="list-row-main justify-items-start sm:basis-80">
                  <button type="button" className={NAME} onClick={() => show(c.id)}>{c.name}</button>
                  <span className="list-row-meta"><span className="min-w-0 wrap-anywhere"><FactsLine facts={requestFacts(c, now)} /></span></span>
                </span>
                <span className="list-row-end max-w-full"><AccessButtons company={c} onDecided={afterDecided} /></span>
              </li>
            ))}
            {waiting.length ? null : (
              <li className="list-row">
                <span className="list-row-lead"><IconChip icon="check-circle" tone="good" size="sm" /></span>
                <span className="list-row-main"><span className="list-row-title wrap">No company is waiting.</span></span>
              </li>
            )}
          </ul>
        )}
      </Card>

      {asking.length ? (
        <Card title="Asked to upgrade" flush>
          <ul>
            {asking.map((c) => (
              <li key={c.id} className="list-row">
                <span className="list-row-lead"><Avatar name={c.name} shape="square" /></span>
                <span className="list-row-main">
                  <span className="list-row-title wrap">{c.name}</span>
                  <span className="list-row-meta wrap-anywhere">
                    <span className="min-w-0">{c.planRequest?.words}</span>
                    <span title={exactWhen(c.planRequest?.since)}>{whenWords(c.planRequest?.since)}</span>
                  </span>
                </span>
                <span className="list-row-end"><Link to={appPaths.adminCompany(c.id)} replace className="btn secondary sm" aria-label={`Open ${c.name}`}>Open</Link></span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <section className="stack gap-4" aria-label="All companies">
        <div className="flex flex-wrap items-center gap-2">
          {COMPANY_FILTERS.map((f) => (
            <button key={f.id} type="button" className="toggle-chip" aria-pressed={filter === f.id} onClick={() => pick(filter === f.id ? "all" : f.id)}>
              {f.label}
              {q.data ? <>{" "}<span className="count">{rows.filter((c) => companyInFilter(c, f.id)).length}</span></> : null}
            </button>
          ))}
          <div className="relative w-full min-w-0 sm:ml-auto sm:w-64">
            <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-ink-3" />
            <input className="input rounded-full pl-10" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search companies" aria-label="Search companies" />
          </div>
        </div>
        <Table
          head={["Company", "Status", "Plan", "Jobs", numHead("Applicants"), "Last active"]}
          label="Companies"
          loading={q.data ? undefined : 4}
          empty={narrowed && rows.length ? <div className="flex flex-wrap items-center justify-between gap-3"><span>No company matches.</span><Button size="sm" onClick={showAll}>Show all companies</Button></div> : "No companies yet."}
        >
          {shown.map((c) => (
            <tr key={c.id}>
              <td>
                <div className="flex items-center gap-3">
                  <Avatar name={c.name} shape="square" />
                  <div className="grid min-w-36 justify-items-start gap-0.5 wrap-anywhere">
                    <button type="button" className={NAME} onClick={() => show(c.id)}>{c.name}</button>
                    <div className="small muted">{verticalWords(c.vertical)}</div>
                  </div>
                </div>
              </td>
              <td><Pill tone={companyStatusTone(c.status)} size="sm">{c.statusLabel}</Pill></td>
              <td>{c.planName}</td>
              <td className="nowrap">{jobsWords(c.jobs)}</td>
              <td className="num">{c.applicants}</td>
              <td className="nowrap text-ink-2">{c.lastActivityAt ? <span title={exactWhen(c.lastActivityAt)}>{whenWords(c.lastActivityAt, new Date(now))}</span> : "Never"}</td>
            </tr>
          ))}
        </Table>
      </section>
      {opened ? <CompanyDrawer company={opened} onClose={() => show(null)} /> : null}
    </div>
  );
}
