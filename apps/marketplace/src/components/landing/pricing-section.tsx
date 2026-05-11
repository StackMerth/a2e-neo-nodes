"use client";

import { ArrowRight, Check } from "lucide-react";

const plans = [
  {
    name: "On-Demand",
    description: "Pay only for the minutes you use. Cancel anytime.",
    pricePerMin: "0.097",
    pricePerHour: "5.84",
    gpuExample: "H100",
    features: [
      "Per-minute billing, no minimums",
      "Refund unused minutes on early stop",
      "Reputation-scored operators",
      "Ephemeral SSH credentials per session",
      "Live cost meter in your dashboard",
    ],
    cta: "Start renting",
    popular: false,
  },
  {
    name: "Spot",
    description: "40% off retail. Preemptible with 90 seconds notice.",
    pricePerMin: "0.058",
    pricePerHour: "3.50",
    gpuExample: "H100",
    features: [
      "40% off the on-demand rate",
      "90 second eviction warning before preemption",
      "Refund prorated for unused minutes",
      "Optional checkpoint snapshot for restart",
      "Best fit for batch and training workloads",
    ],
    cta: "Pick spot",
    popular: true,
  },
  {
    name: "Reserved",
    description: "Commit 7, 30, or 90 days. Preemption-exempt.",
    pricePerMin: "0.087",
    pricePerHour: "5.26",
    gpuExample: "H100",
    features: [
      "10% off the on-demand rate",
      "Never preempted, capacity guaranteed",
      "Choose 7, 30, or 90 day terms",
      "Early termination uses minutes consumed",
      "Best fit for long-running production",
    ],
    cta: "Reserve",
    popular: false,
  },
];

export function PricingSection() {
  return (
    <section id="pricing" className="relative py-32 lg:py-40 border-t border-foreground/10">
      <div className="max-w-7xl mx-auto px-6 lg:px-12">
        {/* Header */}
        <div className="max-w-3xl mb-20">
          <span className="font-mono text-xs tracking-widest text-muted-foreground uppercase block mb-6">
            Pricing
          </span>
          <h2 className="font-display text-5xl md:text-6xl lg:text-7xl tracking-tight text-foreground mb-6">
            Three tiers,
            <br />
            <span className="text-stroke">one rate sheet</span>
          </h2>
          <p className="text-lg text-muted-foreground max-w-xl">
            Per-minute billing on every tier. Sample rates shown for an H100; the marketplace surfaces live per-operator pricing for every GPU class.
          </p>
        </div>

        {/* Pricing Cards */}
        <div className="grid md:grid-cols-3 gap-px bg-foreground/10">
          {plans.map((plan, idx) => (
            <div
              key={plan.name}
              className={`relative p-8 lg:p-12 bg-background ${
                plan.popular ? "md:-my-4 md:py-12 lg:py-16 border-2 border-foreground" : ""
              }`}
            >
              {plan.popular && (
                <span className="absolute -top-3 left-8 px-3 py-1 bg-foreground text-primary-foreground text-xs font-mono uppercase tracking-widest">
                  Most Popular
                </span>
              )}

              {/* Plan Header */}
              <div className="mb-8">
                <span className="font-mono text-xs text-muted-foreground">
                  {String(idx + 1).padStart(2, "0")}
                </span>
                <h3 className="font-display text-3xl text-foreground mt-2">{plan.name}</h3>
                <p className="text-sm text-muted-foreground mt-2">{plan.description}</p>
              </div>

              {/* Price */}
              <div className="mb-8 pb-8 border-b border-foreground/10">
                <div className="flex items-baseline gap-2">
                  <span className="font-display text-5xl lg:text-6xl text-foreground">
                    ${plan.pricePerMin}
                  </span>
                  <span className="text-muted-foreground font-mono text-sm">/ {plan.gpuExample} min</span>
                </div>
                <p className="text-xs text-muted-foreground font-mono mt-2">
                  ~${plan.pricePerHour}/hr at retail
                </p>
              </div>

              {/* Features */}
              <ul className="space-y-4 mb-10">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3">
                    <Check className="w-4 h-4 text-foreground mt-0.5 shrink-0" />
                    <span className="text-sm text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <button
                className={`w-full py-4 flex items-center justify-center gap-2 text-sm font-medium transition-all group ${
                  plan.popular
                    ? "bg-foreground text-primary-foreground hover:bg-foreground/90"
                    : "border border-foreground/20 text-foreground hover:border-foreground hover:bg-foreground/5"
                }`}
              >
                {plan.cta}
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
              </button>
            </div>
          ))}
        </div>

        {/* Bottom Note */}
        <p className="mt-12 text-center text-sm text-muted-foreground">
          Settlement on Solana, median 11 seconds.{" "}
          <a href="#" className="underline underline-offset-4 hover:text-foreground transition-colors">
            See live H100, H200, B200, B300, GB300 rates
          </a>
        </p>
      </div>
    </section>
  );
}
