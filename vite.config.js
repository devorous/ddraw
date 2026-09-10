/** @fileoverview Vite configuration for ddraw — MPA with Svelte landing/gallery + vanilla JS drawing app. */

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const devBackendTarget = process.env.VITE_DEV_BACKEND_TARGET || 'http://127.0.0.1:8030';

// Inject APP_VERSION from package.json
function versionInjectionPlugin() {
  const packageJson = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf8'));
  const version = packageJson.version;

  return {
    name: 'version-injection',
    resolveId(id) {
      if (id === 'virtual-version') {
        return id;
      }
    },
    load(id) {
      if (id === 'virtual-version') {
        return `export const APP_VERSION = '${version}';`;
      }
    },
    // transformIndexHtml runs in dev serve AND build (the old `transform` hook
    // only fired at build time, so dev showed "Version unknown").
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `<script>window.APP_VERSION = '${version}';</script>\n  </head>`
      );
    }
  };
}

/**
 * Re-points each HTML entry's PWA manifest link at the real root-level file.
 *
 * vite-plugin-pwa injects `<link rel="manifest" href="./manifest.webmanifest">`
 * into every entry, but `base: './'` makes that relative to the entry's own
 * directory — so on a nested entry (/go/, /gallery/, /chat/, ...) it resolves to
 * a file that does not exist. Worse than a 404: Vercel checks rewrites after the
 * filesystem, so `/go/(.*)` answers the miss with the page's own HTML and the
 * browser parses markup as JSON.
 *
 * Fixed with `../` hops rather than a leading `/` so the link stays relative —
 * the itch and Tauri builds both serve from a non-root path and rely on that.
 *
 * Runs in `closeBundle` rather than `transformIndexHtml`: vite-plugin-pwa
 * injects the link when it writes the HTML at bundle close, which is after every
 * transformIndexHtml hook has already run.
 */
function manifestHrefPlugin() {
  let outDir = 'dist';
  return {
    name: 'nested-manifest-href',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    // Must sort after vite-plugin-pwa's own closeBundle, hence the array order.
    closeBundle: {
      sequential: true,
      order: 'post',
      handler() {
        const patch = (file) => {
          // `sep` rather than a regex: on Windows `relative()` returns
          // backslash-separated paths, and splitting on '/' alone reads every
          // nested entry as depth 0.
          const depth = relative(outDir, file).split(sep).length - 1;
          if (depth === 0) return;
          const html = fs.readFileSync(file, 'utf8');
          const fixed = html.replace(
            /(<link rel="manifest" href=")\.\/(manifest\.webmanifest")/,
            `$1${'../'.repeat(depth)}$2`
          );
          if (fixed !== html) fs.writeFileSync(file, fixed);
        };
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = resolve(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name === 'index.html') patch(full);
          }
        };
        if (fs.existsSync(outDir)) walk(outDir);
      }
    }
  };
}

export default defineConfig(({ command }) => ({
  root: '.',
  base: './',
  publicDir: 'public',
  appType: 'mpa',
  plugins: [
    svelte(),
    versionInjectionPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: [
        'images/pepper.ico',
        'images/pwa-192.png',
        'images/pwa-512.png',
        'images/pwa-512-maskable.png',
      ],
      manifest: {
        name: 'Top Draw',
        short_name: 'TopDraw',
        description: 'Real-time collaborative drawing — works offline too.',
        start_url: '/go/',
        scope: '/',
        display: 'standalone',
        background_color: '#1a1a1a',
        theme_color: '#1a1a1a',
        orientation: 'any',
        icons: [
          { src: 'images/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'images/pwa-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'images/pwa-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,ico,woff2,png,webmanifest}'],
        globIgnores: ['**/brushes/**', '**/snapshots/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/go/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/ws/, /^\/gallery/, /^\/chat/, /^\/board-viewer/, /^\/user/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /\/brushes\/.*\.(gbr|gih|json)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'brushes',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
    manifestHrefPlugin(),
    {
      name: 'go-spa-fallback',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // Serve go/index.html for /go/*, /embed(/*), and /demo paths (SPA
          // fallback). Both variants boot straight into the canvas (see
          // src/main.js) — /demo always forces the offline board.
          if (req.url.startsWith('/go/') && !req.url.includes('.')) {
            req.url = '/go/index.html';
          } else if (/^\/embed(\/|$|\?)/.test(req.url) && !req.url.split('?')[0].includes('.')) {
            req.url = '/go/index.html';
          } else if (/^\/demo\/?(\?|$)/.test(req.url)) {
            req.url = '/go/index.html';
          }
          next();
        });
      },
    },
  ],
  server: {
    port: 3000,
    open: '/go',
    // Vite >=5.4.12 rejects requests whose Host header is neither localhost nor a
    // bare IP. Raw tailnet IPs (100.x.y.z) pass on their own; the MagicDNS name
    // does not, so `tailscale serve` needs the suffix allowlisted here.
    allowedHosts: ['.ts.net'],
    proxy: {
      '/ws': {
        target: devBackendTarget,
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws/, '') || '/',
      },
      '/api': {
        target: devBackendTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        go: resolve(__dirname, 'go/index.html'),
        chat: resolve(__dirname, 'chat/index.html'),
        boardViewer: resolve(__dirname, 'board-viewer/index.html'),
        gallery: resolve(__dirname, 'gallery/index.html'),
        galleryGrid: resolve(__dirname, 'gallery/grid/index.html'),
        user: resolve(__dirname, 'user/index.html'),
        board: resolve(__dirname, 'board/index.html'),
        messenger: resolve(__dirname, 'messenger/index.html'),
        // Dev-only variant gallery, served at /dropdown-preview/ by `npm run dev`.
        // Excluded from builds so it never deploys.
        ...(command === 'serve'
          ? { dropdownPreview: resolve(__dirname, 'dropdown-preview/index.html') }
          : {}),
      },
      output: {
        manualChunks(id) {
          // Vendor chunks
          if (id.includes('protobufjs')) return 'vendor-proto';
          if (id.includes('perfect-freehand')) return 'vendor-freehand';
          if (id.includes('stackblur')) return 'vendor-blur';
          if (id.includes('node_modules/svelte')) return 'vendor-svelte';

          // App code chunks (via dynamic imports in main.js)
          // auth-landing.js and its dependencies (Auth, LandingPage, WebSocketClient, etc.)
          // are dynamically imported and will form their own chunk
          if (id.includes('/auth/Auth.js') ||
              id.includes('/ui/LandingPage.js') ||
              (id.includes('/network/WebSocketClient.js') && !id.includes('App.js'))) {
            return 'auth-landing';
          }

          // Large Svelte components that are part of the drawing app
          // These stay with App.js for now since they're loaded with the app
          // Individual lazy-loading can be added later if needed
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
  },
}));
