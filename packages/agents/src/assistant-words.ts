/**
 * The app's word for a resume in what an assistant writes to a person. The models write "résumé", and every page, email
 * and button says "resume". Only the spelling changes: "resume" as a verb reads the same, and nothing else is touched.
 */
export function resumeAsWeWriteIt(text: string): string {
  return text.replace(/(?<![\p{L}\p{N}])([Rr])[ée]sum[ée](s?)(?![\p{L}\p{N}])/gu, (_all, r: string, s: string) => `${r}esume${s}`);
}
