/*
 * M5.4: robots policy. Allow everything indexable except API responses
 * proxied through Next, and point crawlers at the sitemap.
 */
import type { MetadataRoute } from 'next'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://marketplace.stackforgelab.tech'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
