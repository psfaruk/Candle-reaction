import type { NextConfig } from "next";

/**
 * Start-command-proof routing:
 *  • /engine/*  + /qx-health  → proxied to the Python engine (:3003)
 *    (the engine is spawned by src/instrumentation.ts on every server boot)
 *  • skipTrailingSlashRedirect — /engine/ must NOT be 308-redirected to
 *    /engine by Next before the rewrite can proxy it (socket.io clients
 *    always call /engine/ with the trailing slash).
 *
 * The engine port defaults to 3003 (same default as src/instrumentation.ts
 * and the engine itself) — keep it in sync if you ever change it.
 */
const ENGINE_PORT = process.env.QX_ENGINE_PORT || "3003";
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;

const nextConfig: NextConfig = {
  output: "standalone",
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      // socket.io endpoint (browser connects here; polling works through the
      // proxy, and the engine also accepts websockets when reached directly)
      { source: "/engine", destination: `${ENGINE_URL}/engine/` },
      { source: "/engine/:path*", destination: `${ENGINE_URL}/engine/:path*` },
      // liveness/readiness probe (Railway healthcheck)
      { source: "/qx-health", destination: `${ENGINE_URL}/qx-health` },
      { source: "/qx-health/:path*", destination: `${ENGINE_URL}/qx-health/:path*` },
    ];
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
