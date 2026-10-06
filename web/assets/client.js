// Shared by every page: the service's public settings and one Supabase client built from them.

let settings;

export async function loadSettings() {
  if (!settings) {
    const response = await fetch('/config.json');
    if (!response.ok) throw new Error('The service is not available right now.');
    settings = await response.json();
  }
  return settings;
}

export async function createClient() {
  const { supabaseUrl, supabasePublishableKey } = await loadSettings();
  // `supabase` is the global defined by /assets/supabase.js.
  return globalThis.supabase.createClient(supabaseUrl, supabasePublishableKey);
}

export async function currentSession(client) {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session;
}

/** Sends the browser to Google and back to the page it is on now. */
export async function signInWithGoogle(client) {
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href },
  });
  if (error) throw error;
}

/** Shows exactly one of the page's sections. */
export function show(id) {
  for (const section of document.querySelectorAll('main > section')) {
    section.hidden = section.id !== id;
  }
}

export function showError(message) {
  document.getElementById('error-message').textContent = message;
  show('error');
}
