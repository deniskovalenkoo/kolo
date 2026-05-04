import { defineConfig } from 'astro/config';

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
});
