/**
 * qx-engine auto-spawner (nodejs runtime only).
 *
 * Makes the app START-COMMAND-PROOF: Railway (or any host) may launch the
 * app with its own command (`next start`, `node server.js`, `npm start`,
 * Dockerfile CMD …). Only some of those run deploy/start.sh, so the Python
 * engine could end up never started → /engine + /qx-health dead → no data.
 *
 * This module runs inside EVERY Next.js server boot (standalone server.js,
 * `next start`, `next dev`) — it spawns the Python engine on an internal
 * port (:3003) and next.config.ts rewrites route /engine + /qx-health to
 * it. Whichever command boots the Next server, the engine comes up.
 *
 * Safety:
 *  • once per process (globalThis guard)
 *  • the engine has its own duplicate-guard (healthy engine on :3003 →
 *    it exits 0; we re-check every 90s so this group can take over later)
 *  • the child dies with the Next process (no orphans between deploys)
 *  • repeated failures → backoff, give up after 50 tries
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

type G = typeof globalThis & {
  __QX_ENGINE_SPAWNER?: boolean;
  __QX_ENGINE_EXITED?: boolean;
  __QX_ENGINE_CHILD?: ChildProcess | null;
};
const g = globalThis as G;
if (g.__QX_ENGINE_SPAWNER) {
  // module re-evaluated (e.g. dev HMR) — do not spawn twice
} else {
  g.__QX_ENGINE_SPAWNER = true;

  // ---- locate mini-services/qx-engine ----
  // Collect candidates by walking up from BOTH cwd and this file's location,
  // then prefer the SOURCE tree (a copy baked into .next/standalone goes
  // stale the moment the engine source is edited after a build).
  const candidates: string[] = [];
  const roots = [process.cwd()];
  try {
    roots.push(path.dirname(__filename));
  } catch {
    /* __filename unavailable (bundled CJS shim) — cwd walk is enough */
  }
  for (const root of roots) {
    let dir = root;
    for (let i = 0; i < 8; i++) {
      const cand = path.join(dir, 'mini-services', 'qx-engine');
      if (fs.existsSync(path.join(cand, 'run.sh')) && !candidates.includes(cand)) {
        candidates.push(cand);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const engineDir =
    candidates.find((c) => !c.includes(`${path.sep}.next${path.sep}standalone${path.sep}`)) ||
    candidates[0] ||
    null;
  if (!engineDir) {
    console.warn('[qx] ⚠ mini-services/qx-engine পাওয়া যায়নি — engine spawn স্কিপ');
  } else {
    const ENGINE_PORT = process.env.QX_ENGINE_PORT || '3003';
    const NEXT_PORT = process.env.PORT || '3000'; // Next server's own port

    let failures = 0;
    const spawnEngine = (delayMs: number) => {
      setTimeout(() => {
        if (g.__QX_ENGINE_EXITED) return;
        let child: ChildProcess | null = null;
        try {
          child = spawn('bash', [path.join(engineDir as string, 'run.sh')], {
            cwd: engineDir as string,
            env: {
              ...process.env,
              QX_ENGINE_PORT: ENGINE_PORT,
              QX_NEXT_PORT: NEXT_PORT,
              QX_PARENT_PID: String(process.pid), // engine self-exits if we die
            },
            stdio: ['ignore', 'inherit', 'inherit'],
          });
        } catch (e) {
          console.warn('[qx] ⚠ engine spawn ব্যর্থ:', e);
        }
        if (!child) return;
        g.__QX_ENGINE_CHILD = child;
        console.log(`[qx] 🐍 Python engine spawned (pid ${child.pid}, :${ENGINE_PORT})`);
        child.on('exit', (code) => {
          g.__QX_ENGINE_CHILD = null;
          if (g.__QX_ENGINE_EXITED) return;
          if (code === 0) {
            // duplicate-guard: a healthy engine already owns :3003 —
            // re-check soon so this group can take over if it dies
            console.log('[qx] ℹ :3003-এ ইঞ্জিন আগেই চলছে — 20s পরে আবার চেক করব');
            spawnEngine(20_000);
          } else {
            failures += 1;
            if (failures > 50) {
              console.error('[qx] ✗ engine বারবার ব্যর্থ — spawn বন্ধ করা হলো');
              return;
            }
            const wait = Math.min(10_000 * failures, 60_000);
            console.warn(`[qx] ⚠ engine বন্ধ (code ${code}) — ${wait / 1000}s পরে আবার`);
            spawnEngine(wait);
          }
        });
      }, delayMs);
    };

    // the engine is internal (:3003) so there is no port race with Next —
    // start almost immediately (the engine itself boots in 1-3s)
    spawnEngine(300);

    // clean shutdown: kill the child when the Next process exits
    process.on('exit', () => {
      g.__QX_ENGINE_EXITED = true;
      const c = g.__QX_ENGINE_CHILD;
      if (c && !c.killed) {
        try {
          c.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    });
  }
}
