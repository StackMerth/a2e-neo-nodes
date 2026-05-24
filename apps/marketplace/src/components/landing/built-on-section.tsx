"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Premium trust strip — AITECH-style brand authority, but reworked
 * as a bento layout instead of a uniform grid. NVIDIA gets a hero
 * tile (the biggest substantive claim — every node is NVIDIA), the
 * other nine wordmarks ring it as refined satellite tiles. Each
 * tile has a brand-tinted accent line that slides in on hover so
 * the wordmarks feel alive without going full neon.
 *
 * Stays within the marketplace editorial palette: typography-led,
 * no glow effects, no decorative chrome. The asymmetry is the
 * premium signal, not surface decoration.
 */
interface Wordmark {
  name: string;
  tag: string;
  accent: string;
}

const HERO: Wordmark = { name: "NVIDIA", tag: "Every GPU we deploy", accent: "#76b900" };

const satellites: Wordmark[] = [
  { name: "CUDA", tag: "Compute toolkit", accent: "#76b900" },
  { name: "PyTorch", tag: "Framework", accent: "#ee4c2c" },
  { name: "TensorFlow", tag: "Framework", accent: "#ff6f00" },
  { name: "HuggingFace", tag: "Model hub", accent: "#ffcc4d" },
  { name: "vLLM", tag: "Inference server", accent: "#3b82f6" },
  { name: "Ollama", tag: "Local runtime", accent: "#a3a3a3" },
  { name: "Docker", tag: "Workload format", accent: "#2496ed" },
  { name: "Ubuntu", tag: "Node OS", accent: "#e95420" },
  { name: "GitHub", tag: "Open source", accent: "#a3a3a3" },
];

