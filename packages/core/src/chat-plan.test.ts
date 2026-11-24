import { describe, expect, it } from "vitest";
import { CHAT_WRAP_KEY, ChatPlan } from "@ros/contracts";
import { CHAT_GAP_LIMIT, asksYesOrNo, buildChatPlan, chatCounter, chatItemSettled, chatMoveStays, chatNextMove, saysNotDone, screeningKindFor, syncChatPlan, tapAnswerText, tapEcho, tapFormatFor } from "./chat-plan";

describe("the AI interview's plan (a counter and the section, never the questions in advance)", () => {
  const at = "2026-11-18T10:00:00.000Z";
  const plan = () => buildChatPlan({ questions: ["q_explain", "q_room"], gaps: ["mh_arduino", "mh_teaching"], at });

  it("puts the job's interview questions first, then the must-haves the CV reading did not find shown", () => {
    const p = plan();
    expect(p).toMatchObject({ v: 1, section: "required", current: null, builtAt: at });
    expect(p.items.map((i) => [i.key, i.kind, i.required, i.state, i.step, i.pushes])).toEqual([
      ["q_explain", "question", true, "open", "direct", 0], ["q_room", "question", true, "open", "direct", 0],
      ["mh_arduino", "gap", false, "open", "direct", 0], ["mh_teaching", "gap", false, "open", "direct", 0],
    ]);
    expect(chatCounter(p)?.label).toBe("Question 1 of 4");
    // no question at all: it starts with the must-haves; nothing at all: straight to the close
    expect(buildChatPlan({ questions: [], gaps: ["mh_a"], at }).section).toBe("experience");
    expect(buildChatPlan({ questions: [], gaps: [], at }).section).toBe("wrapping_up");
    expect(chatCounter(null)).toBeNull();
  });

  it("asks about at most four must-haves, never the same key twice, never the closing question as an item", () => {
    const many = buildChatPlan({ questions: ["a", "a", CHAT_WRAP_KEY], gaps: ["a", "b", "c", "b", "d", "e", "f"], at });
    expect(many.items.filter((i) => i.kind === "gap")).toHaveLength(CHAT_GAP_LIMIT);
    expect(many.items.map((i) => i.key)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("the ladder: concrete covers; vague gets one push then counts; 'No' climbs to the analog, then (a must-have) the smaller version, then not known", () => {
    const gap = { kind: "gap" as const, step: "direct" as const, pushes: 0 };
    expect(chatNextMove(gap, "concrete", true)).toBe("covered");
    expect(chatNextMove(gap, "vague", true)).toBe("push");
    expect(chatNextMove({ ...gap, pushes: 1 }, "vague", true)).toBe("covered");
    expect(chatNextMove(gap, "not_done", true)).toBe("analog");
    expect(chatNextMove({ ...gap, step: "analog" }, "not_done", true)).toBe("smaller");
    expect(chatNextMove({ ...gap, step: "smaller" }, "not_done", true)).toBe("unknown");
    // one of the job's questions: the analog, then not known (no smaller version)
    expect(chatNextMove({ kind: "question", step: "analog", pushes: 0 }, "not_done", true)).toBe("unknown");
    // a yes-or-no question takes its answer as it is: "No", or a bare "Yes"
    expect(chatNextMove({ kind: "question", step: "direct", pushes: 0 }, "not_done", false)).toBe("covered");
    expect(chatNextMove({ kind: "question", step: "direct", pushes: 0 }, "vague", false)).toBe("covered");
    // and so does a must-have with no ladder (one that names a licence: held or not), whatever step a stored plan left it at
    for (const step of ["direct", "analog", "smaller"] as const) {
      expect(chatNextMove({ ...gap, step }, "not_done", false), step).toBe("covered");
      expect(chatNextMove({ ...gap, step }, "vague", false), step).toBe("covered");
    }
    expect(["push", "analog", "smaller"].every((m) => chatMoveStays(m as "push"))).toBe(true);
    expect(chatMoveStays("covered") || chatMoveStays("unknown")).toBe(false);
  });

  it("reads a plain 'No' / 'I haven't' as not done, and a 'No, but…' as an answer", () => {
    for (const no of ["No", "no.", "Nope", "I haven't", "I haven’t done that", "Not really", "Never", "No, I haven't", "I don't", "I have never done that"]) expect(saysNotDone(no), no).toBe(true);
    for (const yes of ["No, but at my last job I explained the X-ray to a nervous patient", "Not yet, though I shadowed it once", "Yes", "I built a pump controller", "", "Not exactly the same, similar though: I ran the front desk"]) expect(saysNotDone(yes), yes).toBe(false);
  });

  it("moves on with the progress: asking, covered once passed, not known stays so, skipped; the section follows; the counter says which question is being asked", () => {
    let p = plan();
    p = syncChatPlan(p, { askedKeys: ["q_explain"], currentQuestionKey: "q_explain" });
    expect(p).toMatchObject({ section: "required", current: "q_explain" });
    expect(p.items[0].state).toBe("asking");
    // one push, still asking
    p = syncChatPlan(p, { askedKeys: ["q_explain"], currentQuestionKey: "q_explain" }, { key: "q_explain", move: "push" });
    expect(p.items[0]).toMatchObject({ state: "asking", pushes: 1 });
    // covered, on to the second question, which is then skipped
    p = syncChatPlan(p, { askedKeys: ["q_explain", "q_room"], currentQuestionKey: "q_room" }, { key: "q_explain", move: "covered" });
    expect(chatCounter(p)?.label).toBe("Question 2 of 4");
    p = syncChatPlan(p, { askedKeys: ["q_explain", "q_room", "mh_arduino"], currentQuestionKey: "mh_arduino", declined: ["q_room"] });
    expect(p.items.map((i) => i.state)).toEqual(["covered", "skipped", "asking", "open"]);
    expect(p.section).toBe("experience");
    expect(chatCounter(p)?.label).toBe("Question 3 of 4");
    // "No" all the way down: settled as not known, and it stays so once passed
    p = syncChatPlan(p, { askedKeys: ["q_explain", "q_room", "mh_arduino"], currentQuestionKey: "mh_arduino", declined: ["q_room"] }, { key: "mh_arduino", move: "analog" });
    expect(p.items[2]).toMatchObject({ state: "asking", step: "analog" });
    p = syncChatPlan(p, { askedKeys: ["q_explain", "q_room", "mh_arduino", "mh_teaching", CHAT_WRAP_KEY], currentQuestionKey: CHAT_WRAP_KEY, declined: ["q_room"] }, { key: "mh_arduino", move: "unknown" });
    expect(p.items.map((i) => i.state)).toEqual(["covered", "skipped", "unknown", "covered"]);
    expect(p).toMatchObject({ section: "wrapping_up", current: null });
    expect(p.items.every(chatItemSettled)).toBe(true);
    expect(chatCounter(p)?.label).toBe("All 4 questions done");
  });

  it("the counter counts every question the chat asks, a must-have asked about included and the closing question never, and says when all are done", () => {
    const stored = (states: Array<["question" | "gap", boolean, "open" | "asking" | "covered" | "unknown" | "skipped"]>, section: "experience" | "required" | "wrapping_up" = "required") =>
      ChatPlan.parse({ v: 1, section, builtAt: at, items: states.map(([kind, required, state], i) => ({ key: `k${i}`, kind, required, state })) });
    expect(chatCounter(undefined)).toBeNull();
    // answered, settled as not known and skipped are closed alike; the one being asked is the next
    const p = stored([["gap", false, "covered"], ["question", true, "covered"], ["question", true, "unknown"], ["question", true, "asking"], ["question", true, "open"], ["question", false, "skipped"]]);
    expect(chatCounter(p)).toEqual({ done: 4, total: 6, label: "Question 5 of 6" });
    expect(chatCounter(stored([["gap", false, "asking"]], "experience"))?.label).toBe("Question 1 of 1");
    // at the closing question: how many were asked, in plain words whatever the number
    expect(chatCounter(stored([["question", true, "skipped"], ["gap", false, "unknown"]], "wrapping_up"))).toEqual({ done: 2, total: 2, label: "All 2 questions done" });
    expect(chatCounter(stored([["question", true, "skipped"]], "wrapping_up"))?.label).toBe("All questions done");
    expect(chatCounter(stored([], "wrapping_up"))?.label).toBe("One question");
    // an item the chat passed over without asking (the model never asks again what the form asked) is not a question it
    // asked: above the closing question the line says how many are done, never "Question 3 of 3" (the live site, 25
    // November 2026); while another item is still being asked it counts as before
    expect(chatCounter(stored([["question", true, "covered"], ["gap", false, "open"], ["gap", false, "covered"]], "wrapping_up"))).toEqual({ done: 2, total: 2, label: "All 2 questions done" });
    expect(chatCounter(stored([["question", true, "covered"], ["gap", false, "open"]], "wrapping_up"))?.label).toBe("All questions done");
    expect(chatCounter(stored([["question", true, "covered"], ["gap", false, "open"], ["gap", false, "asking"]], "experience"))?.label).toBe("Question 2 of 3");
    // as the plan itself moves: the closing question asked while a must-have was never asked about
    let passed = buildChatPlan({ questions: ["q_explain", "q_room"], gaps: ["mh_arduino", "mh_teaching"], at });
    passed = syncChatPlan(passed, { askedKeys: ["q_explain", "q_room", "mh_teaching"], currentQuestionKey: "mh_teaching" });
    expect(chatCounter(passed)?.label).toBe("Question 3 of 4");
    passed = syncChatPlan(passed, { askedKeys: ["q_explain", "q_room", "mh_teaching", CHAT_WRAP_KEY], currentQuestionKey: CHAT_WRAP_KEY }, { key: "mh_teaching", move: "covered" });
    expect(passed.items.map((i) => i.state)).toEqual(["covered", "covered", "open", "covered"]);
    expect(passed.section).toBe("wrapping_up");
    expect(chatCounter(passed)).toEqual({ done: 3, total: 3, label: "All 3 questions done" });
  });
});

describe("tap answers", () => {
  const comp = { basis: "hourly" as const, currency: "USD" };
  it("works out the format from the question's kind and wording; skills and examples are always typed", () => {
    expect(tapFormatFor({ kind: "compensation", question: "What pay range are you looking for?" }, comp)).toEqual({ kind: "pay_range", basis: "hourly", currency: "USD" });
    expect(tapFormatFor({ kind: "eligibility", question: "Is your RDH license active in California?" }, comp)).toEqual({ kind: "yes_no" });
    // its kind alone never gives the buttons: this asks for their own words
    expect(tapFormatFor({ kind: "eligibility", question: "Tell us about your license." }, comp)).toBeNull();
    expect(tapFormatFor({ kind: "availability", question: "Which days of the week can you work?" }, comp)).toMatchObject({ kind: "days" });
    expect(tapFormatFor({ kind: "availability", question: "When could you start?" }, comp)).toEqual({ kind: "start_date" });
    expect(tapFormatFor({ kind: "availability", question: "Which days and hours are you available, and when could you start?" }, comp)).toBeNull();
    expect(tapFormatFor({ kind: "logistics", question: "Do you have reliable transportation to Irvine?" }, comp)).toEqual({ kind: "yes_no" });
    expect(tapFormatFor({ kind: "logistics", question: "How far is your commute?" }, comp)).toBeNull();
    expect(tapFormatFor({ kind: "skills", question: "Do you use Dentrix?" }, comp)).toBeNull();
    expect(tapFormatFor({ kind: "behavioral", question: "Tell me about a hard moment with a patient." }, comp)).toBeNull();
  });

  it("offers Yes and No only where the words ask yes or no, never for a question that asks them to name or list", () => {
    const typed = [
      "Which certifications do you hold, such as x-ray, coronal polishing, RDA or BLS?",
      "Which certifications do you hold (x-ray, coronal polishing, RDA, BLS)?",
      "Can you tell us which state licensed you?",
      "Could you list the certificates you hold?",
      "Can you explain your license status?",
      "Can you share your license number?",
      "Do you know who issued your license?",
      "Please confirm your license is active.",
    ];
    for (const question of typed) expect(tapFormatFor({ kind: "eligibility", question }, comp), question).toBeNull();
    const tapped = ["Do you currently hold an active California RDA license?", "Is your RDH license active in the state this office is in?", "Can you lift 25 pounds safely?"];
    for (const question of tapped) expect(tapFormatFor({ kind: "eligibility", question }, comp), question).toEqual({ kind: "yes_no" });
    // the same for availability and logistics questions; days, a start date and pay keep their own taps
    expect(tapFormatFor({ kind: "logistics", question: "Can you tell us how you would get to Irvine?" }, comp)).toBeNull();
    expect(tapFormatFor({ kind: "availability", question: "Are you available on Saturdays?" }, comp)).toEqual({ kind: "yes_no" });
    expect(tapFormatFor({ kind: "availability", question: "Which days of the week can you work?" }, comp)).toMatchObject({ kind: "days" });
  });

  it("a relative clause after a noun asks nothing open, while 'whether' does", () => {
    const tapped = [
      "Do you hold an active dental hygiene (RDH) license in the state where this office is located?",
      "Do you hold an active Registered Dental Assistant (RDA) license in the state where this office is located?",
      "Do you hold an active dental license (DDS/DMD) in the state where this office is located?",
      "Is your RDH license active in the state this office is in?",
      "Can you get to the office where you would work by 8 AM?",
      "Are you able to commute to the office where you would work?",
    ];
    for (const question of tapped) expect(tapFormatFor({ kind: "eligibility", question }, comp), question).toEqual({ kind: "yes_no" });
    expect(tapFormatFor({ kind: "logistics", question: "Are you able to commute to the office where you would work?" }, comp)).toEqual({ kind: "yes_no" });
    const typed = [
      "Can you confirm your RDH license state and whether it is currently active?",
      "Can you confirm whether your license is active?",
      // a second question after the clause is still read
      "Do you hold a license in the state where this office is located, and which number is it?",
      "Do you hold a license in the state where this office is located and which number is it?",
      // a wh-word after a preposition asks which
      "Do you have a preference for which days you work?",
    ];
    for (const question of typed) expect(tapFormatFor({ kind: "eligibility", question }, comp), question).toBeNull();
  });

  it("a relative clause the question asks for keeps the text box", () => {
    const typed = [
      "Can you confirm the state where you are licensed?",
      "Could you name the state where you hold your RDH license?",
      "Can you confirm the date when your license expires?",
      "Can you confirm the state where you hold your license and the date when it expires?",
    ];
    for (const question of typed) expect(tapFormatFor({ kind: "eligibility", question }, comp), question).toBeNull();
    expect(tapFormatFor({ kind: "availability", question: "Are there any days when you cannot work?" }, comp)).toBeNull();
    expect(tapFormatFor({ kind: "logistics", question: "Is there a time when you would need to leave early?" }, comp)).toBeNull();
    // one that only places the noun still asks nothing open
    expect(tapFormatFor({ kind: "availability", question: "Can you work on the days when the office is busiest?" }, comp)).toEqual({ kind: "yes_no" });
  });

  // The code check of 25 November 2026: the job editor shows no kind and sets none, so "Can you work Saturdays?" added
  // there was kept as an open question: no Yes and No, and a "No" was followed by "tell me about something similar".
  it("a question a person writes or rewords in the editor gets its kind from its words: yes-or-no words make it a question about a fact", () => {
    for (const question of ["Can you work Saturdays?", "Do you hold an active California RDA license?", "Are you able to lift 25 pounds safely?", "Have you used Dentrix before?"]) {
      expect(asksYesOrNo(question), question).toBe(true);
      // new, or reworded from an open question: a question about a fact, with Yes and No
      for (const was of [undefined, "skills", "behavioral", "motivation", "compensation"] as const) expect(screeningKindFor(question, was), `${question} (${was})`).toBe("eligibility");
      expect(tapFormatFor({ kind: screeningKindFor(question), question }, comp), question).toEqual({ kind: "yes_no" });
      // it keeps the kind it had when that was already one about a fact
      for (const was of ["availability", "logistics", "eligibility"] as const) expect(screeningKindFor(question, was), `${question} (${was})`).toBe(was);
    }
    // a request for their own words that only opens like a yes-or-no question stays open
    for (const question of ["Can you give an example of a time you calmed a nervous patient?", "Could you give us a recent example?", "Could you talk us through a crown prep?", "Can you tell us about your last job?", "Would you describe a hard day?", "Can you talk about a mistake you made?"]) {
      expect(screeningKindFor(question), question).toBe("skills");
      expect(screeningKindFor(question, "behavioral"), question).toBe("behavioral");
    }
    expect(screeningKindFor("Can you give two weeks' notice?")).toBe("eligibility");
  });

  it("words that are not yes-or-no leave a question the kind it had, and make a new one an open question; a pay question keeps its pay range only while it speaks of pay", () => {
    for (const question of ["How do you set up for a crown prep?", "Tell me about a nervous patient and what you did.", "Which certifications do you hold?", "What are you looking for in your next role?"]) {
      expect(asksYesOrNo(question), question).toBe(false);
      expect(screeningKindFor(question), question).toBe("skills");
      for (const was of ["skills", "behavioral", "motivation", "availability", "logistics", "eligibility"] as const) expect(screeningKindFor(question, was), `${question} (${was})`).toBe(was);
    }
    // the days tap and the start date stay with a reworded availability question
    expect(tapFormatFor({ kind: screeningKindFor("Which days can you work?", "availability"), question: "Which days can you work?" }, comp)).toMatchObject({ kind: "days" });
    // pay: reworded, it is still the pay question; with other words it is an open question, never a pay range under them
    for (const question of ["What hourly range are you looking for?", "What salary are you hoping for?", "What pay do you expect?", "How much are you looking to earn, in $ an hour?"]) expect(screeningKindFor(question, "compensation"), question).toBe("compensation");
    expect(screeningKindFor("Tell me about a nervous patient and what you did.", "compensation")).toBe("skills");
    expect(tapFormatFor({ kind: screeningKindFor("Tell me about a nervous patient and what you did.", "compensation"), question: "Tell me about a nervous patient and what you did." }, comp)).toBeNull();
    expect(screeningKindFor("Is $24 to $28 an hour within the range you are looking for?", "compensation")).toBe("eligibility");
  });

  it("records a tap as fixed words, and refuses one that does not fit the question", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(tapAnswerText({ kind: "yes_no" }, { kind: "yes_no", choice: "yes" })).toBe("Yes");
    expect(tapAnswerText({ kind: "yes_no" }, { kind: "yes_no", choice: "no" })).toBe("No");
    expect(tapAnswerText({ kind: "days", options: [] }, { kind: "days", days: ["saturday", "Monday", "Tuesday"] })).toBe("I can work Monday, Tuesday and Saturday.");
    expect(tapAnswerText({ kind: "days", options: [] }, { kind: "days", days: ["Funday"] })).toBeNull();
    expect(tapAnswerText({ kind: "start_date" }, { kind: "start_date", date: "2026-11-02" }, now)).toBe("I can start on Monday, November 2, 2026.");
    expect(tapAnswerText({ kind: "start_date" }, { kind: "start_date", date: "2020-01-01" }, now)).toBeNull();
    expect(tapAnswerText({ kind: "pay_range", basis: "hourly", currency: "USD" }, { kind: "pay_range", min: 48, max: 52 })).toBe("I'm looking for $48 to $52 an hour.");
    expect(tapAnswerText({ kind: "pay_range", basis: "salary", currency: "USD" }, { kind: "pay_range", min: 72000 })).toBe("I'm looking for $72,000 a year.");
    expect(tapAnswerText({ kind: "pay_range", basis: "hourly", currency: "USD" }, { kind: "pay_range", min: 60, max: 50 })).toBeNull();
    expect(tapAnswerText({ kind: "yes_no" }, { kind: "pay_range", min: 50 })).toBeNull();
  });

  it("says every tap back in the assistant's voice, never the candidate's 'I'", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    const echo = (format: Parameters<typeof tapAnswerText>[0], answer: Parameters<typeof tapAnswerText>[1]) => tapEcho(tapAnswerText(format, answer, now)!);
    expect(echo({ kind: "pay_range", basis: "hourly", currency: "USD" }, { kind: "pay_range", min: 18, max: 20 })).toBe("$18 to $20 an hour");
    expect(echo({ kind: "pay_range", basis: "salary", currency: "USD" }, { kind: "pay_range", min: 72000 })).toBe("$72,000 a year");
    expect(echo({ kind: "start_date" }, { kind: "start_date", date: "2026-11-16" })).toBe("you could start on Monday, November 16, 2026");
    expect(echo({ kind: "days", options: [] }, { kind: "days", days: ["Friday", "monday"] })).toBe("you can work Monday and Friday");
    expect(echo({ kind: "yes_no" }, { kind: "yes_no", choice: "yes" })).toBe("Yes");
    expect(echo({ kind: "yes_no" }, { kind: "yes_no", choice: "no" })).toBe("No");
    // every shape a tap can take, in every kind: none says "I", "I'm" or "my"
    const taps: Array<[Parameters<typeof tapAnswerText>[0], Parameters<typeof tapAnswerText>[1]]> = [
      [{ kind: "pay_range", basis: "hourly", currency: "USD" }, { kind: "pay_range", min: 48 }],
      [{ kind: "pay_range", basis: "salary", currency: "EUR" }, { kind: "pay_range", min: 50000, max: 60000.5 }],
      [{ kind: "start_date" }, { kind: "start_date", date: "2026-10-23" }],
      [{ kind: "days", options: [] }, { kind: "days", days: ["Sunday"] }],
    ];
    for (const [f, a] of taps) expect(echo(f, a), JSON.stringify(a)).not.toMatch(/\b(?:I|I'm|my|me)\b/);
    // words of any other shape in the first person are not said back at all; anything else is
    expect(tapEcho("I'd rather say on a call.")).toBeNull();
    expect(tapEcho("Weekends only.")).toBe("Weekends only");
    expect(tapEcho("  ")).toBeNull();
  });
});
