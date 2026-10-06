import { createClient, currentSession, show, showError, signInWithGoogle } from './client.js';

async function deleteAccount(client, session) {
  document.getElementById('delete').disabled = true;
  const response = await fetch('/account', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session.access_token}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showError(body.error ?? 'Your account could not be deleted. Nothing was changed.');
    return;
  }
  // The sign-in no longer exists; forget it in this browser too.
  await client.auth.signOut({ scope: 'local' });
  show('deleted');
}

async function main() {
  const client = await createClient();
  const session = await currentSession(client);
  if (!session) {
    document.getElementById('google').addEventListener('click', () => {
      signInWithGoogle(client).catch((error) => showError(error.message));
    });
    show('sign-in');
    return;
  }

  document.getElementById('email').textContent = session.user.email ?? 'your account';
  const confirm = document.getElementById('confirm');
  const remove = document.getElementById('delete');
  confirm.addEventListener('input', () => {
    remove.disabled = confirm.value.trim() !== 'DELETE';
  });
  remove.addEventListener('click', () => {
    deleteAccount(client, session).catch((error) => showError(error.message));
  });
  document.getElementById('sign-out').addEventListener('click', async () => {
    await client.auth.signOut();
    window.location.reload();
  });
  show('account');
}

main().catch((error) => showError(error.message));
