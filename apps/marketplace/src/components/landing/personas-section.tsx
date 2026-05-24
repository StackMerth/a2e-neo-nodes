"use client";

import { useEffect, useRef, useState } from "react";
import { Beaker, Code2, Building2, Rocket, Sparkles, Cpu } from "lucide-react";

/*
 * Built-for ICP grid — who actually uses the platform and what they
 * get out of it. AITECH-style six-persona block, but written for
 * TokenOS-aligned audiences (Web3 studios, DePIN builders) instead
 * of the generic SaaS-y "Sales / Marketing / HR" cuts.
 *
 * Editorial style: cream/ink, hairline border grid, mono labels,
 * display body. Each tile is a thin profile, not a marketing card —
 * one short hook per persona, no checkmarks or feature lists.
 */
interface Persona {
  icon: typeof Beaker;
  name: string;
  hook: string;
  detail: string;
}

const PERSONAS: Persona[] = [
  {
    icon: Beaker,
    name: "Research teams",
    hook: "Burst training without an AWS bill",
    detail: "Spin up 8x H100 for a weekend of fine-tunes, kill the job, pay for the minutes you used. No quota requests, no reservations, no calendar invite with a sales rep.",
  },
  {
    icon: Code2,
    name: "Solo developers",
    hook: "A real GPU at indie prices",
    detail: "RTX 4090 or L40S for less than the cost of a model API call. Ship the side project, learn the stack, keep your weekend.",
  },
  {
    icon: Sparkles,
    name: "Generative AI studios",
    hook: "Image, video, audio at minute-level cost",
    detail: "Stable Diffusion XL, Flux, Suno-style audio, video diffusion — all run on the same SSH-accessible boxes you'd rent from a hyperscaler, except you get billed per minute and refunded on early stop.",
  },
  {
    icon: Building2,
    name: "Enterprise ML teams",
    hook: "Reserved capacity without the contract",
    detail: "Lock in 7, 30, or 90 days on RESERVED tier. Get the price discount, get the preemption-exempt guarantee, skip the procurement process. Solana settlement and on-chain receipts replace the PO chase.",
  },
  {
    icon: Rocket,
    name: "AI startups",
    hook: "From experiment to production on one bill",
    detail: "Spot tier for batch training, reserved for serving, on-demand for the random Tuesday spike. One rate sheet, one cost meter, one settlement chain — no four-cloud invoice reconciliation at month-end.",
  },
  {
    icon: Cpu,
    name: "Web3 + DePIN builders",
    hook: "Crypto-native infrastructure with the receipts to prove it",
    detail: "Wallet sign-to-pay, USDC settlement, every operator carrying a public reputation score. Verifiable from the chain, no centralized invoice flow, fits naturally inside a token-driven product stack.",
  },
];

export function PersonasSection() {
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
      id="who-its-for"
      ref={sectionRef}
      className="relative py-20 sm:py-28 lg:py-36 overflow-hidden"
    >
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Header — heading area always visible (no opacity gate)
            so the section is identifiable even if the IntersectionObserver
            never fires (e.g. an aggressive privacy extension blocks it). */}
        <div className="max-w-3xl mb-12 sm:mb-16">
          <span className="inline-flex items-center gap-3 text-xs font-mono uppercase tracking-[0.18em] text-muted-foreground mb-5">
            <span className="w-8 h-px bg-brand" />
            Built for
          </span>
          <h2 className="text-5xl sm:text-6xl lg:text-7xl font-display tracking-tight leading-[0.95] mb-6 text-foreground">
            Who it&apos;s for.
          </h2>
          <p className="text-base sm:text-lg lg:text-xl text-muted-foreground leading-relaxed max-w-2xl">
            Six audiences, <span className="text-brand">one rate sheet.</span>{" "}
            Whether you&apos;re fine-tuning on a Saturday or running production
            inference behind an enterprise SLA, the same per-minute meter and
            the same SSH access path serve you both.
          </p>
        </div>

        {/* Personas grid — 2-up on tablet, 3-up on desktop, single
            hairline grid so the tiles read as a unified block rather
            than as marketing cards. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-foreground/10 border border-foreground/10">
          {PERSONAS.map((p, idx) => {
            const Icon = p.icon;
            return (
              <div
                key={p.name}
                className={`group relative bg-background p-6 sm:p-8 transition-all duration-500 ${
                  isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
                }`}
                style={{ transitionDelay: `${idx * 60 + 120}ms` }}
              >
                {/* Index marker top-right */}
                <span className="absolute top-6 right-6 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
                  {String(idx + 1).padStart(2, "0")}
                </span>

                {/* Icon */}
                <div
                  className="w-10 h-10 mb-5 flex items-center justify-center transition-colors duration-300"
                  style={{
                    border: "1px solid var(--foreground)",
                    color: "var(--foreground)",
                    opacity: 0.85,
                  }}
                >
                  <Icon size={18} />
                </div>

                {/* Persona name + hook */}
                <h3 className="font-display text-xl sm:text-2xl tracking-tight mb-2">
                  {p.name}
                </h3>
                <p
                  className="font-mono text-[11px] uppercase tracking-[0.14em] mb-4"
                  style={{ color: "var(--brand)" }}
                >
                  {p.hook}
                </p>

                {/* Detail */}
                <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
                  {p.detail}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