const stats = [
  { value: "10+", label: "Frameworks & tools" },
  { value: "100%", label: "NVIDIA inventory" },
  { value: "Open", label: "Source on GitHub" },
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
      className="relative py-20 sm:py-28 lg:py-36 overflow-hidden"
    >
      {/* Subtle layered backdrop — hairline grid + corner glow, both
          held back so they read as texture, not chrome. */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
            backgroundSize: "64px 64px",
            color: "var(--foreground)",
            maskImage: "radial-gradient(ellipse at center, black 35%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse at center, black 35%, transparent 75%)",
          }}
        />
      </div>

      <div className="relative max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Header — refined typography, eyebrow + display headline +
            stat band. The headline is what carries the section. */}
        <div
          className={`max-w-3xl mb-12 sm:mb-16 transition-all duration-700 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
          }`}
        >
          <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-5">
            <span className="w-8 h-px bg-brand" />
            The stack you already run
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-6xl font-display tracking-tight leading-[0.95] mb-5">
            Bring your tools.
            <br />
            <span className="text-muted-foreground/60">Run them on real silicon.</span>
          </h2>
          <p className="text-base sm:text-lg lg:text-xl text-muted-foreground leading-relaxed max-w-2xl">
            Every node is NVIDIA hardware. Every CUDA, PyTorch, TensorFlow, HuggingFace, vLLM, or Ollama workload runs the way it would on a server you owned.
          </p>
        </div>

        {/* Stat strip — three numbers that frame the bento below. */}
        <div
          className={`grid grid-cols-3 max-w-2xl mb-10 sm:mb-14 transition-all duration-700 delay-100 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          {stats.map((s, idx) => (
            <div
              key={s.label}
              className="px-4"
              style={
                idx === 0
                  ? { borderRight: "1px solid rgba(125,125,125,0.18)" }
                  : idx === stats.length - 1
                  ? { borderLeft: "1px solid rgba(125,125,125,0.18)" }
                  : { borderRight: "1px solid rgba(125,125,125,0.18)" }
              }
            >
              <div className="text-2xl sm:text-3xl font-display tabular-nums leading-none mb-1">
                {s.value}
              </div>
              <div className="text-[10px] sm:text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">
                {s.label}
              </div>
            </div>
          ))}
        </div>

        {/* Bento — hero NVIDIA tile on the left (spans 2 cols + 2 rows
            on lg), 9 satellite wordmarks ringing it. On mobile,
            hero stacks on top + satellites form a 2-col grid below. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
          {/* HERO TILE */}
          <HeroTile wordmark={HERO} isVisible={isVisible} />

          {/* SATELLITE TILES */}
          {satellites.map((w, idx) => (
            <SatelliteTile key={w.name} wordmark={w} index={idx} isVisible={isVisible} />
          ))}
        </div>

        {/* Footnote — owns the honest-claim line so the section
            doesn't read as partnership theater. */}
        <p
          className={`mt-8 sm:mt-10 text-xs font-mono text-muted-foreground/70 transition-opacity duration-700 delay-500 ${
            isVisible ? "opacity-100" : "opacity-0"
          }`}
        >
          We do not represent these projects. They run on top of compute we rent. Every name above is something a real workload on the platform actually uses.
        </p>
      </div>
    </section>
  );
}

function HeroTile({ wordmark, isVisible }: { wordmark: Wordmark; isVisible: boolean }) {
  return (
    <div
      className={`relative col-span-2 sm:col-span-3 lg:col-span-2 lg:row-span-2 group overflow-hidden transition-all duration-700 ${
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
      }`}
      style={{
        background: `linear-gradient(160deg, ${wordmark.accent}15 0%, transparent 60%), var(--background)`,
        border: "1px solid rgba(125,125,125,0.18)",
      }}
    >
      {/* Subtle brand-tinted corner accent — sharp angular bar, not a glow */}
      <div
        className="absolute top-0 left-0 h-1 transition-all duration-500 group-hover:w-full"
        style={{ background: wordmark.accent, width: "33%" }}
      />

      {/* Geometric mark — a stylized rectangle that nods to silicon
          die shapes without rendering a literal logo. Sits in the
          top-right as a quiet decorative element. */}
      <div className="absolute top-6 right-6 flex flex-col items-end gap-1 opacity-60">
        <div className="w-12 h-1 rounded-full" style={{ background: wordmark.accent }} />
        <div className="w-8 h-1 rounded-full" style={{ background: `${wordmark.accent}80` }} />
        <div className="w-4 h-1 rounded-full" style={{ background: `${wordmark.accent}40` }} />
      </div>

      <div className="relative p-8 sm:p-10 lg:p-12 flex flex-col justify-end min-h-[200px] lg:min-h-[320px]">
        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-[10px] uppercase tracking-[0.2em] font-mono" style={{ color: wordmark.accent }}>
            Featured
          </span>
          <span className="w-8 h-px" style={{ background: wordmark.accent, opacity: 0.4 }} />
        </div>
        <div className="font-display text-5xl sm:text-6xl lg:text-7xl tracking-tight leading-none mb-3">
          {wordmark.name}
        </div>
        <div className="text-sm sm:text-base text-muted-foreground max-w-sm leading-relaxed">
          {wordmark.tag}. H100, H200, L40S, and the Blackwell B-series — every chip in inventory carries the green badge.
        </div>
      </div>
    </div>
  );
}

function SatelliteTile({ wordmark, index, isVisible }: { wordmark: Wordmark; index: number; isVisible: boolean }) {
  return (
    <div
      className={`group relative overflow-hidden transition-all duration-500 ${
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
      }`}
      style={{
        background: "var(--background)",
        border: "1px solid rgba(125,125,125,0.18)",
        transitionDelay: `${index * 50 + 150}ms`,
      }}
    >
      {/* Brand-accent bottom line, animates in on hover */}
      <div
        className="absolute bottom-0 left-0 h-[2px] w-0 transition-all duration-500 group-hover:w-full"
        style={{ background: wordmark.accent }}
      />

      {/* Brand-tinted hover wash — held very subtle */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
        style={{
          background: `linear-gradient(to top, ${wordmark.accent}0c, transparent 60%)`,
        }}
      />

      <div className="relative p-5 sm:p-6 flex flex-col h-full min-h-[110px] justify-between">
        <div className="flex items-start justify-between gap-2 mb-3">
          <span
            className="font-display text-xl sm:text-2xl tracking-tight transition-transform duration-300 group-hover:translate-x-0.5"
          >
            {wordmark.name}
          </span>
          <span
            className="shrink-0 w-1.5 h-1.5 rounded-full mt-2 transition-transform duration-300 group-hover:scale-150"
            style={{ background: wordmark.accent }}
            aria-hidden
          />
        </div>
        <div className="text-[10px] sm:text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">
          {wordmark.tag}
        </div>
      </div>
    </div>
  );
}
