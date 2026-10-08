import type { CompAdapter, CompBenchmark } from "../types";

/**
 * BLS Occupational Employment and Wage Statistics (OEWS). Public API v1 needs no key (low daily limits);
 * v2 uses a free registration key. Series ids encode area and occupation:
 *   OEUM{area code 7 digits}000000{SOC 6 digits}{data type 2 digits}
 * Data type 03 = mean hourly wage, 04 = annual mean, 08 = hourly median... (we request 03 and 13/14 percentiles when available).
 * Metro area codes and SOC codes are looked up from small built-in tables; unknown → null (the playbook range is used).
 */
const SOC: Record<string, string> = {
  "dental hygienist": "291292",
  "registered dental hygienist": "291292",
  "dental assistant": "319091",
  "medical secretary": "436013",
  "receptionist": "434171",
  "office manager": "431011",
  "dentist": "291021",
  "hvac technician": "499021",
  "electrician": "472111",
  "plumber": "472152",
  "veterinary technician": "292056",
  "home health aide": "311120",
  "marketing manager": "112021",
  "performance marketing": "112021",
  "growth marketing": "112021",
  "digital marketing manager": "112021",
  "e-commerce manager": "112021",
  "ecommerce manager": "112021",
  "marketing coordinator": "131161",
  "marketing specialist": "131161",
  "social media": "131161",
  "content marketing": "131161",
  "account executive": "414012",
  "sales representative": "414012",
  "operations manager": "111021",
  "accountant": "132011",
  "front desk": "434171",
  "bookkeeper": "433031",
  "administrative assistant": "436014",
  "customer service representative": "434051",
  "medical assistant": "319092",
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
    const t = title.toLowerCase();
    let best: { key: string; soc: string } | null = null;
    for (const [k, v] of Object.entries(SOC)) if (t.includes(k) && (!best || k.length > best.key.length)) best = { key: k, soc: v };
    return best?.soc ?? null;
  }

  static areaFor(locationText: string | undefined): { code: string; label: string } {
    const l = (locationText ?? "").toLowerCase();
    for (const [k, v] of Object.entries(AREA)) if (k !== "national" && l.includes(k)) return { code: v, label: k };
    return { code: AREA.national, label: "US national" };
  }

  async benchmark(query: { title: string; socCode?: string; locationText?: string; basis?: "hourly" | "salary" }): Promise<CompBenchmark | null> {
    if (this.status !== "live") return null;
    const soc = query.socCode ?? BlsOewsAdapter.socFor(query.title);
    if (!soc) return null;
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
      };
    } catch {
      return null;
    }
  }
}
