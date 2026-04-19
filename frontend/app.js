window.addEventListener('error', (e) => {
  const s = document.getElementById('stats');
  if (s) s.textContent = `JS error: ${e.message}`;
});

const whenInput = document.getElementById('when');
const filterSel = document.getElementById('filter');
const searchInput = document.getElementById('search');
const suggestBox = document.getElementById('suggest');
const stats = document.getElementById('stats');
const weatherEl = document.getElementById('weather');
const slider = document.getElementById('timeSlider');
const timeLabel = document.getElementById('timeLabel');
const stableOnly = document.getElementById('stableOnly');
stats.textContent = 'init…';

if (typeof maplibregl === 'undefined') {
  stats.textContent = 'MapLibre non chargé';
  throw new Error('MapLibre missing');
}

function pad(n) { return String(n).padStart(2, '0'); }
function localISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [2.3479, 48.8927],
  zoom: 15.5,
  pitch: 40,
  bearing: -18,
  maxPitch: 75,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

map.on('load', () => {
  map.addSource('shadows', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const layers = map.getStyle().layers;
  const buildingLayer = layers.find(l => l.id === 'building-3d' || l.id === 'building' || l.type === 'fill-extrusion');
  const beforeId = buildingLayer ? buildingLayer.id : undefined;
  map.addLayer({
    id: 'shadows-fill', type: 'fill', source: 'shadows',
    paint: { 'fill-color': '#1c2230', 'fill-opacity': 0.38, 'fill-antialias': true }
  }, beforeId);

  map.addSource('bars', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'bars-halo', type: 'circle', source: 'bars',
    paint: {
      'circle-radius': ['case',
        ['==', ['get', 'sunny'], false], 9,
        ['get', 'stable'], 10,
        7.5,
      ],
      'circle-color': '#ffffff',
      'circle-opacity': ['case',
        ['!', ['get', 'confirmed']], 0,
        ['==', ['get', 'sunny'], false], 1,
        ['get', 'stable'], 1,
        0.55,
      ],
    },
  });
  map.addLayer({
    id: 'bars-dot', type: 'circle', source: 'bars',
    paint: {
      'circle-radius': ['case',
        ['!', ['get', 'confirmed']], 5,
        ['==', ['get', 'sunny'], false], 7,
        ['get', 'stable'], 7.5,
        5.5,
      ],
      'circle-color': ['case',
        ['!', ['get', 'confirmed']], 'rgba(0,0,0,0)',
        ['get', 'sunny'], '#f5b700',
        '#4a5b6b',
      ],
      'circle-opacity': ['case',
        ['!', ['get', 'confirmed']], 0,
        ['==', ['get', 'sunny'], false], 1,
        ['get', 'stable'], 1,
        0.5,
      ],
      'circle-stroke-width': ['case',
        ['!', ['get', 'confirmed']], 2,
        0,
      ],
      'circle-stroke-color': ['case', ['get', 'sunny'], '#f5b700', '#4a5b6b'],
      'circle-stroke-opacity': ['case',
        ['!', ['get', 'confirmed']], 0.9,
        0,
      ],
    },
  });

  map.on('click', 'bars-dot', (e) => {
    const f = e.features[0];
    if (!f) return;
    const b = JSON.parse(f.properties.bar);
    const popup = new maplibregl.Popup({ offset: 12, className: 'popup-premium', closeButton: false })
      .setLngLat([b.lon, b.lat])
      .setHTML(popupHTML(b, null))
      .addTo(map);
    if (window.matchMedia('(max-width: 640px)').matches) {
      map.easeTo({ center: [b.lon, b.lat], offset: [0, -120], duration: 350 });
    }
    wireReportForm(popup, b);
    hydratePopup(popup, b);
  });
  map.on('mouseenter', 'bars-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'bars-dot', () => { map.getCanvas().style.cursor = ''; });
});

let lastData = null;
let streets = [];

function fmtDur(min) {
  if (min == null) return null;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${String(m).padStart(2,'0')}` : `${h} h`;
}

function fmtTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

function popupHTML(b, forecast) {
  const tLabel = b.terrace_confirmed ? 'terrasse confirmée' : 'terrasse probable';
  const cLabel = b.category === 'restaurant' ? 'resto' : 'bar/café';
  const badge = b.sunny ? '☀️' : '🌑';
  const name = b.name || '(sans nom)';

  let stabBadge = '';
  if (forecast && forecast.sunny) {
    stabBadge = forecast.stable
      ? `<span class="stab-badge stable">stable</span>`
      : `<span class="stab-badge fugace">fugace</span>`;
  }

  let body;
  if (!forecast) {
    body = `<div class="popup-note">calcul…</div>`;
  } else if (forecast.sunny && forecast.minutes_left != null) {
    if (forecast.minutes_left === 0) {
      body = `<div class="popup-note">sur le point de passer à l'ombre</div>`;
    } else {
      const d = fmtDur(forecast.minutes_left);
      const suffix = forecast.capped ? '+' : '';
      const at = forecast.shadow_at ? `<div class="popup-hero-sub">jusqu'à ${fmtTime(forecast.shadow_at)}</div>` : '';
      body = `<div class="popup-hero">
        <div class="popup-hero-metric">${d}${suffix}</div>
        <div class="popup-hero-label">encore au soleil</div>
        ${at}
      </div>`;
    }
  } else if (!forecast.sunny && forecast.minutes_until_sunny != null) {
    const at = forecast.sun_at ? `<div class="popup-hero-sub">dès ${fmtTime(forecast.sun_at)}</div>` : '';
    body = `<div class="popup-hero">
      <div class="popup-hero-metric shadow">${fmtDur(forecast.minutes_until_sunny)}</div>
      <div class="popup-hero-label">au soleil dans</div>
      ${at}
    </div>`;
  } else {
    const msg = forecast.sunny ? 'soleil jusqu\'au coucher' : 'à l\'ombre jusqu\'au coucher';
    body = `<div class="popup-note">${msg}</div>`;
  }

  const alreadyReported = localStorage.getItem('reported:' + b.id);
  const footer = alreadyReported
    ? `<div class="popup-footer muted">✓ signalé</div>`
    : `<div class="popup-footer"><a href="#" class="report-link" data-bar-id="${b.id}">signaler</a></div>`;

  return `<div class="popup-card" data-bar-id="${b.id}">
    <div class="popup-head">
      <div class="popup-title">${name} ${stabBadge}</div>
      <div class="popup-badge">${badge}</div>
    </div>
    <div class="popup-meta">${tLabel} · ${cLabel}</div>
    ${body}
    ${footer}
  </div>`;
}

