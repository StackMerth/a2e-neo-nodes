"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Premium trust strip — bento layout with the hero tile auto-cycling
 * through every brand on a 6-second timer. Each brand carries its own
 * long-form description for the hero state; the satellite grid shows
 * whichever 9 brands are not currently in the spotlight, in the
 * canonical ordering minus the featured one.
 *
 * Pause-on-hover for the hero, click any satellite to jump straight
 * to it, pagination dots below the hero so users see where they are
 * in the rotation. Respects `prefers-reduced-motion` — if the
 * visitor opts out of motion, the rotation freezes on the first
 * brand instead of auto-advancing.
 */
interface Brand {
  name: string;
  tag: string;
  accent: string;
  // Long-form description that renders in the hero state.
  featured: string;
}

const BRANDS: Brand[] = [
  {
    name: "NVIDIA",
    tag: "Every GPU we deploy",
    accent: "#76b900",
    // 8 first-class tiers per packages/database/prisma/schema.prisma
    // (excluding OTHER + CONSUMER catchalls). RTX 3090/4090 are
    // first-class consumer tiers; L40S is mid-datacenter; H100/H200
    // are the standard datacenter pair; B200/B300/GB300 cover the
    // Blackwell family.
    featured:
      "Every GPU we deploy. RTX 3090, RTX 4090, L40S, H100, H200, B200, B300, GB300 — eight tiers, one rate sheet, every chip carrying the green badge.",
  },
  {
    name: "CUDA",
    tag: "Compute toolkit",
    accent: "#76b900",
    featured:
      "The compute toolkit your workloads target. CUDA, cuDNN, NCCL, and TensorRT all live on every node, no special build flags or proprietary glue.",
  },
  {
    name: "PyTorch",
    tag: "Framework",
    accent: "#ee4c2c",
    featured:
      "Train and serve PyTorch models without the setup tax. Latest torch with the matching CUDA toolkit, NCCL, and Triton pre-installed on every image.",
  },
  {
    name: "TensorFlow",
    tag: "Framework",
    accent: "#ff6f00",
    featured:
      "TF and Keras workloads run unchanged. GPU acceleration auto-detected via tf.config — your training script does not learn about us.",
  },
  {
    name: "HuggingFace",
    tag: "Model hub",
    accent: "#ffcc4d",
    featured:
      "Pull any model from the Hub. Transformers, Diffusers, Accelerate, and Datasets all cached on-node for fast iteration without re-downloading.",
  },
  {
    name: "vLLM",
    tag: "Inference server",
    accent: "#3b82f6",
    featured:
      "High-throughput inference server tuned for paged-attention. Bring your model weights, get OpenAI-compatible endpoints with continuous batching out of the box.",
  },
  {
    name: "Ollama",
    tag: "Local runtime",
    accent: "#a3a3a3",
    featured:
      "Local LLM runtime for the operator. Pull a model, run it, expose it — no orchestration glue required, no separate inference service to manage.",
  },
  {
    name: "Docker",
    tag: "Workload format",
    accent: "#2496ed",
    featured:
      "Workloads ship as Docker images. Standard registry, standard CUDA runtime, standard everything — nothing about the image format is platform-specific.",
  },
  {
    name: "Ubuntu",
    tag: "Node OS",
    accent: "#e95420",
    featured:
      "Every node runs Ubuntu LTS. SSH in, install your stack, treat it like a server you owned — no managed-platform abstractions in the way.",
  },
  {
    name: "GitHub",
    tag: "Open source",
    accent: "#a3a3a3",
    featured:
      "Source is on GitHub. Every worker, every payment path, every refund rule — readable before you trust it. Real code, not a pitch deck.",
  },
];

const stats = [
  { value: "10+", label: "Frameworks & tools" },
  { value: "100%", label: "NVIDIA inventory" },
  { value: "Open", label: "Source on GitHub" },
];

const ROTATE_MS = 6000;

