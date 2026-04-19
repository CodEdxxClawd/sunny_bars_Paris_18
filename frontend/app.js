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
      'circle-radius': ['case', ['get', 'confirmed'], 9, 6.5],
      'circle-color': '#ffffff',
      'circle-opacity': ['case', ['get', 'confirmed'], 1, 0.85],
    },
  });
  map.addLayer({
    id: 'bars-dot', type: 'circle', source: 'bars',
    paint: {
      'circle-radius': ['case', ['get', 'confirmed'], 7, 4.5],
      'circle-color': ['case', ['get', 'sunny'], '#f5b700', '#4a5b6b'],
      'circle-opacity': ['case', ['get', 'confirmed'], 1, 0.78],
      'circle-stroke-width': 0,
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

function popupHTML(b, forecast) {
  const tLabel = b.terrace_confirmed ? 'terrasse confirmée' : 'terrasse probable';
  const cLabel = b.category === 'restaurant' ? 'resto' : 'bar/café';
  const badge = b.sunny ? '☀️' : '🌑';
  const name = b.name || '(sans nom)';

  let body;
  if (!forecast) {
    body = `<div class="popup-note">calcul…</div>`;
  } else if (forecast.sunny && forecast.minutes_left != null) {
    if (forecast.minutes_left === 0) {
      body = `<div class="popup-note">sur le point de passer à l'ombre</div>`;
    } else {
      const d = fmtDur(forecast.minutes_left);
      const suffix = forecast.capped ? '+' : '';
      body = `<div class="popup-hero">
        <div class="popup-hero-metric">${d}${suffix}</div>
        <div class="popup-hero-label">encore au soleil</div>
      </div>`;
    }
  } else if (!forecast.sunny && forecast.minutes_until_sunny != null) {
    body = `<div class="popup-hero">
      <div class="popup-hero-metric shadow">${fmtDur(forecast.minutes_until_sunny)}</div>
      <div class="popup-hero-label">au soleil dans</div>
    </div>`;
  } else {
    const msg = forecast.sunny ? 'soleil jusqu\'au coucher' : 'à l\'ombre jusqu\'au coucher';
    body = `<div class="popup-note">${msg}</div>`;
  }

  return `<div class="popup-card">
    <div class="popup-head">
      <div class="popup-title">${name}</div>
      <div class="popup-badge">${badge}</div>
    </div>
    <div class="popup-meta">${tLabel} · ${cLabel}</div>
    ${body}
  </div>`;
}

async function hydratePopup(popup, b) {
  try {
    const r = await fetch(`/forecast?id=${encodeURIComponent(b.id)}&datetime=${encodeURIComponent(whenInput.value)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const f = await r.json();
    if (popup.isOpen()) popup.setHTML(popupHTML(b, f));
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
  const bars = lastData.bars.filter(b => cat === 'all' || b.category === cat);

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
