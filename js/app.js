// ==============================

// 沖繩旅遊地圖 — 主邏輯

// ==============================


(function () {
  'use strict';

  // ==================== State ====================

  const STORAGE_KEY = 'okinawa_itinerary';
  const GITHUB_ITINERARY_URL = 'https://bingfenghung.github.io/okinawa-travel-pwa/data/itinerary.json';

  const state = {
    map: null,
    currentDay: 0,
    currentSpot: null,
    currentPosition: null,
    routeLayer: null,
    markerLayer: null,
    nearbyLayer: null,
    positionMarker: null,
    watchId: null,
    notifyTimers: [],
    deferredInstallPrompt: null,
    itinerary: loadItinerarySync(),
    darkMode: localStorage.getItem('darkMode') === 'true',
    mapPickMode: false,
    visitedSpots: loadVisitedSpots(),
    currencyRate: parseFloat(localStorage.getItem('okinawa_currency_rate')) || 0.22
  };

  // ==================== Data Persistence ====================

  // Synchronous load from localStorage (used at startup)

  function loadItinerarySync() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return normalizeItinerary(parsed);
        }
      }
    } catch (e) {
      console.warn('Failed to load itinerary:', e);
    }
    return JSON.parse(JSON.stringify(APP_DATA.itinerary));
  }

  // First-visit: fetch from GitHub if no localStorage data exists

  async function loadItineraryFromGitHub() {
    if (localStorage.getItem(STORAGE_KEY)) return false;
    try {
      const cacheBuster = '?t=' + Date.now();
      const res = await fetch(GITHUB_ITINERARY_URL + cacheBuster, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) throw new Error('Invalid format');
      state.itinerary = normalizeItinerary(data);
      saveItinerary();
      return true;
    } catch (e) {
      console.warn('Failed to fetch itinerary from GitHub:', e);
      return false;
    }
  }

  // Force reload from GitHub (user-triggered)

  async function reloadFromGitHub() {
    const btn = document.getElementById('btn-reload-github');
    const originalText = btn.textContent;
    btn.textContent = '⏳ 載入中...';
    btn.disabled = true;
    try {
      // Add cache-busting query to bypass GitHub Pages CDN cache

      const cacheBuster = '?t=' + Date.now();
      const res = await fetch(GITHUB_ITINERARY_URL + cacheBuster, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) throw new Error('Invalid format');
      state.itinerary = normalizeItinerary(data);
      state.currentDay = 0;
      state.currentSpot = null;
      saveItinerary();
      renderDayTabs();
      renderSpotList();
      showDayOnMap();
      scheduleNotifications();
      closeModal('settings-modal');
      alert('✅ 已從 GitHub 重新載入行程！（共 ' + data.length + ' 天）');
    } catch (e) {
      console.error('GitHub reload failed:', e);
      alert('❌ 載入失敗：' + e.message + '\n請確認網路連線或 GitHub 上有行程檔案。\nURL: ' + GITHUB_ITINERARY_URL);
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }

  function saveItinerary() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.itinerary));
    } catch (e) {
      console.warn('Failed to save itinerary:', e);
      alert('儲存失敗，可能是儲存空間不足。建議匯出 JSON 備份。');
    }
  }

  function normalizeItinerary(data) {
    return data.map((day, di) => ({
      day: day.day || di + 1,
      date: day.date || new Date(Date.now() + di * 86400000).toISOString().slice(0, 10),
      title: day.title || `Day ${di + 1}`,
      weather: day.weather || { icon: '🌤️', temp: '--°C', desc: '--', humidity: '--', wind: '--' },
      spots: Array.isArray(day.spots) ? day.spots.map(s => normalizeSpot(s)) : []
    }));
  }

  function normalizeSpot(s) {
    return {
      id: s.id || generateId(),
      name: s.name || '未命名景點',
      lat: Number(s.lat) || 26.3344,
      lng: Number(s.lng) || 127.7731,
      time: s.time || '09:00',
      duration: Number(s.duration) || 60,
      description: s.description || '',
      tips: s.tips || '',
      transportToNext: s.transportToNext || null,
      nearby: Array.isArray(s.nearby) ? s.nearby : []
    };
  }

  function generateId() {
    return 'sp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  // ==================== HTML Escaping ====================

  const _escEl = document.createElement('div');
  function esc(str) {
    _escEl.textContent = str || '';
    return _escEl.innerHTML;
  }

  // ==================== Visited Spots ====================

  function loadVisitedSpots() {
    try {
      return JSON.parse(localStorage.getItem('okinawa_visited') || '{}');
    } catch (e) { return {}; }
  }

  function toggleVisited(spotId) {
    if (state.visitedSpots[spotId]) {
      delete state.visitedSpots[spotId];
    } else {
      state.visitedSpots[spotId] = true;
    }
    localStorage.setItem('okinawa_visited', JSON.stringify(state.visitedSpots));
  }

  function isVisited(spotId) {
    return !!state.visitedSpots[spotId];
  }

  // ==================== Google Maps ====================

  function openGoogleMaps(lat, lng, name) {
    const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    window.open(url, '_blank');
  }

  // ==================== Map Init ====================

  function initMap() {
    state.map = L.map('map', {
      center: APP_DATA.center,
      zoom: APP_DATA.defaultZoom,
      zoomControl: true,
      attributionControl: false
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors'
    }).addTo(state.map);

    state.routeLayer = L.layerGroup().addTo(state.map);
    state.markerLayer = L.layerGroup().addTo(state.map);
    state.nearbyLayer = L.layerGroup().addTo(state.map);
  }

  // ==================== Custom Markers ====================

  function createIcon(className, label) {
    return L.divIcon({
      className: '',
      html: `<div class="custom-marker ${className}">${label}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });
  }

  // ==================== Sidebar Rendering ====================

  function renderDayTabs() {
    const container = document.getElementById('day-tabs');
    container.innerHTML = '';
    state.itinerary.forEach((day, i) => {
      const btn = document.createElement('button');
      btn.className = `day-tab ${i === state.currentDay ? 'active' : ''}`;
      const deleteHtml = state.itinerary.length > 1
        ? `<span class="day-tab-delete" data-day="${i}" title="刪除此天">✕</span>`
        : '';
      btn.innerHTML = `
        Day ${day.day} ${deleteHtml}
        <span class="tab-weather">${esc(day.weather.icon)} ${esc(day.weather.temp)}</span>
      `;
      btn.addEventListener('click', (e) => {
        if (e.target.closest('.day-tab-delete')) return;
        switchDay(i);
      });
      container.appendChild(btn);
    });

    // Delete day handlers

    container.querySelectorAll('.day-tab-delete').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const dayIdx = parseInt(el.dataset.day, 10);
        deleteDay(dayIdx);
      });
    });

    // Add day button

    const addBtn = document.createElement('button');
    addBtn.className = 'day-tab-add';
    addBtn.textContent = '＋';
    addBtn.title = '新增一天';
    addBtn.addEventListener('click', addDay);
    container.appendChild(addBtn);
  }

  function switchDay(dayIndex) {
    state.currentDay = dayIndex;
    state.currentSpot = null;
    renderDayTabs();
    renderSpotList();
    showDayOnMap();
  }

  function renderSpotList() {
    const container = document.getElementById('spot-list');
    container.innerHTML = '';
    const day = state.itinerary[state.currentDay];
    if (!day) return;

    const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

    day.spots.forEach((spot, i) => {
      // Spot card

      const card = document.createElement('div');
      card.className = `spot-card ${state.currentSpot === spot.id ? 'active' : ''} ${isVisited(spot.id) ? 'visited' : ''}`;
      card.dataset.spotIndex = i;
      card.dataset.spotId = spot.id;

      // Only enable drag on non-touch devices

      if (!isTouchDevice) {
        card.draggable = true;
      }

      const reorderHtml = isTouchDevice ? `
          <div class="spot-reorder" style="display:flex;gap:6px;">
            ${i > 0 ? `<button class="reorder-btn btn-move-up" data-idx="${i}">↑</button>` : ''}
            ${i < day.spots.length - 1 ? `<button class="reorder-btn btn-move-down" data-idx="${i}">↓</button>` : ''}
          </div>
      ` : '';

      card.innerHTML = `
        <div class="spot-header">
          <button class="spot-visited-btn btn-toggle-visited" data-spot-id="${spot.id}" title="打卡">${isVisited(spot.id) ? '✅' : '⬜'}</button>
          <span class="spot-name">${esc(spot.name)}</span>
          <span class="spot-time">${esc(spot.time)} · ${spot.duration}分</span>
        </div>
        <div class="spot-desc">${esc(spot.description)}</div>
        ${spot.tips ? `<div class="spot-tips">💡 ${esc(spot.tips)}</div>` : ''}
        <div class="spot-actions">
          <button class="spot-action-btn btn-navigate" data-spot-id="${spot.id}">🧭 導航</button>
          <button class="spot-action-btn btn-google-maps" data-lat="${spot.lat}" data-lng="${spot.lng}" data-name="${esc(spot.name)}">🗺️ Google Maps</button>
          ${spot.nearby && spot.nearby.length > 0 ? `<button class="spot-action-btn btn-nearby" data-spot-id="${spot.id}">🍜 附近美食</button>` : ''}
          <button class="spot-action-btn btn-photo" data-spot-id="${spot.id}">📸 拍照</button>
          <button class="spot-edit-btn btn-edit-spot" data-spot-id="${spot.id}" title="編輯">✏️</button>
          <button class="spot-edit-btn btn-delete-spot" data-spot-id="${spot.id}" title="刪除">🗑️</button>
          ${reorderHtml}
        </div>
      `;

      // Click to fly to spot

      card.addEventListener('click', (e) => {
        if (e.target.closest('.spot-action-btn') || e.target.closest('.reorder-btn') || e.target.closest('.spot-edit-btn') || e.target.closest('.spot-visited-btn')) return;
        selectSpot(spot);
      });

      // Drag & Drop (desktop only)

      if (!isTouchDevice) {
        card.addEventListener('dragstart', onDragStart);
        card.addEventListener('dragover', onDragOver);
        card.addEventListener('dragleave', onDragLeave);
        card.addEventListener('drop', onDrop);
        card.addEventListener('dragend', onDragEnd);
      }

      container.appendChild(card);

      // Transport connector

      if (spot.transportToNext && i < day.spots.length - 1) {
        const conn = document.createElement('div');
        conn.className = 'transport-connector';
        const icon = APP_DATA.transportIcons[spot.transportToNext.mode] || '➡️';
        conn.innerHTML = `
          <div class="transport-line" style="background:${spot.transportToNext.color}"></div>
          <div class="transport-info">
            ${icon} ${spot.transportToNext.note} · 約 ${spot.transportToNext.duration} 分鐘
          </div>
        `;
        container.appendChild(conn);
      }
    });

    // Bind action buttons

    container.querySelectorAll('.btn-navigate').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const spot = findSpot(btn.dataset.spotId);
        if (spot) navigateToSpot(spot);
      });
    });

    container.querySelectorAll('.btn-nearby').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const spot = findSpot(btn.dataset.spotId);
        if (spot) showNearbyFood(spot);
      });
    });

    container.querySelectorAll('.btn-photo').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const spot = findSpot(btn.dataset.spotId);
        if (spot) capturePhoto(spot);
      });
    });

    // Google Maps buttons

    container.querySelectorAll('.btn-google-maps').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openGoogleMaps(btn.dataset.lat, btn.dataset.lng, btn.dataset.name);
      });
    });

    // Visited toggle buttons

    container.querySelectorAll('.btn-toggle-visited').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleVisited(btn.dataset.spotId);
        renderSpotList();
      });
    });

    // Mobile reorder buttons

    container.querySelectorAll('.btn-move-up, .btn-move-down').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        const day = state.itinerary[state.currentDay];
        const targetIdx = btn.classList.contains('btn-move-up') ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= day.spots.length) return;
        const [moved] = day.spots.splice(idx, 1);
        day.spots.splice(targetIdx, 0, moved);
        recalcTimes(day);
        renderSpotList();
        showDayOnMap();
        saveItinerary();
      });
    });

    // Edit/Delete spot buttons

    container.querySelectorAll('.btn-edit-spot').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const spot = findSpot(btn.dataset.spotId);
        if (spot) openSpotEditor(spot);
      });
    });

    container.querySelectorAll('.btn-delete-spot').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSpot(btn.dataset.spotId);
      });
    });
  }

  function findSpot(id) {
    for (const day of state.itinerary) {
      const spot = day.spots.find(s => s.id === id);
      if (spot) return spot;
    }
    return null;
  }

  // ==================== Map Display ====================

  function showDayOnMap() {
    state.markerLayer.clearLayers();
    state.routeLayer.clearLayers();
    state.nearbyLayer.clearLayers();
    const day = state.itinerary[state.currentDay];
    if (!day) return;

    const bounds = [];

    day.spots.forEach((spot, i) => {
      const marker = L.marker([spot.lat, spot.lng], {
        icon: createIcon('marker-spot', i + 1)
      }).addTo(state.markerLayer);

      marker.bindPopup(`
        <div class="popup-title">${esc(spot.name)}</div>
        <div class="popup-detail">${esc(spot.time)} · ${spot.duration}分鐘</div>
      `);

      bounds.push([spot.lat, spot.lng]);
    });

    // Draw connecting lines between spots

    if (day.spots.length > 1) {
      for (let i = 0; i < day.spots.length - 1; i++) {
        const from = day.spots[i];
        const to = day.spots[i + 1];
        const transport = from.transportToNext;
        if (transport) {
          L.polyline(
            [[from.lat, from.lng], [to.lat, to.lng]],
            {
              color: transport.color || '#999',
              weight: 3,
              opacity: 0.4,
              dashArray: transport.mode === 'walk' ? '8, 8' : null
            }
          ).addTo(state.markerLayer);
        }
      }
    }

    if (bounds.length > 0) {
      state.map.fitBounds(bounds, { padding: [50, 50] });
    }
  }

  function selectSpot(spot) {
    state.currentSpot = spot.id;
    renderSpotList();
    state.map.flyTo([spot.lat, spot.lng], 15, { duration: 1 });
  }

  // ==================== Navigation (Route Drawing) ====================

  function navigateToSpot(spot) {
    state.routeLayer.clearLayers();
    state.currentSpot = spot.id;
    renderSpotList();

    if (!state.currentPosition) {
      getCurrentPosition().then(pos => {
        if (pos) drawRoute(pos, spot);
        else alert('無法取得目前位置，請確認 GPS 已開啟');
      });
    } else {
      drawRoute(state.currentPosition, spot);
    }
  }

  function drawRoute(fromPos, toSpot) {
    state.routeLayer.clearLayers();

    const from = [fromPos.lat, fromPos.lng];
    const to = [toSpot.lat, toSpot.lng];

    // Draw polyline

    const polyline = L.polyline([from, to], {
      color: '#e94560',
      weight: 4,
      opacity: 0.8,
      dashArray: '12, 8'
    }).addTo(state.routeLayer);

    // Current position marker

    L.marker(from, {
      icon: createIcon('marker-current', '📍')
    }).addTo(state.routeLayer).bindPopup('目前位置');

    // Destination marker

    L.marker(to, {
      icon: createIcon('marker-spot', '🏁')
    }).addTo(state.routeLayer).bindPopup(`
      <div class="popup-title">${esc(toSpot.name)}</div>
      <div class="popup-detail">${esc(toSpot.description)}</div>
    `);

    // Distance & estimated time

    const dist = calcDistance(from[0], from[1], to[0], to[1]);
    const estTime = Math.ceil(dist / 40 * 60); // avg 40km/h


    L.popup()
      .setLatLng([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2])
      .setContent(`
        <div class="popup-title">📏 距離 ${dist.toFixed(1)} km</div>
        <div class="popup-detail">🚗 預估 ${estTime} 分鐘 (平均時速 40km)</div>
      `)
      .openOn(state.map);

    state.map.fitBounds(polyline.getBounds(), { padding: [60, 60] });
  }

  // ==================== Geolocation ====================

  function getCurrentPosition() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          state.currentPosition = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude
          };
          updatePositionMarker();
          resolve(state.currentPosition);
        },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }

  function startWatchingPosition() {
    if (!navigator.geolocation) return;
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        state.currentPosition = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude
        };
        updatePositionMarker();
      },
      () => {},
      { enableHighAccuracy: true }
    );
  }

  function updatePositionMarker() {
    if (!state.currentPosition) return;
    if (state.positionMarker) {
      state.positionMarker.setLatLng([state.currentPosition.lat, state.currentPosition.lng]);
    } else {
      state.positionMarker = L.marker(
        [state.currentPosition.lat, state.currentPosition.lng],
        { icon: createIcon('marker-current', '📍') }
      ).addTo(state.map).bindPopup('目前位置');
    }
  }

  // ==================== Nearby Food ====================

  function showNearbyFood(spot) {
    state.nearbyLayer.clearLayers();
    if (!spot.nearby || spot.nearby.length === 0) {
      alert('此景點附近暫無美食資料');
      return;
    }

    state.map.flyTo([spot.lat, spot.lng], 16, { duration: 0.8 });

    spot.nearby.forEach(place => {
      const isConvenience = place.type === 'convenience';
      const icon = createIcon(
        isConvenience ? 'marker-convenience' : 'marker-food',
        isConvenience ? '🏪' : '🍴'
      );

      const marker = L.marker([place.lat, place.lng], { icon })
        .addTo(state.nearbyLayer);

      marker.bindPopup(`
        <div class="popup-title">${esc(place.name)}</div>
        ${place.cuisine ? `<div class="popup-detail">${esc(place.cuisine)}</div>` : ''}
        ${place.price ? `<div class="popup-price">${esc(place.price)}</div>` : ''}
      `);
    });
  }

  // ==================== Notifications ====================

  function initNotifications() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      document.getElementById('notification-banner').classList.remove('hidden');
    }
    if (Notification.permission === 'granted') {
      scheduleNotifications();
    }
  }

  function requestNotificationPermission() {
    Notification.requestPermission().then(perm => {
      document.getElementById('notification-banner').classList.add('hidden');
      if (perm === 'granted') {
        scheduleNotifications();
      }
    });
  }

  function scheduleNotifications() {
    // Clear existing timers

    state.notifyTimers.forEach(t => clearTimeout(t));
    state.notifyTimers = [];

    const now = new Date();

    state.itinerary.forEach(day => {
      day.spots.forEach(spot => {
        const [h, m] = spot.time.split(':').map(Number);
        const spotDate = new Date(day.date + 'T00:00:00');
        spotDate.setHours(h, m, 0, 0);

        // 15 minutes before

        const notifyTime = new Date(spotDate.getTime() - 15 * 60 * 1000);
        const delay = notifyTime.getTime() - now.getTime();

        if (delay > 0) {
          const timer = setTimeout(() => {
            new Notification('🌴 沖繩旅遊提醒', {
              body: `還有 15 分鐘就到 ${spot.name} 的時間囉！\n${spot.tips || ''}`,
              icon: 'icons/icon-192.svg',
              tag: spot.id
            });
          }, delay);
          state.notifyTimers.push(timer);
        }
      });
    });
  }

  // ==================== Expense Tracker ====================

  function getExpenses() {
    return JSON.parse(localStorage.getItem('okinawa_expenses') || '[]');
  }

  function saveExpenses(expenses) {
    localStorage.setItem('okinawa_expenses', JSON.stringify(expenses));
  }

  function addExpense() {
    const category = document.getElementById('expense-category').value;
    const name = document.getElementById('expense-name').value.trim();
    const amount = parseInt(document.getElementById('expense-amount').value, 10);

    if (!name || !amount || amount <= 0) {
      alert('請填寫項目名稱與金額');
      return;
    }

    const expenses = getExpenses();
    expenses.push({
      id: Date.now().toString(),
      category,
      name,
      amount,
      date: new Date().toISOString()
    });
    saveExpenses(expenses);

    document.getElementById('expense-name').value = '';
    document.getElementById('expense-amount').value = '';
    renderExpenses();
  }

  function deleteExpense(id) {
    const expenses = getExpenses().filter(e => e.id !== id);
    saveExpenses(expenses);
    renderExpenses();
  }

  function renderExpenses() {
    const expenses = getExpenses();
    const summaryEl = document.getElementById('expense-summary');
    const listEl = document.getElementById('expense-list');

    // Summary

    const totals = {};
    let grandTotal = 0;
    expenses.forEach(e => {
      totals[e.category] = (totals[e.category] || 0) + e.amount;
      grandTotal += e.amount;
    });

    summaryEl.innerHTML = `
      <span class="expense-total">合計 ¥${grandTotal.toLocaleString()}</span>
      ${Object.entries(totals).map(([cat, amt]) =>
        `<span class="expense-tag">${APP_DATA.expenseCategories[cat] || cat} ¥${amt.toLocaleString()}</span>`
      ).join('')}
    `;

    // List
    listEl.innerHTML = expenses.sort((a, b) => b.date.localeCompare(a.date)).map(e => `
      <div class="expense-item">
        <div class="expense-item-info">
          <span>${APP_DATA.expenseCategories[e.category] || ''}</span>
          <strong>${e.name}</strong>
        </div>
        <span class="expense-item-amount">¥${e.amount.toLocaleString()}</span>
        <button class="expense-delete" data-id="${e.id}" title="刪除">🗑️</button>
      </div>
    `).join('');

    listEl.querySelectorAll('.expense-delete').forEach(btn => {
      btn.addEventListener('click', () => deleteExpense(btn.dataset.id));
    });
  }

  // ==================== Checklist ====================

  function getChecklist() {
    const saved = JSON.parse(localStorage.getItem('okinawa_checklist') || '{}');
    return APP_DATA.checklist.map(item => ({
      ...item,
      checked: saved[item.id] || false
    }));
  }

  function toggleChecklistItem(id) {
    const saved = JSON.parse(localStorage.getItem('okinawa_checklist') || '{}');
    saved[id] = !saved[id];
    localStorage.setItem('okinawa_checklist', JSON.stringify(saved));
    renderChecklist();
  }

  function renderChecklist() {
    const items = getChecklist();
    const container = document.getElementById('checklist-items');
    const categories = [...new Set(items.map(i => i.category))];

    container.innerHTML = categories.map(cat => `
      <div class="checklist-category">${cat}</div>
      ${items.filter(i => i.category === cat).map(item => `
        <div class="checklist-item ${item.checked ? 'checked' : ''}">
          <input type="checkbox" id="ck-${item.id}" ${item.checked ? 'checked' : ''} data-id="${item.id}">
          <label for="ck-${item.id}">${item.name}</label>
        </div>
      `).join('')}
    `).join('');

    container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => toggleChecklistItem(cb.dataset.id));
    });
  }

  // ==================== Weather API (Open-Meteo) ====================

  const WEATHER_CACHE_KEY = 'okinawa_weather_cache';
  const WEATHER_CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours


  function getWeatherIconAndDesc(wmoCode) {
    const map = {
      0: { icon: '☀️', desc: '晴天' },
      1: { icon: '🌤️', desc: '大致晴朗' },
      2: { icon: '⛅', desc: '多雲' },
      3: { icon: '☁️', desc: '陰天' },
      45: { icon: '🌫️', desc: '霧' },
      48: { icon: '🌫️', desc: '霧凇' },
      51: { icon: '🌦️', desc: '小毛毛雨' },
      53: { icon: '🌦️', desc: '毛毛雨' },
      55: { icon: '🌧️', desc: '大毛毛雨' },
      61: { icon: '🌧️', desc: '小雨' },
      63: { icon: '🌧️', desc: '中雨' },
      65: { icon: '🌧️', desc: '大雨' },
      71: { icon: '❄️', desc: '小雪' },
      73: { icon: '❄️', desc: '中雪' },
      75: { icon: '❄️', desc: '大雪' },
      80: { icon: '🌦️', desc: '陣雨' },
      81: { icon: '🌧️', desc: '中陣雨' },
      82: { icon: '⛈️', desc: '大陣雨' },
      95: { icon: '⛈️', desc: '雷陣雨' },
      96: { icon: '⛈️', desc: '雷陣雨伴冰雹' },
      99: { icon: '⛈️', desc: '強雷陣雨伴冰雹' }
    };
    return map[wmoCode] || { icon: '🌤️', desc: `天氣代碼 ${wmoCode}` };
  }

  function getWindDirection(degrees) {
    const dirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
    return dirs[Math.round(degrees / 45) % 8] + '風';
  }

  async function fetchWeatherFromAPI() {
    // Check cache

    try {
      const cached = JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY) || '{}');
      if (cached.data && cached.timestamp && (Date.now() - cached.timestamp < WEATHER_CACHE_TTL)) {
        return cached.data;
      }
    } catch (e) { /* ignore */ }

    // Collect dates from itinerary

    const dates = state.itinerary.map(d => d.date).filter(Boolean);
    if (dates.length === 0) return null;

    const startDate = dates[0];
    const endDate = dates[dates.length - 1];

    // Open-Meteo forecast API (free, no key needed, up to 16 days)

    const url = `https://api.open-meteo.com/v1/forecast?latitude=26.33&longitude=127.77&daily=weather_code,temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean,wind_speed_10m_max,wind_direction_10m_dominant&start_date=${startDate}&end_date=${endDate}&timezone=Asia%2FTokyo`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      if (!json.daily || !json.daily.time) return null;

      const weatherMap = {};
      json.daily.time.forEach((date, i) => {
        const wmo = json.daily.weather_code[i];
        const { icon, desc } = getWeatherIconAndDesc(wmo);
        const tMax = Math.round(json.daily.temperature_2m_max[i]);
        const tMin = Math.round(json.daily.temperature_2m_min[i]);
        const humidity = json.daily.relative_humidity_2m_mean ? Math.round(json.daily.relative_humidity_2m_mean[i]) : '--';
        const windSpeed = Math.round(json.daily.wind_speed_10m_max[i] / 3.6); // km/h → m/s

        const windDir = json.daily.wind_direction_10m_dominant ? getWindDirection(json.daily.wind_direction_10m_dominant[i]) : '';

        weatherMap[date] = {
          icon,
          temp: `${tMax}°C / ${tMin}°C`,
          desc,
          humidity: `${humidity}%`,
          wind: `${windDir} ${windSpeed}m/s`
        };
      });

      // Cache result

      try {
        localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ data: weatherMap, timestamp: Date.now() }));
      } catch (e) { /* ignore */ }

      return weatherMap;
    } catch (e) {
      console.warn('Weather API failed:', e);
      return null;
    }
  }

  async function updateWeatherData() {
    const weatherMap = await fetchWeatherFromAPI();
    if (!weatherMap) return false;

    let updated = false;
    state.itinerary.forEach(day => {
      if (day.date && weatherMap[day.date]) {
        day.weather = weatherMap[day.date];
        updated = true;
      }
    });

    if (updated) {
      saveItinerary();
      renderDayTabs();
    }
    return updated;
  }

  // ==================== Weather Display ====================

  function renderWeather() {
    const container = document.getElementById('weather-list');

    // Show loading state + trigger API fetch

    container.innerHTML = '<div style="text-align:center;padding:20px;color:#888;">⏳ 正在取得最新天氣資料...</div>';

    fetchWeatherFromAPI().then(weatherMap => {
      if (weatherMap) {
        state.itinerary.forEach(day => {
          if (day.date && weatherMap[day.date]) {
            day.weather = weatherMap[day.date];
          }
        });
        saveItinerary();
        renderDayTabs();
      }

      // Check if any date is within forecast range

      const now = new Date();
      const firstDate = new Date(state.itinerary[0]?.date);
      const daysDiff = Math.ceil((firstDate - now) / 86400000);
      const forecastNote = daysDiff > 16
        ? `<div class="weather-note">📅 行程日期尚未進入預報範圍（約 ${daysDiff} 天後），天氣資料將在出發前 ~16 天內自動更新</div>`
        : weatherMap
          ? '<div class="weather-note">✅ 已從 Open-Meteo 取得即時預報</div>'
          : '<div class="weather-note">⚠️ 無法取得天氣資料，顯示的是快取或預設值</div>';

      container.innerHTML = forecastNote + state.itinerary.map(day => `
        <div class="weather-card">
          <div class="weather-icon">${day.weather.icon}</div>
          <div class="weather-info">
            <h3>${esc(day.title)}</h3>
            <div class="weather-date">${day.date || ''}</div>
            <div class="weather-temp">${day.weather.temp}</div>
            <div class="weather-detail">${day.weather.desc} · ${day.weather.humidity} · ${day.weather.wind}</div>
          </div>
        </div>
      `).join('');
    });
  }

  // ==================== Photo Capture ====================

  function getPhotos() {
    return JSON.parse(localStorage.getItem('okinawa_photos') || '{}');
  }

  function savePhoto(spotId, dataUrl) {
    const photos = getPhotos();
    if (!photos[spotId]) photos[spotId] = [];
    photos[spotId].push({ url: dataUrl, date: new Date().toISOString() });
    localStorage.setItem('okinawa_photos', JSON.stringify(photos));
  }

  function capturePhoto(spot) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        // Compress to max 200KB

        compressImage(ev.target.result, 800, 0.7).then(compressed => {
          savePhoto(spot.id, compressed);
          renderPhotoGallery();
        });
      };
      reader.readAsDataURL(file);
    });
    input.click();
  }

  function compressImage(dataUrl, maxWidth, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ratio = Math.min(maxWidth / img.width, 1);
        canvas.width = img.width * ratio;
        canvas.height = img.height * ratio;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = dataUrl;
    });
  }

  function renderPhotoGallery() {
    const photos = getPhotos();
    const container = document.getElementById('photo-gallery');
    const allSpots = state.itinerary.flatMap(d => d.spots);

    container.innerHTML = allSpots
      .filter(spot => photos[spot.id] && photos[spot.id].length > 0)
      .map(spot => `
        <div class="photo-spot-section">
          <div class="photo-spot-title">📍 ${esc(spot.name)}</div>
          <div class="photo-grid">
            ${photos[spot.id].map(p =>
              `<img src="${p.url}" alt="${spot.name}" loading="lazy">`
            ).join('')}
          </div>
        </div>
      `).join('') || '<p style="color:var(--text-secondary);text-align:center;padding:40px 0;">還沒有照片，去景點拍一張吧！📸</p>';
  }

  // ==================== Dark Mode ====================

  function toggleDarkMode() {
    state.darkMode = !state.darkMode;
    document.body.classList.toggle('dark', state.darkMode);
    localStorage.setItem('darkMode', state.darkMode);
    const btn = document.getElementById('btn-darkmode');
    btn.textContent = state.darkMode ? '☀️' : '🌙';
  }

  function applyDarkMode() {
    if (state.darkMode) {
      document.body.classList.add('dark');
      document.getElementById('btn-darkmode').textContent = '☀️';
    }
  }

  // ==================== Drag & Drop (Reorder Spots) ====================

  let dragIndex = null;

  function onDragStart(e) {
    dragIndex = parseInt(e.currentTarget.dataset.spotIndex, 10);
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragIndex.toString());
  }

  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
  }

  function onDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
  }

  function onDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const toIndex = parseInt(e.currentTarget.dataset.spotIndex, 10);
    if (dragIndex === null || dragIndex === toIndex) return;

    const day = state.itinerary[state.currentDay];
    const [moved] = day.spots.splice(dragIndex, 1);
    day.spots.splice(toIndex, 0, moved);

    // Recalculate times

    recalcTimes(day);
    renderSpotList();
    showDayOnMap();
    saveItinerary();
  }

  function onDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    dragIndex = null;
  }

  function recalcTimes(day) {
    if (day.spots.length === 0) return;
    let [h, m] = day.spots[0].time.split(':').map(Number);

    day.spots.forEach((spot, i) => {
      spot.time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      m += spot.duration;
      if (spot.transportToNext && i < day.spots.length - 1) {
        m += spot.transportToNext.duration;
      }
      h += Math.floor(m / 60);
      m = m % 60;
    });
  }

  // ==================== Sidebar Toggle ====================

  function initSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    const handle = document.getElementById('sheet-handle');
    const isMobile = () => window.innerWidth <= 768;

    // Desktop: simple toggle via button

    toggle.addEventListener('click', () => {
      const isCollapsed = sidebar.classList.toggle('collapsed');
      toggle.textContent = isCollapsed ? '▶' : '◀';
      setTimeout(() => state.map.invalidateSize(), 350);
    });

    // Mobile: half ↔ collapsed via swipe, tap handle → open fullscreen modal

    let sheetCollapsed = false;

    function collapseSheet() {
      sheetCollapsed = true;
      sidebar.classList.add('collapsed');
      setTimeout(() => state.map.invalidateSize(), 350);
    }

    function expandSheetHalf() {
      sheetCollapsed = false;
      sidebar.classList.remove('collapsed');
      setTimeout(() => state.map.invalidateSize(), 350);
    }

    // Tap handle → open fullscreen itinerary modal

    handle.addEventListener('click', () => {
      if (!isMobile()) return;
      openItineraryModal();
    });

    // Swipe on handle

    let touchStartY = 0;
    let touchStartTime = 0;

    handle.addEventListener('touchstart', (e) => {
      if (!isMobile()) return;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
    }, { passive: true });

    handle.addEventListener('touchmove', (e) => {
      e.preventDefault();
    }, { passive: false });

    handle.addEventListener('touchend', (e) => {
      if (!isMobile()) return;
      const dy = e.changedTouches[0].clientY - touchStartY;
      const dt = Date.now() - touchStartTime;
      const velocity = Math.abs(dy) / dt;

      if (Math.abs(dy) < 30 && velocity < 0.3) return; // too small, let click handle it


      if (dy < 0) {
        // Swipe UP → if collapsed restore half, else open fullscreen modal

        if (sheetCollapsed) expandSheetHalf();
        else openItineraryModal();
      } else {
        // Swipe DOWN → collapse

        if (!sheetCollapsed) collapseSheet();
      }
    }, { passive: true });

    // Re-invalidate map on resize

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!isMobile()) {
          sidebar.classList.remove('collapsed');
          toggle.textContent = sidebar.classList.contains('collapsed') ? '▶' : '◀';
        }
        state.map.invalidateSize();
      }, 200);
    });
  }

  // ==================== Fullscreen Itinerary Modal ====================

  function openItineraryModal() {
    renderModalDayTabs();
    renderModalSpotList();
    openModal('itinerary-modal');
  }

  function renderModalDayTabs() {
    const container = document.getElementById('modal-day-tabs');
    container.innerHTML = '';
    state.itinerary.forEach((day, i) => {
      const btn = document.createElement('button');
      btn.className = `day-tab ${i === state.currentDay ? 'active' : ''}`;
      btn.innerHTML = `
        Day ${day.day}
        <span class="tab-weather">${esc(day.weather.icon)} ${esc(day.weather.temp)}</span>
      `;
      btn.addEventListener('click', () => {
        state.currentDay = i;
        state.currentSpot = null;
        // Sync sidebar too

        renderDayTabs();
        renderSpotList();
        showDayOnMap();
        // Re-render modal

        renderModalDayTabs();
        renderModalSpotList();
      });
      container.appendChild(btn);
    });
  }

  function renderModalSpotList() {
    const container = document.getElementById('modal-spot-list');
    container.innerHTML = '';
    const day = state.itinerary[state.currentDay];
    if (!day || day.spots.length === 0) {
      container.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:40px 0;">這天還沒有行程，點 ＋ 新增景點吧！</p>';
      return;
    }

    const title = document.getElementById('itinerary-modal-title');
    title.textContent = '📍 ' + (day.title || 'Day ' + day.day);

    day.spots.forEach((spot, i) => {
      const card = document.createElement('div');
      card.className = `spot-card ${state.currentSpot === spot.id ? 'active' : ''} ${isVisited(spot.id) ? 'visited' : ''}`;

      card.innerHTML = `
        <div class="spot-header">
          <button class="spot-visited-btn btn-toggle-visited" data-spot-id="${spot.id}" title="打卡">${isVisited(spot.id) ? '✅' : '⬜'}</button>
          <span class="spot-name">${esc(spot.name)}</span>
          <span class="spot-time">${esc(spot.time)} · ${spot.duration}分</span>
        </div>
        <div class="spot-desc">${esc(spot.description)}</div>
        ${spot.tips ? `<div class="spot-tips">💡 ${esc(spot.tips)}</div>` : ''}
        <div class="spot-actions">
          <button class="spot-action-btn btn-navigate" data-spot-id="${spot.id}">🧭 導航</button>
          <button class="spot-action-btn btn-google-maps" data-lat="${spot.lat}" data-lng="${spot.lng}" data-name="${esc(spot.name)}">🗺️ Google Maps</button>
          ${spot.nearby && spot.nearby.length > 0 ? `<button class="spot-action-btn btn-nearby" data-spot-id="${spot.id}">🍜 附近美食</button>` : ''}
          <button class="spot-action-btn btn-photo" data-spot-id="${spot.id}">📸 拍照</button>
          <button class="spot-edit-btn btn-edit-spot" data-spot-id="${spot.id}" title="編輯">✏️</button>
          <button class="spot-edit-btn btn-delete-spot" data-spot-id="${spot.id}" title="刪除">🗑️</button>
          <div class="spot-reorder" style="display:flex;gap:6px;">
            ${i > 0 ? `<button class="reorder-btn btn-move-up" data-idx="${i}">↑</button>` : ''}
            ${i < day.spots.length - 1 ? `<button class="reorder-btn btn-move-down" data-idx="${i}">↓</button>` : ''}
          </div>
        </div>
      `;

      // Tap card → fly to spot on map & close modal

      card.addEventListener('click', (e) => {
        if (e.target.closest('.spot-action-btn') || e.target.closest('.reorder-btn') || e.target.closest('.spot-edit-btn') || e.target.closest('.spot-visited-btn')) return;
        selectSpot(spot);
        closeModal('itinerary-modal');
      });

      container.appendChild(card);

      // Transport connector

      if (spot.transportToNext && i < day.spots.length - 1) {
        const conn = document.createElement('div');
        conn.className = 'transport-connector';
        const icon = APP_DATA.transportIcons[spot.transportToNext.mode] || '➡️';
        conn.innerHTML = `
          <div class="transport-line" style="background:${spot.transportToNext.color}"></div>
          <div class="transport-info">
            ${icon} ${esc(spot.transportToNext.note)} · 約 ${spot.transportToNext.duration} 分鐘
          </div>
        `;
        container.appendChild(conn);
      }
    });

    // Bind action buttons in modal

    container.querySelectorAll('.btn-navigate').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const spot = findSpot(btn.dataset.spotId);
        if (spot) { navigateToSpot(spot); closeModal('itinerary-modal'); }
      });
    });

    container.querySelectorAll('.btn-nearby').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const spot = findSpot(btn.dataset.spotId);
        if (spot) { showNearbyFood(spot); closeModal('itinerary-modal'); }
      });
    });

    container.querySelectorAll('.btn-photo').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const spot = findSpot(btn.dataset.spotId);
        if (spot) capturePhoto(spot);
      });
    });

    // Google Maps buttons in modal

    container.querySelectorAll('.btn-google-maps').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openGoogleMaps(btn.dataset.lat, btn.dataset.lng, btn.dataset.name);
      });
    });

    // Visited toggle buttons in modal

    container.querySelectorAll('.btn-toggle-visited').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleVisited(btn.dataset.spotId);
        renderSpotList();
        renderModalSpotList();
      });
    });

    container.querySelectorAll('.btn-edit-spot').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const spot = findSpot(btn.dataset.spotId);
        if (spot) { closeModal('itinerary-modal'); openSpotEditor(spot); }
      });
    });

    container.querySelectorAll('.btn-delete-spot').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSpot(btn.dataset.spotId);
        renderModalSpotList();
      });
    });

    container.querySelectorAll('.btn-move-up, .btn-move-down').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        const d = state.itinerary[state.currentDay];
        const targetIdx = btn.classList.contains('btn-move-up') ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= d.spots.length) return;
        const [moved] = d.spots.splice(idx, 1);
        d.spots.splice(targetIdx, 0, moved);
        recalcTimes(d);
        saveItinerary();
        renderSpotList();
        showDayOnMap();
        renderModalSpotList();
      });
    });
  }

  // ==================== Modal Management ====================

  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }

  function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  }

  function initModals() {
    // Close buttons

    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => closeModal(btn.dataset.modal));
    });

    // Click backdrop to close

    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    });

    // Header buttons

    document.getElementById('btn-weather').addEventListener('click', () => {
      renderWeather();
      openModal('weather-modal');
    });

    document.getElementById('btn-expense').addEventListener('click', () => {
      renderExpenses();
      openModal('expense-modal');
    });

    document.getElementById('btn-checklist').addEventListener('click', () => {
      renderChecklist();
      openModal('checklist-modal');
    });

    document.getElementById('btn-photo').addEventListener('click', () => {
      renderPhotoGallery();
      openModal('photo-modal');
    });

    document.getElementById('btn-darkmode').addEventListener('click', toggleDarkMode);

    // Settings

    document.getElementById('btn-settings').addEventListener('click', () => {
      openModal('settings-modal');
    });

    // Expense add

    document.getElementById('expense-add').addEventListener('click', addExpense);

    // Notification banner

    document.getElementById('btn-allow-notify').addEventListener('click', requestNotificationPermission);
    document.getElementById('btn-dismiss-notify').addEventListener('click', () => {
      document.getElementById('notification-banner').classList.add('hidden');
    });
  }

  // ==================== PWA Install ====================

  function initPWAInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      document.getElementById('install-banner').classList.remove('hidden');
    });

    document.getElementById('btn-install').addEventListener('click', () => {
      if (state.deferredInstallPrompt) {
        state.deferredInstallPrompt.prompt();
        state.deferredInstallPrompt.userChoice.then(() => {
          state.deferredInstallPrompt = null;
          document.getElementById('install-banner').classList.add('hidden');
        });
      }
    });

    document.getElementById('btn-dismiss-install').addEventListener('click', () => {
      document.getElementById('install-banner').classList.add('hidden');
    });
  }

  // ==================== Service Worker ====================

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').then(reg => {
        console.log('Service Worker registered:', reg.scope);
      }).catch(err => {
        console.warn('SW registration failed:', err);
      });
    }
  }

  // ==================== Spot Editor ====================

  function openSpotEditor(existingSpot) {
    const form = document.getElementById('spot-editor-form');
    const title = document.getElementById('spot-editor-title');

    if (existingSpot) {
      title.textContent = '✏️ 編輯景點';
      document.getElementById('edit-spot-id').value = existingSpot.id;
      document.getElementById('edit-spot-name').value = existingSpot.name;
      document.getElementById('edit-spot-time').value = existingSpot.time;
      document.getElementById('edit-spot-duration').value = existingSpot.duration;
      document.getElementById('edit-spot-lat').value = existingSpot.lat;
      document.getElementById('edit-spot-lng').value = existingSpot.lng;
      document.getElementById('edit-spot-desc').value = existingSpot.description;
      document.getElementById('edit-spot-tips').value = existingSpot.tips;
      const t = existingSpot.transportToNext;
      document.getElementById('edit-transport-mode').value = t ? t.mode : '';
      document.getElementById('edit-transport-duration').value = t ? t.duration : '';
      document.getElementById('edit-transport-note').value = t ? t.note : '';
    } else {
      title.textContent = '✏️ 新增景點';
      form.reset();
      document.getElementById('edit-spot-id').value = '';
      document.getElementById('edit-spot-time').value = '09:00';
      document.getElementById('edit-spot-duration').value = '60';
    }

    openModal('spot-editor-modal');
  }

  function handleSpotEditorSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('edit-spot-id').value;
    const name = document.getElementById('edit-spot-name').value.trim();
    const lat = parseFloat(document.getElementById('edit-spot-lat').value);
    const lng = parseFloat(document.getElementById('edit-spot-lng').value);

    if (!name) { alert('請輸入景點名稱'); return; }
    if (isNaN(lat) || isNaN(lng)) { alert('請輸入有效的座標'); return; }

    const transportMode = document.getElementById('edit-transport-mode').value;
    const transportColors = { car: '#3498db', walk: '#f39c12', monorail: '#e74c3c', bus: '#27ae60', taxi: '#9b59b6' };
    const transport = transportMode ? {
      mode: transportMode,
      duration: parseInt(document.getElementById('edit-transport-duration').value, 10) || 0,
      note: document.getElementById('edit-transport-note').value.trim() || APP_DATA.transportIcons[transportMode] + ' 前往下一站',
      color: transportColors[transportMode] || '#999'
    } : null;

    const spotData = {
      id: id || generateId(),
      name,
      lat,
      lng,
      time: document.getElementById('edit-spot-time').value || '09:00',
      duration: parseInt(document.getElementById('edit-spot-duration').value, 10) || 60,
      description: document.getElementById('edit-spot-desc').value.trim(),
      tips: document.getElementById('edit-spot-tips').value.trim(),
      transportToNext: transport,
      nearby: []
    };

    const day = state.itinerary[state.currentDay];

    if (id) {
      // Edit existing

      const idx = day.spots.findIndex(s => s.id === id);
      if (idx >= 0) {
        spotData.nearby = day.spots[idx].nearby;
        day.spots[idx] = spotData;
      }
    } else {
      // Add new

      day.spots.push(spotData);
    }

    recalcTimes(day);
    saveItinerary();
    closeModal('spot-editor-modal');
    renderSpotList();
    showDayOnMap();
    scheduleNotifications();
  }

  function deleteSpot(spotId) {
    if (!confirm('確定要刪除這個景點嗎？')) return;
    const day = state.itinerary[state.currentDay];
    const idx = day.spots.findIndex(s => s.id === spotId);
    if (idx < 0) return;

    day.spots.splice(idx, 1);

    // Clear stale transport on new last spot

    if (day.spots.length > 0 && idx === day.spots.length) {
      day.spots[day.spots.length - 1].transportToNext = null;
    }

    if (state.currentSpot === spotId) {
      state.currentSpot = null;
    }

    recalcTimes(day);
    saveItinerary();
    renderSpotList();
    showDayOnMap();
    scheduleNotifications();
  }

  // ==================== Day Management ====================

  function addDay() {
    const lastDay = state.itinerary[state.itinerary.length - 1];
    const lastDate = lastDay ? new Date(lastDay.date + 'T00:00:00') : new Date();
    const nextDate = new Date(lastDate.getTime() + 86400000);

    state.itinerary.push({
      day: state.itinerary.length + 1,
      date: nextDate.toISOString().slice(0, 10),
      title: `Day ${state.itinerary.length + 1}`,
      weather: { icon: '🌤️', temp: '--°C', desc: '--', humidity: '--', wind: '--' },
      spots: []
    });

    saveItinerary();
    switchDay(state.itinerary.length - 1);
  }

  function deleteDay(dayIdx) {
    if (state.itinerary.length <= 1) return;
    if (!confirm(`確定要刪除 Day ${state.itinerary[dayIdx].day} 的所有行程嗎？`)) return;

    state.itinerary.splice(dayIdx, 1);

    // Renumber

    state.itinerary.forEach((d, i) => { d.day = i + 1; });

    // Clamp current day

    if (state.currentDay >= state.itinerary.length) {
      state.currentDay = state.itinerary.length - 1;
    }
    state.currentSpot = null;

    saveItinerary();
    renderDayTabs();
    renderSpotList();
    showDayOnMap();
    scheduleNotifications();
  }

  // ==================== Map Pick ====================

  function startMapPick() {
    state.mapPickMode = true;
    closeModal('spot-editor-modal');
    document.getElementById('map-pick-overlay').classList.remove('hidden');
    document.getElementById('fab-add-spot').classList.add('hidden');
    state.map.getContainer().style.cursor = 'crosshair';
    state.map.once('click', onMapPick);
  }

  function onMapPick(e) {
    document.getElementById('edit-spot-lat').value = e.latlng.lat.toFixed(4);
    document.getElementById('edit-spot-lng').value = e.latlng.lng.toFixed(4);
    endMapPick();
    openModal('spot-editor-modal');
  }

  function cancelMapPick() {
    state.map.off('click', onMapPick);
    endMapPick();
    openModal('spot-editor-modal');
  }

  function endMapPick() {
    state.mapPickMode = false;
    document.getElementById('map-pick-overlay').classList.add('hidden');
    document.getElementById('fab-add-spot').classList.remove('hidden');
    state.map.getContainer().style.cursor = '';
  }

  // ==================== Import / Export / Reset ====================

  function exportItinerary() {
    try {
      const json = JSON.stringify(state.itinerary, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `okinawa-itinerary-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('匯出失敗：' + e.message);
    }
  }

  function importItinerary() {
    document.getElementById('import-file').click();
  }

  function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!Array.isArray(data) || data.length === 0) {
          alert('無效的行程格式：需要是陣列');
          return;
        }
        if (!confirm(`即將載入 ${data.length} 天的行程，會覆蓋目前資料。確定嗎？`)) return;

        state.itinerary = normalizeItinerary(data);
        state.currentDay = 0;
        state.currentSpot = null;
        saveItinerary();
        renderDayTabs();
        renderSpotList();
        showDayOnMap();
        scheduleNotifications();
        closeModal('settings-modal');
        alert('✅ 行程匯入成功！');
      } catch (err) {
        alert('匯入失敗：JSON 格式錯誤\n' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function resetItinerary() {
    if (!confirm('確定要重置為預設行程嗎？所有自訂修改將會遺失。')) return;
    state.itinerary = JSON.parse(JSON.stringify(APP_DATA.itinerary));
    state.currentDay = 0;
    state.currentSpot = null;
    saveItinerary();
    renderDayTabs();
    renderSpotList();
    showDayOnMap();
    scheduleNotifications();
    closeModal('settings-modal');
  }

  // ==================== Init Itinerary Editor ====================

  function initItineraryEditor() {
    // FAB

    document.getElementById('fab-add-spot').addEventListener('click', () => openSpotEditor(null));

    // Spot editor form submit

    document.getElementById('spot-editor-form').addEventListener('submit', handleSpotEditorSubmit);

    // Map pick

    document.getElementById('btn-map-pick').addEventListener('click', startMapPick);
    document.getElementById('btn-cancel-pick').addEventListener('click', cancelMapPick);

    // Import / Export / Reset / GitHub reload

    document.getElementById('btn-export').addEventListener('click', exportItinerary);
    document.getElementById('btn-import').addEventListener('click', importItinerary);
    document.getElementById('import-file').addEventListener('change', handleImportFile);
    document.getElementById('btn-reset').addEventListener('click', resetItinerary);
    document.getElementById('btn-reload-github').addEventListener('click', () => {
      if (!confirm('確定要從 GitHub 重新載入行程嗎？會覆蓋目前資料。')) return;
      reloadFromGitHub();
    });

    document.getElementById('btn-clear-storage').addEventListener('click', () => {
      if (!confirm('⚠️ 確定要清空所有本機資料嗎？\n\n這會清除：行程、記帳紀錄、行前清單、照片、天氣快取等所有資料。\n\n此操作無法復原！')) return;
      localStorage.clear();
      alert('✅ 已清空所有 localStorage 資料，頁面即將重新載入。');
      location.reload();
    });
  }

  // ==================== Utilities ====================

  function calcDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function deg2rad(deg) { return deg * (Math.PI / 180); }

  // ==================== Travel Tools ====================

  const PHRASES_DATA = [
    { cat: '👋 基本招呼', items: [
      { jp: 'こんにちは', roman: 'Konnichiwa', zh: '你好' },
      { jp: 'ありがとうございます', roman: 'Arigatou gozaimasu', zh: '非常感謝' },
      { jp: 'すみません', roman: 'Sumimasen', zh: '不好意思/對不起' },
      { jp: 'はい / いいえ', roman: 'Hai / Iie', zh: '是/不是' },
      { jp: 'お願いします', roman: 'Onegaishimasu', zh: '拜託了/請' },
    ]},
    { cat: '🍜 餐廳用餐', items: [
      { jp: '〇名です', roman: '(kazu) mei desu', zh: '我們有○位' },
      { jp: 'メニューをください', roman: 'Menyuu o kudasai', zh: '請給我菜單' },
      { jp: 'これをください', roman: 'Kore o kudasai', zh: '請給我這個' },
      { jp: 'おすすめは何ですか？', roman: 'Osusume wa nan desu ka?', zh: '推薦什麼？' },
      { jp: 'お会計お願いします', roman: 'Okaikei onegaishimasu', zh: '請結帳' },
      { jp: 'おいしかったです', roman: 'Oishikatta desu', zh: '很好吃' },
      { jp: 'アレルギーがあります', roman: 'Arerugii ga arimasu', zh: '我有過敏' },
    ]},
    { cat: '🚗 交通問路', items: [
      { jp: '〇はどこですか？', roman: '(basho) wa doko desu ka?', zh: '○在哪裡？' },
      { jp: 'この住所に行きたいです', roman: 'Kono juusho ni ikitai desu', zh: '我想去這個地址' },
      { jp: '駅はどこですか？', roman: 'Eki wa doko desu ka?', zh: '車站在哪裡？' },
      { jp: 'タクシーを呼んでください', roman: 'Takushii o yonde kudasai', zh: '請幫我叫計程車' },
      { jp: 'レンタカーを借りたいです', roman: 'Rentakaa o karitai desu', zh: '我想租車' },
    ]},
    { cat: '🛍️ 購物', items: [
      { jp: 'いくらですか？', roman: 'Ikura desu ka?', zh: '多少錢？' },
      { jp: '試着できますか？', roman: 'Shichaku dekimasu ka?', zh: '可以試穿嗎？' },
      { jp: '免税できますか？', roman: 'Menzei dekimasu ka?', zh: '可以免稅嗎？' },
      { jp: 'カードで払えますか？', roman: 'Kaado de haraemasu ka?', zh: '可以刷卡嗎？' },
      { jp: '袋をください', roman: 'Fukuro o kudasai', zh: '請給我袋子' },
    ]},
    { cat: '🆘 緊急求助', items: [
      { jp: '助けてください！', roman: 'Tasukete kudasai!', zh: '請幫幫我！' },
      { jp: '警察を呼んでください', roman: 'Keisatsu o yonde kudasai', zh: '請叫警察' },
      { jp: '病院に行きたいです', roman: 'Byouin ni ikitai desu', zh: '我想去醫院' },
      { jp: '日本語がわかりません', roman: 'Nihongo ga wakarimasen', zh: '我不懂日語' },
      { jp: 'パスポートをなくしました', roman: 'Pasupooto o nakushimashita', zh: '我護照丟了' },
    ]},
    { cat: '🏨 住宿', items: [
      { jp: 'チェックインお願いします', roman: 'Chekkuin onegaishimasu', zh: '請幫我辦理入住' },
      { jp: 'チェックアウトは何時ですか？', roman: 'Chekkuauto wa nanji desu ka?', zh: '退房時間是幾點？' },
      { jp: 'Wi-Fiのパスワードは？', roman: 'Waifai no pasuwaado wa?', zh: 'Wi-Fi 密碼是？' },
      { jp: '荷物を預かってもらえますか？', roman: 'Nimotsu o azukatte moraemasu ka?', zh: '可以寄放行李嗎？' },
    ]},
  ];

  const EMERGENCY_DATA = [
    { icon: '🚨', title: '日本報警電話', detail: '遇到犯罪、交通事故', phone: '110' },
    { icon: '🚑', title: '火災 / 急救 / 救護車', detail: '火災、急病、受傷', phone: '119' },
    { icon: '🏥', title: '沖繩縣立南部醫療中心', detail: '〒901-1193 沖繩縣島尻郡南風原町字新川118-1', phone: '098-888-0123' },
    { icon: '🏥', title: '沖繩美軍醫院（急診）', detail: '可收治外國人，24 小時急診', phone: '098-743-7555' },
    { icon: '🇹🇼', title: '台北駐日經濟文化代表處（那霸）', detail: '〒900-0015 沖繩縣那霸市久茂地3-15-9\nアルテビル那覇 6F', phone: '098-862-7008' },
    { icon: '📞', title: 'Japan Visitor Hotline', detail: '觀光廳外國旅客諮詢熱線\n24小時對應、支援中文', phone: '050-3816-2787' },
    { icon: '💳', title: '信用卡掛失', detail: 'VISA: 00531-44-0022\nMastercard: 00531-11-3886\nJCB: 0120-794-082', phone: null },
    { icon: '📱', title: '海外急難救助（台灣外交部）', detail: '全球免付費緊急聯絡', phone: '+886-800-085-095' },
  ];

  function initTravelTools() {
    // Tools modal open

    document.getElementById('btn-tools').addEventListener('click', () => {
      openModal('tools-modal');
    });

    // Tab switching

    document.querySelectorAll('.tools-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tools-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tools-panel').forEach(p => p.classList.add('hidden'));
        tab.classList.add('active');
        document.getElementById('tools-' + tab.dataset.tab).classList.remove('hidden');
      });
    });

    // Currency converter

    initCurrencyConverter();

    // Render phrases & emergency (static content)

    renderPhrases();
    renderEmergencyInfo();
  }

  function initCurrencyConverter() {
    const jpyInput = document.getElementById('currency-jpy');
    const twdInput = document.getElementById('currency-twd');

    function updateRateDisplay() {
      document.getElementById('currency-rate-display').textContent =
        `1 JPY ≈ ${state.currencyRate.toFixed(4)} TWD`;
    }

    jpyInput.addEventListener('input', () => {
      const jpy = parseFloat(jpyInput.value) || 0;
      twdInput.value = jpy ? Math.round(jpy * state.currencyRate) : '';
    });

    twdInput.addEventListener('input', () => {
      const twd = parseFloat(twdInput.value) || 0;
      jpyInput.value = twd ? Math.round(twd / state.currencyRate) : '';
    });

    // Quick chips

    document.querySelectorAll('.currency-quick-chips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const jpy = parseInt(chip.dataset.jpy, 10);
        jpyInput.value = jpy;
        twdInput.value = Math.round(jpy * state.currencyRate);
      });
    });

    // Update rate from API

    document.getElementById('btn-update-rate').addEventListener('click', async () => {
      const btn = document.getElementById('btn-update-rate');
      btn.textContent = '⏳ 查詢中...';
      btn.disabled = true;
      try {
        const res = await fetch('https://api.exchangerate-api.com/v4/latest/JPY');
        const data = await res.json();
        if (data.rates && data.rates.TWD) {
          state.currencyRate = data.rates.TWD;
          localStorage.setItem('okinawa_currency_rate', state.currencyRate.toString());
          updateRateDisplay();
          // Re-calc if there's a value

          if (jpyInput.value) {
            twdInput.value = Math.round(parseFloat(jpyInput.value) * state.currencyRate);
          }
          btn.textContent = '✅ 已更新';
        } else {
          btn.textContent = '❌ 失敗';
        }
      } catch (e) {
        btn.textContent = '❌ 離線無法更新';
      }
      setTimeout(() => {
        btn.textContent = '🔄 更新匯率';
        btn.disabled = false;
      }, 2000);
    });

    updateRateDisplay();
  }

  function renderPhrases() {
    const container = document.getElementById('phrases-list');
    container.innerHTML = PHRASES_DATA.map(cat => `
      <div class="phrases-category">${cat.cat}</div>
      ${cat.items.map((p, i) => `
        <div class="phrase-card">
          <div class="phrase-text">
            <div class="phrase-jp">${esc(p.jp)}</div>
            <div class="phrase-roman">${esc(p.roman)}</div>
            <div class="phrase-zh">${esc(p.zh)}</div>
          </div>
          <button class="phrase-speak-btn" data-text="${esc(p.jp)}" title="朗讀">🔊</button>
        </div>
      `).join('')}
    `).join('');

    // TTS speak buttons

    container.querySelectorAll('.phrase-speak-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(btn.dataset.text);
          utterance.lang = 'ja-JP';
          utterance.rate = 0.85;
          window.speechSynthesis.speak(utterance);
        }
      });
    });
  }

  function renderEmergencyInfo() {
    const container = document.getElementById('emergency-list');
    container.innerHTML = EMERGENCY_DATA.map(e => `
      <div class="emergency-card">
        <div class="emergency-icon">${e.icon}</div>
        <div class="emergency-info">
          <div class="emergency-title">${esc(e.title)}</div>
          <div class="emergency-detail">${esc(e.detail)}</div>
        </div>
        ${e.phone ? `<a href="tel:${e.phone}" class="emergency-call-btn">📞 ${esc(e.phone)}</a>` : ''}
      </div>
    `).join('');
  }

  // ==================== App Init ====================
  async function init() {
    applyDarkMode();
    initMap();

    // On first visit, try to load from GitHub
    const fetched = await loadItineraryFromGitHub();
    if (fetched) {
      console.log('Loaded itinerary from GitHub');
    }

    renderDayTabs();
    renderSpotList();
    showDayOnMap();
    initSidebarToggle();
    initModals();
    initItineraryEditor();
    initTravelTools();

    // Google Drive 載入行程
    const btnGDrive = document.getElementById('btn-import-gdrive');
    if (btnGDrive) {
      btnGDrive.addEventListener('click', async () => {
        try {
          // 1. 載入 Google API script 與 Google Identity Services
          if (!window.gapi || !window.google) {
            await Promise.all([
              new Promise(res => {
                const script = document.createElement('script');
                script.src = 'https://apis.google.com/js/api.js';
                script.onload = res;
                document.body.appendChild(script);
              }),
              new Promise(res => {
                const script = document.createElement('script');
                script.src = 'https://accounts.google.com/gsi/client';
                script.onload = res;
                document.body.appendChild(script);
              })
            ]);
          }

          // 2. 初始化 gapi client (只需 API Key)
          await new Promise((resolve, reject) => {
            window.gapi.load('client', { callback: resolve, onerror: reject });
          });
          await window.gapi.client.init({
            apiKey: 'AIzaSyDG2M2uSIXncvYFKu-86taPiv46SoIziCM', // TODO: 請填入你的 Google API Key
            discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest']
          });

          // 3. 使用 Google Identity Services 取得 Access Token
          const tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: '395992156922-r8tuo6a0f6nk3u395ulej55j26f7b1ce.apps.googleusercontent.com', // TODO: 請填入你的 OAuth 2.0 Client ID
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: async (tokenResponse) => {
              if (tokenResponse.error !== undefined) {
                throw tokenResponse;
              }

              try {
                // 4. 取得 token 後，列出 JSON 檔案
                const response = await window.gapi.client.drive.files.list({
                  q: "mimeType='application/json' and trashed=false",
                  pageSize: 20,
                  fields: 'files(id, name)'
                });
                
                const files = response.result.files;
                if (!files || files.length === 0) {
                  alert('Google Drive 中沒有可用的 JSON 檔案');
                  return;
                }

                // 5. 選擇檔案
                const fileNameList = files.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
                const idx = prompt(`選擇要載入的檔案：\n${fileNameList}\n請輸入編號 (1-${files.length})`);
                if (!idx) return;
                
                const file = files[parseInt(idx, 10) - 1];
                if (!file) {
                  alert('無效的選擇');
                  return;
                }

                // 6. 下載檔案內容
                const fileRes = await window.gapi.client.drive.files.get({
                  fileId: file.id,
                  alt: 'media'
                });
                
                let data;
                try {
                  data = typeof fileRes.body === 'string' ? JSON.parse(fileRes.body) : fileRes.result;
                } catch (e) {
                  alert('檔案格式錯誤，請確認是正確的行程 JSON 檔案');
                  return;
                }

                // 7. 匯入資料
                if (!Array.isArray(data) || data.length === 0) {
                  alert('JSON 檔案內容格式不正確');
                  return;
                }
                
                state.itinerary = normalizeItinerary(data);
                state.currentDay = 0;
                state.currentSpot = null;
                saveItinerary();
                renderDayTabs();
                renderSpotList();
                showDayOnMap();
                scheduleNotifications && scheduleNotifications();
                closeModal && closeModal('settings-modal');
                alert('✅ 已成功從 Google Drive 載入行程！');

              } catch (err) {
                console.error(err);
                alert('取得檔案時發生錯誤：' + (err.message || JSON.stringify(err)));
              }
            }
          });

          // 觸發登入視窗
          tokenClient.requestAccessToken({ prompt: 'consent' });

        } catch (error) {
          console.error(error);
          alert('初始化 Google API 失敗，請確認你的 API 金鑰與 Client ID 是否正確。錯誤：' + (error.message || error.details || ''));
        }
      });
    }
    initNotifications();
    initPWAInstall();
    registerServiceWorker();
    startWatchingPosition();
    getCurrentPosition();

    // Fetch weather data in background
    updateWeatherData().then(updated => {
      if (updated) console.log('Weather data updated from API');
    });
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();