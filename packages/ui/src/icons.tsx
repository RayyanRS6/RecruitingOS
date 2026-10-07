import { type IconName, resolveIcon } from "./glyphs";
import { cx } from "./helpers";

/**
 * An inline SVG icon (docs/07), drawn in the current text colour. Decorative by default (hidden from screen readers,
 * because a word sits next to it); pass `label` when the icon stands alone and has to say what it is.
 */
export function Icon(props: { name: IconName; size?: number; label?: string; className?: string; strokeWidth?: number }) {
  const glyph = resolveIcon(props.name);
  const size = props.size ?? 18;
  const drawing = (
    <>
      {glyph.stroke.map((d) => <path key={d} d={d} />)}
      {glyph.fill?.map((d) => <path key={d} d={d} fill="currentColor" stroke="none" />)}
    </>
  );
  const shared = { className: cx("icon", props.className), width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: props.strokeWidth ?? 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, focusable: "false" as const };
  if (props.label) {
    return (
      <svg {...shared} role="img" aria-label={props.label}>
        <title>{props.label}</title>
        {drawing}
      </svg>
    );
  }
  return (
    <svg {...shared} aria-hidden="true">
      {drawing}
    </svg>
  );
}

export { ICON_NAMES, type IconName } from "./glyphs";
