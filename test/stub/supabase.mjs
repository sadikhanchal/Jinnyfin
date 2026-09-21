// ============================================================================
//  A stand-in for @supabase/supabase-js, used only by the tests.
//
//  The app fetches the real library from a CDN at runtime. The test harness
//  intercepts that fetch and hands back this file instead, so the tests never
//  touch the real database, never need a password, and run the same offline.
//
//  Everything the tests drive lives on `window.__sb`:
//    __sb.fire(event, session)   — pretend Supabase raised an auth event
//    __sb.rows                   — what the next pull will hand back, per table
//    __sb.pushed                 — every row that actually reached the server
//    __sb.rejectUpsert(table, row) — return an error message to make the
//      server refuse that one row (any batch containing it fails whole,
//      exactly like a real constraint violation), or a falsy value to let it
//      through — same signature Postgres itself effectively has.
//    __sb.pulls                  — how many times each table was pulled from,
//      so a test can tell the pull phase ran even after a push partly failed.
// ============================================================================

const S = (globalThis.__sb ||= {
  rows: {},                 // { transactions: [...], accounts: [...] } — filled by the harness
  pushed: [],
  user: { id: 'test-user', email: 'test@jinnyfin.local' },
  cb: null,
  /** Raise an auth event exactly as the real library does. */
  fire(event, session) { S.cb?.(event, session === undefined ? { user: S.user } : session); },
});

export function createClient() {
  return {
    auth: {
      // The real client fires PASSWORD_RECOVERY as part of the SAME internal
      // check that getSession() awaits, and only to whoever is already
      // listening when that happens — a listener attached after this resolves
      // has missed it for good. recoveryOnInit reproduces exactly that: the
      // event reaches S.cb only if onAuthStateChange was called before
      // getSession(), so a regression that swaps the order back would make
      // this fire to nobody, same as it did in production.
      getSession: async () => {
        if (S.recoveryOnInit && !S.recoveryFired) { S.recoveryFired = true; S.cb?.('PASSWORD_RECOVERY', { user: S.user }); }
        return { data: { session: { user: S.user } } };
      },
      getUser: async () => ({ data: { user: S.user }, error: null }),
      onAuthStateChange(cb) {
        S.cb = cb;
        return { data: { subscription: { unsubscribe() { S.cb = null; } } } };
      },
      signInWithPassword: async () => ({ data: { user: S.user }, error: null }),
      signOut: async () => {
        S.signOutAuthStorage = localStorage.getItem('jinnyfin-auth');
        return { error: null };
      },
      updateUser: async (opts) => { if (opts && 'password' in opts) S.updatedPassword = opts.password; return { data: { user: S.user }, error: null }; },
      resetPasswordForEmail: async (email) => { S.resetFor = email; return { error: null }; },
    },
    from(table) {
      const q = {
        select: () => q,
        gt: () => q, gte: () => q, lt: () => q, eq: () => q, in: () => q,
        order: () => q,
        // The app pages in 1000s: page 0 gets the rows, page 1 ends the loop.
        //
        // A COPY every time, the way a real server answers. Handing back the
        // same objects meant the app's own store held the very rows the test
        // then edited, so "has this row changed since we last saw it?" was
        // always no and the test proved nothing.
        range: async start => {
          if (S.pullDelay) await new Promise(resolve => setTimeout(resolve, S.pullDelay));
          S.pulls = S.pulls || {}; S.pulls[table] = (S.pulls[table] || 0) + 1;
          return { data: start === 0 ? structuredClone(S.rows[table] || []) : [], error: null };
        },
        async upsert(rows) {
          const list = [].concat(rows);
          if (S.rejectUpsert) {
            const bad = list.map(r => S.rejectUpsert(table, r)).find(Boolean);
            if (bad) return { data: null, error: { message: bad } };
          }
          S.pushed.push(...list.map(r => ({ table, row: r })));
          return { data: [], error: null };
        },
        async insert(rows) { S.pushed.push(...[].concat(rows).map(r => ({ table, row: r }))); return { data: [], error: null }; },
        async delete() { return { data: [], error: null }; },
      };
      return q;
    },
    functions: { invoke: async () => ({ data: null, error: null }) },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  };
}

export default { createClient };
