import { describe, expect, it } from "vitest";
import { BlsOewsAdapter } from "./bls";

/** J19: the BLS wage benchmark against a fake fetch: a known metro, an unknown location falling back to national, and the API failing. */
describe("BLS OEWS benchmark", () => {
  type Call = { url: string; body: { seriesid: string[]; registrationkey?: string } };
  const series = (ids: string[], values: [number, number, number], year = "2025") => ({ status: "REQUEST_SUCCEEDED", Results: { series: ids.map((id, i) => ({ seriesID: id, data: [{ year, period: "A01", value: String(values[i]) }] })) } });
  const fetchAnswering = (answer: (call: Call) => { status: number; body: unknown }, calls: Call[] = []) => (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Call["body"] };
    calls.push(call);
    const { status, body } = answer(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  it("a known metro: the Los Angeles area series for a dental hygienist, hourly percentiles", async () => {
    const calls: Call[] = [];
    const adapter = new BlsOewsAdapter(undefined, fetchAnswering((c) => ({ status: 200, body: series(c.body.seriesid, [48.1, 55.3, 62.9]) }), calls));
    expect(adapter.status).toBe("live");
    const result = await adapter.benchmark({ title: "Registered Dental Hygienist", locationText: "Irvine, CA", basis: "hourly" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.bls.gov/publicAPI/v1/timeseries/data/");
    expect(calls[0].body.seriesid).toEqual(["OEUM003108000000029129207", "OEUM003108000000029129208", "OEUM003108000000029129209"]);
    expect(calls[0].body.registrationkey).toBeUndefined();
    // the place as people write it (polish list: "austin area" read oddly in the assistant's message)
    expect(result).toEqual({ metro: "Irvine area", basis: "hourly", p25: 48.1, p50: 55.3, p75: 62.9, source: "BLS OEWS 2025, SOC 291292, area 0031080", asOf: "2025" });
    expect(BlsOewsAdapter.areaFor("Salt Lake City, UT").label).toBe("Salt Lake");
    expect(BlsOewsAdapter.areaFor("Austin, TX")).toEqual({ code: "0012420", label: "Austin" });
  });

  it("social media and content jobs are read as marketing specialists (13-1161), marked approximate, never as marketing managers (polish list)", async () => {
    // every name the playbook's social and content role answers to, and the role's own title
    for (const title of ["Social Media Manager", "Social and Content Marketing Manager", "Content Marketing Manager", "Social Media Marketing Manager", "Community Manager", "Brand Content Manager", "Content Manager"]) {
      expect(BlsOewsAdapter.occupationFor(title), title).toEqual({ soc: "131161", approximate: "Market research analysts and marketing specialists" });
    }
    // a marketing manager is still a marketing manager, and a marketing coordinator a close match for specialists
    expect(BlsOewsAdapter.occupationFor("Marketing Manager")).toEqual({ soc: "112021" });
    expect(BlsOewsAdapter.occupationFor("Marketing Coordinator")).toEqual({ soc: "131161" });
    const calls: Call[] = [];
    const adapter = new BlsOewsAdapter(undefined, fetchAnswering((c) => ({ status: 200, body: series(c.body.seriesid, [58000, 71000, 90000]) }), calls));
    const social = await adapter.benchmark({ title: "Social Media Manager", locationText: "Austin, TX", basis: "salary" });
    expect(calls[0].body.seriesid[0]).toBe("OEUM001242000000013116112");
    expect(social).toEqual({ metro: "Austin area", basis: "salary", p25: 58000, p50: 71000, p75: 90000, source: "BLS OEWS 2025, SOC 131161, area 0012420", asOf: "2025", approximate: true, occupation: "Market research analysts and marketing specialists" });
    // the playbook's own code wins over the title (written either way); whether it is close is the caller's to say
    const byCode = await adapter.benchmark({ title: "Social and Content Marketing Manager", socCode: "13-1161", locationText: "Austin, TX", basis: "salary" });
    expect(calls[1].body.seriesid[0]).toBe("OEUM001242000000013116112");
    expect(byCode?.approximate).toBeUndefined();
  });

  it("an unknown location falls back to the national series; a key selects v2 and annual figures use the annual data types", async () => {
    const calls: Call[] = [];
    const adapter = new BlsOewsAdapter("registration-key-for-tests", fetchAnswering((c) => ({ status: 200, body: series(c.body.seriesid, [61000, 72000, 88000], "2024") }), calls));
    const result = await adapter.benchmark({ title: "Office Manager", locationText: "Boise, ID", basis: "salary" });
    expect(calls[0].url).toBe("https://api.bls.gov/publicAPI/v2/timeseries/data/");
    expect(calls[0].body.registrationkey).toBe("registration-key-for-tests");
    expect(calls[0].body.seriesid).toEqual(["OEUN000000000000043101112", "OEUN000000000000043101113", "OEUN000000000000043101114"]);
    expect(result).toEqual({ metro: "US national", basis: "salary", p25: 61000, p50: 72000, p75: 88000, source: "BLS OEWS 2024, SOC 431011, area 0000000", asOf: "2024" });
  });

  it("an API error, a broken answer, a missing series or an unknown title mean no benchmark, never a throw", async () => {
    expect(await new BlsOewsAdapter(undefined, fetchAnswering(() => ({ status: 500, body: { message: "down" } }))).benchmark({ title: "Dental Assistant", locationText: "Phoenix" })).toBeNull();
    expect(await new BlsOewsAdapter(undefined, (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch).benchmark({ title: "Dental Assistant" })).toBeNull();
    expect(await new BlsOewsAdapter(undefined, fetchAnswering(() => ({ status: 200, body: { status: "REQUEST_NOT_PROCESSED", Results: {} } }))).benchmark({ title: "Dental Assistant" })).toBeNull();
    expect(await new BlsOewsAdapter(undefined, fetchAnswering((c) => ({ status: 200, body: series(c.body.seriesid, [0, 0, 0]) }))).benchmark({ title: "Dental Assistant" })).toBeNull();
    const calls: Call[] = [];
    expect(await new BlsOewsAdapter(undefined, fetchAnswering(() => ({ status: 200, body: {} }), calls)).benchmark({ title: "Chief Astronaut" })).toBeNull();
    expect(calls).toHaveLength(0); // no occupation code, no call
    expect(await new BlsOewsAdapter(undefined, fetchAnswering(() => ({ status: 200, body: {} }), calls)).benchmark({ title: "Dental Assistant", socCode: "not-a-code" })).toBeNull();
    expect(calls).toHaveLength(0); // a malformed code is no code
  });

  it("names the occupation by the longest match in the title, and reads hourly or annual figures as asked (plan C2)", async () => {
    expect(BlsOewsAdapter.socFor("Front Desk Receptionist")).toBe("434171");
    expect(BlsOewsAdapter.socFor("Registered Dental Hygienist")).toBe("291292");
    expect(BlsOewsAdapter.socFor("Medical Secretary and Receptionist")).toBe("436013");
    expect(BlsOewsAdapter.socFor("Full-charge Bookkeeper")).toBe("433031");
    const calls: Call[] = [];
    const adapter = new BlsOewsAdapter(undefined, fetchAnswering((c) => ({ status: 200, body: series(c.body.seriesid, [88000, 104000, 126000]) }), calls));
    const salaried = await adapter.benchmark({ title: "Marketing Manager", locationText: "Los Angeles, CA", basis: "salary" });
    expect(calls[0].body.seriesid.map((id) => id.slice(-2))).toEqual(["12", "13", "14"]);
    expect(salaried?.basis).toBe("salary");
    const hourly = await adapter.benchmark({ title: "Marketing Manager", locationText: "Los Angeles, CA", basis: "hourly" });
    expect(calls[1].body.seriesid.map((id) => id.slice(-2))).toEqual(["07", "08", "09"]);
    expect(hourly?.basis).toBe("hourly");
  });

  it("disabled means no call at all", async () => {
    const calls: Call[] = [];
    const adapter = new BlsOewsAdapter(undefined, fetchAnswering(() => ({ status: 200, body: {} }), calls), false);
    expect(adapter.status).toBe("disabled");
    expect(await adapter.benchmark({ title: "Dental Assistant", locationText: "Irvine" })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
