// Phase 9 Plan 2: separate Vite target for the phone UI bundle.
//
// The phone bundle is built INDEPENDENTLY of the desktop renderer:
//   - root: src/phone/   (NOT src/renderer/, which is the desktop target)
//   - outDir: ../../dist/phone  (repo-relative)
//   - target: es2020     (mobile WebView compatibility)
//   - no preload bridge, no electron dependency
//
// Build entry: src/phone/index.html. Vite bundles main.tsx + styles.css
// into dist/phone/{index.html, assets/main-<hash>.js, assets/styles-<hash>.css}.
//
// The result is served by main's `servePhoneBundle` (src/main/network/static.ts)
// at http://<bind-host>:<port>/.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '..', '..', 'dist', 'phone'),
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
});