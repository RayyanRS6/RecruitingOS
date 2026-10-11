import type { ReactNode } from "react";
import { cx, type Tone } from "./helpers";

/**
 * The match score's breakdown as bars (plan adjustments §1, docs/07): one row per requirement, the costliest first, each
 * with its tag ("Must-have", or how much a skill counts), how much of it was met and the points it cost. The bar only
 * helps a glance: the words beside it carry the meaning, so the bar itself is hidden from screen readers. The rows at
 * full marks can be folded under one line ("4 more at full marks") that opens in place. No hooks, so server components
 * can use it too.
 */
export type ScoreBarItem = {
  key: string;
  label: string;
  /** "Must-have", or the skill's importance ("Essential", "Important", "Helpful"). */
  tag?: string;
  mustHave?: boolean;
  /** 0-100: how much of this requirement the evidence shows. */
  pctMet: number;
  /** Points of the 100 this requirement cost. */
  pointsLost: number;
  /** Under the bar: the finding and the quote, for example. */
  detail?: ReactNode;
};

const pct = (n: number) => Math.min(100, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));

/**
 * The bar's colour: green when met in full, amber when partly met, red only for a must-have that is not met (the one
 * place red is used for a score), plain grey otherwise. A skill that goes against them is grey, not red: it is not an
 * alarm, and the words say what it is.
 */
export function barTone(pctMet: number, mustHave = false): Tone {
  const p = pct(pctMet);
  if (p >= 100) return "good";
  if (p > 0) return "caution";
  return mustHave ? "critical" : "neutral";
}

/** The words beside a bar: "50% met" and "6 points lost" (or "full marks"). */
export function barFigures(pctMet: number, pointsLost: number): { met: string; lost: string } {
  const lost = Math.max(0, Math.round(pointsLost));
  return { met: `${pct(pctMet)}% met`, lost: lost > 0 ? `${lost} ${lost === 1 ? "point" : "points"} lost` : pct(pctMet) >= 100 ? "full marks" : "under 1 point lost" };
}

/**
 * A single bar on its own (a cell of the comparison view). Decorative: the words beside it say the same. A must-have
 * that is not met has nothing to fill, so its whole track turns red instead.
 */
export function ScoreBar(props: { pctMet: number; mustHave?: boolean; size?: "sm" | "md" }) {
  const tone = barTone(props.pctMet, props.mustHave);
  return (
    <span className={cx("sbar-track", props.size === "sm" && "sm", tone === "critical" && "critical")} aria-hidden="true">
      <span className={cx("sbar-fill", tone)} style={{ width: `${pct(props.pctMet)}%` }} />
    </span>
  );
}

function BarRow({ item }: { item: ScoreBarItem }) {
  const f = barFigures(item.pctMet, item.pointsLost);
  return (
    <li className="sbar">
      <div className="sbar-head">
        <span className="sbar-label">{item.label}</span>
        {item.tag ? <span className={cx("sbar-tag", item.mustHave && "must")}>{item.tag}</span> : null}
        <span className="sbar-figures">
          <span>{f.met}</span>
          <span className="sbar-lost">{f.lost}</span>
        </span>
      </div>
      <ScoreBar pctMet={item.pctMet} mustHave={item.mustHave} />
      {item.detail ? <div className="sbar-detail">{item.detail}</div> : null}
    </li>
  );
}

/**
 * The bars, in the order given (the caller sorts them, costliest first). `folded` rows sit under one line that opens in
 * place (`foldedLabel`, "4 more at full marks" by default); `label` names the list for screen readers.
 */
export function ScoreBars(props: { items: ScoreBarItem[]; label: string; folded?: ScoreBarItem[]; foldedLabel?: string }) {
  const folded = props.folded ?? [];
  return (
    <div className="sbars-wrap">
      {props.items.length ? (
        <ul className="sbars" aria-label={props.label}>
          {props.items.map((item) => <BarRow key={item.key} item={item} />)}
        </ul>
      ) : null}
      {folded.length ? (
        <details className="sbars-more">
          <summary>{props.foldedLabel ?? `${folded.length} more at full marks`}</summary>
          <ul className="sbars" aria-label={`${props.label}: at full marks`}>
            {folded.map((item) => <BarRow key={item.key} item={item} />)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
