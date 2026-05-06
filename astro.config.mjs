import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://kolo.xyz',
  output: 'static',
  trailingSlash: 'never',
  build: {
    format: 'directory',
  },
  compressHTML: false,
  devToolbar: {
    enabled: false,
  },
  integrations: [
    sitemap({
      // Don't list the admin dashboard in the public sitemap.
      filter: (page) => !page.includes('/migration-status'),
      // Localised alternates so Google knows /, /ua/, /ru/ are translations of each other.
      i18n: {
        defaultLocale: 'en',
        locales: { en: 'en-US', ua: 'uk-UA', ru: 'ru-RU' },
      },
    }),
  ],
});
