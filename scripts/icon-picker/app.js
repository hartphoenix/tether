const $ = selector => document.querySelector(selector);
const status = $('#save-status');
const menu = $('#context-menu');
let state, catalog, themes, dirty = false, saving = false, blocked = false, timer;
const svgCache = new Map();
const rowViews = new Map();

function notice(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = new Error((await response.json().catch(() => ({}))).error || `Request failed (${response.status})`);
    error.status = response.status; throw error;
  }
  return response.json();
}
function changed() {
  dirty = true; notice('Saving…'); clearTimeout(timer); timer = setTimeout(save, 180);
  updateProgress();
}
async function save() {
  if (saving || !dirty || blocked) return;
  saving = true; $('#retry').hidden = true;
  try {
    while (dirty) {
      dirty = false;
      const saved = await request('/api/state', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(state), keepalive:true });
      state.revision = saved.revision; state.updatedAt = saved.updatedAt;
    }
    notice('All changes saved');
  } catch (error) {
    dirty = true; blocked = error.status === 409;
    notice(blocked ? error.message : 'Not saved. Keep this page open and retry.', true);
    $('#retry').hidden = blocked;
    if (blocked) $('.table-wrap').inert = $('.controls').inert = true;
  } finally { saving = false; }
}
$('#retry').onclick = save;
addEventListener('online', save);
addEventListener('beforeunload', event => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden) void save(); });

function updateProgress() {
  $('#progress').textContent = `${Object.values(state.rows).filter(row => row.selected).length} / ${catalog.length} chosen`;
}
function applyAppearance() {
  const theme = themes.find(t => t.id === state.theme);
  for (const [key, value] of Object.entries(theme.design.colors)) document.documentElement.style.setProperty(`--${key}`, value);
  const font = theme.design.fonts.heading;
  document.documentElement.style.setProperty('--heading-font', `"${font.family}", ${font.fallback}`);
  // Use the actual palette to determine native control appearance, including custom themes.
  const hex = theme.design.colors.background.slice(1);
  const rgb = hex.length === 3 ? hex.split('').map(x => parseInt(x + x, 16)) : [0,2,4].map(i => parseInt(hex.slice(i,i+2),16));
  document.documentElement.style.colorScheme = rgb[0]*.299 + rgb[1]*.587 + rgb[2]*.114 < 140 ? 'dark' : 'light';
  document.documentElement.style.setProperty('--scale', state.scale);
  $('#theme').value = state.theme; $('#scale').value = state.scale * 100;
  $('#scale-value').textContent = `${Math.round(state.scale * 100)}%`;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function lucide(name) {
  if (!svgCache.has(name)) svgCache.set(name, fetch(`/icons/${name}.svg`).then(async response => {
    if (!response.ok) throw new Error(`“${name}” is not in this Lucide version.`);
    return response.text();
  }).catch(error => { svgCache.delete(name); throw error; }));
  return svgCache.get(name);
}
let menuAction, menuTrigger;
function closeMenu(restore = false) { menu.hidden = true; if (restore && menuTrigger?.isConnected) menuTrigger.focus(); }
function context(button, action) {
  function open(x, y) {
    menuAction = action; menuTrigger = button; menu.hidden = false;
    menu.style.left = `${Math.max(5,Math.min(x,innerWidth-menu.offsetWidth-8))}px`;
    menu.style.top = `${Math.max(5,Math.min(y,innerHeight-menu.offsetHeight-8))}px`;
    $('#remove').focus();
  }
  button.oncontextmenu = event => { event.preventDefault(); open(event.clientX,event.clientY); };
  button.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); const rect = button.getBoundingClientRect(); open(rect.left,rect.bottom);
    }
  });
}
$('#remove').onclick = () => { closeMenu(); menuAction?.(); };
document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) closeMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(true); if(event.key === 'Tab') closeMenu(); });
addEventListener('scroll', () => closeMenu(), true); addEventListener('resize', () => closeMenu());

