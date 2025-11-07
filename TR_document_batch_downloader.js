// ==UserScript==
// @name         TR Document Batch Downloader
// @namespace    tr-batch-dl
// @description  Im Tab "Profile - Transaktionen", sowie im Tab "Profile - Aktivität" werden alle Elemente angeklickt und die verlinkten Dokumente heruntergeladen.
// @match        https://app.traderepublic.com/*
// @run-at       document-idle
// @grant        GM_openInTab
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // ---------------- Config ----------------
  const CFG = {
    enableAutoListScroll: true,
    slowMode: true,
    debugOutline: true,

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

  async function clickAllDocs() {
    console.group(`${LOG_PREFIX} Dokumente öffnen`, LOG_STYLE);
    const docs = findDocsButtons();
    log('Dokumente gefunden:', docs.length);
    let opened = 0;
    for (let i=0;i<docs.length;i++) {
      const btn = docs[i];
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

    console.warn('%c[TR-BatchDL] Close: ❌ blieb offen','color:#0ea5e9;font-weight:600');
    console.groupEnd();
    return false;
  }

  // ---------------- window.open Hook ----------------
  function hookWindowOpen() {
    const prev = window.open;
    if (!prev || prev._trbd_hooked) return () => {};
    const unhook = () => { window.open = prev; log('window.open unhooked'); };
    window.open = function(url, target, features) {
      log('window.open:', { url, target });
      try { if (url) GM_openInTab(url, { active: false, insert: true }); } catch {}
      return prev.apply(this, arguments);
    };
    window.open._trbd_hooked = true;
    log('window.open gehookt');
    return unhook;
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

    const box = document.createElement('div');
    box.id = UI_ID;
    box.style.cssText = `
      position: fixed; z-index: 999999; right: 12px; bottom: 12px;
      background: rgba(20,20,20,.92); color: #fff; font: 12px system-ui, sans-serif;
      border-radius: 12px; padding: 12px; width: 300px; box-shadow: 0 6px 20px rgba(0,0,0,.45);
    `;
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong>TR Batch Downloader</strong>
        <button id="trbd-x" style="background:none;border:none;color:#aaa;font-size:16px;cursor:pointer;">×</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <label>Von<br><input id="trbd-start" type="number" min="0" value="\${+localStorage.getItem('trbd_start')||0}" style="width:100%"></label>
        <label>Bis (-1 Ende)<br><input id="trbd-end" type="number" min="-1" value="\${+localStorage.getItem('trbd_end')||-1}" style="width:100%"></label>
      </div>
      <label style="display:flex;gap:6px;align-items:center;margin-top:8px;">
        <input id="trbd-autoscroll" type="checkbox" \${CFG.enableAutoListScroll?'checked':''}> Liste automatisch nachladen
      </label>
      <label style="display:flex;gap:6px;align-items:center;margin-top:4px;">
        <input id="trbd-slow" type="checkbox" \${CFG.slowMode?'checked':''}> Slow Mode
      </label>
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

// Werte aus Storage lesen (Fallbacks aus CFG)
const startDefault = (localStorage.getItem('trbd_start') ?? '0').toString();
const endDefault   = (localStorage.getItem('trbd_end')   ?? '-1').toString();

// Sofort setzen
startEl.value = startDefault;
endEl.value   = endDefault;
autoEl.checked = !!CFG.enableAutoListScroll;
slowEl.checked = !!CFG.slowMode;

// Und noch einmal im nächsten Frame (gegen SPA-Reflow/Hydration)
requestAnimationFrame(() => {
  startEl.value = startEl.value || startDefault;
  endEl.value   = endEl.value   || endDefault;
  autoEl.checked = autoEl.checked ?? !!CFG.enableAutoListScroll;
  slowEl.checked = slowEl.checked ?? !!CFG.slowMode;
});


    const ui = {
      box,
      running: false,
      setStatus(msg, color='#9fdcff'){ const s = box.querySelector('#trbd-status'); s.textContent = msg; s.style.color = color; },
      getStart(){ return +box.querySelector('#trbd-start').value || 0; },
      getEnd(){ return +box.querySelector('#trbd-end').value ?? -1; },
      update(){
        CFG.enableAutoListScroll = box.querySelector('#trbd-autoscroll').checked;
        CFG.slowMode = box.querySelector('#trbd-slow').checked;
        localStorage.setItem('trbd_start', ui.getStart());
        localStorage.setItem('trbd_end', ui.getEnd());
      }
    };

    let stopFlag = false;

    async function run() {
      const desiredPath = desiredPathFromLocation();
      log('Fixiere Tab auf:', desiredPath);

      const unhook = hookWindowOpen();
      stopFlag = false;
      ui.running = true;
      ui.setStatus('Suche Listeneinträge …');
      console.group(`${LOG_PREFIX} RUN START`, LOG_STYLE);

      await ensureActiveTab(desiredPath);

      let listContainer = findScrollableListContainer();
      if (CFG.enableAutoListScroll && listContainer) await autoScrollListToLoadMore(listContainer);

      let items = getListItems();
      log('Anzahl Listeneinträge:', items.length);
      if (!items.length) { ui.setStatus('Keine Einträge gefunden.', '#ffb4b4'); ui.running = false; unhook(); console.groupEnd(); return; }

      const startIdx = Math.max(0, +ui.box.querySelector('#trbd-start').value || 0);
      const endRaw  = +ui.box.querySelector('#trbd-end').value;
      const endIdx  = (isNaN(endRaw) || endRaw < 0) ? (items.length - 1) : Math.min(endRaw, items.length - 1);
      log('Bereich:', { startIdx, endIdx });
      if (startIdx > endIdx) { ui.setStatus(`Ungültiger Bereich (${startIdx} > ${endIdx}).`, '#ffb4b4'); ui.running = false; unhook(); console.groupEnd(); return; }

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

        ui.setStatus(`(${i}/${endIdx}) Öffne Eintrag …`);
        const overlay = await openItemOverlay(item, i, endIdx);
        unmark(item);
        if (!overlay || !isVisible(overlay)) {
          ui.setStatus(`(${i}/${endIdx}) Kein Overlay – skip`, '#ffd27a');
          continue;
        }

        ui.setStatus(`(${i}/${endIdx}) Öffne Dokumente …`);
        const count = await clickAllDocs();
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
      ui.running = false;
      unhook();
      console.groupEnd();
    }

    // X-Button: GUI ausblenden und bis zum Verlassen/Zurückkehren unterdrücken
    box.querySelector('#trbd-x').onclick = () => {
      sessionStorage.setItem(UI_SUPPRESS_KEY, location.pathname);
      removeUI();
    };

    box.querySelector('#trbd-start-btn').addEventListener('click', () => {
      if (ui.running) return;
      ui.update();
      run();
    });
    box.querySelector('#trbd-stop-btn').addEventListener('click', () => {
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
