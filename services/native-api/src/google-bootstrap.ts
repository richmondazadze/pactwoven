import type { createRuntimePool } from '@pactwoven/db';
import type { readNativeGoogleConfig, GoogleForegroundLane } from './google-config';
import { GOOGLE_FOREGROUND_LANES } from './google-config';

type Pool = Awaited<ReturnType<typeof createRuntimePool>>;
type Config = ReturnType<typeof readNativeGoogleConfig>;
type App = { fetch(request: Request): Response | Promise<Response> };
type Pools = Record<GoogleForegroundLane | 'foundation', Pool>;
type Dependencies = {
  readConfig(): Config;
  openFoundation(url: string): Promise<Pool>;
  openGoogle(url: string, environment: Config['base']['environment'], lane: GoogleForegroundLane): Promise<Pool>;
  compose(config: Config, pools: Pools): App;
  attach(pool: Pool): void;
};
const failure = () => Error('Google connection initialization failed.');
async function close(pools: Pool[]) {
  if (!pools.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.allSettled(pools.map(async pool => { await pool.end(); })),
    new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
  finally { clearTimeout(timer); }
}
async function until<T>(pending: Promise<T>, deadlineAt: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(failure()), Math.max(0, deadlineAt - Date.now()));
    })]);
    if (Date.now() >= deadlineAt) throw failure();
    return value;
  } finally { clearTimeout(timer); }
}

/** Shared, lazy foreground bootstrap. Each caller keeps its own deadline;
 * a shorter caller cannot cancel another caller's healthy initialization. */
export function createNativeGoogleAppLoader(dependencies: Dependencies) {
  let initialized: Promise<App> | undefined;
  return function load(deadlineAt = Date.now() + 15000): Promise<App> {
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now() + 1000) return Promise.reject(failure());
    if (!initialized) {
      // A short first caller may stop waiting; it must not shorten the shared
      // initialization budget for other callers that arrive concurrently.
      const initializeBy = Date.now() + 10000;
      const opened: Pool[] = []; let abandoned = false;
      initialized = (async () => {
        try {
          const config = dependencies.readConfig();
          const names = ['foundation', ...GOOGLE_FOREGROUND_LANES] as const;
          const entries = await until(Promise.all(names.map(async name => {
            if (Date.now() >= initializeBy || abandoned) throw failure();
            const pool = await (name === 'foundation' ? dependencies.openFoundation(config.base.foundationDatabaseUrl)
              : dependencies.openGoogle(config.databaseUrls[name], config.base.environment, name));
            if (abandoned || Date.now() >= initializeBy) { void close([pool]); throw failure(); }
            opened.push(pool); return [name, pool] as const;
          })), initializeBy);
          const app = dependencies.compose(config, Object.fromEntries(entries) as Pools);
          if (Date.now() >= initializeBy) throw failure();
          for (const pool of opened) dependencies.attach(pool);
          return app;
        } catch {
          abandoned = true; await close(opened); throw failure();
        }
      })().catch(() => { initialized = undefined; throw failure(); });
    }
    return until(initialized, deadlineAt);
  };
}
