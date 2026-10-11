import type { CompAdapter, CompBenchmark } from "../types";

/**
 * BLS Occupational Employment and Wage Statistics (OEWS). Public API v1 needs no key (low daily limits);
 * v2 uses a free registration key. Series ids encode area and occupation:
 *   OEUM{area code 7 digits}000000{SOC 6 digits}{data type 2 digits}
 * Data type 03 = mean hourly wage, 04 = annual mean, 08 = hourly median... (we request 03 and 13/14 percentiles when available).
 * Metro area codes and SOC codes are looked up from small built-in tables; unknown → null (the playbook range is used).
 */
/** SOC 13-1161: the occupation BLS publishes for marketing specialists (and market research analysts). */
const MARKETING_SPECIALISTS = { soc: "131161", approximate: "Market research analysts and marketing specialists" } as const;
/** SOC 11-2021, read for a job that runs one channel or the online store: managers of whole marketing teams earn more. */
const MARKETING_MANAGERS_ROUGHLY = { soc: "112021", approximate: "Marketing managers" } as const;

/**
 * Title words → the occupation. `approximate` names the broader group the figures are for when the job has no
 * occupation of its own: social media and content jobs are read as marketing specialists (13-1161), never as marketing
 * managers (11-2021), whose figures are for people running whole marketing teams and would overstate the market.
 * The longest name in the title wins, so "Social and Content Marketing Manager" is a social and content job.
 */
const SOC: Record<string, { soc: string; approximate?: string }> = {
  "dental hygienist": { soc: "291292" },
  "registered dental hygienist": { soc: "291292" },
  "dental assistant": { soc: "319091" },
  "medical secretary": { soc: "436013" },
  "receptionist": { soc: "434171" },
  "office manager": { soc: "431011" },
  "dentist": { soc: "291021" },
  "hvac technician": { soc: "499021" },
  "electrician": { soc: "472111" },
  "plumber": { soc: "472152" },
  "veterinary technician": { soc: "292056" },
  "home health aide": { soc: "311120" },
  "marketing manager": { soc: "112021" },
  "performance marketing": { soc: "112021" },
  "growth marketing": { soc: "112021" },
  "digital marketing manager": { soc: "112021" },
  "e-commerce manager": MARKETING_MANAGERS_ROUGHLY,
  "ecommerce manager": MARKETING_MANAGERS_ROUGHLY,
  "marketing coordinator": { soc: "131161" },
  "marketing specialist": { soc: "131161" },
  "social media": MARKETING_SPECIALISTS,
  "social media manager": MARKETING_SPECIALISTS,
  "social media marketing": MARKETING_SPECIALISTS,
  "social media marketing manager": MARKETING_SPECIALISTS,
  "social and content": MARKETING_SPECIALISTS,
  "social and content marketing manager": MARKETING_SPECIALISTS,
  "social content": MARKETING_SPECIALISTS,
  "content marketing": MARKETING_SPECIALISTS,
  "content marketing manager": MARKETING_SPECIALISTS,
  "content manager": MARKETING_SPECIALISTS,
  "brand content": MARKETING_SPECIALISTS,
  "community manager": MARKETING_SPECIALISTS,
  "account executive": { soc: "414012" },
  "sales representative": { soc: "414012" },
  "operations manager": { soc: "111021" },
  "accountant": { soc: "132011" },
  "front desk": { soc: "434171" },
  "bookkeeper": { soc: "433031" },
  "administrative assistant": { soc: "436014" },
  "customer service representative": { soc: "434051" },
  "medical assistant": { soc: "319092" },
};

const AREA: Record<string, string> = {
  "los angeles": "0031080",
  "anaheim": "0031080",
  "irvine": "0031080",
  "orange county": "0031080",
  "san diego": "0041740",
  "san francisco": "0041860",
  "oakland": "0041860",
  "san jose": "0041940",
  "sacramento": "0040900",
  "riverside": "0040140",
  "phoenix": "0038060",
  "scottsdale": "0038060",
  "las vegas": "0029820",
  "denver": "0019740",
  "salt lake": "0041620",
  "seattle": "0042660",
  "portland": "0038900",
  "dallas": "0019100",
  "fort worth": "0019100",
  "houston": "0026420",
  "austin": "0012420",
  "san antonio": "0041700",
  "chicago": "0016980",
  "minneapolis": "0033460",
  "detroit": "0019820",
  "columbus": "0018140",
  "indianapolis": "0026900",
  "nashville": "0034980",
  "atlanta": "0012060",
  "charlotte": "0016740",
  "miami": "0033100",
  "fort lauderdale": "0033100",
  "orlando": "0036740",
  "tampa": "0045300",
  "philadelphia": "0037980",
  "new york": "0035620",
  "boston": "0014460",
  "national": "0000000",
};

