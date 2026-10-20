const $ = selector => document.querySelector(selector);
let state, dirty = false, saving = false, blocked = false, timer;
function notice(message, error = false) {
  $('#save-status').textContent = message;
  $('#save-status').classList.toggle('error', error);
}
async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) { const error = new Error(body.error || 'Request failed'); error.status = response.status; throw error; }
  return body;
}
function changed() {
  dirty = true; notice('Saving…'); clearTimeout(timer); timer = setTimeout(save, 180);
  progress();
}
function progress() {
  $('#progress').textContent = `${Object.values(state.icons).filter(icon => icon.selected).length} / ${Object.keys(state.icons).length} selected`;
}
async function save() {
  if (!dirty || saving || blocked) return;
  saving = true; $('#retry').hidden = true;
  try {
    while (dirty) {
      dirty = false;
      const saved = await request('/api/go-icons', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state), keepalive: true });
      state.revision = saved.revision;
    }
    notice('All changes saved');
  } catch (error) {
    dirty = true; blocked = error.status === 409;
    notice(blocked ? error.message : 'Not saved. Keep this page open and retry.', true);
    $('#retry').hidden = blocked; $('#go-rows').inert = blocked;
  } finally { saving = false; }
}
$('#retry').onclick = save;
addEventListener('online', save);
addEventListener('beforeunload', event => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden) void save(); });
try {
  const [data, appearance] = await Promise.all([request('/api/go-icons'), request('/api/bootstrap')]);
  state = data.state;
  const theme = appearance.themes.find(theme => theme.id === appearance.state.theme);
  for (const [key, value] of Object.entries(theme.design.colors)) document.documentElement.style.setProperty(`--${key}`, value);
  const hex = theme.design.colors.background.slice(1);
  const rgb = hex.length === 3 ? hex.split('').map(x => parseInt(x + x, 16)) : [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  document.documentElement.style.colorScheme = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 < 140 ? 'dark' : 'light';
  for (const icon of data.catalog) {
    const choice = state.icons[icon.id];
    const row = document.createElement('div'); row.className = 'go-row'; row.dataset.icon = icon.id;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button';
    button.setAttribute('aria-label', `Include ${icon.name}`); button.title = icon.name;
    button.innerHTML = icon.svg; button.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'go-name'; label.textContent = icon.name;
    if (icon.earlier) { const note = document.createElement('small'); note.textContent = 'Earlier round'; label.append(note); }
    const input = document.createElement('input'); input.type = 'text'; input.placeholder = 'Comment…'; input.maxLength = 2000;
    input.setAttribute('aria-label', `Comment on ${icon.name}`); input.value = choice.comment;
    input.oninput = () => { choice.comment = input.value; changed(); };
    function update() { button.setAttribute('aria-pressed', String(choice.selected)); row.classList.toggle('included', choice.selected); }
    button.onclick = () => { choice.selected = !choice.selected; update(); changed(); };
    update(); row.append(button, label, input); $('#go-rows').append(row);
  }
  $('#save-path').textContent = data.statePath;
  progress(); notice('All changes saved');
} catch (error) { notice(`Could not load Go icons: ${error.message}`, true); }
