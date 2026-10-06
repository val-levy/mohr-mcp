import { createClient, currentSession, show, showError, signInWithGoogle } from './client.js';

// Supabase Auth sends the browser here with the ID of the connection request being decided.
const authorizationId = new URLSearchParams(window.location.search).get('authorization_id');

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'the app that sent you here';
  }
}

async function decide(client, approve) {
  for (const button of document.querySelectorAll('#consent button')) button.disabled = true;
  const { data, error } = approve
    ? await client.auth.oauth.approveAuthorization(authorizationId)
    : await client.auth.oauth.denyAuthorization(authorizationId);
  if (error || !data?.redirect_url) {
    showError(error?.message ?? 'The connection could not be completed.');
    return;
  }
  window.location.assign(data.redirect_url);
}

async function main() {
  if (!authorizationId) {
    showError('This page was opened without a connection request.');
    return;
  }
  const client = await createClient();
  const session = await currentSession(client);
  if (!session) {
    document.getElementById('google').addEventListener('click', () => {
      signInWithGoogle(client).catch((error) => showError(error.message));
    });
    show('sign-in');
    return;
  }

  const { data, error } = await client.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !data) {
    showError(error?.message ?? 'This connection request has expired.');
    return;
  }
  // Already allowed earlier: Supabase answers with where to go instead of asking again.
  if (data.redirect_url) {
    window.location.assign(data.redirect_url);
    return;
  }

  document.getElementById('client-name').textContent = data.client?.name ?? 'An app';
  document.getElementById('redirect-host').textContent = hostOf(data.redirect_uri);
  document.getElementById('email').textContent = session.user.email ?? 'your account';
  document.getElementById('allow').addEventListener('click', () => decide(client, true));
  document.getElementById('deny').addEventListener('click', () => decide(client, false));
  show('consent');
}

main().catch((error) => showError(error.message));