function reportFormHTML(b) {
  const name = b.name || '(sans nom)';
  return `<div class="popup-card report-form" data-bar-id="${b.id}">
    <div class="popup-head">
      <div class="popup-title">Signaler — ${name}</div>
    </div>
    <div class="report-body">
      <label class="rf-radio"><input type="radio" name="rtype" value="has_terrace"> 🪑 Terrasse bien présente <span class="rf-hint">confirmer</span></label>
      <label class="rf-radio"><input type="radio" name="rtype" value="has_sun"> ☀️ Soleil bien présent <span class="rf-hint">confirmer</span></label>
      <label class="rf-radio"><input type="radio" name="rtype" value="no_terrace"> Pas de terrasse ici</label>
      <label class="rf-radio"><input type="radio" name="rtype" value="no_sun"> Pas de soleil ici</label>
      <div class="rf-sub" hidden>
        <label class="rf-radio"><input type="radio" name="rsub" value="no_sun_temporary"> Ponctuel <span class="rf-hint">parasol, travaux…</span></label>
        <label class="rf-radio"><input type="radio" name="rsub" value="no_sun_permanent"> Permanent <span class="rf-hint">arbre, bâtiment…</span></label>
      </div>
      <div class="rf-actions">
        <button class="rf-cancel" type="button">annuler</button>
        <button class="rf-submit" type="button" disabled>envoyer</button>
      </div>
      <div class="rf-status"></div>
    </div>
  </div>`;
}

