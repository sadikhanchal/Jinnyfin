// ============================================================================
//  JINNYFIN — the only file you need to edit.
//  Supabase → Project Settings → API Keys  →  Project URL + publishable key
// ============================================================================

export const CONFIG = {
  // Base project URL — note there is NO /rest/v1/ on the end.
  SUPABASE_URL: 'https://rghhuttvobghtkthpsej.supabase.co',

  // Publishable key. This one is meant to be public: it can only ever see rows
  // that belong to whoever is logged in, because Row Level Security says so.
  // Never put an sb_secret_… or service_role key here — those bypass RLS.
  SUPABASE_ANON_KEY: 'sb_publishable__bIl30kj9niiZf_2oVhYTw_9gi4Y5YC',

  // The public half of the push-signing pair. It is meant to be public — it is
  // handed to the phone's push service so it can check a notification really
  // came from this app. The PRIVATE half never appears here: it lives in
  // Supabase's secret store, where only the scheduled job can read it.
  // See PUSH-SETUP.md.
  VAPID_PUBLIC_KEY: 'BL94JGN2xGkX7_6nHUietV0IUMcXAU_Zfvl0vSRjmVlwjeY3nFiQ_fM3mFQCvqH662AOiCjUtqxeN_REBify-Jg',

  APP_NAME: 'Jinnyfin',
  BASE_CURRENCY: 'SAR',        // the currency you earn in
  REPORT_CURRENCY: 'INR',      // the currency reports are totalled in
  DEFAULT_ACCOUNT: 'Cash In Hand',
  WEEK_START: 6,               // 6 = Saturday (KSA), 0 = Sunday, 1 = Monday
};
