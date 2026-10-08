/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */

/**
 * The few line drawings the candidate pages use, drawn the way packages/ui draws its icon set (a 24-pixel grid, 1.75
 * stroke in the text colour; home, building, briefcase, clock, calendar, the arrows, check, mail, people, paperclip,
 * help, eye and external are copied from packages/ui/src/glyphs.ts). Plain markup, no script. Always decorative: the
 * words beside an icon say what it means.
 */
const circle = (cx: number, cy: number, r: number) => `M${cx + r} ${cy}a${r} ${r} 0 1 1-${2 * r} 0 ${r} ${r} 0 0 1 ${2 * r} 0Z`;

const GLYPHS = {
  pin: ["M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z", circle(12, 10, 2.5)],
  building: ["M5 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16", "M15 9h3a1 1 0 0 1 1 1v11", "M3 21h18", "M8.5 8h3", "M8.5 12h3", "M8.5 16h3"],
  home: ["M3.5 10.5 12 3.5l8.5 7", "M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"],
  hybrid: ["M5 8h14", "m15.5 4.5 3.5 3.5-3.5 3.5", "M19 16H5", "m8.5 12.5-3.5 3.5 3.5 3.5"],
  briefcase: ["M4 7.5h16a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1Z", "M9 7.5V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2", "M3 13h18"],
  pay: ["M3.5 6.5h17a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z", circle(12, 12, 2.5), "M6 12h.01", "M18 12h.01"],
  clock: [circle(12, 12, 9), "M12 7v5l3 2"],
  calendar: ["M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z", "M4 10h16", "M8 3v4", "M16 3v4"],
  "arrow-left": ["M19 12H5", "m11 6-6 6 6 6"],
  "arrow-right": ["M5 12h14", "m13 6 6 6-6 6"],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
  mail: ["M4 5.5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z", "m3.5 6.5 8.5 6.5 8.5-6.5"],
  people: [circle(9, 8, 3.5), "M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6", "M15.5 4.6a3.5 3.5 0 0 1 0 6.8", "M17.5 14.4c2 .8 3.5 2.9 3.5 5.6"],
  paperclip: ["M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"],
  help: [circle(12, 12, 9), "M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.4", "M12 17h.01"],
  eye: ["M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z", circle(12, 12, 3)],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
} as const;

export type CandidateIconName = keyof typeof GLYPHS;

export function Icon(props: { name: CandidateIconName }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {GLYPHS[props.name].map((d) => <path d={d} />)}
    </svg>
  );
}