function wireReportForm(popup, b) {
  const root = popup.getElement();
  const link = root.querySelector('.report-link');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      popup.setHTML(reportFormHTML(b));
      wireReportForm(popup, b);
    });
    return;
  }
  const form = root.querySelector('.report-form');
  if (!form) return;
  const sub = form.querySelector('.rf-sub');
  const submitBtn = form.querySelector('.rf-submit');
  const cancelBtn = form.querySelector('.rf-cancel');
  const status = form.querySelector('.rf-status');

  function computeType() {
    const top = form.querySelector('input[name="rtype"]:checked')?.value;
    if (!top) return null;
    if (top !== 'no_sun') return top;
    return form.querySelector('input[name="rsub"]:checked')?.value || null;
  }
  function refresh() {
    const top = form.querySelector('input[name="rtype"]:checked')?.value;
    sub.hidden = (top !== 'no_sun');
    submitBtn.disabled = !computeType();
  }
  form.querySelectorAll('input[type="radio"]').forEach(r => r.addEventListener('change', refresh));

  cancelBtn.addEventListener('click', () => {
    popup.setHTML(popupHTML(b, popup._forecast || null));
    wireReportForm(popup, b);
  });

  submitBtn.addEventListener('click', async () => {
    const t = computeType();
    if (!t) return;
    submitBtn.disabled = true;
    status.textContent = 'envoi…';
    status.className = 'rf-status';
    try {
      const r = await fetch('/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bar_id: b.id, type: t, datetime: whenInput.value }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
      localStorage.setItem('reported:' + b.id, '1');
      status.textContent = '✓ merci, ça aide à améliorer le site';
      status.className = 'rf-status ok';
      setTimeout(() => popup.remove(), 1800);
    } catch (err) {
      status.textContent = 'erreur : ' + err.message;
      status.className = 'rf-status err';
      submitBtn.disabled = false;
    }
  });
}

