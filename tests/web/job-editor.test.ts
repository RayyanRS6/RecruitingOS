import { describe, expect, it } from "vitest";
import { DraftFieldEdit, PacketFieldEdit, type FormQuestionRefusal, type PacketFlag } from "../../packages/contracts/src/index";
import { ApiError } from "../../apps/web/src/api/client";
import {
  KEEP_REASON_MIN, choicesOf, flagsOf, hasChanges, jobEdit, jobFormFrom, jobFormProblem, keepFlagsOf, moveRow, newFormRow, newInterviewRow, newPlace, newSkill, newTextRow, openFlags, questionRefusalsOf,
  type JobForm,
} from "../../apps/web/src/job-editor";
import { jobPacket } from "./job-fixture";

/**
 * The one editor of a job, on a published job and on a written draft alike: the record as the form holds it, the first
 * thing wrong with it in plain words, and the edit a save sends, which carries only what changed. Every edit made here
 * is checked against the API's own schema (`PacketFieldEdit`, `DraftFieldEdit`).
 */
const base = jobFormFrom(jobPacket());
const edited = (change: (f: JobForm) => void): JobForm => {
  const f = structuredClone(base);
  change(f);
  return f;
};
/** The edit, checked as the API would take it for a draft and for a published job. */
const sent = (form: JobForm) => {
  const edit = jobEdit(base, form);
  expect(DraftFieldEdit.safeParse(edit).success, JSON.stringify(edit)).toBe(true);
  expect(PacketFieldEdit.safeParse({ baseVersion: 2, ...edit }).success, JSON.stringify(edit)).toBe(true);
  return edit;
};

