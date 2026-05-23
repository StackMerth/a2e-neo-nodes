"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Trust band that sits under the hero. AITECH-style "real brands"
 * pattern, but every wordmark is something the platform actually
 * deploys (NVIDIA hardware) or that buyers actually run on top of
 * the rented compute (CUDA, PyTorch, vLLM, HuggingFace, Docker,
 * Ubuntu). No partnership theater, no payment-rail laundry list.
 *
 * Text wordmarks in the display face, brand-tinted accent in mono
 * so each tile reads at a glance but stays within the editorial
 * palette — no SVG logo wall, no licensed marks.
 */
interface Wordmark {
  name: string;
  // Short tag visible under each name — what the brand IS, in one
  // mono line so the eye flows past it but a hovering reader gets
  // the context. Kept under 22 chars.
  tag: string;
  // Subtle brand accent applied as a small color dot before the
  // wordmark. Optional — falls back to the default brand color.
  accent?: string;
}

const wordmarks: Wordmark[] = [
  { name: "NVIDIA", tag: "Every GPU we deploy", accent: "#76b900" },
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
      className="relative py-14 sm:py-20 lg:py-24 border-y border-foreground/10 bg-foreground/[0.015]"
    >
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div
          className={`text-center max-w-3xl mx-auto mb-10 sm:mb-14 transition-all duration-700 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-4">
            <span className="w-8 h-px bg-brand" />
            Built for the stack you already run
            <span className="w-8 h-px bg-brand" />
          </span>
          <p className="text-base sm:text-lg text-muted-foreground leading-relaxed">
            Every node is NVIDIA hardware. Bring your CUDA, PyTorch, TensorFlow, HuggingFace, vLLM or Ollama workload and run it the way you already do.
          </p>
        </div>

        {/* 2-up on phones, 5-up from sm, single hairline grid with no
            inner border lines so the wordmarks float on the canvas. */}
        <div
          className={`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-px bg-foreground/10 border border-foreground/10 transition-opacity duration-700 ${
            isVisible ? "opacity-100" : "opacity-0"
          }`}
        >
          {wordmarks.map((w, idx) => (
            <div
              key={w.name}
              className={`group bg-background px-4 sm:px-6 py-6 sm:py-7 flex flex-col items-center justify-center text-center transition-all duration-500 ${
                isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
              }`}
              style={{ transitionDelay: `${idx * 40 + 100}ms` }}
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="w-1.5 h-1.5 rounded-full transition-transform duration-300 group-hover:scale-150"
                  style={{ background: w.accent ?? "currentColor" }}
                  aria-hidden
                />
                <span className="font-display text-xl sm:text-2xl tracking-tight">
                  {w.name}
                </span>
              </div>
              <span className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                {w.tag}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
