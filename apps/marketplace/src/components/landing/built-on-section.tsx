"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Built-on band that sits right under the hero. Editorial trust
 * signal in place of a logo wall: every name is infrastructure the
 * platform actually depends on at runtime. Text wordmarks in the
 * display face, role tag in mono, bordered tiles matching the
 * Security section's certification chips.
 */
const rails = [
  { name: "Solana", role: "Settlement chain" },
  { name: "USDC", role: "Payout currency" },
  { name: "Helius", role: "RPC + webhooks" },
  { name: "Postgres", role: "Source of truth" },
  { name: "Vercel", role: "Frontends" },
  { name: "Render", role: "API + workers" },
  { name: "Resend", role: "Transactional mail" },
  { name: "GitHub", role: "Open source" },
];

export function BuiltOnSection() {
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
      ref={sectionRef}
      className="relative py-12 sm:py-16 lg:py-20 border-y border-foreground/10 bg-foreground/[0.015]"
    >
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="grid lg:grid-cols-[1fr_2fr] gap-8 lg:gap-16 items-start">
          {/* Left column: label + copy */}
          <div
            className={`transition-all duration-700 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
          >
            <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-3">
              <span className="w-8 h-px bg-brand" />
              Built on
            </span>
            <p className="text-sm sm:text-base text-muted-foreground max-w-sm leading-relaxed">
              The rails under the marketplace. Every name listed runs in production today, not a partnership badge wall.
            </p>
          </div>

          {/* Right column: rails grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-px bg-foreground/10 border border-foreground/10">
            {rails.map((rail, idx) => (
              <div
                key={rail.name}
                className={`bg-background p-4 sm:p-5 transition-all duration-500 ${
                  isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
                }`}
                style={{ transitionDelay: `${idx * 50 + 150}ms` }}
              >
                <div className="font-display text-lg sm:text-xl mb-1">{rail.name}</div>
                <div className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                  {rail.role}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
