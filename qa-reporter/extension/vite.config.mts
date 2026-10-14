import { build, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

/**
 * QA Reporter – Vite build for a Chrome Extension (Manifest V3).
 *
 * Documented Chrome API / build decisions:
 * 1. MV3 forbids remote code and enforces a strict CSP (`script-src 'self'`),
 *    so everything is bundled locally — no CDN imports, no eval, no dev-only
 *    HMR runtime in the production output.
 * 2. Chrome expects concrete, stable file paths for the service worker and
 *    content scripts. We therefore build three named entry points:
 *      - popup/popup.html -> React popup launcher
 *      - editor/editor.html -> React editor tab (opened after a capture)
 *      - src/background/index.js -> service worker (ES module; it may import
 *        chunks shared with the pages, so it stays at its emitted path
 *        instead of being copied to the root, which would break those
 *        relative imports)
 *      - content.js       -> content script
 *    A small `closeBundle` plugin builds the content script and copies the
 *    manifest into dist (validated).
 * 3. Content scripts cannot be ES modules in current stable Chrome, so the
 *    content script is built in a separate pass as a self-contained classic
 *    script (format: 'iife'). Rollup cannot emit IIFE for multi-entry builds,
 *    so popup + background (declared `"type": "module"`) are emitted as ES.
 * 4. The manifest shipped in dist must reference BUILT files (.js),
 *    never source .ts paths — the plugin below fails the build if it doesn't.
 */

const rootDir = dirname(fileURLToPath(import.meta.url));
let capturedOutDir: string | undefined;

/** Vite plugin: emit manifest + relocate deterministic bundles post-build. */
function chromeBundlePlugin() {
  return {
    name: 'qa-reporter-chrome-bundle',
    apply: 'build' as const,
    configResolved(cfg: { build: { outDir?: string } }) {
      capturedOutDir = resolve(rootDir, cfg.build.outDir ?? 'dist');
    },
    async closeBundle() {
      const outDir = capturedOutDir ?? resolve(rootDir, 'dist');

      // Content script: separate single-entry build so it can be a classic IIFE.
      await build({
        configFile: false,
        root: rootDir,
        logLevel: 'warn',
        build: {
          target: 'chrome120',
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          lib: {
            entry: resolve(rootDir, 'src/content/index.ts'),
            formats: ['iife'],
            name: 'QAReporterContent',
            fileName: () => 'content.js',
          },
        },
      });

      // Copy + validate manifest so it always references built files.
      const manifestRaw = readFileSync(resolve(rootDir, 'manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
      const bg = (manifest.background as { service_worker?: string }) ?? {};
      const cs = (manifest.content_scripts as Array<{ js?: string[] }>) ?? [];
      if (!bg.service_worker?.endsWith('.js') || !cs[0]?.js?.[0]?.endsWith('.js')) {
        throw new Error('[chrome-bundle] manifest must reference built .js files');
      }
      if (!existsSync(resolve(outDir, bg.service_worker))) {
        throw new Error(`[chrome-bundle] service worker "${bg.service_worker}" not found in build output`);
      }
      const popup = (manifest.action as { default_popup?: string })?.default_popup;
      if (popup && !existsSync(resolve(outDir, popup))) {
        throw new Error(`[chrome-bundle] default_popup "${popup}" not found in build output`);
      }
      if (!existsSync(resolve(outDir, 'editor/editor.html'))) {
        throw new Error('[chrome-bundle] editor/editor.html not found in build output');
      }
      writeFileSync(resolve(outDir, 'manifest.json'), manifestRaw);
    },
  };
}

export default defineConfig({
  root: rootDir,
  base: './',
  plugins: [react(), chromeBundlePlugin()],
  build: {
    target: 'chrome120',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false }, // avoid preload links around extension pages
    rollupOptions: {
      input: {
        popup: resolve(rootDir, 'popup/popup.html'),
        editor: resolve(rootDir, 'editor/editor.html'),
        background: resolve(rootDir, 'src/background/index.ts'),
      },
      output: {
        format: 'es',
        inlineDynamicImports: false,
        entryFileNames: (chunk) => {
          // background stays at the path the manifest references;
          // page assets keep stable names referenced from the HTML files.
          if (chunk.name === 'background') return 'src/background/index.js';
          return 'popup/assets/[name].js';
        },
        chunkFileNames: 'popup/assets/[name].js',
        assetFileNames: 'popup/assets/[name].[ext]',
      },
    },
  },
});
