const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(require('path').join(__dirname, '..', 'dashboard.html'), 'utf8');

const start = html.indexOf('function renderKickChatHtml');
const end   = html.indexOf('\n}', start) + 2;
const src   = html.slice(start, end);

const g = {};
vm.createContext(g);
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
g.escapeHtml = escapeHtml;
vm.runInContext('const escapeHtml = globalThis.escapeHtml;\n' + src + '\nglobalThis.__r = renderKickChatHtml;', g);
const r = g.__r;

const cases = [
  ['the screenshot (with scheme)', 'congratulations @emergeonkick \u00b7 Verify this draw: https://wenbot.gg/v/3wytq7me'],
  ['schemeless bare link',         'Verify this draw: wenbot.gg/v/3wytq7me'],
  ['false-positive guard',         'no link, just 1.5x and e.g. and vs. text'],
  ['trailing punctuation',         'see wenbot.gg/v/abc. ok'],
  ['xss + a bare link',            '<script>alert(1)</script> evil.com/x'],
  ['emote still works',            'gg [emote:37226:emergeHype] wenbot.gg/v/xy'],
];

let fail = 0;
for (const [label, input] of cases) {
  const out = r(input);
  console.log('[' + label + ']');
  console.log('  ' + out + '\n');
  // Safety: no raw executable script tag ever survives.
  if (/<script/i.test(out)) { fail++; console.log('  *** RAW <script> LEAKED ***'); }
  // Any anchor must have a safe href.
  const hrefs = [...out.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
  for (const h of hrefs) if (!/^https:\/\//.test(h)) { fail++; console.log('  *** unsafe href: ' + h + ' ***'); }
}

// Targeted assertions.
const A = (cond, label) => { if (!cond) { fail++; console.log('FAIL ' + label); } else console.log('ok   ' + label); };
console.log('---');
A(r('x https://wenbot.gg/v/abc y').includes('<a href="https://wenbot.gg/v/abc"'), 'full URL becomes an anchor');
A(r('x wenbot.gg/v/abc y').includes('<a href="https://wenbot.gg/v/abc"'), 'bare domain+path gets https:// href');
A(!r('this costs 1.5x more').includes('<a '), 'a bare "1.5x" is not linkified');
A(!r('e.g. something').includes('<a '), 'a bare "e.g." is not linkified');
A(r('end wenbot.gg/v/abc.').match(/<\/a>\./), 'trailing period stays outside the link');
A(r('<b>hi</b> wenbot.gg/v/z').includes('&lt;b&gt;'), 'html is still escaped');
A(r('[emote:1:smile] wenbot.gg/v/z').includes('<img src="https://files.kick.com/emotes/1/'), 'emotes still render');

console.log('\n' + (fail ? fail + ' FAILURES' : 'all clear'));
process.exit(fail ? 1 : 0);
