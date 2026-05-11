'use client'

/**
 * M5.9 / D4: Crisp live chat widget.
 *
 * Loads only when NEXT_PUBLIC_CRISP_WEBSITE_ID is set, so dev builds
 * stay quiet and we can pull the widget by clearing the env var
 * without redeploying code.
 *
 * Portal only: the public marketplace is anonymous and chat there
 * cannot carry continuity. Internal portal pages benefit from it
 * (buyer onboarding questions, operator payout questions, etc.).
 *
 * The Crisp embed is the canonical single-line script tag from
 * https://help.crisp.chat/. We just gate it behind the env var.
 */

import Script from 'next/script'

export function CrispChat() {
  const websiteId = process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID
  if (!websiteId) return null

  return (
    <Script id="crisp-loader" strategy="afterInteractive">
      {`
        window.$crisp = [];
        window.CRISP_WEBSITE_ID = "${websiteId}";
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
