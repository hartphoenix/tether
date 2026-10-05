// Local staging only. The production WebAuthn client and real passkeys are never used here.
const button = document.querySelector('#authenticate');
if (button) {
  button.textContent = button.dataset.request === 'revoke' ? 'End staging sessions' : 'Simulate passkey verification';
  const note = document.createElement('p'); note.textContent = 'Local staging: no real passkey is requested.'; button.before(note);
  button.onclick = async () => {
    button.disabled = true;
    const post = async (path, body) => {
      const response = await fetch('/approval/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('Staging sign-in expired. Reload the reader to try again.');
      return response.json();
    };
    try {
      const options = await post('authentication/options', { requestId: button.dataset.request });
      const verified = await post('authentication/verify', { challengeId: options.id, response: { proof: options.options.challenge } });
      if (verified.revoked) { document.querySelector('#status').textContent = 'Staging sessions ended.'; return; }
      const form = document.createElement('form'); form.method = 'post'; form.action = verified.action;
      const input = document.createElement('input'); input.type = 'hidden'; input.name = 'code'; input.value = verified.code;
      form.append(input); document.body.append(form); form.submit();
    } catch (error) { document.querySelector('#status').textContent = error.message; }
    finally { button.disabled = false; }
  };
}
