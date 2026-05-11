'use client'

/**
 * M5.9 / D4: live chat widget loader.
 *
 * Vendor-neutral. Picks the first vendor whose env var is set, so you
 * can swap providers without touching code:
 *
 *   NEXT_PUBLIC_TAWK_PROPERTY_ID + NEXT_PUBLIC_TAWK_WIDGET_ID
 *     -> Tawk.to (recommended: free forever, easy workspace setup)
 *
 *   NEXT_PUBLIC_CRISP_WEBSITE_ID
 *     -> Crisp.chat (fallback if Tawk is set up later)
 *
 * Both env vars unset -> widget is dormant, component renders nothing.
 *
 * Portal only. The public marketplace is anonymous and chat there
 * cannot carry continuity.
 *
 * If you want to add a third vendor (Intercom, Plain, Chatwoot) just
 * add another `if` branch with its embed snippet and an env-var check.
 * The component contract stays the same: render nothing or render one
 * `<Script>` that injects the vendor loader.
 */

import Script from 'next/script'

export function CrispChat() {
  const tawkProperty = process.env.NEXT_PUBLIC_TAWK_PROPERTY_ID
  const tawkWidget = process.env.NEXT_PUBLIC_TAWK_WIDGET_ID
  const crispId = process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID

  // Prefer Tawk when both property and widget are set, since that is
  // the recommended vendor. Fall back to Crisp if only Crisp is set.
  if (tawkProperty && tawkWidget) {
    return (
      <Script id="tawk-loader" strategy="afterInteractive">
        {`
          var Tawk_API = Tawk_API || {};
          var Tawk_LoadStart = new Date();
          (function() {
            var s1 = document.createElement("script");
            var s0 = document.getElementsByTagName("script")[0];
            s1.async = true;
            s1.src = "https://embed.tawk.to/${tawkProperty}/${tawkWidget}";
            s1.charset = "UTF-8";
            s1.setAttribute("crossorigin", "*");
            s0.parentNode.insertBefore(s1, s0);
          })();
        `}
      </Script>
    )
  }

  if (crispId) {
    return (
      <Script id="crisp-loader" strategy="afterInteractive">
        {`
          window.$crisp = [];
          window.CRISP_WEBSITE_ID = "${crispId}";
          (function() {
            var d = document;
            var s = d.createElement("script");
            s.src = "https://client.crisp.chat/l.js";
            s.async = 1;
            d.getElementsByTagName("head")[0].appendChild(s);
          })();
        `}
      </Script>
    )
  }

  return null
}
