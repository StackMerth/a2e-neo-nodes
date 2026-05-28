"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight, ExternalLink } from "lucide-react";
import { AnimatedTetrahedron } from "./animated-tetrahedron";
import { portalUrls } from "@/lib/portal-urls";

export function CtaSection() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.2 }
    );

    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMousePosition({
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    });
  };

  return (
    <section ref={sectionRef} className="relative py-16 sm:py-24 lg:py-32 overflow-hidden">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div
          className={`relative border border-foreground transition-all duration-1000 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
          }`}
          onMouseMove={handleMouseMove}
        >
          {/* Spotlight effect */}
          <div
            className="absolute inset-0 opacity-10 pointer-events-none transition-opacity duration-300"
            style={{
              background: `radial-gradient(600px circle at ${mousePosition.x}% ${mousePosition.y}%, rgba(0,0,0,0.15), transparent 40%)`
            }}
          />

          <div className="relative z-10 px-6 sm:px-8 lg:px-16 py-12 sm:py-16 lg:py-24">
            <div className="flex flex-col lg:flex-row items-center justify-between gap-8 sm:gap-12">
              {/* Left content */}
              <div className="flex-1">
                <h2 className="text-3xl sm:text-4xl lg:text-7xl font-display tracking-tight mb-6 sm:mb-8 leading-[0.95]">
                  Pick a GPU,
                  <br />
                  pay by the minute.
                </h2>

                <p className="text-lg sm:text-xl text-muted-foreground mb-8 sm:mb-12 leading-relaxed max-w-xl">
                  Sixty seconds from payment to an SSH prompt. Refunds for unused minutes. No tickets.
                </p>

                <div className="flex flex-col sm:flex-row items-start gap-4">
                  <Button
                    asChild
                    size="lg"
                    className="bg-brand hover:bg-brand/90 text-background px-6 sm:px-8 h-12 sm:h-14 text-sm sm:text-base rounded-full group"
                  >
                    <a href={portalUrls.signup}>
                      Start renting
                      <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
                    </a>
                  </Button>
                  <Button
                    asChild
                    size="lg"
                    variant="outline"
                    className="h-12 sm:h-14 px-6 sm:px-8 text-sm sm:text-base rounded-full border-foreground/40 hover:bg-foreground/5 hover:border-foreground/60 group"
                  >
                    <a href={portalUrls.spec} target="_blank" rel="noreferrer">
                      Read the spec
                      <ExternalLink className="w-4 h-4 ml-2 opacity-70 transition-opacity group-hover:opacity-100" />
                    </a>
                  </Button>
                </div>

                <p className="text-sm text-muted-foreground mt-8 font-mono">
                  Pay with USDC on Solana or card. No subscription, no minimum.
                </p>
              </div>

              {/* Right animation */}
              <div className="hidden lg:flex items-center justify-center w-[500px] h-[500px] -mr-16">
                <AnimatedTetrahedron />
              </div>
            </div>
          </div>

          {/* Decorative corner */}
          <div className="absolute top-0 right-0 w-32 h-32 border-b border-l border-foreground/10" />
          <div className="absolute bottom-0 left-0 w-32 h-32 border-t border-r border-foreground/10" />
        </div>
      </div>
    </section>
  );
}
