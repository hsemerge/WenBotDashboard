// Verify js/qr.js against the reference `qrcode` npm package, module for module.
//
// A QR encoder is easy to get subtly wrong (masking, block interleaving, format
// bits) and the failure mode is a code that simply won't scan — which you only
// find out when a streamer is standing there with their phone. So the encoder is
// diffed against a known-good implementation across the whole version range and
// a spread of realistic otpauth payloads.
//
// USAGE:  node scripts/verify-qr.js /path/to/reference-node_modules
//   (the reference dir must contain node_modules/qrcode; it is a DEV dependency
//    only — nothing in the site ships it.)

const path = require("path");
const fs   = require("fs");

const refDir = process.argv[2];
if (!refDir) { console.error("Usage: node scripts/verify-qr.js <dir-containing-node_modules/qrcode>"); process.exit(1); }
let QR;
try { QR = require(path.join(refDir, "node_modules", "qrcode")); }
catch (e) { console.error("Reference not found:", e.message); process.exit(1); }

// Load our browser file into a fake window.
const src = fs.readFileSync(path.join(__dirname, "..", "js", "qr.js"), "utf8");
const win = {};
new Function("window", src)(win);

const cases = [];
// Realistic otpauth URIs of varying length (the actual use case).
cases.push("otpauth://totp/WenBot:a@b.co?secret=JBSWY3DPEHPK3PXP&issuer=WenBot");
cases.push("otpauth://totp/WenBot%20Admin:cscogland@gmail.com?secret=FF2RE6EOGL32W2JSFR2PLFGNR7VWBT4C&issuer=WenBot&algorithm=SHA1&digits=6&period=30");
cases.push("otpauth://totp/WenBot:triitongm@gmail.com?secret=KRSXG5CTMVRXEZLUKN2XAZLSKNSWG23FMFZA&issuer=WenBot");
// Length sweep: force every version boundary 1..12.
for (const n of [1, 5, 10, 14, 20, 28, 30, 44, 50, 64, 70, 86, 90, 108, 120, 124, 140, 154, 170, 182, 200, 216, 240, 254, 270, 280]) {
  cases.push("A".repeat(n));
}
// Mixed content + unicode.
cases.push("https://wenbot.gg/verify?x=" + "9".repeat(60));
cases.push("Ünicode — tëst ✓ " + "z".repeat(40));

// The real question is not "identical to the reference" — several masks produce
// equally valid codes, so a different (legal) mask choice would fail a matrix
// diff while scanning perfectly. So DECODE our output and check it round-trips.
let jsQR;
try { const j = require(path.join(refDir, "node_modules", "jsqr")); jsQR = j.default || j; }
catch (e) { console.error("jsqr not found:", e.message); process.exit(1); }

// Render a module matrix to an RGBA bitmap the way a camera would see it:
// scaled up, with the mandatory 4-module quiet zone.
function render(mine, scale = 4, quiet = 4) {
  const n = mine.size, dim = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!mine.modules[y][x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const px = ((y + quiet) * scale + dy) * dim + ((x + quiet) * scale + dx);
      data[px * 4] = 0; data[px * 4 + 1] = 0; data[px * 4 + 2] = 0;
    }
  }
  return { data, dim };
}

let pass = 0, fail = 0;
for (const text of cases) {
  let mine;
  try { mine = win.qrMatrix(text); }
  catch (e) { console.log(`FAIL (ours threw) len=${text.length}: ${e.message}`); fail++; continue; }

  // Sanity-check the version choice against the reference (byte mode forced —
  // left alone it picks alphanumeric for uppercase input, a mode difference).
  let ref = null;
  try { ref = QR.create([{ data: text, mode: "byte" }], { errorCorrectionLevel: "M" }); } catch {}
  if (ref && ref.version !== mine.version) {
    console.log(`FAIL version len=${text.length}: ours v${mine.version} vs ref v${ref.version}`); fail++; continue;
  }

  const img = render(mine);
  const got = jsQR(img.data, img.dim, img.dim);
  if (!got) { console.log(`FAIL undecodable len=${String(text.length).padStart(3)} v${mine.version}`); fail++; continue; }
  if (got.data !== text) {
    console.log(`FAIL wrong data len=${text.length} v${mine.version}: got ${JSON.stringify(got.data.slice(0, 40))}`); fail++; continue;
  }
  pass++;
}

console.log(`\n${pass} decoded correctly, ${fail} failed, of ${pass + fail}.`);
process.exit(fail ? 1 : 0);
