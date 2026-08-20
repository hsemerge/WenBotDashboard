// Click-to-sort table headers — shared by the admin panel and the dashboard.
// Loaded via <script src="/js/table-sort.js">; defines createTableSort as a global.
//
// The helper owns the sort state, the header chrome and the comparator. The page
// keeps rendering its own rows, so sorting composes with whatever searching and
// filtering that table already does — call sorter.apply(rows) on the filtered
// array right before you build the markup.
//
// Headers opt in with data-sort="<column key>"; a <th> without it stays inert
// (expander arrows, action buttons).

(function (global) {
  'use strict';

  var ARROWS = { asc: '\u25B2', desc: '\u25BC' };

  function isMissing(v) {
    return v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v));
  }

  function baseCompare(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    // numeric:true so "slot 2" sorts before "slot 10" rather than after it.
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  /**
   * @param {object}   opts
   * @param {string}   opts.storageKey  localStorage key — the choice survives a refresh
   * @param {Element|string} opts.head   the <tr> of <th>s (element or selector)
   * @param {object}   opts.columns     key -> getter fn, or { get, dir } to pin a
   *                                    column's first-click direction
   * @param {function} opts.onChange    called after a header click; re-render here
   * @returns {{ apply: function, active: function, clear: function }}
   */
  global.createTableSort = function createTableSort(opts) {
    var columns = opts.columns || {};
    var state   = { key: null, dir: null };
    // Last set of rows handed to apply(), so a header click can inspect real values
    // to decide which way the first click should point.
    var lastRows = [];

    try {
      var saved = JSON.parse(localStorage.getItem(opts.storageKey) || 'null');
      if (saved && columns[saved.key]) state = saved;
    } catch (e) { /* ignore — an unreadable preference is just no preference */ }

    function getter(key) {
      var c = columns[key];
      return typeof c === 'function' ? c : (c && c.get);
    }

    // First click on a column: text reads better ascending, numbers and dates
    // read better descending (biggest payment, most recent login). A column can
    // pin its own direction when neither guess fits — plan tiers, say.
    function firstDir(key) {
      var c = columns[key];
      if (c && c.dir) return c.dir;
      var get = getter(key);
      for (var i = 0; i < lastRows.length; i++) {
        var v = get(lastRows[i]);
        if (!isMissing(v)) return typeof v === 'number' ? 'desc' : 'asc';
      }
      return 'asc';
    }

    function paintHeaders() {
      var head = typeof opts.head === 'string' ? document.querySelector(opts.head) : opts.head;
      if (!head) return;
      var ths = head.querySelectorAll('th[data-sort]');
      for (var i = 0; i < ths.length; i++) {
        var th  = ths[i];
        var key = th.getAttribute('data-sort');
        var on  = state.key === key;
        var label = th.getAttribute('data-sort-label');
        if (label === null) {
          // Stash the original text once, so repainting never eats the arrow.
          label = th.textContent.trim();
          th.setAttribute('data-sort-label', label);
        }
        th.style.cursor     = 'pointer';
        th.style.userSelect = 'none';
        th.style.whiteSpace = 'nowrap';
        th.title = on
          ? 'Sorted ' + (state.dir === 'asc' ? 'ascending' : 'descending') + ' — click to reverse'
          : 'Sort by ' + label;
        th.innerHTML = label
          + '<span style="margin-left:5px;font-size:9px;opacity:' + (on ? '1' : '.28') + ';">'
          + (on ? ARROWS[state.dir] : ARROWS.desc) + '</span>';
      }
    }

    function bind() {
      var head = typeof opts.head === 'string' ? document.querySelector(opts.head) : opts.head;
      if (!head || head.__sortBound) return;
      head.__sortBound = true;
      head.addEventListener('click', function (ev) {
        var th = ev.target.closest ? ev.target.closest('th[data-sort]') : null;
        if (!th || !head.contains(th)) return;
        var key = th.getAttribute('data-sort');
        if (!columns[key]) return;
        if (state.key === key) {
          // Third click clears back to the table's own default ordering, so
          // there's always a way back without reloading the page.
          if (state.dir === firstDir(key)) {
            state = { key: key, dir: state.dir === 'asc' ? 'desc' : 'asc' };
          } else {
            state = { key: null, dir: null };
          }
        } else {
          state = { key: key, dir: firstDir(key) };
        }
        try { localStorage.setItem(opts.storageKey, JSON.stringify(state)); } catch (e) {}
        paintHeaders();
        if (opts.onChange) opts.onChange();
      });
      paintHeaders();
    }

    return {
      // Sorted COPY. Returns the input untouched when no column is active, so the
      // caller's own default ordering stays in charge until someone clicks.
      apply: function (rows) {
        lastRows = rows;
        bind();
        var get = state.key && getter(state.key);
        if (!get) return rows;
        var dir = state.dir === 'asc' ? 1 : -1;
        return rows.slice().sort(function (ra, rb) {
          var a = get(ra), b = get(rb);
          var am = isMissing(a), bm = isMissing(b);
          // Blanks always sink, whichever way the column points — a screenful of
          // "—" at the top is never what the click was for.
          if (am || bm) return (am && bm) ? 0 : (am ? 1 : -1);
          return baseCompare(a, b) * dir;
        });
      },
      active: function () { return state.key ? { key: state.key, dir: state.dir } : null; },
      refresh: function () { bind(); paintHeaders(); },
    };
  };
})(window);
