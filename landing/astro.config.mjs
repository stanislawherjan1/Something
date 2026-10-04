import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://something.md',
  // No dev overlay: it would show up in the README art rendered from the dev server.
  devToolbar: { enabled: false },
});
