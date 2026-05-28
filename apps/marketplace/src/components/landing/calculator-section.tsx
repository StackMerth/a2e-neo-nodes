"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/*
 * Cost comparison calculator — what you'd pay on AWS / Azure / GCP for
 * the same GPU hours. Source prices are on-demand list rates from each
 * provider's public pricing page (US-East / us-east-1 / us-central1)
 * normalized to single-GPU $/hr. Reservations and committed-use
 * discounts can lower hyperscaler pricing 30-60% — those numbers
 * aren't quoted here because TokenOS doesn't require commitments.
 *
 * Tiers without a generally-available hyperscaler equivalent (B200,
 * B300, GB300) render an honest "not yet on hyperscalers" message
 * instead of inventing comparison numbers.
 *
 * Editorial UI: mono labels, display numbers, bordered tiles. No
 * gradient cards or marketing flourish.
 */

interface TierComparison {
  id: string;
  label: string;
  tokenosHourly: number;
  awsHourly: number | null;
  azureHourly: number | null;
  gcpHourly: number | null;
}

const TIERS: TierComparison[] = [
  // Hyperscaler prices: AWS p5/g6e (us-east-1), Azure ND-H100/ND-H200/NCads (East US),
  // GCP a3-highgpu / g2-standard (us-central1), normalized to single-GPU $/hr.
  // Consumer / RTX tiers have null hyperscaler columns — AWS/Azure/GCP
  // don't sell consumer GPUs, the comparison only makes sense against
  // datacenter inventory.
  { id: "H100", label: "NVIDIA H100", tokenosHourly: 140.15 / 24, awsHourly: 12.29, azureHourly: 12.25, gcpHourly: 11.06 },
  { id: "H200", label: "NVIDIA H200", tokenosHourly: 179.85 / 24, awsHourly: 13.5, azureHourly: 13.75, gcpHourly: 12.5 },
  { id: "L40S", label: "NVIDIA L40S", tokenosHourly: 21 / 24, awsHourly: 1.86, azureHourly: 1.05, gcpHourly: 0.95 },
  { id: "B200", label: "NVIDIA B200", tokenosHourly: 321.1 / 24, awsHourly: null, azureHourly: null, gcpHourly: null },
  { id: "B300", label: "NVIDIA B300", tokenosHourly: 431.75 / 24, awsHourly: null, azureHourly: null, gcpHourly: null },
  { id: "GB300", label: "NVIDIA GB300", tokenosHourly: 499.35 / 24, awsHourly: null, azureHourly: null, gcpHourly: null },
  { id: "RTX_4090", label: "NVIDIA RTX 4090", tokenosHourly: 0.58, awsHourly: null, azureHourly: null, gcpHourly: null },
  { id: "RTX_3090", label: "NVIDIA RTX 3090", tokenosHourly: 0.37, awsHourly: null, azureHourly: null, gcpHourly: null },
  { id: "CONSUMER", label: "Consumer GPU", tokenosHourly: 0.29, awsHourly: null, azureHourly: null, gcpHourly: null },
];

const HOURS_PRESETS = [
  { label: "24/7", value: 730 },
  { label: "Business hrs", value: 200 },
  { label: "Light use", value: 80 },
];

