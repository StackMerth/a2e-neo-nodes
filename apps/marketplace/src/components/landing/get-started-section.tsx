"use client";

import { useEffect, useRef, useState } from "react";
import { Wallet, MousePointerClick, Terminal, ArrowRight } from "lucide-react";

/*
 * 3-step "Get started" illustration. Marketing-side counterpart to
 * the deeper HowItWorksSection (which carries API + SSH code).
 *
 * Each step is a large numbered tile: 01 → 02 → 03 across desktop,
 * stacked on mobile. AITECH-style "Create Account / Deposit Funds /
 * Deploy GPU" pattern, but rewritten for the TokenOS flow
 * (wallet-first, pay-at-checkout, SSH in seconds).
 *
 * Editorial: hairline borders, oversized mono step numbers, display
 * titles, no glow, no gradient cards.
 */
interface Step {
  number: string;
  icon: typeof Wallet;
  title: string;
  body: string;
  accent: string;
}

const STEPS: Step[] = [
  {
    number: "01",
    icon: Wallet,
    title: "Connect wallet",
    body: "Phantom, Solflare, or sign up with an email and link a wallet later. Free, no on-chain transaction needed to start.",
    accent: "#22c55e",
  },
  {
    number: "02",
    icon: MousePointerClick,
    title: "Pick + pay",
    body: "Browse live inventory, click Rent on a tile, sign a single USDC transfer in your wallet. No paste, no manual confirmation step.",
    accent: "#3b82f6",
  },
  {
    number: "03",
    icon: Terminal,
    title: "SSH in",
    body: "Ephemeral SSH credentials land in your dashboard within a minute of payment. Per-minute billing starts ticking; stop anytime and get unused minutes refunded.",
    accent: "#8b5cf6",
  },
];

export function GetStartedSection() {
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
    <section
      id="get-started"
      ref={sectionRef}
      className="relative py-20 sm:py-28 lg:py-36 overflow-hidden"
    >
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Header — always visible, no opacity gate */}
        <div className="max-w-3xl mb-12 sm:mb-16">
          <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-5">
            <span className="w-8 h-px bg-brand" />
            Get started
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-6xl font-display tracking-tight leading-[0.95] mb-5">
            Three steps.
            <br />
            <span className="text-muted-foreground/60">Sub-minute to SSH.</span>
          </h2>
          <p className="text-base sm:text-lg lg:text-xl text-muted-foreground leading-relaxed max-w-2xl">
            No quota request, no calendar invite with sales, no two-week
            onboarding. From wallet to GPU prompt in the time it takes to
            brew a coffee.
          </p>
        </div>

        {/* Steps grid — 3-up on desktop with arrows between, stacked
            on mobile. Each tile carries a large step number, an icon,
            a title, and one paragraph of body. */}
        <div className="relative grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
          {STEPS.map((step, idx) => {
            const Icon = step.icon;
            const isLast = idx === STEPS.length - 1;
            return (
              <div
                key={step.number}
                className={`relative bg-background border border-foreground/15 p-6 sm:p-8 transition-all duration-500 ${
                  isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
                }`}
                style={{ transitionDelay: `${idx * 100 + 120}ms` }}
              >
                {/* Step number — oversized, accent-tinted, sits as a
                    quiet background mark in the top-right. */}
                <span
                  aria-hidden
                  className="absolute top-4 right-5 font-display text-5xl sm:text-6xl leading-none tracking-tight pointer-events-none"
                  style={{ color: step.accent, opacity: 0.18 }}
                >
                  {step.number}
                </span>

                {/* Icon */}
                <div
                  className="relative w-12 h-12 mb-6 flex items-center justify-center"
                  style={{
                    border: `1px solid ${step.accent}`,
                    color: step.accent,
                    background: `${step.accent}10`,
                  }}
                >
                  <Icon size={20} />
                </div>

                {/* Step label in mono */}
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.18em] mb-2"
                  style={{ color: step.accent }}
                >
                  Step {step.number}
                </div>

                {/* Title + body */}
                <h3 className="font-display text-2xl sm:text-3xl tracking-tight mb-3">
                  {step.title}
                </h3>
                <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
                  {step.body}
                </p>

                {/* Arrow connector between tiles, desktop only.
                    Hidden after the last tile and on mobile where the
                    tiles stack and the arrow would point at nothing. */}
                {!isLast && (
                  <div
                    aria-hidden
                    className="hidden md:flex absolute top-1/2 -right-5 -translate-y-1/2 z-10 w-10 h-10 items-center justify-center bg-background border border-foreground/15 rounded-full"
                  >
                    <ArrowRight size={14} className="text-foreground/60" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
