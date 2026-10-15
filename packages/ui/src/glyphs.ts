/**
 * The icon drawings (docs/07): our own simple line drawings on a 24-pixel grid, stroked in the current text colour.
 * `stroke` paths are outlines; `fill` paths are small solid marks (the dots of "more"). Kept apart from the component so
 * the set can be checked without React.
 */
export type Glyph = { stroke: readonly string[]; fill?: readonly string[] };

const circle = (cx: number, cy: number, r: number) => `M${cx + r} ${cy}a${r} ${r} 0 1 1-${2 * r} 0 ${r} ${r} 0 0 1 ${2 * r} 0Z`;

export const GLYPHS = {
  home: { stroke: ["M3.5 10.5 12 3.5l8.5 7", "M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"] },
  briefcase: { stroke: ["M4 7.5h16a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1Z", "M9 7.5V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2", "M3 13h18"] },
  people: { stroke: [circle(9, 8, 3.5), "M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6", "M15.5 4.6a3.5 3.5 0 0 1 0 6.8", "M17.5 14.4c2 .8 3.5 2.9 3.5 5.6"] },
  calendar: { stroke: ["M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z", "M4 10h16", "M8 3v4", "M16 3v4"] },
  settings: {
    stroke: [
      "M10.26 5.01L10.68 2.59L13.32 2.59L13.74 5.01L15.71 5.83L17.72 4.41L19.59 6.28L18.17 8.29L18.99 10.26L21.41 10.68L21.41 13.32L18.99 13.74L18.17 15.71L19.59 17.72L17.72 19.59L15.71 18.17L13.74 18.99L13.32 21.41L10.68 21.41L10.26 18.99L8.29 18.17L6.28 19.59L4.41 17.72L5.83 15.71L5.01 13.74L2.59 13.32L2.59 10.68L5.01 10.26L5.83 8.29L4.41 6.28L6.28 4.41L8.29 5.83Z",
      circle(12, 12, 3),
    ],
  },
  plus: { stroke: ["M12 5v14", "M5 12h14"] },
  minus: { stroke: ["M5 12h14"] },
  search: { stroke: [circle(11, 11, 6.5), "m20 20-4.2-4.2"] },
  "chevron-right": { stroke: ["m9 6 6 6-6 6"] },
  "chevron-left": { stroke: ["m15 6-6 6 6 6"] },
  "chevron-down": { stroke: ["m6 9 6 6 6-6"] },
  "chevron-up": { stroke: ["m6 15 6-6 6 6"] },
  check: { stroke: ["m5 12.5 4.5 4.5L19 7.5"] },
  "check-circle": { stroke: [circle(12, 12, 9), "m8 12.5 2.7 2.7L16 9.8"] },
  x: { stroke: ["M6 6l12 12", "M18 6 6 18"] },
  sparkle: { stroke: ["M11 3.5c.7 4.2 3.3 6.8 7.5 7.5-4.2.7-6.8 3.3-7.5 7.5-.7-4.2-3.3-6.8-7.5-7.5 4.2-.7 6.8-3.3 7.5-7.5Z", "M19 2.5v4", "M17 4.5h4"] },
  mail: { stroke: ["M4 5.5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z", "m3.5 6.5 8.5 6.5 8.5-6.5"] },
  send: { stroke: ["M21 3 10.5 13.5", "M21 3l-6.5 18-4-7.5L3 9.5 21 3Z"] },
  upload: { stroke: ["M12 15V4", "m7.5 8.5 4.5-4.5 4.5 4.5", "M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"] },
  paperclip: { stroke: ["M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"] },
  mic: { stroke: ["M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z", "M5.5 11a6.5 6.5 0 0 0 13 0", "M12 17.5V21", "M9 21h6"] },
  eye: { stroke: ["M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z", circle(12, 12, 3)] },
  edit: { stroke: ["M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z", "m14 7 3 3"] },
  clock: { stroke: [circle(12, 12, 9), "M12 7v5l3 2"] },
  alert: { stroke: ["M10.3 4.2 2.6 17.5a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z", "M12 9.5v4", "M12 17h.01"] },
  info: { stroke: [circle(12, 12, 9), "M12 11v5", "M12 8h.01"] },
  help: { stroke: [circle(12, 12, 9), "M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.4", "M12 17h.01"] },
  lock: { stroke: ["M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z", "M8 11V7.5a4 4 0 0 1 8 0V11"] },
  link: { stroke: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"] },
  share: { stroke: [circle(18, 5, 2.5), circle(6, 12, 2.5), circle(18, 19, 2.5), "m8.2 10.8 7.6-4.6", "m8.2 13.2 7.6 4.6"] },
  filter: { stroke: ["M4 5h16l-6 7.5V19l-4 2v-8.5L4 5Z"] },
  sort: { stroke: ["M7 4v16", "m3.5 16.5 3.5 3.5 3.5-3.5", "M17 20V4", "m13.5 7.5 3.5-3.5 3.5 3.5"] },
  more: { stroke: [], fill: [circle(5, 12, 1.6), circle(12, 12, 1.6), circle(19, 12, 1.6)] },
  "arrow-left": { stroke: ["M19 12H5", "m11 6-6 6 6 6"] },
  "arrow-right": { stroke: ["M5 12h14", "m13 6 6 6-6 6"] },
  user: { stroke: [circle(12, 8, 4), "M4 21c0-4 3.6-7 8-7s8 3 8 7"] },
  building: { stroke: ["M5 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16", "M15 9h3a1 1 0 0 1 1 1v11", "M3 21h18", "M8.5 8h3", "M8.5 12h3", "M8.5 16h3"] },
  star: { stroke: ["M12 3.1L14.53 9.12L21.04 9.66L16.09 13.93L17.58 20.29L12 16.9L6.42 20.29L7.91 13.93L2.96 9.66L9.47 9.12Z"] },
  flag: { stroke: ["M5 21V4", "M5 4h11l-2 4 2 4H5"] },
  refresh: { stroke: ["M20 11a8 8 0 0 0-14.3-4.6L4 8", "M4 4v4h4", "M4 13a8 8 0 0 0 14.3 4.6L20 16", "M20 20v-4h-4"] },
  external: { stroke: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"] },
  copy: { stroke: ["M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z", "M16 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"] },
  "log-out": { stroke: ["M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4", "m10 17 5-5-5-5", "M15 12H4"] },
  menu: { stroke: ["M4 6h16", "M4 12h16", "M4 18h16"] },
  message: { stroke: ["M5 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"] },
  grid: { stroke: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h6v6h-6z"] },
  pin: { stroke: ["M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z", circle(12, 10, 2.5)] },
  dollar: { stroke: ["M12 3v18", "M16.5 7.5c-.6-1.5-2.3-2.5-4.5-2.5-2.5 0-4.5 1.3-4.5 3.3 0 4.7 9.5 2.4 9.5 7.2 0 2-2 3.5-4.8 3.5-2.4 0-4.2-1.1-4.8-2.8"] },
  // Full screen and back (the résumé inside the candidate panel, plan H5).
  expand: { stroke: ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"] },
  shrink: { stroke: ["M9 4v5H4", "M15 4v5h5", "M9 20v-5H4", "M15 20v-5h5"] },
  // The light and dark theme switch at the foot of the rail.
  sun: { stroke: [circle(12, 12, 4), "M12 2.5v2", "M12 19.5v2", "M2.5 12h2", "M19.5 12h2", "m5.3 5.3 1.4 1.4", "m17.3 17.3 1.4 1.4", "m5.3 18.7 1.4-1.4", "m17.3 6.7 1.4-1.4"] },
  moon: { stroke: ["M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7Z"] },
} satisfies Record<string, Glyph>;

/** Second names for the same drawing, matching the places they stand for (the rail's Today, Roles, Talent, Interviews). */
export const ICON_ALIASES = {
  today: "home",
  roles: "briefcase",
  talent: "people",
  interviews: "calendar",
  assistant: "sparkle",
  pencil: "edit",
  attach: "paperclip",
  "sign-out": "log-out",
  location: "pin",
  pay: "dollar",
} as const satisfies Record<string, keyof typeof GLYPHS>;

export type IconName = keyof typeof GLYPHS | keyof typeof ICON_ALIASES;

export const ICON_NAMES = [...Object.keys(GLYPHS), ...Object.keys(ICON_ALIASES)] as IconName[];

/** The drawing for a name or one of its aliases. */
export function resolveIcon(name: IconName): Glyph {
  const key: keyof typeof GLYPHS = name in ICON_ALIASES ? ICON_ALIASES[name as keyof typeof ICON_ALIASES] : (name as keyof typeof GLYPHS);
  return GLYPHS[key];
}
