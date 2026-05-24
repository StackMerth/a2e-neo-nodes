"use client";

import { useEffect, useState, useRef } from "react";

const regions = [
  { city: "US West", region: "Oregon, California", latency: "active" },
  { city: "US East", region: "Virginia, New York", latency: "active" },
  { city: "Europe", region: "Frankfurt, Amsterdam", latency: "active" },
  { city: "Asia Pacific", region: "Singapore, Tokyo", latency: "active" },
  { city: "South America", region: "Sao Paulo", latency: "coming" },
  { city: "Oceania", region: "Sydney", latency: "coming" },
];

export function InfrastructureSection() {
  const [isVisible, setIsVisible] = useState(false);
  const [activeRegion, setActiveRegion] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.1 }
    );

    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveRegion((prev) => (prev + 1) % regions.length);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section ref={sectionRef} className="relative py-16 sm:py-24 lg:py-32 overflow-hidden">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="grid lg:grid-cols-2 gap-10 sm:gap-16 lg:gap-24 items-center">
          {/* Left: Content */}
          <div
            className={`transition-all duration-700 ${
              isVisible ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-8"
            }`}
          >
            <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-6">
              <span className="w-8 h-px bg-foreground/30" />
              Inventory
            </span>
            <h2 className="text-3xl sm:text-4xl lg:text-6xl font-display tracking-tight mb-6 sm:mb-8">
              Real machines,
              <br />
              real operators.
            </h2>
            <p className="text-xl text-muted-foreground leading-relaxed mb-12">
              Inventory is contributed by independent node operators. Each one carries a reputation score derived from uptime, ratings, and completed jobs. You can read the formula. You can read the source.
            </p>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-8">
              <div>
                <div className="text-4xl lg:text-5xl font-display mb-2">8+</div>
                <div className="text-sm text-muted-foreground">GPU tiers supported</div>
              </div>
              <div>
                <div className="text-4xl lg:text-5xl font-display mb-2">4</div>
                <div className="text-sm text-muted-foreground">Reputation tiers</div>
              </div>
              <div>
                <div className="text-4xl lg:text-5xl font-display mb-2">3</div>
                <div className="text-sm text-muted-foreground">Pricing tiers</div>
              </div>
            </div>
          </div>

          {/* Right: Location list */}
          <div
            className={`transition-all duration-700 delay-200 ${
              isVisible ? "opacity-100 translate-x-0" : "opacity-0 translate-x-8"
            }`}
          >
            <div className="border border-foreground/10">
              {/* Header */}
              <div className="px-6 py-4 border-b border-foreground/10 flex items-center justify-between">
                <span className="text-sm font-mono text-muted-foreground">Operator regions</span>
                <span className="flex items-center gap-2 text-xs font-mono text-foreground/60">
                  <span className="w-2 h-2 rounded-full bg-foreground/40 animate-pulse" />
                  Live inventory
                </span>
              </div>

              {/* Regions */}
              <div>
                {regions.map((region, index) => (
                  <div
                    key={region.city}
                    className={`px-6 py-5 border-b border-foreground/5 last:border-b-0 flex items-center justify-between transition-all duration-300 ${
                      activeRegion === index ? "bg-foreground/[0.02]" : ""
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <span
                        className={`w-2 h-2 rounded-full transition-colors duration-300 ${
                          activeRegion === index ? "bg-foreground" : "bg-foreground/20"
                        }`}
                      />
                      <div>
                        <div className="font-medium">{region.city}</div>
                        <div className="text-sm text-muted-foreground">{region.region}</div>
                      </div>
                    </div>
                    <span className="font-mono text-sm text-muted-foreground">{region.latency}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