async function hydratePopup(popup, b) {
  try {
    const r = await fetch(`/forecast?id=${encodeURIComponent(b.id)}&datetime=${encodeURIComponent(whenInput.value)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const f = await r.json();
    popup._forecast = f;
    if (popup.isOpen()) {
      popup.setHTML(popupHTML(b, f));
      wireReportForm(popup, b);
    }
  } catch (err) {
    if (popup.isOpen()) {
      popup.setHTML(`<div class="popup-card"><div class="popup-head"><div class="popup-title">${b.name||'(sans nom)'}</div></div><div class="popup-note">erreur : ${err.message}</div></div>`);
    }
  }
}

function renderWeather() {
  const w = lastData?.weather;
  if (!w) { weatherEl.classList.add('hidden'); return; }
  weatherEl.classList.remove('hidden', 'warn', 'bad');
  if (w.rain) weatherEl.classList.add('bad');
  else if (w.overcast) weatherEl.classList.add('warn');
  const icon = w.rain ? '🌧️' : w.overcast ? '☁️' : '🌤️';
  const txt = w.warning ? `${icon} ${w.warning}` : `${icon} ${w.cloud_cover.toFixed(0)}% nuages · ${w.temperature.toFixed(0)}°C`;
  weatherEl.textContent = txt;
}

function render() {
  if (!lastData) return;
  const cat = filterSel.value;
  const onlyStable = stableOnly?.checked;
  const bars = lastData.bars.filter(b => {
    if (cat !== 'all' && b.category !== cat) return false;
    if (onlyStable && !(b.sunny && b.stable)) return false;
    return true;
  });

  let sunny = 0, sunnyConfirmed = 0, confirmed = 0;
  const features = [];
  for (const b of bars) {
    if (b.sunny) sunny++;
    if (b.terrace_confirmed) {
      confirmed++;
      if (b.sunny) sunnyConfirmed++;
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
      properties: {
        sunny: !!b.sunny,
        stable: !!b.stable,
        confirmed: !!b.terrace_confirmed,
        bar: JSON.stringify(b),
      },
    });
  }
  const src = map.getSource('bars');
  if (src) src.setData({ type: 'FeatureCollection', features });

  stats.textContent = `${sunnyConfirmed}/${confirmed} confirmés au soleil · ${sunny}/${bars.length} total · ${lastData.elevation.toFixed(0)}° az ${lastData.azimuth.toFixed(0)}°`;
  renderWeather();
  syncSlider();
}

async function fetchShadows() {
  try {
    const r = await fetch(`/shadows?datetime=${encodeURIComponent(whenInput.value)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const geo = await r.json();
    const src = map.getSource('shadows');
    if (src) src.setData(geo);
  } catch (err) {
    console.error('shadows fetch failed', err);
  }
}

async function refresh() {
  if (!whenInput.value) { stats.textContent = 'saisis une date'; return; }
  stats.textContent = 'calcul…';
  try {
    const r = await fetch(`/sunshine?datetime=${encodeURIComponent(whenInput.value)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    lastData = await r.json();
  } catch (err) {
    console.error('sunshine fetch failed', err);
    stats.textContent = `erreur : ${err.message}`;
    return;
  }
  render();
  if (map.isStyleLoaded()) fetchShadows();
  else map.once('idle', fetchShadows);
}

function setNow() { whenInput.value = localISO(new Date()); refresh(); }

const SLIDER_STEP_MIN = 15;
let sliderSunrise = null, sliderSunset = null;

function syncSlider() {
  if (!lastData?.sunrise || !lastData?.sunset) {
    slider.disabled = true; timeLabel.textContent = '--:--';
    return;
  }
  sliderSunrise = new Date(lastData.sunrise);
  sliderSunset = new Date(lastData.sunset);
  const totalMin = Math.round((sliderSunset - sliderSunrise) / 60000);
  const steps = Math.max(1, Math.floor(totalMin / SLIDER_STEP_MIN));
  const cur = new Date(whenInput.value);
  let idx = Math.round((cur - sliderSunrise) / 60000 / SLIDER_STEP_MIN);
  idx = Math.max(0, Math.min(steps, idx));
  slider.min = 0; slider.max = steps; slider.value = idx;
  slider.disabled = false;
  const t = new Date(sliderSunrise.getTime() + idx * SLIDER_STEP_MIN * 60000);
  timeLabel.textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

let sliderDebounce = null;
slider.addEventListener('input', () => {
  if (!sliderSunrise) return;
  const idx = Number(slider.value);
  const t = new Date(sliderSunrise.getTime() + idx * SLIDER_STEP_MIN * 60000);
  timeLabel.textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  whenInput.value = localISO(t);
  clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(refresh, 200);
});

document.getElementById('now').addEventListener('click', setNow);
whenInput.addEventListener('change', refresh);
whenInput.addEventListener('input', refresh);
filterSel.addEventListener('change', render);
stableOnly?.addEventListener('change', render);

// --- Search / autocomplete ---
fetch('/data/streets_18e.json').then(r => r.json()).then(s => { streets = s; }).catch(() => {});

function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

let activeIdx = -1;
let currentSuggestions = [];

function showSuggestions(q) {
  const nq = normalize(q.trim());
  if (!nq) { suggestBox.style.display = 'none'; currentSuggestions = []; return; }
  const venues = (lastData?.bars || [])
    .filter(b => b.name && b.name !== '(sans nom)' && normalize(b.name).includes(nq))
    .slice(0, 8)
    .map(b => ({ kind: b.category === 'restaurant' ? 'resto' : 'bar/café',
                 label: b.name, lat: b.lat, lon: b.lon, zoom: 18 }));
  const streetHits = streets
    .filter(s => normalize(s.name).includes(nq))
    .slice(0, 8)
    .map(s => ({ kind: 'rue', label: s.name, lat: s.lat, lon: s.lon, zoom: 17 }));
  currentSuggestions = [...venues, ...streetHits].slice(0, 12);
  activeIdx = -1;
  if (!currentSuggestions.length) { suggestBox.style.display = 'none'; return; }
  suggestBox.innerHTML = currentSuggestions.map((s, i) =>
    `<div data-i="${i}"><span class="kind">${s.kind}</span>${s.label}</div>`
  ).join('');
  suggestBox.style.display = 'block';
}

function pick(i) {
  const s = currentSuggestions[i];
  if (!s) return;
  searchInput.value = s.label;
  suggestBox.style.display = 'none';
  map.flyTo({ center: [s.lon, s.lat], zoom: s.zoom, speed: 1.2 });
}

searchInput.addEventListener('input', () => showSuggestions(searchInput.value));
searchInput.addEventListener('focus', () => showSuggestions(searchInput.value));
searchInput.addEventListener('blur', () => setTimeout(() => { suggestBox.style.display = 'none'; }, 150));
searchInput.addEventListener('keydown', (e) => {
  if (!currentSuggestions.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = (activeIdx + 1) % currentSuggestions.length; }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = (activeIdx - 1 + currentSuggestions.length) % currentSuggestions.length; }
  else if (e.key === 'Enter') { e.preventDefault(); pick(activeIdx >= 0 ? activeIdx : 0); return; }
  else if (e.key === 'Escape') { suggestBox.style.display = 'none'; return; }
  else return;
  [...suggestBox.children].forEach((c, i) => c.classList.toggle('active', i === activeIdx));
});
suggestBox.addEventListener('mousedown', (e) => {
  const div = e.target.closest('div[data-i]');
  if (div) pick(Number(div.dataset.i));
});

map.on('load', () => { setNow(); });

// --- Mobile layout : move controls into bottom sheet + floating timebar ---
(function setupMobileLayout() {
  const mq = window.matchMedia('(max-width: 640px)');
  if (!mq.matches) return;

  const sheet = document.getElementById('sheet');
  const sheetSlots = document.getElementById('sheetSlots');
  const backdrop = document.getElementById('sheetBackdrop');
  const toggle = document.getElementById('sheetToggle');
  const timebar = document.getElementById('timebar');
  if (!sheet || !timebar) return;

  // Move time slider into floating bar
  const sliderWrap = document.querySelector('header .slider-wrap');
  if (sliderWrap) {
    const label = document.createElement('span');
    label.className = 'tb-label';
    label.id = 'tbLabel';
    timebar.appendChild(label);
    timebar.appendChild(sliderWrap.querySelector('#timeSlider'));
    // Mirror timeLabel into tb-label
    const updateTb = () => { label.textContent = timeLabel.textContent; };
    new MutationObserver(updateTb).observe(timeLabel, { childList: true, characterData: true, subtree: true });
    updateTb();
  }

  // Build sheet rows
  function row(labelText, el) {
    const r = document.createElement('div');
    r.className = 'sheet-row';
    if (labelText) {
      const l = document.createElement('label');
      l.textContent = labelText;
      r.appendChild(l);
    }
    r.appendChild(el);
    sheetSlots.appendChild(r);
  }
  const whenLabel = document.querySelector('header .ctrl-when');
  if (whenLabel) row('Quand', whenLabel.querySelector('#when'));
  const nowBtn = document.getElementById('now');
  if (nowBtn) { nowBtn.classList.add('sheet-now'); row('', nowBtn); }
  const filterEl = document.getElementById('filter');
  if (filterEl) row('Catégorie', filterEl);
  const stableLabel = document.querySelector('header .ctrl-stable');
  if (stableLabel) {
    stableLabel.classList.add('ctrl-stable');
    sheetSlots.appendChild(stableLabel);
  }
  const searchWrap = document.querySelector('header .search-wrap');
  if (searchWrap) row('Recherche', searchWrap);

  // Stats line at bottom of sheet
  const statsMirror = document.createElement('div');
  statsMirror.className = 'sheet-stats';
  sheetSlots.appendChild(statsMirror);
  new MutationObserver(() => { statsMirror.textContent = stats.textContent; })
    .observe(stats, { childList: true, characterData: true, subtree: true });

  // Toggle
  function open() { sheet.classList.add('open'); backdrop.classList.add('open'); }
  function close() { sheet.classList.remove('open'); backdrop.classList.remove('open'); }
  toggle.addEventListener('click', () => {
    sheet.classList.contains('open') ? close() : open();
  });
  backdrop.addEventListener('click', close);

  // Swipe-down to dismiss
  let startY = null;
  sheet.addEventListener('touchstart', (e) => {
    if (sheet.scrollTop > 0) return;
    startY = e.touches[0].clientY;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 60) { close(); startY = null; }
  }, { passive: true });
  sheet.addEventListener('touchend', () => { startY = null; });
})();