describe("the form as it opens", () => {
  it("holds every part of the record a person may change", () => {
    expect(base).toMatchObject({ title: "Dental Assistant", department: "Clinical", employmentType: "full_time", schedule: "Weekdays, 8 to 5", remotePolicy: "onsite", basis: "hourly", payMin: "24", payMax: "28", showPay: true, benefits: "Health, dental and paid time off", minutes: "10" });
    expect(base.places).toEqual([{ city: "Irvine", region: "CA", rest: { country: "US", timezone: "America/Los_Angeles" } }]);
    expect(base.mustHaves).toEqual([{ key: "m1", text: "Active RDA licence" }, { key: "m2", text: "Two years chairside" }]);
    expect(base.niceToHaves).toEqual([{ key: "n1", text: "Spanish" }]);
    expect(base.skills).toEqual([{ key: "s1", name: "Digital radiography", importance: "important", definition: "Takes and reads digital x-rays." }]);
    expect(base.interview[0]).toEqual({ key: "q1", question: "Tell us about a busy day.", modelAnswer: "A concrete example." });
    expect(base.formQuestions.map((q) => [q.kind, q.required, q.options, q.unit, q.min, q.max])).toEqual([["yes_no", true, "", "", "", ""], ["choice", false, "Days\nEvenings", "", "", ""], ["number", true, "", "years", "0", "40"]]);
  });

  it("opens a draft with no pay yet with the pay boxes empty", () => {
    const { compensation: _pay, ...noPay } = jobPacket();
    expect(jobFormFrom(noPay as never)).toMatchObject({ basis: "", payMin: "", payMax: "", showPay: true, benefits: "" });
  });

  it("starts a new row empty, without a key, and moves a row up or down inside its list", () => {
    expect(newPlace()).toEqual({ city: "", region: "", rest: { country: "US" } });
    expect(newTextRow()).toEqual({ key: null, text: "" });
    expect(newSkill()).toEqual({ key: null, name: "", importance: "important", definition: "" });
    expect(newInterviewRow()).toEqual({ key: null, question: "", modelAnswer: "" });
    expect(newFormRow()).toMatchObject({ key: null, kind: "yes_no", required: true });
    expect(moveRow(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveRow(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveRow(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveRow(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    expect(choicesOf({ options: " Days \n\nEvenings\n " })).toEqual(["Days", "Evenings"]);
  });
});

describe("what a save sends", () => {
  it("sends nothing when nothing changed", () => {
    expect(jobEdit(base, structuredClone(base))).toEqual({});
    expect(hasChanges({})).toBe(false);
    // spaces around a word are not a change
    expect(jobEdit(base, edited((f) => { f.title = "  Dental Assistant "; }))).toEqual({});
  });

  it("sends only the part that changed", () => {
    const title = sent(edited((f) => { f.title = "Lead Dental Assistant"; }));
    expect(title).toEqual({ identity: { title: "Lead Dental Assistant" } });
    expect(hasChanges(title)).toBe(true);
    expect(sent(edited((f) => { f.description = `${f.description} Saturdays are shared.`; }))).toEqual({ description: `${base.description} Saturdays are shared.` });
    expect(sent(edited((f) => { f.minutes = "15"; }))).toEqual({ screening: { maxMinutes: 15 } });
    expect(sent(edited((f) => { f.remotePolicy = "hybrid"; f.schedule = ""; f.department = ""; }))).toEqual({ identity: { department: null, schedule: null, remotePolicy: "hybrid" } });
  });

  it("keeps what the form does not show of a place, and writes a state in capitals", () => {
    const moved = sent(edited((f) => { f.places[0].city = "Tustin"; f.places[0].region = "ca"; f.places.push({ ...newPlace(), city: "Costa Mesa", region: "CA" }); f.places.push(newPlace()); }));
    expect(moved).toEqual({ identity: { locations: [{ country: "US", timezone: "America/Los_Angeles", city: "Tustin", region: "CA" }, { country: "US", city: "Costa Mesa", region: "CA" }] } });
  });

  it("sends the pay whole whenever any of it changed, and the other pay choices on their own", () => {
    expect(sent(edited((f) => { f.payMax = "30"; }))).toEqual({ compensation: { basis: "hourly", min: 24, max: 30 } });
    expect(sent(edited((f) => { f.basis = "salary"; f.payMin = "52k"; f.payMax = "$60,000"; }))).toEqual({ compensation: { basis: "salary", min: 52000, max: 60000 } });
    expect(sent(edited((f) => { f.showPay = false; }))).toEqual({ compensation: { discloseRange: false } });
    expect(sent(edited((f) => { f.benefits = ""; }))).toEqual({ compensation: { benefitsSummary: null } });
  });

  it("sends a changed list whole, in order: a row that was there keeps its key, a new one has none, an empty one is left out", () => {
    const edit = sent(edited((f) => {
      f.mustHaves = [f.mustHaves[1], { key: null, text: " CPR certification " }, { key: null, text: "  " }];
    }));
    expect(edit).toEqual({ requirements: { mustHaves: [{ key: "m2", text: "Two years chairside" }, { text: "CPR certification" }] } });
    expect(sent(edited((f) => { f.niceToHaves = []; }))).toEqual({ requirements: { niceToHaves: [] } });
    expect(sent(edited((f) => { f.skills[0].importance = "essential"; f.skills.push({ ...newSkill(), name: "Dentrix" }); }))).toEqual({
      competencies: [{ key: "s1", name: "Digital radiography", importance: "essential", definition: "Takes and reads digital x-rays." }, { name: "Dentrix", importance: "important", definition: "" }],
    });
    expect(sent(edited((f) => { f.interview = moveRow(f.interview, 0, 1); }))).toEqual({
      screening: { questions: [{ key: "q2", question: "How do you sterilise instruments?", modelAnswer: "" }, { key: "q1", question: "Tell us about a busy day.", modelAnswer: "A concrete example." }, { key: "q3", question: "Why this practice?", modelAnswer: "" }] },
    });
  });

  it("sends the screening questions with what each kind needs", () => {
    const edit = sent(edited((f) => {
      f.formQuestions[1].options = "Days\nEvenings\nNights";
      f.formQuestions[2].max = "";
      f.formQuestions.push({ ...newFormRow(), question: "Do you have reliable transport?", required: false });
    }));
    expect(edit).toEqual({
      formQuestions: [
        { kind: "yes_no", key: "f1", question: "Can you work Saturdays?", help: "", required: true },
        { kind: "choice", key: "f2", question: "Which shift suits you?", help: "", required: false, options: ["Days", "Evenings", "Nights"] },
        { kind: "number", key: "f3", question: "Years of chairside experience?", help: "", required: true, unit: "years", min: 0 },
        { kind: "yes_no", question: "Do you have reliable transport?", help: "", required: false },
      ],
    });
  });
});

describe("what cannot be saved, said before anything is sent", () => {
  const problem = (change: (f: JobForm) => void) => jobFormProblem(edited(change));

  it("finds nothing wrong with the record as it is", () => {
    expect(jobFormProblem(base)).toBeNull();
  });

  it("asks for a title, a place and a description", () => {
    expect(problem((f) => { f.title = " "; })).toBe("Give the job a title.");
    expect(problem((f) => { f.places = [newPlace()]; })).toBe("Say where the job is: a city or a state.");
    expect(problem((f) => { f.description = "Too short."; })).toBe("The job description needs at least 50 characters.");
  });

  it("holds pay to the pay card's rules once any of it is typed, and lets a draft leave it empty", () => {
    expect(problem((f) => { f.payMin = "30"; })).toBe("The lowest pay must not be above the highest.");
    expect(problem((f) => { f.basis = ""; })).toBe("Choose by the hour or a yearly salary.");
    expect(problem((f) => { f.basis = ""; f.payMin = ""; f.payMax = ""; })).toBeNull();
  });

  it("keeps the counts the API keeps: one to six must-haves, at most eight skills, three to twelve interview questions, at most ten screening questions", () => {
    expect(problem((f) => { f.mustHaves = [newTextRow()]; })).toBe("Keep at least one must-have.");
    expect(problem((f) => { f.mustHaves = Array.from({ length: 7 }, (_, i) => ({ key: null, text: `Must-have ${i}` })); })).toBe("At most 6 must-haves.");
    expect(problem((f) => { f.skills = Array.from({ length: 9 }, (_, i) => ({ ...newSkill(), name: `Skill ${i}` })); })).toBe("At most 8 skills.");
    expect(problem((f) => { f.interview = f.interview.slice(0, 2); })).toBe("The AI interview needs 3 to 12 questions.");
    expect(problem((f) => { f.interview = Array.from({ length: 13 }, (_, i) => ({ ...newInterviewRow(), question: `Question ${i}?` })); })).toBe("The AI interview needs 3 to 12 questions.");
    expect(problem((f) => { f.minutes = "45"; })).toBe("The AI interview's length is a whole number of minutes, 5 to 30.");
    expect(problem((f) => { f.formQuestions = Array.from({ length: 11 }, (_, i) => ({ ...newFormRow(), question: `Question ${i}?` })); })).toBe("At most 10 screening questions.");
  });

  it("asks a choice question for two to eight choices, and a number question for numbers", () => {
    expect(problem((f) => { f.formQuestions[1].options = "Days"; })).toBe('A choice question needs 2 to 8 choices: "Which shift suits you?".');
    expect(problem((f) => { f.formQuestions[2].min = "a few"; })).toBe('The lowest and highest answer must be numbers: "Years of chairside experience?".');
    expect(problem((f) => { f.formQuestions[0].question = "Ok"; })).toBe("Write each screening question in full.");
    // an empty row is simply left out
    expect(problem((f) => { f.formQuestions.push(newFormRow()); f.mustHaves.push(newTextRow()); })).toBeNull();
  });
});

describe("what the server may answer to a save", () => {
  const flag = (id: string, kept = false): PacketFlag => ({ id, path: "description.publicJobDescription", rule: "age", text: "young and energetic", reason: "It can stand in for age.", alternative: "energetic", ...(kept ? { kept: { reason: "A quote from our mission.", by: { kind: "user", id: "u1" }, at: "2026-11-18T10:00:00.000Z" } } : {}) } as PacketFlag);

  it("lists the wording flags of a refused save, and only the ones nobody has kept hold anything", () => {
    const refused = new ApiError(422, "packet_flags", "Some wording needs a look.", { flags: [flag("f1"), flag("f2")] });
    expect(flagsOf(refused).map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(flagsOf(new ApiError(409, "stale_version", "Someone else saved this job."))).toEqual([]);
    expect(flagsOf(new TypeError("Failed to fetch"))).toEqual([]);
    expect(openFlags([flag("f1"), flag("f2", true)]).map((f) => f.id)).toEqual(["f1"]);
    expect(openFlags(null)).toEqual([]);
  });

  it("keeps a flagged phrase only with a reason of five characters or more", () => {
    expect(KEEP_REASON_MIN).toBe(5);
    expect(keepFlagsOf({ f1: "  It is the certificate's own name. ", f2: "ok", f3: "" })).toEqual([{ flagId: "f1", reason: "It is the certificate's own name." }]);
    expect(PacketFieldEdit.safeParse({ baseVersion: 2, keepFlags: keepFlagsOf({ f1: "It is the certificate's own name." }) }).success).toBe(true);
  });

  it("names the parts of a screening question the server refused", () => {
    const refusal: FormQuestionRefusal = { index: 0, key: "f1", part: "question", rule: "age", text: "How old are you?", reason: "It asks about age.", alternative: "Ask about the experience the job needs.", words: "How old are you?" };
    expect(questionRefusalsOf(new ApiError(422, "question_not_allowed", "A question cannot be asked.", { problems: [refusal] }))).toEqual([refusal]);
    expect(questionRefusalsOf(new ApiError(422, "packet_flags", "x", { flags: [] }))).toEqual([]);
    expect(questionRefusalsOf(null)).toEqual([]);
  });
});
