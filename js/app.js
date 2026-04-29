// ==============================

// 沖繩旅遊地圖 — 主邏輯

// ==============================


(function () {
  'use strict';

  // ==================== State ====================

  const STORAGE_KEY = 'okinawa_itinerary';
  const GITHUB_OWNER = 'ryanhsieh821';
  const GITHUB_REPO = 'TravelMap';
  const GITHUB_BRANCH = 'main';
  const GITHUB_ITINERARY_PATH = 'data/itinerary.json';
  const GITHUB_BACKUP_DIR = 'data/backup';
  const GITHUB_PAGES_BASE_URL = 'https://ryanhsieh821.github.io/TravelMap';
  const GITHUB_API_CONTENTS_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents`;
  const GITHUB_ITINERARY_URL = `${GITHUB_PAGES_BASE_URL}/${GITHUB_ITINERARY_PATH}`;

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
    appTitle: localStorage.getItem('okinawa_app_title') || '沖繩旅遊地圖',
    itinerary: loadItinerarySync(),
    darkMode: localStorage.getItem('darkMode') === 'true',
    mapPickMode: false,
    visitedSpots: loadVisitedSpots(),
    currencyRate: parseFloat(localStorage.getItem('okinawa_currency_rate')) || 0.22
  };

  // ==================== Data Persistence ====================

  function processImportedData(data) {
    let list = data;
    if (!Array.isArray(data)) {
      if (data.title) {
        state.appTitle = data.title;
        localStorage.setItem('okinawa_app_title', state.appTitle);
        document.title = state.appTitle;
        const titleEl = document.getElementById('app-title-display');
        if (titleEl) titleEl.textContent = state.appTitle;
      }
      list = data.itinerary || data.days || data.spots || data;
    }
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('無效的行程格式');
    }
    return list;
  }

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
      const list = processImportedData(data);
      state.itinerary = normalizeItinerary(list);
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
      const list = processImportedData(data);
      state.itinerary = normalizeItinerary(list);
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

  function getTimestampParts(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return {
      date: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
      time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
      password: `${pad(date.getMinutes())}${pad(date.getHours())}`
    };
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  async function githubApi(path, options = {}) {
    const url = `${GITHUB_API_CONTENTS_URL}/${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers || {})
      }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || `GitHub API HTTP ${res.status}`);
    }
    return data;
  }

  async function uploadItineraryToGitHub() {
    const btn = document.getElementById('btn-upload-github');
    const originalText = btn.textContent;
    const { date, time, password } = getTimestampParts();

    const inputPassword = prompt('請輸入上傳密碼（現在時分顛倒，例如 13:05 → 0513）：');
    if (inputPassword === null) return;
    if (inputPassword.trim() !== password) {
      alert('密碼錯誤，未上傳。');
      return;
    }

    const token = prompt('請輸入 GitHub Personal Access Token（需要 repo contents 寫入權限）：');
    if (token === null) return;
    if (!token.trim()) {
      alert('GitHub Token 不能空白。');
      return;
    }

    if (!confirm('確定要上傳目前行程嗎？\n\n流程：先備份 GitHub 目前的 itinerary.json，再覆寫 data/itinerary.json。')) return;

    btn.textContent = '⏳ 上傳中...';
    btn.disabled = true;

    try {
      const authHeaders = { Authorization: `Bearer ${token.trim()}` };
      const currentFile = await githubApi(`${GITHUB_ITINERARY_PATH}?ref=${GITHUB_BRANCH}`, {
        headers: authHeaders
      });

      const backupPath = `${GITHUB_BACKUP_DIR}/itinerary_${date}_${time}.json`;
      await githubApi(backupPath, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          message: `Backup itinerary ${date}_${time}`,
          content: currentFile.content.replace(/\s/g, ''),
          branch: GITHUB_BRANCH
        })
      });

      const exportData = {
        title: state.appTitle,
        itinerary: state.itinerary
      };
      await githubApi(GITHUB_ITINERARY_PATH, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          message: `Update itinerary ${date}_${time}`,
          content: utf8ToBase64(JSON.stringify(exportData, null, 2)),
          sha: currentFile.sha,
          branch: GITHUB_BRANCH
        })
      });

      alert(`✅ 已上傳行程！\n\n備份：${GITHUB_PAGES_BASE_URL}/${backupPath}\n目前：${GITHUB_ITINERARY_URL}`);
    } catch (e) {
      console.error('GitHub upload failed:', e);
      alert('❌ 上傳失敗：' + e.message + '\n\n請確認 Token 有 repo contents 寫入權限，且 repository/branch 路徑正確。');
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

  let Map, AdvancedMarkerElement, LatLngBounds, Polyline;

  async function initMap() {
    state.map = null;
    state.routeLayer = [];
    state.markerLayer = [];
    state.nearbyLayer = [];
    state.positionMarker = null;

    try {
      for (let attempt = 0; attempt < 40 && (!window.google || !window.google.maps || !window.google.maps.Map); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      if (!window.google || !window.google.maps || !window.google.maps.Map) {
        throw new Error('Google Maps API is unavailable. Check the API key and Google Cloud settings.');
      }

      Map = window.google.maps.Map;
      AdvancedMarkerElement = window.google.maps.Marker;
      LatLngBounds = window.google.maps.LatLngBounds;
      Polyline = window.google.maps.Polyline;

      state.map = new Map(document.getElementById('map'), {
        center: { lat: APP_DATA.center[0], lng: APP_DATA.center[1] },
        zoom: APP_DATA.defaultZoom,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false
      });
      // Force initial render when maps load
      showDayOnMap();
    } catch(e) {
      console.error("Google Maps failed to load", e);
    }
  }

  function clearGoogleLayer(arr) {
    if (arr) {
      arr.forEach(m => m.setMap(null));
      arr.length = 0;
    }
  }

  function addCustomMarker(lat, lng, className, label, layerArray, popupHtml) {
    if (!AdvancedMarkerElement || !state.map) return null;

    const marker = new AdvancedMarkerElement({
      position: { lat: parseFloat(lat), lng: parseFloat(lng) },
      label: {
        text: String(label),
        color: '#ffffff',
        fontSize: '16px',
        fontWeight: '700'
      },
      map: state.map
    });

    if (popupHtml) {
      const info = new window.google.maps.InfoWindow({ content: popupHtml });
      marker.addListener('click', () => info.open(state.map, marker));
    }

    if (layerArray) layerArray.push(marker);
    return marker;
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

    // Day Header with Edit Button
    const dayHeader = document.createElement('div');
    dayHeader.style.cssText = 'padding: 12px; background: var(--bg-card); margin-bottom: 15px; border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.06);';
    
    function renderDayHeaderView() {
      dayHeader.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-weight: bold; font-size: 16px; margin-bottom:4px; color: var(--text)">${esc(day.title)}</div>
            <div style="font-size: 13px; color: var(--text-secondary);">${esc(day.date)}</div>
          </div>
          <button class="btn-edit-day" title="編輯日期與標題" style="background: transparent; border: none; font-size: 20px; cursor: pointer; padding: 5px;">✏️</button>
        </div>
      `;
      dayHeader.querySelector('.btn-edit-day').addEventListener('click', renderDayHeaderEdit);
    }
    
    function renderDayHeaderEdit() {
      dayHeader.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <input type="text" id="edit-day-title" value="${esc(day.title)}" placeholder="標題 (例如：南部海灘之旅)" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
          <input type="date" id="edit-day-date" value="${esc(day.date)}" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
          <div style="display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px;">
            <button class="btn-cancel-edit-day" style="padding: 5px 10px; background: #eee; border: none; border-radius: 4px; cursor: pointer;">取消</button>
            <button class="btn-save-edit-day" style="padding: 5px 10px; background: var(--primary-color, #0f3460); color: white; border: none; border-radius: 4px; cursor: pointer;">儲存</button>
          </div>
        </div>
      `;
      
      dayHeader.querySelector('.btn-cancel-edit-day').addEventListener('click', renderDayHeaderView);
      
      dayHeader.querySelector('.btn-save-edit-day').addEventListener('click', () => {
        const newTitle = dayHeader.querySelector('#edit-day-title').value.trim();
        const newDate = dayHeader.querySelector('#edit-day-date').value;
        if (newTitle) day.title = newTitle;
        if (newDate) day.date = newDate;
        
        saveItinerary();
        renderDayTabs();
        renderSpotList(); 
        // Note: Changing date might also trigger a re-fetch of weather if needed in a more advanced update
      });
    }

    renderDayHeaderView();
    
    container.appendChild(dayHeader);

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

      const photosData = getPhotos();
      const localPhotos = photosData[spot.id] || [];
      const cloudPhotos = spot.photos ? spot.photos.map(p => ({
        url: p.preview || p.url,
        link: p.url,
        isCloud: true
      })) : [];
      const allSpotPhotos = [...localPhotos, ...cloudPhotos];
      let galleryHtml = '';
      if (allSpotPhotos.length > 0) {
        galleryHtml = `
          <div class="spot-inline-photos" style="display: flex; gap: 8px; margin: 8px 0; overflow-x: auto;">
            ${allSpotPhotos.map(p => `<img src="${p.url}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 6px; flex-shrink: 0;" alt="photo">`).join('')}
          </div>
        `;
      }

      card.innerHTML = `
        <div class="spot-header">
          <button class="spot-visited-btn btn-toggle-visited" data-spot-id="${spot.id}" title="打卡">${isVisited(spot.id) ? '✅' : '⬜'}</button>
          <span class="spot-name">${esc(spot.name)}</span>
          <span class="spot-time">${esc(spot.time)} · ${spot.duration}分</span>
        </div>
        ${galleryHtml}
        <div class="spot-desc">${esc(spot.description)}</div>
        ${spot.tips ? `<div class="spot-tips">💡 ${esc(spot.tips)}</div>` : ''}
        <div class="spot-actions">
          <button class="spot-action-btn btn-navigate" data-spot-id="${spot.id}">🧭 導航</button>
          <button class="spot-action-btn btn-google-maps" data-lat="${spot.lat}" data-lng="${spot.lng}" data-name="${esc(spot.name)}">🗺️ Google Maps</button>
          ${spot.nearby && spot.nearby.length > 0 ? `<button class="spot-action-btn btn-nearby" data-spot-id="${spot.id}">🍜 附近美食</button>` : ''}
          <button class="spot-action-btn btn-photo" data-spot-id="${spot.id}">📸 照片</button>
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
    if (!state.map) return;

    clearGoogleLayer(state.markerLayer);
    clearGoogleLayer(state.routeLayer);
    clearGoogleLayer(state.nearbyLayer);
    const day = state.itinerary[state.currentDay];
    if (!day) return;

    const bounds = [];
    const photos = getPhotos();

    day.spots.forEach((spot, i) => {
      const localPhotos = photos[spot.id] || [];
      const cloudPhotos = spot.photos ? spot.photos.map(p => ({
        url: p.preview || p.url,
        link: p.url,
        isCloud: true
      })) : [];

      const allSpotPhotos = [...localPhotos, ...cloudPhotos];
      let photoHtml = '';
      if (allSpotPhotos.length > 0) {
        // 取最新的第一張照片顯示在 popup 中
        photoHtml = `<div style="margin-top:8px;text-align:center;"><img src="${allSpotPhotos[allSpotPhotos.length - 1].url}" style="width:100%; max-height:120px; object-fit:cover; border-radius:4px;"></div>`;
      }

      const marker = addCustomMarker(spot.lat, spot.lng, "marker-spot", i + 1, state.markerLayer, `
        <div class="popup-title">${esc(spot.name)}</div>
        <div class="popup-detail">${esc(spot.time)} · ${spot.duration}分鐘</div>
        ${photoHtml}
      `);

      bounds.push({lat: spot.lat, lng: spot.lng});
    });

    // Draw connecting lines between spots

    if (day.spots.length > 1) {
      for (let i = 0; i < day.spots.length - 1; i++) {
        const from = day.spots[i];
        const to = day.spots[i + 1];
        const transport = from.transportToNext;
        if (transport && Polyline) {
          const polyline = new Polyline({
            path: [{lat: from.lat, lng: from.lng}, {lat: to.lat, lng: to.lng}],
            geodesic: true,
            strokeColor: transport.color || '#999',
            strokeOpacity: 0.4,
            strokeWeight: 3
          });
          polyline.setMap(state.map);
          state.markerLayer.push(polyline);
        }
      }
    }

    if (bounds.length > 0) {
      if(LatLngBounds){
        const b = new LatLngBounds();
        bounds.forEach(pt => b.extend(pt));
        state.map.fitBounds(b);
      }
    }
  }

  function selectSpot(spot) {
    state.currentSpot = spot.id;
    renderSpotList();
    state.map.panTo({ lat: spot.lat, lng: spot.lng });
    state.map.setZoom(15);
  }

  // ==================== Navigation (Route Drawing) ====================

  function navigateToSpot(spot) {
    clearGoogleLayer(state.routeLayer);
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
    clearGoogleLayer(state.routeLayer);

    const from = [fromPos.lat, fromPos.lng];
    const to = [toSpot.lat, toSpot.lng];

    // Draw polyline
    let polyline;
    if (Polyline) {
      polyline = new Polyline({
        path: [{lat: from[0], lng: from[1]}, {lat: to[0], lng: to[1]}],
        geodesic: true, strokeColor: '#e94560', strokeOpacity: 0.8, strokeWeight: 4
      });
      polyline.setMap(state.map);
      state.routeLayer.push(polyline);
    }

    // Current position marker

    addCustomMarker(from[0], from[1], 'marker-current', '📍', state.routeLayer, '目前位置');

    // Destination marker

    addCustomMarker(to[0], to[1], 'marker-spot', '🏁', state.routeLayer, `
      <div class="popup-title">${esc(toSpot.name)}</div>
      <div class="popup-detail">${esc(toSpot.description)}</div>
    `);

    // Distance & estimated time

    const dist = calcDistance(from[0], from[1], to[0], to[1]);
    const estTime = Math.ceil(dist / 40 * 60); // avg 40km/h


    if(AdvancedMarkerElement) {
      const info = new window.google.maps.InfoWindow({
        content: `<div style="text-align:center;font-weight:bold;">${dist.toFixed(1)} km<br>約 ${estTime} 分鐘</div>`,
        position: { lat: (from[0] + to[0]) / 2, lng: (from[1] + to[1]) / 2 }
      });
      info.open(state.map);
    }

    if(LatLngBounds){ const b = new LatLngBounds(); b.extend({lat: from[0], lng: from[1]}); b.extend({lat: to[0], lng: to[1]}); state.map.fitBounds(b); }
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
      state.positionMarker.setPosition({lat: state.currentPosition.lat, lng: state.currentPosition.lng});
    } else {
      state.positionMarker = addCustomMarker(state.currentPosition.lat, state.currentPosition.lng, 'marker-current', '📍', null, '目前位置');
    }
  }

  // ==================== Nearby Food ====================

  function showNearbyFood(spot) {
    clearGoogleLayer(state.nearbyLayer);
    if (!spot.nearby || spot.nearby.length === 0) {
      alert('此景點附近暫無美食資料');
      return;
    }

    state.map.panTo({ lat: spot.lat, lng: spot.lng });
    state.map.setZoom(16);

    spot.nearby.forEach(place => {
      const isConvenience = place.type === 'convenience';
      const className = isConvenience ? 'marker-convenience' : 'marker-food';
      const label = isConvenience ? '🏪' : '🍴';

      const marker = addCustomMarker(place.lat, place.lng, className, label, state.nearbyLayer, `
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
    // Collect dates from itinerary
    const dates = state.itinerary.map(d => d.date).filter(Boolean);
    if (dates.length === 0) return null;

    const startDate = dates[0];
    const endDate = dates[dates.length - 1];

    // Check cache
    try {
      const cached = JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY) || '{}');
      if (cached.data && cached.timestamp && (Date.now() - cached.timestamp < WEATHER_CACHE_TTL)) {
        // 確認快取內有包含我們需要的起迄日期
        if (cached.data[startDate] && cached.data[endDate]) {
          return cached.data;
        }
      }
    } catch (e) { /* ignore */ }

    // Open-Meteo forecast API (free, no key needed, up to 16 days)

    const url = `https://api.open-meteo.com/v1/forecast?latitude=26.33&longitude=127.77&daily=weather_code,temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean,wind_speed_10m_max,wind_direction_10m_dominant&start_date=${startDate}&end_date=${endDate}&timezone=Asia%2FTokyo`;

    try {
      let res = await fetch(url);
      let json = await res.json();

      // 若行程日期超過 Open-Meteo 的 16 天預測極限，會回傳 error。此時改用「去年同一天」的歷史氣候資料當作參考
      if (json.error) {
        let sl = startDate;
        let el = endDate;
        let yearDiff = 0;
        const sDate = new Date(startDate);
        const eDate = new Date(endDate);

        // 只有「未來」超過 16 天的日期，我們才需要往前推到「去年」拿歷史資料
        if (sDate > new Date()) {
          yearDiff = sDate.getFullYear() - new Date().getFullYear() + 1; // 回推到有完整資料的去年
          sDate.setFullYear(sDate.getFullYear() - yearDiff);
          eDate.setFullYear(eDate.getFullYear() - yearDiff);
          sl = sDate.toISOString().split('T')[0];
          el = eDate.toISOString().split('T')[0];
        }

        const historyUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=26.33&longitude=127.77&daily=weather_code,temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean,wind_speed_10m_max,wind_direction_10m_dominant&start_date=${sl}&end_date=${el}&timezone=Asia%2FTokyo`;
        
        res = await fetch(historyUrl);
        json = await res.json();
        
        if (json.error) return null;

        // 將歷史資料的年份加回原本行程的年份，讓行程表可以正確對應
        if (yearDiff > 0 && json.daily && json.daily.time) {
          json.daily.time = json.daily.time.map(d => {
            return `${parseInt(d.substring(0,4)) + yearDiff}${d.substring(4)}`;
          });
          json.isHistorical = true; // 標記這是歷史借用資料
        }
      }

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
          desc: json.isHistorical ? `(歷年參考) ${desc}` : desc,
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
      
      let forecastNote = '';
      if (weatherMap && Object.values(weatherMap)[0]?.desc.includes('(歷年參考)')) {
        forecastNote = `<div class="weather-note">📅 行程距離現在約 ${daysDiff} 天，尚未進入準確預報範圍。目前顯示為「歷年同期的歷史氣候平均資料」作為參考！</div>`;
      } else if (daysDiff > 16) {
        forecastNote = `<div class="weather-note">📅 行程日期尚未進入預報範圍（約 ${daysDiff} 天後），天氣資料將在出發前 ~16 天內自動更新</div>`;
      } else if (weatherMap) {
        forecastNote = '<div class="weather-note">✅ 已成功取得 Open-Meteo 最新天氣預報！</div>';
      } else {
        forecastNote = '<div class="weather-note" style="color:#d32f2f;">⚠️ 無法取得天氣資料，顯示的是快取或預設值</div>';
      }

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

  async function uploadToCloudinary(dataUrl) {
    return new Promise(async (resolve, reject) => {
      try {
        const cloudName = 'dbzbapkcn'; // TODO: 填入你的 Cloudinary Cloud Name
        const uploadPreset = 'TravelMap';     // TODO: 填入你設定的 Unsigned Upload Preset
        
        if (cloudName === 'YOUR_CLOUDINARY_CLOUD_NAME') {
          return reject(new Error('Cloudinary 尚未設定！請至程式碼中填入你的 Cloud Name 與 preset。'));
        }

        const form = new FormData();
        form.append('file', dataUrl);
        form.append('upload_preset', uploadPreset);
        
        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
          method: 'POST',
          body: form
        });
        
        const data = await res.json();
        
        if (!res.ok) throw new Error(data.error?.message || '上傳失敗');

        resolve({
          id: data.public_id,
          webViewLink: data.secure_url, // 原始圖片連結
          previewUrl: data.secure_url   // Cloudinary 可以產生各種預覽，這裡我們先儲存這個原始檔連結
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function capturePhoto(spot) {
    // 1. 動態建立選擇模式的 UI
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
    
    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--bg-card,#fff);padding:20px;border-radius:12px;width:90%;max-width:320px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.2);';
    dialog.innerHTML = `
      <h3 style="margin-top:0;">📸 選擇儲存方式</h3>
      <p style="font-size:14px;color:var(--text-secondary,#666);margin-bottom:20px;">你要將這張照片存在哪裡？</p>
      <button id="btn-save-cloudinary" class="btn-primary" style="width:100%;margin-bottom:10px;font-size:16px;">☁️ 上傳至 Cloudinary</button>
      <button id="btn-save-local" class="btn-secondary" style="width:100%;margin-bottom:10px;font-size:16px;">📱 僅存在本機相簿</button>
      <button id="btn-save-cancel" style="width:100%;background:transparent;border:none;color:var(--text-secondary,#666);padding:10px;">取消</button>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const closeOverlay = () => document.body.removeChild(overlay);

    // 取消按鈕
    dialog.querySelector('#btn-save-cancel').onclick = closeOverlay;

    // 定義開啟相機/檔案選擇的共用邏輯
    const proceedWithFilePicker = (useCloudinary) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const btnList = document.querySelectorAll(`.btn-photo[data-spot-id="${spot.id}"]`);
        btnList.forEach(btn => btn.textContent = '⏳ 處理中...');

        const reader = new FileReader();
        reader.onload = async (ev) => {
          try {
            // 壓縮圖片
            const compressed = await compressImage(ev.target.result, 800, 0.7);
            
            if (useCloudinary) {
              btnList.forEach(btn => btn.textContent = '☁️ 上傳中...');
              // 上傳並取得雲端 URL
              const clData = await uploadToCloudinary(compressed);
              
              // 將照片連結加入行程資料的 JSON
              if (!spot.photos) spot.photos = [];
              spot.photos.push({
                id: clData.id,
                url: clData.webViewLink,
                preview: clData.previewUrl,
                date: new Date().toISOString()
              });
              saveItinerary();
              alert('✅ 照片已上傳至 Cloudinary！\n(將隨著行程 JSON 匯出與同步)');
            } else {
              // 本機儲存
              savePhoto(spot.id, compressed);
              alert('✅ 已將照片暫存於本機相簿');
            }
          } catch (err) {
            console.error(err);
            alert('❌ 上傳發生錯誤：\n' + (err.message || JSON.stringify(err)));
          } finally {
            btnList.forEach(btn => btn.textContent = '📸 照片');
            renderPhotoGallery();
          }
        };
        reader.readAsDataURL(file);
      });
      input.click();
    };

    // 點擊本機儲存
    dialog.querySelector('#btn-save-local').onclick = () => {
      closeOverlay();
      proceedWithFilePicker(false);
    };

    // 點擊 Cloudinary 儲存 
    dialog.querySelector('#btn-save-cloudinary').onclick = () => {
      closeOverlay();
      proceedWithFilePicker(true);
    };
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

    const galleryHtml = allSpots
      .map(spot => {
        // 取得本機的 Base64 圖片
        const localPhotos = photos[spot.id] || [];
        // 取得存在行程 JSON (Cloudinary等雲端儲存) 的圖片
        const cloudPhotos = spot.photos ? spot.photos.map(p => ({
          url: p.preview || p.url, // 縮圖
          link: p.url,             // 原圖連結
          isCloud: true
        })) : [];

        const allSpotPhotos = [...localPhotos, ...cloudPhotos];
        
        if (allSpotPhotos.length === 0) return '';

        return `
          <div class="photo-spot-section">
            <div class="photo-spot-title">📍 ${esc(spot.name)}</div>
            <div class="photo-grid">
              ${allSpotPhotos.map(p => 
                p.isCloud 
                  ? `<a href="${p.link}" target="_blank" title="在新分頁檢視原圖">
                       <img src="${p.url}" alt="${spot.name}" loading="lazy" style="border: 2px solid #5fa8d3;">
                     </a>`
                  : `<img src="${p.url}" alt="${spot.name}" loading="lazy">`
              ).join('')}
            </div>
          </div>
        `;
      })
      .filter(html => html !== '')
      .join('');

    container.innerHTML = galleryHtml || '<p style="color:var(--text-secondary);text-align:center;padding:40px 0;">還沒有照片，去景點拍一張吧！📸</p>';
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
          <button class="spot-action-btn btn-photo" data-spot-id="${spot.id}">📸 照片</button>
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
    
    // Clear the search field (handle both standard input and the new PlaceAutocompleteElement)
    const searchEl = document.getElementById('edit-spot-search');
    if (searchEl) {
      if (searchEl.inputValue !== undefined) searchEl.inputValue = '';
      else searchEl.value = '';
    }

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
    initGooglePlaces();
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
    document.getElementById('map').style.cursor = 'crosshair';
    window.google.maps.event.addListenerOnce(state.map, 'click', (e) => onMapPick({ latlng: { lat: e.latLng.lat(), lng: e.latLng.lng() } }));
  }

  function onMapPick(e) {
    if(AdvancedMarkerElement) {
      const info = new window.google.maps.InfoWindow({
        content: '<div style="text-align:center;"><p>📍選擇此座標？</p><button id="btn-confirm-pick" class="btn-primary btn-sm" style="margin-top:4px;">確定</button></div>',
        position: { lat: e.latlng.lat, lng: e.latlng.lng }
      });
      info.open(state.map);
      
      window.google.maps.event.addListenerOnce(info, 'domready', () => {
        document.getElementById('btn-confirm-pick').addEventListener('click', () => {
          document.getElementById('edit-spot-lat').value = e.latlng.lat.toFixed(4);
          document.getElementById('edit-spot-lng').value = e.latlng.lng.toFixed(4);
          info.close();
          endMapPick();
          openModal('spot-editor-modal');
        });
      });
    } else {
        document.getElementById('edit-spot-lat').value = e.latlng.lat.toFixed(4);
        document.getElementById('edit-spot-lng').value = e.latlng.lng.toFixed(4);
        endMapPick();
        openModal('spot-editor-modal');
    }
  }

  function cancelMapPick() {
    window.google.maps.event.clearListeners(state.map, 'click');
    endMapPick();
    openModal('spot-editor-modal');
  }

  function endMapPick() {
    state.mapPickMode = false;
    document.getElementById('map-pick-overlay').classList.add('hidden');
    document.getElementById('fab-add-spot').classList.remove('hidden');
    document.getElementById('map').style.cursor = '';
  }

  // ==================== Import / Export / Reset ====================

  function exportItinerary() {
    try {
      const defaultFilename = `okinawa-itinerary-${new Date().toISOString().slice(0, 10)}.json`;
      const inputFilename = prompt('請輸入匯出的 JSON 檔名：', defaultFilename);
      if (inputFilename === null) return;

      const filename = inputFilename.trim();
      if (!filename) {
        alert('檔名不能空白');
        return;
      }

      const downloadFilename = filename.toLowerCase().endsWith('.json') ? filename : `${filename}.json`;
      const exportData = {
        title: state.appTitle,
        itinerary: state.itinerary
      };
      const json = JSON.stringify(exportData, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadFilename;
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
        const list = processImportedData(data);
        
        if (!confirm(`即將載入 ${list.length} 天的行程，會覆蓋目前資料。確定嗎？`)) return;

        state.itinerary = normalizeItinerary(list);
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

  // ==================== Google Places ====================

  let placesAutocompleteInitialized = false;

  async function initGooglePlaces() {
    const input = document.getElementById('edit-spot-search');
    if (!input) return;

    if (!window.google || !window.google.maps || !window.google.maps.places || !window.google.maps.places.Autocomplete) {
      if (!placesAutocompleteInitialized) {
        setTimeout(initGooglePlaces, 500);
      }
      return;
    }

    if (placesAutocompleteInitialized) return;
    placesAutocompleteInitialized = true;

    try {
      const autocomplete = new window.google.maps.places.Autocomplete(input, {
        fields: ['geometry', 'name'],
        types: ['establishment', 'geocode']
      });

      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace();
        if (!place || !place.geometry || !place.geometry.location) {
          alert('找不到該地標的位置資訊');
          return;
        }

        const lat = place.geometry.location.lat().toFixed(6);
        const lng = place.geometry.location.lng().toFixed(6);

        document.getElementById('edit-spot-lat').value = lat;
        document.getElementById('edit-spot-lng').value = lng;

        const nameInput = document.getElementById('edit-spot-name');
        if (!nameInput.value || nameInput.value.trim() === '') {
          nameInput.value = place.name || '';
        }
      });
    } catch (err) {
      console.warn('Google Places Init Error:', err);
    }
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

    document.getElementById('btn-upload-github').addEventListener('click', uploadItineraryToGitHub);

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
    // 優先設定 App Title
    document.title = state.appTitle;
    const titleEl = document.getElementById('app-title-display');
    if (titleEl) {
      titleEl.textContent = state.appTitle;
      
      // 允許使用者直接點擊修改主標題
      titleEl.style.cursor = 'pointer';
      titleEl.title = '點擊修改旅程名稱';
      titleEl.innerHTML += ' <span style="font-size:14px;opacity:0.6;">✏️</span>';
      
      titleEl.addEventListener('click', () => {
        const newTitle = prompt('✏️ 請輸入新的旅程名稱：', state.appTitle);
        if (newTitle && newTitle.trim()) {
          state.appTitle = newTitle.trim();
          localStorage.setItem('okinawa_app_title', state.appTitle);
          document.title = state.appTitle;
          titleEl.innerHTML = esc(state.appTitle) + ' <span style="font-size:14px;opacity:0.6;">✏️</span>';
        }
      });
    }

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
    initGooglePlaces();
    initTravelTools();

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

