import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RolePacket as RolePacketSchema } from "../../packages/contracts/src/index";
import { samplePacket } from "../../packages/agents/src/fixtures/sample-packet";
import type { RolePacket as WebRolePacket } from "../../apps/web/src/api/client";
import { IMPORTANCE_CHOICES, MUST_HAVES_SCORE_LINE, SKILLS_MAX, applySkills, checkedInLabel, editorFocusFrom, importanceLabel, newSkillRow, removalWords, skillRowsFrom, skillUses, skillsProblem } from "../../apps/web/src/skills-form";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/**
 * The plain rubric editor (plan F3, F12): the role's skills as rows with what each means, how much it counts in the
 * match score (Essential, Important, Helpful) and where it is checked. A save keeps what the form does not show, keeps
 * the screening questions and interview rounds pointing at skills that exist, and says before a removal what leans on it.
 * The sample packet: Chairside skill (weight 5), Patient care (4), Infection control (4); the question "recent" asks
 * about chairside, "nervous" about patients, and the only interview round checks patients alone.
 */
const packet = samplePacket() as unknown as WebRolePacket;
const saved = (rows: ReturnType<typeof skillRowsFrom>) => {
  const next = structuredClone(packet);
  applySkills(next, rows);
  return next;
};

describe("the skills in the role editor", () => {
  it("reads each skill's importance from its weight when nobody has picked one, in the founder's words", () => {
    expect(IMPORTANCE_CHOICES.map((c) => c.label)).toEqual(["Essential", "Important", "Helpful"]);
    expect(skillRowsFrom(packet).map((r) => [r.key, r.importance, r.evaluatedIn])).toEqual([["chairside", "essential", "both"], ["patients", "important", "both"], ["infection", "important", "screen"]]);
  });

  it("saves without changing anything when nothing was touched", () => {
    const next = saved(skillRowsFrom(packet));
    expect(next.competencies).toEqual(packet.competencies);
    expect(next.screening).toEqual(packet.screening);
    expect(next.interviews).toEqual(packet.interviews);
  });

  it("saves a picked importance with its weight, and a new skill with a readable key and its meaning as the indicator", () => {
    const rows = skillRowsFrom(packet);
    rows[1] = { ...rows[1], importance: "essential" };
    rows.push({ ...newSkillRow(), name: "Dental software", definition: "Books and charts in Dentrix.", importance: "helpful" });
    const next = saved(rows);
    const parsed = RolePacketSchema.parse(next);
    expect(parsed.competencies[1]).toMatchObject({ key: "patients", importance: "essential", weight: 5, indicators: ["A nervous patient story"] });
    expect(parsed.competencies[3]).toMatchObject({ key: "comp_4_dental_software", name: "Dental software", importance: "helpful", weight: 1, evaluatedIn: "both", indicators: ["Books and charts in Dentrix."] });
    // the skills that were not touched keep exactly what they had
    expect(parsed.competencies[0]).toEqual(RolePacketSchema.parse(packet).competencies[0]);
  });

  it("never changes an existing key, and keeps a new key clear of the others", () => {
    const rows = skillRowsFrom(packet);
    rows[0] = { ...rows[0], name: "Assisting the dentist" };
    rows.push({ ...newSkillRow(), name: "Patients", definition: "d" });
    const next = saved([...rows, { ...newSkillRow(), name: "Patients again", definition: "d" }]);
    expect(next.competencies.map((c) => c.key)).toEqual(["chairside", "patients", "infection", "comp_4_patients", "comp_5_patients_again"]);
  });

  it("says what leans on a skill before it goes, and unlinks the question once it is removed", () => {
    const rows = skillRowsFrom(packet);
    const uses = skillUses(packet, "chairside", rows.map((r) => r.key));
    expect(uses).toEqual({ questions: ["Tell me about your most recent dental assisting work."], rounds: [] });
    expect(removalWords("Chairside skill", uses)).toEqual({ text: 'Chairside skill: the screening question "Tell me about your most recent dental assisting work." asks about it. Removing it unlinks them; the questions and rounds themselves stay as they are.', blocked: false });
    const next = saved([...rows.filter((r) => r.key !== "chairside"), { ...newSkillRow(), name: "Dental software", definition: "Dentrix" }]);
    expect((next.screening.questions[0] as { competencyKey?: string }).competencyKey).toBeUndefined();
    expect((next.screening.questions[1] as { competencyKey?: string }).competencyKey).toBe("patients");
    expect(RolePacketSchema.safeParse(next).success).toBe(true);
    // a skill nothing leans on simply goes
    expect(removalWords("Infection control", skillUses(packet, "infection", rows.map((r) => r.key)))).toBeNull();
  });

  it("will not remove the only skill an interview round checks, and says why", () => {
    const rows = skillRowsFrom(packet);
    const words = removalWords("Patient care", skillUses(packet, "patients", rows.map((r) => r.key)));
    expect(words?.blocked).toBe(true);
    expect(words?.text).toMatch(/only skill the interview round "Conversation with the dentist" checks/);
    const without = [...rows.filter((r) => r.key !== "patients"), { ...newSkillRow(), name: "Dental software", definition: "Dentrix" }];
    expect(skillsProblem(without, packet)).toBe('The interview round "Conversation with the dentist" would check no skill. Keep one of the skills it checks.');
  });

  it("says plainly what cannot be saved: 3 to 8 skills, each with a meaning and a name of its own", () => {
    const rows = skillRowsFrom(packet);
    expect(skillsProblem(rows, packet)).toBeNull();
    expect(skillsProblem(rows.slice(0, 2), packet)).toMatch(/at least 3 skills/);
    expect(skillsProblem([...rows, ...Array.from({ length: SKILLS_MAX - 2 }, (_, i) => ({ ...newSkillRow(), name: `Extra ${i}`, definition: "d" }))], packet)).toBe(`At most ${SKILLS_MAX} skills.`);
    expect(skillsProblem([...rows, { ...newSkillRow(), name: "New one", definition: " " }], packet)).toBe("Every skill needs a line on what it means.");
    expect(skillsProblem([...rows, { ...newSkillRow(), name: "patient CARE", definition: "d" }], packet)).toMatch(/same name/);
    // an empty row is left out, not counted
    expect(skillsProblem([...rows, newSkillRow()], packet)).toBeNull();
  });

  it("shows each skill's importance and where it is checked on the role page, and what must-haves do to the score", () => {
    expect(importanceLabel({ weight: 5 })).toBe("Essential");
    expect(importanceLabel({ weight: 4 })).toBe("Important");
    expect(importanceLabel({ weight: 5, importance: "helpful" })).toBe("Helpful");
    expect(checkedInLabel("both")).toBe("screening chat and interviews");
    expect(checkedInLabel("screen")).toBe("screening chat");
    expect(MUST_HAVES_SCORE_LINE).toMatch(/holds the score at 54 at most/);
  });

  it("opens the editor at a section only for the sections it has", () => {
    expect(editorFocusFrom("must-haves")).toBe("must-haves");
    expect(editorFocusFrom("skills")).toBe("skills");
    expect(editorFocusFrom("pay")).toBeNull();
    expect(editorFocusFrom(null)).toBeNull();
  });

  it("is wired into the editor and the role page: the skills rows, the save, and the ?edit= link", () => {
    const editor = read("../../apps/web/src/pages/RoleEditor.tsx");
    expect(editor).toContain('<RequirementGroup id="ed-skills"');
    expect(editor).toContain('<RequirementGroup id="ed-must-haves"');
    expect(editor).toContain("<SkillRows rows={skills} onChange={setSkills} packet={packet} />");
    expect(editor).toContain("applySkills(next, skills);");
    expect(editor).toContain("return skillsProblem(input.skills, input.packet);");
    const page = read("../../apps/web/src/pages/RoleDetail.tsx");
    // the "stricter than needed" prompt links to /roles/:id?tab=requirements&edit=must-haves (docs/spec/22 section 3)
    expect(page).toContain('const wantsEdit = editorFocusFrom(search.get("edit"));');
    expect(page).toContain('onClick={() => openEditor("must-haves")}');
    expect(page).toContain('onClick={() => openEditor("skills")}');
    expect(page).toContain("focus={editBase.focus}");
  });
});
