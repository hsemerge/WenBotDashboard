// Shared client-side utilities — loaded via <script src="/js/utils.js">

// HTML-escape a string for safe interpolation into innerHTML.
// Replaces &, <, >, " — single quotes are not escaped because they're rarely
// the boundary character; if you need attribute-safe, wrap with double quotes.
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