function formatUSD(n: number): string {
  if (n >= 100000) return `$${(n / 1000).toFixed(0)}k`;
  if (n >= 10000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function CalculatorSection() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  const [tierId, setTierId] = useState<string>("H100");
  const [gpuCount, setGpuCount] = useState<number>(1);
  const [monthlyHours, setMonthlyHours] = useState<number>(730);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.1 },
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  const tier = useMemo(() => TIERS.find((t) => t.id === tierId) ?? TIERS[0]!, [tierId]);

  const tokenosMonthly = tier.tokenosHourly * gpuCount * monthlyHours;
  const awsMonthly = tier.awsHourly !== null ? tier.awsHourly * gpuCount * monthlyHours : null;
  const azureMonthly = tier.azureHourly !== null ? tier.azureHourly * gpuCount * monthlyHours : null;
  const gcpMonthly = tier.gcpHourly !== null ? tier.gcpHourly * gpuCount * monthlyHours : null;

  // Headline savings figure: vs AWS by convention (largest hyperscaler).
  // If AWS doesn't sell this tier, fall back to whichever hyperscaler does.
  const headlineCompare = awsMonthly ?? azureMonthly ?? gcpMonthly;
  const headlineDelta = headlineCompare !== null ? headlineCompare - tokenosMonthly : null;
  const headlineSavingsPct = headlineCompare !== null ? (headlineDelta! / headlineCompare) * 100 : null;
  const headlineCompareLabel = awsMonthly !== null ? "AWS" : azureMonthly !== null ? "Azure" : gcpMonthly !== null ? "GCP" : null;

  return (
    <section
      id="calculator"
      ref={sectionRef}
      className="relative py-16 sm:py-24 lg:py-32 bg-foreground/[0.02] overflow-hidden"
    >
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div
          className={`max-w-3xl mb-12 sm:mb-16 transition-all duration-700 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
          }`}
        >
          <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-6">
            <span className="w-8 h-px bg-brand" />
            Cost comparison
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-6xl font-display tracking-tight mb-6">
            What you would
            <br />
            pay elsewhere.
          </h2>
          <p className="text-base sm:text-lg lg:text-xl text-muted-foreground leading-relaxed">
            On-demand list prices from AWS, Azure, and GCP for the same hardware. Reservation and committed-use discounts can lower their numbers 30 to 60 percent; TokenOS does not require any commitment to get the figure shown.
          </p>
        </div>

        <div
          className={`grid lg:grid-cols-[1fr_2fr] gap-px bg-foreground/15 border border-foreground/15 transition-all duration-700 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
          }`}
        >
          {/* Left: inputs */}
          <div className="bg-background p-6 sm:p-8 space-y-8">
            <div>
              <label className="block font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
                GPU tier
              </label>
              <div className="grid grid-cols-2 gap-2">
                {TIERS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTierId(t.id)}
                    className={`px-3 py-2.5 border text-sm font-mono transition-colors ${
                      tierId === t.id
                        ? "border-brand bg-brand/10 text-foreground"
                        : "border-foreground/15 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                    }`}
                  >
                    {t.id}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
                GPU count
              </label>
              <div className="flex items-center border border-foreground/15">
                <button
                  type="button"
                  onClick={() => setGpuCount((n) => Math.max(1, n - 1))}
                  className="w-12 h-12 font-mono text-lg hover:bg-foreground/5 transition-colors"
                  aria-label="Decrement GPU count"
                >
                  −
                </button>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={gpuCount}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    if (Number.isFinite(next)) setGpuCount(Math.max(1, Math.min(1000, Math.round(next))));
                  }}
                  className="flex-1 h-12 bg-transparent text-center font-display text-xl outline-none border-x border-foreground/15"
                />
                <button
                  type="button"
                  onClick={() => setGpuCount((n) => Math.min(1000, n + 1))}
                  className="w-12 h-12 font-mono text-lg hover:bg-foreground/5 transition-colors"
                  aria-label="Increment GPU count"
                >
                  +
                </button>
              </div>
            </div>

            <div>
              <label className="block font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
                Monthly hours
              </label>
              <div className="grid grid-cols-3 gap-2 mb-3">
                {HOURS_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setMonthlyHours(p.value)}
                    className={`px-2 py-2 border text-xs font-mono transition-colors ${
                      monthlyHours === p.value
                        ? "border-brand bg-brand/10 text-foreground"
                        : "border-foreground/15 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                type="range"
                min={1}
                max={730}
                value={monthlyHours}
                onChange={(e) => setMonthlyHours(Number(e.target.value))}
                className="w-full accent-brand"
              />
              <div className="flex justify-between font-mono text-[11px] text-muted-foreground mt-2">
                <span>1 hr</span>
                <span className="text-foreground font-medium">{monthlyHours} hrs / mo</span>
                <span>730 hrs</span>
              </div>
            </div>
          </div>

          {/* Right: output */}
          <div className="bg-background p-6 sm:p-8 lg:p-10">
            {headlineCompareLabel === null ? (
              <div className="h-full flex flex-col justify-center">
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
                  Not yet on hyperscalers
                </span>
                <h3 className="font-display text-2xl sm:text-3xl mb-4">
                  {tier.label} is not generally available on AWS, Azure, or GCP today.
                </h3>
                <p className="text-base text-muted-foreground leading-relaxed mb-8">
                  TokenOS is among the earliest providers of this hardware. The on-demand price you can rent at right now:
                </p>
                <div className="border border-foreground/15 p-6">
                  <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-2">
                    TokenOS / month
                  </div>
                  <div className="font-display text-4xl sm:text-5xl text-brand">
                    {formatUSD(tokenosMonthly)}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground mt-2">
                    {gpuCount} × {tier.label} · {monthlyHours} hrs · ${tier.tokenosHourly.toFixed(2)} / GPU-hr
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-8">
                <div>
                  <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-3 block">
                    Estimated monthly delta
                  </span>
                  <div className="flex items-baseline gap-4 flex-wrap">
                    <span className="font-display text-5xl sm:text-6xl lg:text-7xl text-brand leading-none">
                      {formatUSD(headlineDelta!)}
                    </span>
                    <span className="font-mono text-base text-muted-foreground">
                      {headlineSavingsPct!.toFixed(1)}% off {headlineCompareLabel}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-foreground/10 border border-foreground/10">
                  <PriceTile label="TokenOS" amount={tokenosMonthly} highlight />
                  <PriceTile label="AWS" amount={awsMonthly} />
                  <PriceTile label="Azure" amount={azureMonthly} />
                  <PriceTile label="GCP" amount={gcpMonthly} />
                </div>

                <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
                  {gpuCount} × {tier.label} for {monthlyHours} hours per month. TokenOS rate of ${tier.tokenosHourly.toFixed(2)} / GPU-hr is the published on-demand price; no reservations or commitments required.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function PriceTile({ label, amount, highlight }: { label: string; amount: number | null; highlight?: boolean }) {
  return (
    <div className="bg-background p-4 sm:p-5">
      <div className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-2">
        {label}
      </div>
      <div className={`font-display text-xl sm:text-2xl ${highlight ? "text-brand" : ""}`}>
        {amount === null ? "—" : formatUSD(amount)}
      </div>
    </div>
  );
}