export class BlsOewsAdapter implements CompAdapter {
  readonly id = "bls_oews";
  readonly status: "live" | "disabled";
  constructor(private apiKey: string | undefined, private fetchImpl: typeof fetch = fetch, enabled = true) {
    this.status = enabled ? "live" : "disabled";
  }

  /**
   * The occupation for a job title: the longest known name the title contains, so "Dental Office Manager" is an office
   * manager and "Registered Dental Hygienist" a hygienist whatever order the table is in. The caller passes a title,
   * never a whole pasted ad (plan C5: an ad that mentions a receptionist is not a receptionist's job).
   */
  static socFor(title: string): string | null {
    return BlsOewsAdapter.occupationFor(title)?.soc ?? null;
  }

  /** The occupation for a job title, and the broader group's name when it is only an approximate match. */
  static occupationFor(title: string): { soc: string; approximate?: string } | null {
    const t = title.toLowerCase();
    let best: { key: string; occupation: { soc: string; approximate?: string } } | null = null;
    for (const [k, v] of Object.entries(SOC)) if (t.includes(k) && (!best || k.length > best.key.length)) best = { key: k, occupation: v };
    return best?.occupation ?? null;
  }

  /** The metro area for a place, named the way people write it ("Austin area"), or the national figures. */
  static areaFor(locationText: string | undefined): { code: string; label: string } {
    const l = (locationText ?? "").toLowerCase();
    for (const [k, v] of Object.entries(AREA)) if (k !== "national" && l.includes(k)) return { code: v, label: placeName(k) };
    return { code: AREA.national, label: "US national" };
  }

  /**
   * Market pay for a job and place. `socCode` (from the playbook role) wins over the title; the caller knows whether that
   * occupation is a close match. A title read as a broader occupation comes back marked `approximate`.
   */
  async benchmark(query: { title: string; socCode?: string; locationText?: string; basis?: "hourly" | "salary" }): Promise<CompBenchmark | null> {
    if (this.status !== "live") return null;
    const occupation = query.socCode ? { soc: query.socCode.replace(/\D/g, "") } : BlsOewsAdapter.occupationFor(query.title);
    const soc = occupation?.soc;
    if (!soc || !/^\d{6}$/.test(soc)) return null;
    const area = BlsOewsAdapter.areaFor(query.locationText);
    const prefix = area.code === "0000000" ? "OEUN" : "OEUM";
    const mk = (dt: string) => `${prefix}${area.code}000000${soc}${dt}`;
    // 03 hourly mean, 08 hourly median, 07 hourly 25th, 09 hourly 75th (annual: 04, 13, 12, 14)
    const hourly = query.basis !== "salary";
    const ids = hourly ? [mk("07"), mk("08"), mk("09")] : [mk("12"), mk("13"), mk("14")];
    const url = this.apiKey ? "https://api.bls.gov/publicAPI/v2/timeseries/data/" : "https://api.bls.gov/publicAPI/v1/timeseries/data/";
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesid: ids, ...(this.apiKey ? { registrationkey: this.apiKey } : {}) }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const json = (await res.json()) as { status?: string; Results?: { series?: Array<{ seriesID: string; data?: Array<{ year: string; value: string }> }> } };
      const series = json.Results?.series ?? [];
      const latest = (id: string) => {
        const s = series.find((x) => x.seriesID === id);
        const d = s?.data?.[0];
        return d ? { value: Number(d.value), year: d.year } : null;
      };
      const p25 = latest(ids[0]);
      const p50 = latest(ids[1]);
      const p75 = latest(ids[2]);
      if (!p25 || !p50 || !p75 || [p25, p50, p75].some((x) => Number.isNaN(x.value) || x.value <= 0)) return null;
      return {
        metro: area.label === "US national" ? "US national" : `${area.label} area`,
        basis: hourly ? "hourly" : "salary",
        p25: p25.value,
        p50: p50.value,
        p75: p75.value,
        source: `BLS OEWS ${p50.year}, SOC ${soc}, area ${area.code}`,
        asOf: p50.year,
        ...(occupation && "approximate" in occupation && occupation.approximate ? { approximate: true as const, occupation: occupation.approximate } : {}),
      };
    } catch {
      return null;
    }
  }
}

/** "salt lake" → "Salt Lake": a place as people write it. */
function placeName(key: string): string {
  return key.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
