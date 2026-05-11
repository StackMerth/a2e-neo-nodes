"use client";

import { useEffect, useState } from "react";

/*
 * The section reuses the original "testimonials" carousel structure but
 * presents A2E's operating principles instead of quotes from real customers.
 * Until real operators and buyers publish quotes we can attribute to them,
 * we surface the design tenets that drive the platform. Each "quote" is a
 * literal commitment the codebase enforces.
 */
const principles = [
  {
    quote: "Pay only for the minutes you used. Refund the rest.",
    author: "Operating principle",
    role: "A2E Network",
    company: "Per-minute meter",
    metric: "/min billing precision",
  },
  {
    quote: "Reputation is earned through uptime and ratings. It cannot be bought.",
    author: "Operating principle",
    role: "A2E Network",
    company: "Reputation scorer",
    metric: "60% uptime, 25% ratings, 15% volume",
  },
  {
    quote: "Every spot rental receives 90 seconds notice before preemption. No exceptions.",
    author: "Operating principle",
    role: "A2E Network",
    company: "Spot preemption worker",
    metric: "90s grace window",
  },
  {
    quote: "Buyers SSH in under sixty seconds from payment. No tickets, no approvals on small rentals.",
    author: "Operating principle",
    role: "A2E Network",
    company: "Auto allocator",
    metric: "<60s pay-to-prompt",
  },
];

export function TestimonialsSection() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsAnimating(true);
      setTimeout(() => {
        setActiveIndex((prev) => (prev + 1) % principles.length);
        setIsAnimating(false);
      }, 300);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const active = principles[activeIndex];

  return (
    <section className="relative py-32 lg:py-40 border-t border-foreground/10 lg:pb-14">
      <div className="max-w-7xl mx-auto px-6 lg:px-12">
        {/* Section Label */}
        <div className="flex items-center gap-4 mb-16">
          <span className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            How we operate
          </span>
          <div className="flex-1 h-px bg-foreground/10" />
          <span className="font-mono text-xs text-muted-foreground">
            {String(activeIndex + 1).padStart(2, "0")} / {String(principles.length).padStart(2, "0")}
          </span>
        </div>

        {/* Main Quote */}
        <div className="grid lg:grid-cols-12 gap-12 lg:gap-20">
          <div className="lg:col-span-8">
            <blockquote
              className={`transition-all duration-300 ${
                isAnimating ? "opacity-0 translate-y-4" : "opacity-100 translate-y-0"
              }`}
            >
              <p className="font-display text-4xl md:text-5xl lg:text-6xl leading-[1.1] tracking-tight text-foreground">
                &ldquo;{active.quote}&rdquo;
              </p>
            </blockquote>

            {/* Author */}
            <div
              className={`mt-12 flex items-center gap-6 transition-all duration-300 delay-100 ${
                isAnimating ? "opacity-0" : "opacity-100"
              }`}
            >
              <div className="w-16 h-16 rounded-full bg-foreground/5 border border-foreground/10 flex items-center justify-center">
                <span className="font-display text-2xl text-foreground">
                  {active.author.charAt(0)}
                </span>
              </div>
              <div>
                <p className="text-lg font-medium text-foreground">{active.author}</p>
                <p className="text-muted-foreground">
                  {active.role}, {active.company}
                </p>
              </div>
            </div>
          </div>

          {/* Metric Highlight */}
          <div className="lg:col-span-4 flex flex-col justify-center">
            <div
              className={`p-8 border border-foreground/10 transition-all duration-300 ${
                isAnimating ? "opacity-0 scale-95" : "opacity-100 scale-100"
              }`}
            >
              <span className="font-mono text-xs tracking-widest text-muted-foreground uppercase block mb-4">
                What it means
              </span>
              <p className="font-display text-3xl md:text-4xl text-foreground">
                {active.metric}
              </p>
            </div>

            {/* Navigation Dots */}
            <div className="flex gap-2 mt-8">
              {principles.map((_, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setIsAnimating(true);
                    setTimeout(() => {
                      setActiveIndex(idx);
                      setIsAnimating(false);
                    }, 300);
                  }}
                  className={`h-2 transition-all duration-300 ${
                    idx === activeIndex
                      ? "w-8 bg-foreground"
                      : "w-2 bg-foreground/20 hover:bg-foreground/40"
                  }`}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Tech Stack Marquee Label */}
        <div className="mt-24 pt-12 border-t border-foreground/10">
          <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase mb-8 text-center">
            Built on
          </p>
        </div>
      </div>

      {/* Full-width marquee outside container */}
      <div className="w-full">
        <div className="flex gap-16 items-center marquee">
          {[...Array(2)].map((_, setIdx) => (
            <div key={setIdx} className="flex gap-16 items-center shrink-0">
              {["Solana", "Postgres", "Redis", "BullMQ", "Helius", "WireGuard", "Docker", "Render", "Vercel"].map(
                (tech) => (
                  <span
                    key={`${setIdx}-${tech}`}
                    className="font-display text-xl md:text-2xl text-foreground/30 whitespace-nowrap hover:text-foreground transition-colors duration-300"
                  >
                    {tech}
                  </span>
                )
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
