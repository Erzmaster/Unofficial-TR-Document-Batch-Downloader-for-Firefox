// ==UserScript==
// @name         TR Document Batch Downloader
// @version      2.0
// @namespace    tr-batch-dl
// @description  Automatically iterates Trade Republic transaction/activity tabs, opens each entry, and downloads linked documents with optional auto-renaming.
// @match        https://app.traderepublic.com/*
// @run-at       document-idle
// @grant        GM_download
// @noframes
// ==/UserScript==

(function () {
  "use strict";
  const SCRIPT_VERSION = "2.0";
  console.log("[GM Test] Version", SCRIPT_VERSION);

  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ---------------- Config ----------------
  const CFG = {
    enableAutoListScroll: true,
    slowMode: true,
    debugOutline: true,
    filenameTemplate: '{date}_{title}_{subtitle}_{doc}',
    dateFormat: 'YYYYMMDD',
    defaultStartIndex: 0,
    defaultEndIndex: -1,
    useCustomNames: true,

    // Tab-Lock
    lockTab: true,
    tabFixTimeout: 800,

    // Selektoren
    listItemSel: '.clickable.timelineEventAction:not(.detailDocuments__action)',
    closeSel: 'button.closeButton.sideModal__close, .closeButton.sideModal__close, .sideModal__close, [aria-label="Close"], [aria-label="Schließen"]',
    docButtonSel: '.clickable.timelineEventAction.detailDocuments__action',

    // Timings
    slow: {
      waitAfterOpenItem:     900,
      waitBetweenDocClicks:  900,
      waitAfterCloseOverlay: 900,
      afterEachItemPace:     120,
      autoScrollDelay:       500,
      focusDelay:            80,
      modalPollInterval:     50,
      closeCheckWindow:      500,
      backdropClickGap:      80
    },
    fast: {
      waitAfterOpenItem:     300,
      waitBetweenDocClicks:  220,
      waitAfterCloseOverlay: 300,
      afterEachItemPace:     60,
      autoScrollDelay:       300,
      focusDelay:            40,
      modalPollInterval:     40,
      closeCheckWindow:      300,
      backdropClickGap:      60
    }
  };

  const DEFAULT_FILENAME_TEMPLATE = CFG.filenameTemplate;
  const DEFAULT_DATE_FORMAT = CFG.dateFormat;
  const DEFAULT_USE_CUSTOM_NAMES = CFG.useCustomNames;
  const FILENAME_TEMPLATE_KEY = 'trbd_filename_template';
  const DATE_FORMAT_KEY = 'trbd_date_format';
  const CUSTOM_NAME_KEY = 'trbd_use_custom_names';
  try {
    const storedTemplate = localStorage.getItem(FILENAME_TEMPLATE_KEY);
    if (storedTemplate) CFG.filenameTemplate = storedTemplate;
    const storedDateFmt = localStorage.getItem(DATE_FORMAT_KEY);
    if (storedDateFmt) CFG.dateFormat = storedDateFmt;
  } catch {}
  try {
    const storedCustomNames = localStorage.getItem(CUSTOM_NAME_KEY);
    if (storedCustomNames !== null) {
      CFG.useCustomNames = storedCustomNames === 'true' || storedCustomNames === '1';
    }
  } catch {}

  // ---------------- Helpers ----------------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const T = () => (CFG.slowMode ? CFG.slow : CFG.fast);

  const LOG_PREFIX = '%c[TR-BatchDL]';
  const LOG_STYLE  = 'color:#0ea5e9;font-weight:600';
  const log  = (...a) => console.log(LOG_PREFIX, LOG_STYLE, ...a);

  const isVisible = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden';
  };

  const mark = (el, color = 'orange') => {
    if (!CFG.debugOutline || !el) return;
    el.dataset._trbd_ow = el.style.outline || '';
    el.style.outline = `2px solid ${color}`;
    el.style.outlineOffset = '2px';
  };
  const unmark = (el) => {
    if (!CFG.debugOutline || !el) return;
    el.style.outline = el.dataset._trbd_ow || '';
    delete el.dataset._trbd_ow;
  };

  const MONTH_MAP = {
    januar: 1,
    februar: 2,
    maerz: 3,
    märz: 3,
    april: 4,
    mai: 5,
    juni: 6,
    juli: 7,
    august: 8,
    september: 9,
    oktober: 10,
    november: 11,
    dezember: 12,
    december: 12
  };

  const normalizeMonthName = (name = '') =>
    name.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/\s+/g, '');

  const extractYearFromHeading = (text = '') => {
    const match = text.match(/(19|20)\d{2}/);
    if (match) return parseInt(match[0], 10);
    return new Date().getFullYear();
  };

  const findYearForItem = (item) => {
    const headings = document.querySelectorAll('h2.timelineMonthDivider');
    let year = new Date().getFullYear();
    for (const heading of headings) {
      const relation = heading.compareDocumentPosition(item);
      if (relation === 0 || relation & Node.DOCUMENT_POSITION_FOLLOWING) {
        year = extractYearFromHeading(heading.textContent || '');
      } else if (relation & Node.DOCUMENT_POSITION_PRECEDING) {
        break;
      }
    }
    return year;
  };

  const parseDateString = (str = '', fallbackYear) => {
    if (!str) return null;
    const text = str.trim();
    let day, month, year;
    let match = text.match(/(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?/);
    if (match) {
      day = parseInt(match[1], 10);
      month = parseInt(match[2], 10);
      if (match[3]) {
        year = parseInt(match[3], 10);
        if (year < 100) year += 2000;
      }
    }
    if ((!day || !month) && /(\d{1,2})\.\s*[A-Za-zÄÖÜäöü]+/.test(text)) {
      match = text.match(/(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)/);
      if (match) {
        day = parseInt(match[1], 10);
        const normalized = normalizeMonthName(match[2]);
        month = MONTH_MAP[normalized];
      }
    }
    if (!day || !month) return null;
    year = year || fallbackYear || new Date().getFullYear();
    return { day, month, year };
  };

  const resolveDateParts = (meta = {}) => {
    const fallbackYear = meta.itemYear || new Date().getFullYear();
    return parseDateString(meta.docDate, fallbackYear) ||
           parseDateString(meta.itemDate, fallbackYear) ||
           null;
  };

  const formatDateParts = (parts, format) => {
    if (!parts) return '';
    const pad = (n) => String(n).padStart(2, '0');
    const map = {
      YYYY: parts.year,
      YY: String(parts.year).slice(-2),
      MM: pad(parts.month),
      DD: pad(parts.day)
    };
    return format.replace(/YYYY|YY|MM|DD/g, token => map[token] ?? token);
  };

  const getTimelineItemContext = (item) => {
    if (!item) return {};
    const title = item.querySelector('.timelineV2Event__title')?.textContent?.trim() || '';
    const itemYear = findYearForItem(item);
    const subtitleText = item.querySelector('.timelineV2Event__subtitle')?.textContent?.trim() || '';
    let datePart = '';
    let subtitle = subtitleText;
    if (subtitleText.includes(' - ')) {
      const parts = subtitleText.split(' - ');
      datePart = parts.shift()?.trim() || '';
      subtitle = parts.join(' - ').trim();
    } else if (/^\d{2}\.\d{2}\./.test(subtitleText)) {
      datePart = subtitleText.trim();
      subtitle = '';
    }
    return { itemTitle: title, itemDate: datePart, itemSubtitle: subtitle, itemYear };
  };

  // ---------------- Download Helper (GM_download) ----------------
  const trackedLocations = new WeakMap();
  const pendingPopups = new Set();
  const navigationHooks = (() => {
    const LocProto = (PAGE.Location && PAGE.Location.prototype) || (typeof Location !== 'undefined' ? Location.prototype : null);
    const state = {
      enabled: false,
      origAssign: null,
      origReplace: null,
      hrefDesc: null
    };
    const enable = () => {
      if (state.enabled || !LocProto) return;
      if (typeof LocProto.assign === 'function') {
        state.origAssign = LocProto.assign;
        LocProto.assign = function(url) {
          const fallback = () => state.origAssign.apply(this, arguments);
          if (interceptLocationNavigation(this, url, fallback)) return;
          return fallback();
        };
      }
      if (typeof LocProto.replace === 'function') {
        state.origReplace = LocProto.replace;
        LocProto.replace = function(url) {
          const fallback = () => state.origReplace.apply(this, arguments);
          if (interceptLocationNavigation(this, url, fallback)) return;
          return fallback();
        };
      }
      const desc = Object.getOwnPropertyDescriptor(LocProto, 'href');
      if (desc && desc.set) {
        state.hrefDesc = desc;
        Object.defineProperty(LocProto, 'href', {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set(value) {
            const fallback = () => desc.set.call(this, value);
            if (interceptLocationNavigation(this, value, fallback)) return;
            return fallback();
          }
        });
      }
      state.enabled = true;
    };
    const disable = () => {
      if (!state.enabled || !LocProto) return;
      if (state.origAssign) {
        LocProto.assign = state.origAssign;
      }
      if (state.origReplace) {
        LocProto.replace = state.origReplace;
      }
      if (state.hrefDesc) {
        Object.defineProperty(LocProto, 'href', state.hrefDesc);
      }
      state.enabled = false;
      state.origAssign = null;
      state.origReplace = null;
      state.hrefDesc = null;
    };
    return { enable, disable };
  })();

  const downloadTracker = (() => {
    let pending = null;
    let timer = null;
    return {
      set(meta) {
        pending = meta;
        if (timer) clearTimeout(timer);
        log('Tracker set', meta);
        timer = setTimeout(() => {
          log('Tracker timeout (auto-clear)');
          pending = null;
          timer = null;
          closePendingPopups();
          navigationHooks.disable();
        }, 10000);
        navigationHooks.enable();
      },
      consume() {
        const meta = pending;
        log('Tracker consume', meta);
        pending = null;
        if (timer) clearTimeout(timer);
        timer = null;
        closePendingPopups();
        navigationHooks.disable();
        return meta;
      },
      hasPending() {
        return !!pending;
      },
      peek() {
        if (!pending) log('Tracker peek: empty');
        return pending;
      },
      clear() {
        log('Tracker clear()');
        pending = null;
        if (timer) clearTimeout(timer);
        timer = null;
        closePendingPopups();
        navigationHooks.disable();
      }
    };
  })();

  const sanitizeFilename = (name) =>
    (name || 'download')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/[_\s]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'document';

  function buildDownloadName(meta, url) {
    const fallback = (() => {
      try {
        const clean = (url || '').split('?')[0];
        const tail = clean.split('/').pop();
        if (tail) return tail;
      } catch {}
      return 'document.pdf';
    })();
    if (!CFG.useCustomNames) {
      let base = sanitizeFilename(fallback) || 'document';
      if (!/\.pdf$/i.test(base)) base += '.pdf';
      return base;
    }
    const tokens = {
      title: meta?.itemTitle?.trim() || '',
      date: meta?.itemDate?.trim() || meta?.docDate?.trim() || '',
      subtitle: meta?.itemSubtitle?.trim() || '',
      doc: meta?.docTitle?.trim() || ''
    };
    if (!tokens.doc) tokens.doc = fallback.replace(/\.pdf$/i, '');

    const dateParts = resolveDateParts(meta);
    const formattedDate = dateParts
      ? formatDateParts(dateParts, CFG.dateFormat || DEFAULT_DATE_FORMAT)
      : (meta?.itemDate || meta?.docDate || tokens.date);
    tokens.date = formattedDate || tokens.date;

    let template = CFG.filenameTemplate || '{doc}';
    try {
      const stored = localStorage.getItem(FILENAME_TEMPLATE_KEY);
      if (stored) template = stored;
    } catch {}

    const filled = template.replace(/\{(title|date|subtitle|doc)\}/gi, (_, key) => tokens[key.toLowerCase()] || '');
    let base = filled.trim() || tokens.doc || fallback.replace(/\.pdf$/i, '');
    base = sanitizeFilename(base) || 'document';
    if (!/\.pdf$/i.test(base)) base += '.pdf';
    return base;
  }

  function queueGmDownload(url, prevOpen) {
    if (typeof GM_download !== 'function') return false;
    const meta = downloadTracker.peek();
    const filename = buildDownloadName(meta, url);
    try {
      GM_download({
        url,
        name: filename,
        saveAs: false,
        ontimeout: () => {
          log('GM_download timeout, fallback window.open', filename);
          prevOpen?.();
        },
        onerror: (err) => {
          console.error(LOG_PREFIX, LOG_STYLE, 'GM_download error', err);
          prevOpen?.();
        }
      });
      log('GM_download gestartet:', filename);
      downloadTracker.consume();
      return true;
    } catch (err) {
      console.error(LOG_PREFIX, LOG_STYLE, 'GM_download exception', err);
      return false;
    }
  }

  function closePendingPopups() {
    if (!pendingPopups.size) return;
    log('Schließe Popups:', pendingPopups.size);
    for (const win of Array.from(pendingPopups)) {
      try { win.close(); } catch {}
      pendingPopups.delete(win);
    }
  }

  function interceptLocationNavigation(loc, url, fallback) {
    if (!downloadTracker.hasPending()) return false;
    const win = trackedLocations.get(loc);
    if (!win) return false;
    if (typeof url !== 'string' || !url.trim()) return false;
    log('Interceptiere location-Navigation:', url);
    const handled = queueGmDownload(url, fallback);
    if (handled) {
      trackedLocations.delete(loc);
      try { win?.close?.(); } catch {}
      return true;
    }
    return false;
  }

  (function hookWindowOpenForDownloads() {
    const prev = PAGE.open;
    if (!prev || prev._trbd_gm_hooked) return;
    function replacement(url, target, features) {
      const args = arguments;
      if (downloadTracker.hasPending() && typeof url === 'string' && url.trim()) {
        const handled = queueGmDownload(url, () => prev.apply(this, args));
        if (handled) return null;
      }
      const win = prev.apply(this, args);
      if (win) {
        try {
          if (downloadTracker.hasPending() && win.location) {
            trackedLocations.set(win.location, win);
            log('Popup getrackt (vor Navigation).');
          } else {
            log('window.open ohne aktiven Tracker', url);
          }
          pendingPopups.add(win);
          win.addEventListener?.('beforeunload', () => pendingPopups.delete(win), { once: true });
          if (!downloadTracker.hasPending()) {
            setTimeout(() => {
              if (!downloadTracker.hasPending()) {
                try { win.close(); } catch {}
                pendingPopups.delete(win);
              }
            }, 1500);
          }
        } catch {}
      }
      return win;
    }
    replacement._trbd_gm_hooked = true;
    PAGE.open = replacement;
    log('window.open für GM_download gehookt');
  })();

  // ---------------- Tab-Lock ----------------
  function desiredPathFromLocation() {
    return location.pathname.includes('/activities')
      ? '/profile/activities'
      : '/profile/transactions';
  }

  function findTabElementForPath(path) {
    const label = path.endsWith('/activities') ? 'Aktivität' : 'Transaktionen';
    return ([...document.querySelectorAll('a[href], button, [role="tab"], [data-qa*="tab"]')]
      .find(el => {
        try {
          const href = el.getAttribute('href') || '';
          const txt  = (el.textContent || '').trim();
          return isVisible(el) && (href.endsWith(path) || txt === label);
        } catch { return false; }
      })) || null;
  }

  async function ensureActiveTab(desiredPath) {
    if (!CFG.lockTab) return true;
    if (location.pathname === desiredPath) return true;

    console.group('%c[TR-BatchDL] Tab-Fix', 'color:#0ea5e9;font-weight:600');
    log('→ zurück zu', desiredPath);

    const tab = findTabElementForPath(desiredPath);
    if (tab) {
      try { tab.click(); log('Tab per Klick gesetzt'); } catch {}
      await sleep(CFG.tabFixTimeout);
      if (location.pathname === desiredPath) { console.groupEnd(); return true; }
    }
    try {
      history.pushState({}, '', desiredPath);
      window.dispatchEvent(new Event('popstate'));
      log('Tab per pushState gesetzt');
    } catch {
      location.assign(desiredPath);
      log('Tab per location.assign gesetzt');
    }
    await sleep(CFG.tabFixTimeout);
    console.groupEnd();
    return (location.pathname === desiredPath);
  }

  // ---------------- Modal ----------------
  function getActiveModal() {
    const cands = Array.from(document.querySelectorAll(
      '.sideModal, [class*="sideModal"], [role="dialog"], .modal, [class*="Modal"]'
    )).filter(isVisible);
    let best=null, score=-1;
    for (const el of cands) {
      const hasClose = !!el.querySelector(CFG.closeSel);
      const r = el.getBoundingClientRect();
      const sc = (r.width*r.height) + (hasClose?1e6:0);
      if (sc>score) { score=sc; best=el; }
    }
    return best;
  }

  // ---------------- Dokumente ----------------
  function findDocsButtons() {
    return Array.from(document.querySelectorAll(CFG.docButtonSel)).filter(isVisible);
  }

  async function clickAllDocs(context = {}) {
    console.group(`${LOG_PREFIX} Dokumente öffnen`, LOG_STYLE);
    const docs = findDocsButtons();
    log('Dokumente gefunden:', docs.length);
    let opened = 0;
    for (let i=0;i<docs.length;i++) {
      const btn = docs[i];
      const docTitle =
        btn.querySelector('.detailDocuments__documentTitle')?.textContent?.trim() ||
        btn.getAttribute('title') ||
        `Dokument ${i+1}`;
      const docDate = btn.querySelector('.detailDocuments__documentDate')?.textContent?.trim() || '';
      downloadTracker.set({
        docTitle,
        docDate,
        docIndex: i + 1,
        docTotal: docs.length,
        itemTitle: context.itemTitle,
        itemDate: context.itemDate,
        itemSubtitle: context.itemSubtitle,
        itemYear: context.itemYear
      });
      mark(btn, 'magenta');
      try { btn.scrollIntoView({ block:'center', inline:'nearest' }); } catch {}
      btn.focus?.();
      await sleep(T().focusDelay);
      try { btn.click(); } catch {}
      log(`→ Doc ${i+1}/${docs.length} geklickt`);
      opened++;
      await sleep(T().waitBetweenDocClicks);
      unmark(btn);
    }
    console.groupEnd();
    return opened;
  }

  // ---------------- Overlay open/close ----------------
  const getListItems = () =>
    Array.from(document.querySelectorAll(CFG.listItemSel))
      .filter(el => !el.classList.contains('detailDocuments__action'));

  const findScrollableListContainer = () => {
    const first = getListItems()[0];
    if (!first) return document.scrollingElement || document.documentElement;
    let p = first.parentElement;
    while (p && p !== document.body) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|overlay)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) return p;
      p = p.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };

  async function autoScrollListToLoadMore(container) {
    if (!container || !CFG.enableAutoListScroll) return;
    const before = getListItems().length;
    container.scrollTop = container.scrollHeight;
    log('Liste nachladen: vorher', before);
    await sleep(T().autoScrollDelay);
  }

  async function openItemOverlay(item, i, endIdx) {
    console.group(`${LOG_PREFIX} Eintrag ${i}/${endIdx} öffnen`, LOG_STYLE);
    mark(item, 'orange');
    try { item.scrollIntoView({ block:'center', inline:'nearest' }); } catch {}
    log('Klicke Listeneintrag');
    try { item.click(); } catch {}
    await sleep(T().waitAfterOpenItem);

    let modal=null, t0=Date.now();
    while (Date.now()-t0<5000) {
      modal = getActiveModal();
      if (modal) break;
      await sleep(T().modalPollInterval);
    }
    if (!modal) { log('→ kein Overlay (überspringe)'); unmark(item); console.groupEnd(); return null; }
    log('→ Overlay da');
    console.groupEnd();
    return modal;
  }

  // Backdrop-only (lean & schnell)
  async function closeOverlay() {
    console.group('%c[TR-BatchDL] Schließe Overlay', 'color:#0ea5e9;font-weight:600');

    const isVis = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden';
    };

    const SEL_BACKDROP = '.sideModal__backdrop, .barrier.-sideModal, [class*="backdrop"]';
    const SEL_MODAL    = '.sideModal, [class*="sideModal"], [role="dialog"], .modal, [class*="Modal"]';

    const findActiveOverlay = () => {
      const cands = Array.from(document.querySelectorAll(SEL_MODAL)).filter(isVis);
      let best=null, score=-1;
      for (const el of cands) {
        const r = el.getBoundingClientRect();
        const sc = r.width * r.height;
        if (sc > score) { score = sc; best = el; }
      }
      return best;
    };

    const activeOverlay = findActiveOverlay();
    const backdrop = Array.from(document.querySelectorAll(SEL_BACKDROP)).find(isVis) || null;
    if (!activeOverlay || !backdrop) {
      console.log('%c[TR-BatchDL] Close: kein aktives Overlay/Backdrop gefunden – skip','color:#0ea5e9;font-weight:600');
      console.groupEnd();
      return true;
    }

    const waitOverlayGone = async (ms=CFG.slowMode ? CFG.slow.closeCheckWindow : CFG.fast.closeCheckWindow) => {
      const t0 = Date.now();
      while (Date.now()-t0 < ms) {
        if (!activeOverlay.isConnected || !isVis(activeOverlay)) return true;
        await sleep(40);
      }
      return false;
    };

    const centerClick = (el) => {
      if (!el) return;
      const r  = el.getBoundingClientRect();
      const cx = Math.floor(r.left + r.width/2);
      const cy = Math.floor(r.top  + r.height/2);
      const t  = document.elementFromPoint(cx, cy) || el;
      mark(t, 'red');
      try { t.dispatchEvent(new MouseEvent('click', { bubbles:true })); } catch {}
      try { t.click?.(); } catch {}
      setTimeout(()=>unmark(t), 200);
    };

    centerClick(backdrop);
    await sleep(CFG.slowMode ? CFG.slow.backdropClickGap : CFG.fast.backdropClickGap);
    if (await waitOverlayGone()) {
      console.log('%c[TR-BatchDL] Close: ✅ per Backdrop','color:#0ea5e9;font-weight:600');
      console.groupEnd();
      return true;
    }

    // zweiter kurzer Versuch
    centerClick(backdrop);
    await sleep(CFG.slowMode ? CFG.slow.backdropClickGap : CFG.fast.backdropClickGap);
    if (await waitOverlayGone()) {
      console.log('%c[TR-BatchDL] Close: ✅ per Backdrop (2)','color:#0ea5e9;font-weight:600');
      console.groupEnd();
      return true;
    }

    const closeBtn = activeOverlay.querySelector(CFG.closeSel) || document.querySelector(CFG.closeSel);
    if (closeBtn) {
      mark(closeBtn, 'yellow');
      try { closeBtn.click(); } catch {}
      await sleep(T().focusDelay);
      unmark(closeBtn);
      if (await waitOverlayGone()) {
        console.log('%c[TR-BatchDL] Close: ✅ per Button','color:#0ea5e9;font-weight:600');
        console.groupEnd();
        return true;
      }
    }

    console.warn('%c[TR-BatchDL] Close: ❌ blieb offen','color:#0ea5e9;font-weight:600');
    console.groupEnd();
    return false;
  }

  // ---------------- UI lifecycle ----------------
  const UI_ID = 'trbd-ui';
  const UI_SUPPRESS_KEY = 'trbd_ui_suppressed_for_path';

  function removeUI() {
    const box = document.getElementById(UI_ID);
    if (box) box.remove();
  }

  function buildUIOnce() {
    // respektiere „unterdrückt für diesen Pfad“
    if (sessionStorage.getItem(UI_SUPPRESS_KEY) === location.pathname) return;
    if (document.getElementById(UI_ID)) return;

    const storedTemplateValue = (() => {
      try { return localStorage.getItem(FILENAME_TEMPLATE_KEY); } catch { return null; }
    })();
    const storedDateFormatValue = (() => {
      try { return localStorage.getItem(DATE_FORMAT_KEY); } catch { return null; }
    })();
    const templateValue = (storedTemplateValue ?? CFG.filenameTemplate ?? DEFAULT_FILENAME_TEMPLATE).replace(/"/g, '&quot;');
    const dateFormatValue = (storedDateFormatValue ?? CFG.dateFormat ?? DEFAULT_DATE_FORMAT).replace(/"/g, '&quot;');

    const box = document.createElement('div');
    box.id = UI_ID;
    box.style.cssText = `
      position: fixed; z-index: 999999; left: 12px; bottom: 12px;
      background: rgba(20,20,20,.92); color: #fff; font: 12px system-ui, sans-serif;
      border-radius: 12px; padding: 12px; width: 300px; box-shadow: 0 6px 20px rgba(0,0,0,.45);
    `;
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong>TR Batch Downloader</strong>
        <button id="trbd-x" style="background:none;border:none;color:#aaa;font-size:16px;cursor:pointer;">×</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <label>Von<br><input id="trbd-start" type="number" min="0" value="${+localStorage.getItem('trbd_start')||0}" style="width:100%"></label>
        <label>Bis (-1 Ende)<br><input id="trbd-end" type="number" min="-1" value="${+localStorage.getItem('trbd_end')||-1}" style="width:100%"></label>
      </div>
      <label style="display:flex;gap:6px;align-items:center;margin-top:8px;">
        <input id="trbd-autoscroll" type="checkbox" \${CFG.enableAutoListScroll?'checked':''}> Liste automatisch nachladen
      </label>
      <label style="display:flex;gap:6px;align-items:center;margin-top:4px;">
        <input id="trbd-slow" type="checkbox" \${CFG.slowMode?'checked':''}> Slow Mode
      </label>
      <label style="display:flex;gap:6px;align-items:center;margin-top:4px;">
        <input id="trbd-custom-names" type="checkbox" \${CFG.useCustomNames?'checked':''}> Dateinamen umbenennen
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;margin-top:8px;">
        <span>Dateinamen-Template <span style="font-size:11px;color:#9ca3af;">Tokens: {title}, {date}, {subtitle}, {doc}</span></span>
        <input id="trbd-template" type="text" value="${templateValue}" style="width:100%;padding:6px;border-radius:8px;border:1px solid #333;background:#0b0b0b;color:#fff;">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;margin-top:6px;">
        <span>Datumsformat <span style="font-size:11px;color:#9ca3af;">Tokens: YYYY, YY, MM, DD</span></span>
        <input id="trbd-dateformat" type="text" value="${dateFormatValue}" style="width:100%;padding:6px;border-radius:8px;border:1px solid #333;background:#0b0b0b;color:#fff;">
      </label>
      <div style="display:flex;gap:8px;margin-top:6px;">
        <button id="trbd-reset-template" style="flex:1;padding:6px;border-radius:8px;border:1px solid #444;background:#111;color:#eee;cursor:pointer;">Dateinamen zurücksetzen</button>
        <button id="trbd-reset-date" style="flex:1;padding:6px;border-radius:8px;border:1px solid #444;background:#111;color:#eee;cursor:pointer;">Datumsformat zurücksetzen</button>
      </div>
      <button id="trbd-reset-all" style="margin-top:6px;width:100%;padding:6px;border-radius:8px;border:1px solid #555;background:#1a1a1a;color:#fff;cursor:pointer;">Alles auf Standard</button>
      <div id="trbd-status" style="margin:8px 0; min-height:18px; color:#9fdcff;">Bereit.</div>
      <div style="display:flex; gap:8px;">
        <button id="trbd-start-btn" style="flex:1;padding:8px;border-radius:8px;border:none;background:#0ea5e9;color:#fff;cursor:pointer;">Start</button>
        <button id="trbd-stop-btn" style="flex:1;padding:8px;border-radius:8px;border:1px solid #666;background:#222;color:#eee;cursor:pointer;">Stop</button>
      </div>
    `;
    document.body.appendChild(box);
    // --- Defaults robust setzen (nachdem das Box-Element wirklich im DOM ist)
const startEl = box.querySelector('#trbd-start');
const endEl   = box.querySelector('#trbd-end');
const autoEl  = box.querySelector('#trbd-autoscroll');
const slowEl  = box.querySelector('#trbd-slow');
const customNamesEl = box.querySelector('#trbd-custom-names');
const templateEl = box.querySelector('#trbd-template');
const dateFormatEl = box.querySelector('#trbd-dateformat');
const resetTemplateBtn = box.querySelector('#trbd-reset-template');
const resetDateBtn = box.querySelector('#trbd-reset-date');
const resetAllBtn = box.querySelector('#trbd-reset-all');
const startBtn = box.querySelector('#trbd-start-btn');
const stopBtn = box.querySelector('#trbd-stop-btn');

// Werte aus Storage lesen (Fallbacks aus CFG)
const storedStart = localStorage.getItem('trbd_start');
const storedEnd = localStorage.getItem('trbd_end');
const startDefault = (storedStart ?? CFG.defaultStartIndex).toString();
const endDefault   = (storedEnd ?? CFG.defaultEndIndex).toString();

// Sofort setzen
startEl.value = startDefault;
endEl.value   = endDefault;
autoEl.checked = !!CFG.enableAutoListScroll;
slowEl.checked = !!CFG.slowMode;
customNamesEl.checked = !!CFG.useCustomNames;

// Und noch einmal im nächsten Frame (gegen SPA-Reflow/Hydration)
requestAnimationFrame(() => {
  startEl.value = startEl.value || startDefault;
  endEl.value   = endEl.value   || endDefault;
  autoEl.checked = autoEl.checked ?? !!CFG.enableAutoListScroll;
  slowEl.checked = slowEl.checked ?? !!CFG.slowMode;
  customNamesEl.checked = customNamesEl.checked ?? !!CFG.useCustomNames;
  templateEl.value = templateEl.value || (CFG.filenameTemplate ?? DEFAULT_FILENAME_TEMPLATE);
  dateFormatEl.value = dateFormatEl.value || (CFG.dateFormat ?? DEFAULT_DATE_FORMAT);
});

resetTemplateBtn.addEventListener('click', () => {
  CFG.filenameTemplate = DEFAULT_FILENAME_TEMPLATE;
  templateEl.value = DEFAULT_FILENAME_TEMPLATE;
  try { localStorage.setItem(FILENAME_TEMPLATE_KEY, CFG.filenameTemplate); } catch {}
});

resetDateBtn.addEventListener('click', () => {
  CFG.dateFormat = DEFAULT_DATE_FORMAT;
  dateFormatEl.value = DEFAULT_DATE_FORMAT;
  try { localStorage.setItem(DATE_FORMAT_KEY, CFG.dateFormat); } catch {}
});

resetAllBtn.addEventListener('click', () => {
  CFG.filenameTemplate = DEFAULT_FILENAME_TEMPLATE;
  CFG.dateFormat = DEFAULT_DATE_FORMAT;
  CFG.enableAutoListScroll = true;
  CFG.slowMode = true;
  CFG.useCustomNames = DEFAULT_USE_CUSTOM_NAMES;
  templateEl.value = DEFAULT_FILENAME_TEMPLATE;
  dateFormatEl.value = DEFAULT_DATE_FORMAT;
  autoEl.checked = true;
  slowEl.checked = true;
  customNamesEl.checked = CFG.useCustomNames;
  startEl.value = CFG.defaultStartIndex;
  endEl.value = CFG.defaultEndIndex;
  try {
    localStorage.setItem(FILENAME_TEMPLATE_KEY, CFG.filenameTemplate);
    localStorage.setItem(DATE_FORMAT_KEY, CFG.dateFormat);
    localStorage.setItem('trbd_start', CFG.defaultStartIndex);
    localStorage.setItem('trbd_end', CFG.defaultEndIndex);
    localStorage.setItem(CUSTOM_NAME_KEY, CFG.useCustomNames);
  } catch {}
});


    const ui = {
      box,
      running: false,
      setStatus(msg, color='#9fdcff'){ const s = box.querySelector('#trbd-status'); s.textContent = msg; s.style.color = color; },
      setRunning(state) {
        this.running = state;
        if (startBtn) startBtn.disabled = state;
      },
      getStart(){ return +box.querySelector('#trbd-start').value || 0; },
      getEnd(){ return +box.querySelector('#trbd-end').value ?? -1; },
      update(){
        CFG.enableAutoListScroll = box.querySelector('#trbd-autoscroll').checked;
        CFG.slowMode = box.querySelector('#trbd-slow').checked;
        CFG.useCustomNames = box.querySelector('#trbd-custom-names').checked;
        localStorage.setItem('trbd_start', ui.getStart());
        localStorage.setItem('trbd_end', ui.getEnd());
        try { localStorage.setItem(CUSTOM_NAME_KEY, CFG.useCustomNames); } catch {}
        const tplInput = box.querySelector('#trbd-template').value.trim();
        CFG.filenameTemplate = tplInput || DEFAULT_FILENAME_TEMPLATE;
        try { localStorage.setItem(FILENAME_TEMPLATE_KEY, CFG.filenameTemplate); } catch {}
        const dateFormatInput = box.querySelector('#trbd-dateformat').value.trim().toUpperCase();
        CFG.dateFormat = dateFormatInput || DEFAULT_DATE_FORMAT;
        try { localStorage.setItem(DATE_FORMAT_KEY, CFG.dateFormat); } catch {}
      }
    };

    let stopFlag = false;

    async function run() {
      const desiredPath = desiredPathFromLocation();
      log('Fixiere Tab auf:', desiredPath);

      stopFlag = false;
      ui.setRunning(true);
      ui.setStatus('Suche Listeneinträge …');
      console.group(`${LOG_PREFIX} RUN START`, LOG_STYLE);

      try {
        await ensureActiveTab(desiredPath);

        let listContainer = findScrollableListContainer();
        if (CFG.enableAutoListScroll && listContainer) await autoScrollListToLoadMore(listContainer);

        let items = getListItems();
        log('Anzahl Listeneinträge:', items.length);
        if (!items.length) { ui.setStatus('Keine Einträge gefunden.', '#ffb4b4'); return; }

        const startIdx = Math.max(0, +ui.box.querySelector('#trbd-start').value || 0);
        const endRaw  = +ui.box.querySelector('#trbd-end').value;
        const endIdx  = (isNaN(endRaw) || endRaw < 0) ? (items.length - 1) : Math.min(endRaw, items.length - 1);
        log('Bereich:', { startIdx, endIdx });
        if (startIdx > endIdx) { ui.setStatus(`Ungültiger Bereich (${startIdx} > ${endIdx}).`, '#ffb4b4'); return; }

        for (let i = startIdx; i <= endIdx; i++) {
          if (stopFlag) break;

          await ensureActiveTab(desiredPath);

          items = getListItems();
          if (i >= items.length && CFG.enableAutoListScroll && listContainer) {
            await autoScrollListToLoadMore(listContainer);
            items = getListItems();
          }
          const item = items[i];
          if (!item) { log(`(${i}/${endIdx}) kein Item (nicht geladen) – skip`); continue; }

          const itemCtx = getTimelineItemContext(item);
          ui.setStatus(`(${i}/${endIdx}) Öffne Eintrag …`);
          const overlay = await openItemOverlay(item, i, endIdx);
          unmark(item);
          if (!overlay || !isVisible(overlay)) {
            ui.setStatus(`(${i}/${endIdx}) Kein Overlay – skip`, '#ffd27a');
            continue;
          }

          ui.setStatus(`(${i}/${endIdx}) Öffne Dokumente …`);
          const count = await clickAllDocs(itemCtx);
          if (count === 0) log('→ keine Dokumente (normal)');

          ui.setStatus(`(${i}/${endIdx}) Schließe Overlay …`);
          await closeOverlay();

          await ensureActiveTab(desiredPath);
          listContainer = findScrollableListContainer();

          await sleep(T().afterEachItemPace);
          ui.setStatus(`(${i}/${endIdx}) Fertig – ${count} Dokument(e).`);
          await sleep(T().waitAfterCloseOverlay);
        }

        ui.setStatus(stopFlag ? 'Abgebrochen.' : 'Durchlauf abgeschlossen ✅', '#b6f3b6');
      } finally {
        ui.setRunning(false);
        console.groupEnd();
      }
    }

    // X-Button: GUI ausblenden und bis zum Verlassen/Zurückkehren unterdrücken
    box.querySelector('#trbd-x').onclick = () => {
      sessionStorage.setItem(UI_SUPPRESS_KEY, location.pathname);
      removeUI();
    };

    startBtn?.addEventListener('click', () => {
      if (ui.running) return;
      ui.update();
      run();
    });
    stopBtn?.addEventListener('click', () => {
      stopFlag = true;
      ui.setStatus('Stop angefordert …', '#ffd27a');
      log('STOP angefordert');
    });

    log('Skript geladen. Konsole (F12) zeigt Logs.');
  }

  // ---------------- SPA Auto-Boot ----------------
  function pathEligible() {
    return /\/profile\/(transactions|activities)$/.test(location.pathname);
  }

  function bootIfEligible() {
    if (!pathEligible()) {
      // Zielseiten verlassen → GUI entfernen und Unterdrückung zurücksetzen
      removeUI();
      sessionStorage.removeItem(UI_SUPPRESS_KEY);
      return;
    }
    if (!document.body) {
      const id = setInterval(() => {
        if (document.body) { clearInterval(id); buildUIOnce(); }
      }, 50);
      setTimeout(() => clearInterval(id), 5000);
    } else {
      buildUIOnce();
    }
  }

  (function hookRouting() {
    if (window.__trbd_routing_hooked__) return;
    window.__trbd_routing_hooked__ = true;

    const fire = () => setTimeout(bootIfEligible, 0);

    const origPush = history.pushState;
    history.pushState = function() {
      const r = origPush.apply(this, arguments);
      fire();
      return r;
    };

    const origReplace = history.replaceState;
    history.replaceState = function() {
      const r = origReplace.apply(this, arguments);
      fire();
      return r;
    };

    window.addEventListener('popstate', fire);
    const poll = setInterval(() => {
      if (!window.__trbd_routing_hooked__) return clearInterval(poll);
      bootIfEligible();
    }, 1500);
  })();

  // erster Start nach initialem Load
  bootIfEligible();
})();
