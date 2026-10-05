const frame = document.querySelector('#phone');
const launchMode = document.querySelector('#launch-mode');
const preset = document.querySelector('#preset');
const width = document.querySelector('#width'), height = document.querySelector('#height');
const displayScale = document.querySelector('#display-scale');
const phone = document.querySelector('.phone'), phoneSize = document.querySelector('.phone-size');
try { displayScale.value = localStorage.getItem('tether-stage-display-scale') || '83'; } catch {}
function resize() {
  const mini = preset.value === '375,812';
  const contentWidth = Math.max(280, Math.min(1200, Number(width.value) || 375));
  const requestedHeight = Math.max(280, Math.min(1400, Number(height.value) || 812));
  const standalone = launchMode.value === 'standalone';
  // Reserve the status area and either the home indicator or Safari controls.
  const contentHeight = mini ? requestedHeight - 50 - (standalone ? 34 : 133) : requestedHeight;
  phone.dataset.mode = launchMode.value;
  launchMode.disabled = !mini;
  if (mini) phone.dataset.device = 'mini'; else delete phone.dataset.device;
  document.querySelector('#height-label').textContent = mini ? 'Screen height' : 'Content height';
  frame.width = String(contentWidth);
  frame.height = String(contentHeight);
  document.querySelector('#dimensions').textContent = mini
    ? `Screen ${contentWidth} × ${requestedHeight} · webpage ${contentWidth} × ${contentHeight} · ${standalone ? 'Home Screen app' : 'Safari controls mocked'}`
    : `Webpage ${contentWidth} × ${contentHeight}`;
  const percent = Math.max(50, Math.min(150, Number(displayScale.value) || 83));
  displayScale.value = String(percent);
  phone.style.transform = `scale(${percent / 100})`;
  phoneSize.style.width = `${phone.offsetWidth * percent / 100}px`;
  phoneSize.style.height = `${phone.offsetHeight * percent / 100}px`;
}
document.querySelector('#preset').onchange = event => { [width.value, height.value] = event.target.value.split(','); resize(); };
launchMode.onchange = width.onchange = height.onchange = resize;
displayScale.onchange = () => {
  resize();
  try { localStorage.setItem('tether-stage-display-scale', displayScale.value); } catch {}
};
resize();
document.querySelector('#reload').onclick = document.querySelector('#safari-reload').onclick = () => { frame.src = '/phone/'; };
document.querySelector('#expire').onclick = async () => {
  const response = await fetch('/expire', { method: 'POST' });
  document.querySelector('#state').textContent = response.ok ? 'Session expired. Sign in again inside the preview.' : 'Could not expire the session.';
  if (response.ok) frame.src = '/phone/reader/';
};
