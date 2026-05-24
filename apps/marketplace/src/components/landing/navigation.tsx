"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import { portalUrls } from "@/lib/portal-urls";
import { ThemeToggle } from "@/components/theme-toggle";

// Public-facing nav surfaces, all reachable without an account.
// "Rent" used to be a separate route showing the tier-tile grid; it
// got consolidated into /marketplace alongside the operator catalog
// per UX feedback, and the old /rent route now redirects to here.
const navLinks: Array<{ name: string; href: string; external?: boolean }> = [
  { name: "Marketplace", href: "/marketplace" },
  { name: "Operators", href: "/leaderboard" },
  { name: "Stats", href: "/stats" },
  { name: "Pricing", href: "/#pricing" },
];

// Decide if a nav link is "active" for the current route. Exact-match
// for everything except the home-anchor link (/#pricing) where we
// only care that we are on / and the user has the pricing hash open.
function isLinkActive(linkHref: string, pathname: string | null): boolean {
  if (!pathname) return false;
  if (linkHref.startsWith("/#")) return false; // anchor-only; never permanently active
  // Exact match for the root, prefix-match for nested routes
  if (linkHref === "/") return pathname === "/";
  return pathname === linkHref || pathname.startsWith(linkHref + "/");
}

export function Navigation() {
  const pathname = usePathname();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  // Defer the mobile menu icon to client-only. Lucide's Menu/X icons
  // use SVG <line>/<path> children that have occasionally tripped
  // React 18 hydration in this app. Server renders an empty button,
  // client fills it in post-mount. Visually identical because the
  // button is md:hidden on desktop anyway.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header
      className={`fixed z-50 transition-all duration-500 ${
        isScrolled 
          ? "top-4 left-4 right-4" 
          : "top-0 left-0 right-0"
      }`}
    >
      <nav
        className={`mx-auto transition-all duration-500 bg-background/85 backdrop-blur-xl border border-foreground/10 shadow-lg ${
          isScrolled || isMobileMenuOpen
            ? "rounded-2xl max-w-[1200px]"
            : "rounded-none max-w-[1400px]"
        }`}
      >
        <div
          className={`flex items-center justify-between transition-all duration-500 px-6 lg:px-8 ${
            isScrolled ? "h-14" : "h-20"
          }`}
        >
          {/* Logo (always routes home). Two-tone wordmark to echo the
              old TokenOS_COMPUTE site: base name in foreground, suffix
              in brand green. */}
          <a href="/" className="flex items-center gap-2 group">
            <span className={`font-display tracking-tight transition-all duration-500 ${isScrolled ? "text-lg" : "text-xl"}`}>
              <span>TokenOS</span>
              <span className="text-brand">_DeAI</span>
            </span>
          </a>

          {/* Desktop Navigation. gap-12 tightens to gap-8 from md to lg
              so 5 items fit comfortably. external links get
              target=_blank so docs open in a new tab. */}
          <div className="hidden md:flex items-center gap-8 lg:gap-10">
            {navLinks.map((link) => {
              const active = isLinkActive(link.href, pathname);
              return (
                <a
                  key={link.name}
                  href={link.href}
                  target={link.external ? "_blank" : undefined}
                  rel={link.external ? "noreferrer" : undefined}
                  // Active links get full-opacity text; inactive get
                  // the muted /70 treatment and brighten on hover.
                  className={`text-sm transition-colors duration-300 relative group ${
                    active ? "text-foreground" : "text-foreground/70 hover:text-foreground"
                  }`}
                  aria-current={active ? "page" : undefined}
                >
                  {link.name}
                  {/* Underline: full-width + persistent when active,
                      grows from 0 -> 100% on hover when inactive. */}
                  <span
                    className={`absolute -bottom-1 left-0 h-px bg-foreground transition-all duration-300 ${
                      active ? "w-full" : "w-0 group-hover:w-full"
                    }`}
                  />
                </a>
              );
            })}
          </div>

          {/* Desktop CTA */}
          <div className="hidden md:flex items-center gap-4">
            <ThemeToggle />
            <a href={portalUrls.login} className={`text-foreground/70 hover:text-foreground transition-all duration-500 ${isScrolled ? "text-xs" : "text-sm"}`}>
              Sign in
            </a>
            <Button
              asChild
              size="sm"
              className={`bg-brand hover:bg-brand/90 text-background rounded-full transition-all duration-500 ${isScrolled ? "px-4 h-8 text-xs" : "px-6"}`}
            >
              <a href={portalUrls.signup}>Start renting</a>
            </Button>
          </div>

          {/* Mobile controls: theme toggle + menu button grouped so
              justify-between only sees two children on mobile (logo
              on the left, this cluster on the right). */}
          <div className="md:hidden flex items-center gap-1">
            <ThemeToggle />
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="p-2"
              aria-label="Toggle menu"
              suppressHydrationWarning
            >
              {mounted && (isMobileMenuOpen ? (
                <X className="w-6 h-6" />
              ) : (
                <Menu className="w-6 h-6" />
              ))}
            </button>
          </div>
        </div>

      </nav>
      
      {/* Mobile Menu - Full Screen Overlay */}
      <div
        className={`md:hidden fixed inset-0 bg-background z-40 transition-all duration-500 ${
          isMobileMenuOpen 
            ? "opacity-100 pointer-events-auto" 
            : "opacity-0 pointer-events-none"
        }`}
        style={{ top: 0 }}
      >
        <div className="flex flex-col h-full px-8 pt-28 pb-8">
          {/* Navigation Links */}
          <div className="flex-1 flex flex-col justify-center gap-8">
            {navLinks.map((link, i) => (
              <a
                key={link.name}
                href={link.href}
                target={link.external ? "_blank" : undefined}
                rel={link.external ? "noreferrer" : undefined}
                onClick={() => setIsMobileMenuOpen(false)}
                className={`text-5xl font-display text-foreground hover:text-muted-foreground transition-all duration-500 ${
                  isMobileMenuOpen
                    ? "opacity-100 translate-y-0"
                    : "opacity-0 translate-y-4"
                }`}
                style={{ transitionDelay: isMobileMenuOpen ? `${i * 75}ms` : "0ms" }}
              >
                {link.name}
              </a>
            ))}
          </div>
          
          {/* Bottom CTAs */}
          <div className={`flex gap-4 pt-8 border-t border-foreground/10 transition-all duration-500 ${
            isMobileMenuOpen 
              ? "opacity-100 translate-y-0" 
              : "opacity-0 translate-y-4"
          }`}
          style={{ transitionDelay: isMobileMenuOpen ? "300ms" : "0ms" }}
          >
            <Button
              asChild
              variant="outline"
              className="flex-1 rounded-full h-14 text-base"
            >
              <a href={portalUrls.login} onClick={() => setIsMobileMenuOpen(false)}>Sign in</a>
            </Button>
            <Button
              asChild
              className="flex-1 bg-brand text-background rounded-full h-14 text-base"
            >
              <a href={portalUrls.signup} onClick={() => setIsMobileMenuOpen(false)}>Start renting</a>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