export function BuiltOnSection() {
  const [isVisible, setIsVisible] = useState(false);
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
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

  // Auto-rotate the hero. Pause on hover so a reading user is not
  // pulled off the brand they are mid-sentence on. Skip entirely
  // when the visitor prefers reduced motion.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || isPaused) return;
    const id = window.setInterval(() => {
      setFeaturedIndex((i) => (i + 1) % BRANDS.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [isPaused]);

  const handleSelect = useCallback((idx: number) => {
    setFeaturedIndex(idx);
    setIsPaused(true);
    // Resume rotation after a short pause once the user is done
    // selecting. 8s is long enough to read the description, short
    // enough that the carousel does not feel broken.
    window.setTimeout(() => setIsPaused(false), 8000);
  }, []);

  const featured = BRANDS[featuredIndex]!;
  const satellites = BRANDS.filter((_, i) => i !== featuredIndex);

  return (
    <section
      ref={sectionRef}
      className="relative py-20 sm:py-28 lg:py-36 overflow-hidden"
    >
      {/* Subtle layered backdrop — hairline grid + corner glow */}
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
        {/* Header */}
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

        {/* Stat strip */}
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

        {/* Bento — hero is now 2×3 on lg so 9 satellites fit in a clean
            3×3 grid on the right with no empty slots. */}
        <div
          className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4"
          onMouseEnter={() => setIsPaused(true)}
          onMouseLeave={() => setIsPaused(false)}
        >
          {/* HERO TILE */}
          <HeroTile
            brand={featured}
            isVisible={isVisible}
            featuredIndex={featuredIndex}
            total={BRANDS.length}
            onJump={handleSelect}
          />

          {/* SATELLITES — 9 brands, the canonical order minus the
              featured one. Layout shifts slightly each rotation as
              one brand swaps out; CSS opacity transition keeps it
              from feeling jarring. */}
          {satellites.map((b, idx) => (
            <SatelliteTile
              key={b.name}
              brand={b}
              index={idx}
              isVisible={isVisible}
              onClick={() => {
                const targetIndex = BRANDS.findIndex((x) => x.name === b.name);
                handleSelect(targetIndex);
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function HeroTile({
  brand,
  isVisible,
  featuredIndex,
  total,
  onJump,
}: {
  brand: Brand;
  isVisible: boolean;
  featuredIndex: number;
  total: number;
  onJump: (idx: number) => void;
}) {
  return (
    <div
      className={`relative col-span-2 sm:col-span-3 lg:col-span-2 lg:row-span-3 group overflow-hidden transition-all duration-700 ${
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
      }`}
      style={{
        background: `linear-gradient(160deg, ${brand.accent}15 0%, transparent 60%), var(--background)`,
        border: "1px solid rgba(125,125,125,0.18)",
      }}
    >
      {/* Top accent bar — animates wider when this brand has just
          taken the spotlight. */}
      <div
        key={`bar-${featuredIndex}`}
        className="absolute top-0 left-0 h-1 animate-[heroBar_0.7s_ease-out_forwards]"
        style={{ background: brand.accent, width: "33%" }}
      />

      {/* Decorative die-shape marks, brand-tinted */}
      <div className="absolute top-6 right-6 flex flex-col items-end gap-1 opacity-60 transition-colors duration-500">
        <div className="w-12 h-1 rounded-full transition-colors duration-500" style={{ background: brand.accent }} />
        <div className="w-8 h-1 rounded-full transition-colors duration-500" style={{ background: `${brand.accent}80` }} />
        <div className="w-4 h-1 rounded-full transition-colors duration-500" style={{ background: `${brand.accent}40` }} />
      </div>

      {/* Inner content — keyed on the index so React remounts on
          rotation, letting the CSS fade-in animation fire fresh. */}
      <div
        key={featuredIndex}
        className="relative p-8 sm:p-10 lg:p-12 flex flex-col justify-end min-h-[200px] lg:min-h-[440px] animate-[heroFade_0.6s_ease-out]"
      >
        <div className="flex items-baseline gap-2 mb-3">
          <span
            className="text-[10px] uppercase tracking-[0.2em] font-mono"
            style={{ color: brand.accent }}
          >
            Featured · {String(featuredIndex + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
          </span>
          <span className="w-8 h-px" style={{ background: brand.accent, opacity: 0.4 }} />
        </div>
        <div className="font-display text-5xl sm:text-6xl lg:text-7xl tracking-tight leading-none mb-4">
          {brand.name}
        </div>
        <div className="text-sm sm:text-base text-muted-foreground max-w-md leading-relaxed mb-6">
          {brand.featured}
        </div>

        {/* Pagination dots — click to jump. Active dot is brand-tinted
            and slightly wider so the eye tracks position. */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {Array.from({ length: total }).map((_, i) => {
            const isActive = i === featuredIndex;
            return (
              <button
                key={i}
                type="button"
                onClick={() => onJump(i)}
                aria-label={`Show brand ${i + 1}`}
                className="h-1.5 rounded-full transition-all duration-500 hover:opacity-80"
                style={{
                  width: isActive ? 24 : 6,
                  background: isActive ? brand.accent : "rgba(125,125,125,0.35)",
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Inline keyframes — scoped to this component */}
      <style jsx>{`
        @keyframes heroBar {
          from { width: 0%; }
          to { width: 100%; }
        }
        @keyframes heroFade {
          from { opacity: 0.35; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function SatelliteTile({
  brand,
  index,
  isVisible,
  onClick,
}: {
  brand: Brand;
  index: number;
  isVisible: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative overflow-hidden transition-all duration-500 text-left ${
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
        style={{ background: brand.accent }}
      />

      {/* Brand-tinted hover wash */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
        style={{
          background: `linear-gradient(to top, ${brand.accent}0c, transparent 60%)`,
        }}
      />

      <div className="relative p-5 sm:p-6 flex flex-col h-full min-h-[110px] justify-between">
        <div className="flex items-start justify-between gap-2 mb-3">
          <span className="font-display text-xl sm:text-2xl tracking-tight transition-transform duration-300 group-hover:translate-x-0.5">
            {brand.name}
          </span>
          <span
            className="shrink-0 w-1.5 h-1.5 rounded-full mt-2 transition-transform duration-300 group-hover:scale-150"
            style={{ background: brand.accent }}
            aria-hidden
          />
        </div>
        <div className="text-[10px] sm:text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">
          {brand.tag}
        </div>
      </div>
    </button>
  );
}
