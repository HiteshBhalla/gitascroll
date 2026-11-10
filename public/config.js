// Site settings that change without touching the app code.
window.GITA_CONFIG = {
  // Google AdSense stays off until both are filled in; until then the in-feed cards show the Bhagwat Gita card.
  adsenseClient: "", // Publisher ID from AdSense, e.g. "ca-pub-1234567890123456"
  adsenseSlot: "",   // ID of the in-feed display ad unit, e.g. "1234567890"
  // Supabase project for Ask Gita sign-in (email + one-time code). Both are public values, safe to ship:
  // Supabase dashboard, Project Settings, API. Leave empty and Ask Gita says sign-in isn't set up yet.
  supabaseUrl: "",   // e.g. "https://abcdefghijkl.supabase.co"
  supabaseKey: "",   // the anon / publishable key
};
