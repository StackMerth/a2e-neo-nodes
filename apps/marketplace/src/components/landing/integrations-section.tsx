"use client";

import { useEffect, useState, useRef } from "react";

/*
 * Reworked section: instead of a marquee of generic tech logos
 * (Postgres, Redis, Vercel, etc) this section now surfaces the
 * specific engine workers that make TokenOS DeAI a working DePIN
 * marketplace. Each card names a worker, a one-line description of
 * its job, and a hard number that proves it is running in
 * production.
 */
const primitives = [
  {
    name: "Auto allocator",
    description: "Watches confirmed payments every ten seconds, picks an idle node by tier and reputation, mints an SSH credential before the buyer can refresh the page.",
    metric: "<60s pay-to-prompt",
  },
  {
    name: "Per-minute meter",
    description: "Heartbeats roll into a buyer-facing cost ticker every sixty seconds. Stop early and the unused minutes return to the wallet that paid.",
    metric: "60s WebSocket cadence",
  },
  {
    name: "Reputation engine",
    description: "Daily recompute on a transparent formula. The score, tier, and the math behind both are public. There is no pay-to-rank tier.",
    metric: "60 / 25 / 15 weighting",
  },
  {
    name: "Spot preemption",
    description: "When ON_DEMAND demand spikes, SPOT rentals get a 90 second grace window and a partial refund. RESERVED tier is exempt by contract.",
    metric: "90s grace, never RESERVED",
  },
  {
    name: "Solana settlement",
    description: "USDC payouts confirm on Solana via Helius webhooks. Median end-to-end from buyer-pay to operator-credited is eleven seconds.",
    metric: "11s median settlement",
  },
  {
    name: "Carbon estimator",
    description: "Per-rental CO2 from GPU TDP times region grid intensity. Buyer dashboard surfaces grams per active rental and monthly totals.",
    metric: "per-job CO2 grams",
  },
];

export function IntegrationsSection() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

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

  return (
    <section id="integrations" ref={sectionRef} className="relative py-16 sm:py-24 lg:py-32 overflow-hidden">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Header */}
        <div
          className={`text-center max-w-3xl mx-auto mb-12 sm:mb-16 lg:mb-24 transition-all duration-700 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
          }`}
        >
          <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-4 sm:mb-6">
            <span className="w-8 h-px bg-brand" />
            Engine internals
            <span className="w-8 h-px bg-brand" />
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-6xl font-display tracking-tight mb-4 sm:mb-6">
            Six workers,
            <br />
            one rate sheet.
          </h2>
          <p className="text-base sm:text-lg lg:text-xl text-muted-foreground">
            The moving parts that keep allocations fast, prices honest, and operators accountable. Every one of them is in production today.
          </p>
        </div>

        {/* Primitives grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-foreground/15 border border-foreground/15">
          {primitives.map((p, idx) => (
            <div
              key={p.name}
              className={`relative bg-background p-6 sm:p-8 transition-all duration-500 ${
                isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
              }`}
              style={{ transitionDelay: `${idx * 75}ms` }}
            >
              <div className="flex items-baseline justify-between mb-4">
                <span className="font-mono text-xs text-muted-foreground">
                  {String(idx + 1).padStart(2, "0")}
                </span>
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-brand">
                  {p.metric}
                </span>
              </div>
              <h3 className="font-display text-xl sm:text-2xl mb-3">
                {p.name}
              </h3>
              <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
                {p.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
