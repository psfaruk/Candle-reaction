/**
 * instrumentation entry — runs on EVERY Next.js server boot.
 * Node-only work (spawning the Python engine) lives in a separate module
 * that is dynamically imported ONLY for the nodejs runtime (documented
 * Next.js pattern; keeps the edge bundle free of node builtins).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-engine');
  }
}
