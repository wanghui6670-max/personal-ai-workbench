/*
 * Shared utilities for Personal AI Workbench frontend.
 * Loaded as a classic script before all other JS files.
 * Exposes window.WB with commonly duplicated functions.
 * Each consuming file destructures: const { esc, json, toast } = window.WB;
 */
(function () {
  'use strict';

  /** HTML-escape a value for safe innerHTML injection. */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Same as esc — alias for attribute values. */
  function attr(s) { return esc(s); }

  /** encodeURIComponent wrapper that never throws on null/undefined. */
  function routePart(value) {
    return encodeURIComponent(String(value ?? ''));
  }

  /** Clamp a number to 0-100 integer. */
  function safePercent(value) {
    return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
  }

  /** Format an ISO timestamp as "M月D日 HH:mm". Returns '—' for falsy. */
  function fmtTime(s) {
    if (!s) return '—';
    var d = new Date(s);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /** Format a date string as "M月D日" (appends T00:00:00 for date-only strings). */
  function fmtDate(s) {
    if (!s) return '—';
    var d = new Date(s.length <= 10 ? s + 'T00:00:00' : s);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  }

  /** Compact whitespace and truncate to max chars with ellipsis. */
  function compact(value, max) {
    max = max || 180;
    var text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  /**
   * Fetch JSON from the server. Throws on non-OK response.
   * Uses the global fetch (which may be wrapped by manual-control / ux-enhancements).
   */
  async function json(url, opts) {
    opts = opts || {};
    var r = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts
    });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(data.error || data.question || '请求失败 ' + r.status);
    return data;
  }

  /**
   * Show a toast notification. Looks for #toast element in DOM.
   * @param {string} msg - Message text
   * @param {boolean} error - If true, adds error styling
   * @param {number} duration - Auto-dismiss ms (default 2600)
   */
  function toast(msg, error, duration) {
    var el = document.querySelector('#toast');
    if (!el) { if (error) alert(msg); return; }
    el.textContent = msg;
    el.className = 'toast show' + (error ? ' error' : '');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = 'toast'; }, duration || 2600);
  }

  /** Create a DOM element with optional class and text. */
  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Extract project ID from location.hash like "#project/abc". */
  function projectIdFromHash() {
    var match = (location.hash || '').match(/^#project\/([^/]+)$/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch (e) { return null; }
  }

  /**
   * Setup accessibility for a modal overlay element:
   * - role="dialog", aria-modal="true"
   * - Focus trap (Tab cycles within modal)
   * - Escape key to close (calls onClose callback)
   * - Move focus to first focusable element
   * - Store previous focus for restoration
   * Returns a cleanup function to call when modal closes.
   */
  function setupModal(overlay, onClose) {
    if (!overlay) return function () {};
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    var prevFocus = document.activeElement;
    var focusable = overlay.querySelectorAll('input,button,select,textarea,[tabindex]');
    if (focusable.length) {
      // Focus first non-hidden element
      for (var i = 0; i < focusable.length; i++) {
        if (focusable[i].type !== 'hidden' && !focusable[i].hidden) {
          focusable[i].focus();
          break;
        }
      }
    }
    function trap(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (onClose) onClose();
        cleanup();
        return;
      }
      if (e.key === 'Tab' && focusable.length > 1) {
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', trap);
    function cleanup() {
      document.removeEventListener('keydown', trap);
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus(); } catch (e) {}
      }
    }
    return cleanup;
  }

  /** Fetch /api/state and find a project by ID. */
  async function resolveProject(projectId) {
    var state = await json('/api/state');
    return Array.isArray(state.projects)
      ? state.projects.find(function (p) { return p.id === projectId; }) || null
      : null;
  }

  /** Extract the current view name from location.hash (e.g. "#today" → "today"). */
  function currentView() {
    return (location.hash || '#today').slice(1).split('/')[0] || 'today';
  }

  /** Set the topbar title and description. */
  function setTop(title, desc) {
    var h = document.querySelector('.top-left h1');
    if (h && h.textContent !== title) h.textContent = title;
    var p = document.querySelector('.top-left p');
    if (p && p.textContent !== desc) p.textContent = desc;
  }

  /**
   * Hide legacy main children except preserved nodes (by id) and .capture.
   * Used by enhancement modules to clean up app.js-rendered content.
   */
  function hideLegacyMain(main, keepCapture) {
    if (!main) return;
    var preserve = new Set(['v3-dashboard', 'v3-scene', 'v3-media-page', 'crew-center', 'skills-center', 'jc-operations-page']);
    for (var i = 0; i < main.children.length; i++) {
      var child = main.children[i];
      if (preserve.has(child.id)) continue;
      if (keepCapture && child.classList.contains('capture')) {
        if (child.classList.contains('v3-hidden')) child.classList.remove('v3-hidden');
        continue;
      }
      if (!child.classList.contains('v3-hidden')) child.classList.add('v3-hidden');
    }
  }

  window.WB = {
    esc: esc,
    attr: attr,
    routePart: routePart,
    safePercent: safePercent,
    fmtTime: fmtTime,
    fmtDate: fmtDate,
    compact: compact,
    json: json,
    toast: toast,
    element: element,
    projectIdFromHash: projectIdFromHash,
    resolveProject: resolveProject,
    setupModal: setupModal,
    currentView: currentView,
    setTop: setTop,
    hideLegacyMain: hideLegacyMain
  };
})();