function iconButton(name, svg, label) {
  const wrapper = element('div','choice');
  const button = element('button','icon-button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label',label);
  button.innerHTML = svg; button.querySelector('svg')?.setAttribute('aria-hidden','true');
  wrapper.append(button,element('span','icon-name',name));
  return { wrapper, button };
}
function renderChoices(row) {
  const choice = state.rows[row.id]; const view = rowViews.get(row.id);
  view.current.replaceChildren(); view.candidates.replaceChildren();
  if (choice.showCurrent) {
    const {wrapper,button} = iconButton(row.phosphor ?? 'No icon · text only',row.svg,`Current: ${row.phosphor ?? row.label}`);
    if (!row.phosphor) { button.textContent = row.label; button.classList.add('text-current'); }
    if (row.rotate) button.classList.add('rotated');
    context(button, () => { choice.showCurrent = false; renderChoices(row); changed(); view.current.querySelector('button').focus(); });
    view.current.append(wrapper);
  } else {
    const restore = element('button','restore','Restore current');
    restore.onclick = () => { choice.showCurrent = true; renderChoices(row); changed(); };
    view.current.append(restore);
  }
  for (const name of choice.candidates) {
    const {wrapper,button} = iconButton(name,'',`Choose ${name} for ${row.label}`);
    button.dataset.name = name; button.setAttribute('role','radio'); button.setAttribute('aria-checked',String(choice.selected === name));
    button.tabIndex = name === (choice.selected ?? choice.candidates[0]) ? 0 : -1;
    lucide(name).then(svg => { button.innerHTML = svg; button.querySelector('svg').setAttribute('aria-hidden','true'); }).catch(error => { button.disabled = true; view.error.textContent = error.message; });
    button.onclick = () => { choice.selected = name; renderChoices(row); changed(); view.candidates.querySelector(`[data-name="${name}"]`).focus(); };
    context(button, () => {
      choice.candidates = choice.candidates.filter(n => n !== name);
      if (choice.selected === name) choice.selected = null;
      renderChoices(row); changed(); (view.candidates.querySelector('button') ?? view.input).focus();
    });
    view.candidates.append(wrapper);
  }
  view.clear.hidden = choice.selected === null;
}
function renderRow(row) {
  const tr = element('tr'); tr.dataset.row = row.id; tr.style.setProperty('--icon-size',`${row.size}px`);
  const title = element('td',null,row.label); title.append(element('small',null,`${row.area} · ${Number(row.size.toFixed(2))} px`));
  if (row.note) title.append(element('small',null,row.note));
  const current = element('td','current');
  const alternatives = element('td');
  const candidates = element('div','candidates'); candidates.setAttribute('role','radiogroup'); candidates.setAttribute('aria-label',row.label + ' — ' + row.area);
  candidates.onkeydown = event => {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    const buttons = [...candidates.querySelectorAll('button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault(); const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (index + (['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].click();
  };
  const clear = element('button','clear','Clear choice'); clear.onclick = () => { state.rows[row.id].selected = null; renderChoices(row); changed(); candidates.querySelector('button')?.focus(); };
  alternatives.append(candidates,clear);
  const add = element('td'); const form = element('form');
  const input = element('input'); input.type = 'text'; input.placeholder = 'e.g. panel-right'; input.maxLength = 200; input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('aria-label',`Add Lucide icon for ${row.label} — ${row.area}`); input.value = state.rows[row.id].draft;
  input.oninput = () => { error.textContent = ''; state.rows[row.id].draft = input.value; changed(); };
  const submit = element('button',null,'+'); submit.type = 'submit'; submit.setAttribute('aria-label',`Add candidate for ${row.label}`);
  const error = element('div','row-error'); error.setAttribute('role','alert');
  form.append(input,submit); add.append(form,error);
  form.onsubmit = async event => {
    event.preventDefault(); error.textContent = '';
    const name = input.value.trim().replace(/([a-z0-9])([A-Z])/g,'$1-$2').toLowerCase().replace(/[ _]+/g,'-');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) { error.textContent = 'Enter a Lucide icon name.'; return; }
    submit.disabled = true;
    try {
      await lucide(name);
      const choice = state.rows[row.id];
      if (!choice.candidates.includes(name)) {
        if (choice.candidates.length >= 100) throw new Error('Remove a candidate before adding another.');
        choice.candidates.push(name);
      }
      choice.draft = input.value = ''; renderChoices(row); changed(); input.focus();
    } catch (reason) { error.textContent = reason.message; } finally { submit.disabled = false; }
  };
  rowViews.set(row.id,{current,candidates,input,error,clear}); tr.append(title,current,alternatives,add); $('#rows').append(tr); renderChoices(row);
}

try {
  const bootstrap = await request('/api/bootstrap');
  ({state,catalog,themes} = bootstrap);
  for (const theme of themes) { const option = element('option',null,theme.label); option.value = theme.id; $('#theme').append(option); }
  $('#theme').onchange = event => { state.theme = event.target.value; applyAppearance(); changed(); };
  $('#scale').oninput = event => { state.scale = Number(event.target.value)/100; applyAppearance(); changed(); };
  $('#actual-size').onclick = () => { state.scale = 1; applyAppearance(); changed(); };
  $('#save-path').textContent = bootstrap.statePath;
  $('#download').onclick = event => {
    event.preventDefault();
    const url = URL.createObjectURL(new Blob([JSON.stringify(state,null,2)+'\n'],{type:'application/json'}));
    const link = element('a'); link.href = url; link.download = 'tether-icon-selections.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  };
  applyAppearance(); catalog.forEach(renderRow); updateProgress(); notice('All changes saved');
} catch (error) { notice(`Could not load the picker: ${error.message}`,true); }
