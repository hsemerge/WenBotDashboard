// Minimal QR Code generator — byte mode, error-correction level M, versions 1-12.
//
// Exists because the 2FA setup pages must render a scannable QR for an
// otpauth:// URI, and that URI contains the TOTP SECRET: it must never be sent
// to a third-party QR service, and the site's CSP allows no external scripts
// anyway. So the code is generated locally, in the browser.
//
// Scope is deliberately narrow — byte mode + ECL M + versions 1-12 covers any
// otpauth URI (~290 bytes at v12) and nothing more. Tables below are the ISO/IEC
// 18004 values for that slice.
//
//   window.qrMatrix(text) -> { size, modules }   modules[y][x] === true = dark
//   window.qrSvg(text, opts) -> an <svg> string
//
// Verified module-for-module against the reference `qrcode` npm package across
// the full version range (see scripts/verify-qr.js).

(function () {
  // total codewords, data codewords, EC codewords per block, block count — ECL M
  var VER = {
    1:  [26, 16, 10, 1],   2:  [44, 28, 16, 1],   3:  [70, 44, 26, 1],
    4:  [100, 64, 18, 2],  5:  [134, 86, 24, 2],  6:  [172, 108, 16, 4],
    7:  [196, 124, 18, 4], 8:  [242, 154, 22, 4], 9:  [292, 182, 22, 5],
    10: [346, 216, 26, 5], 11: [404, 254, 30, 5], 12: [466, 290, 22, 8],
  };
  // Row/column coordinates where alignment patterns are centred.
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58],
  };

  // ── GF(256) arithmetic for Reed-Solomon, primitive polynomial 0x11D ────────
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    for (var i = 0, x = 1; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  // Multiply two polynomials (coefficients in DESCENDING degree order).
  function polyMul(a, b) {
    var res = new Array(a.length + b.length - 1).fill(0);
    for (var i = 0; i < a.length; i++)
      for (var j = 0; j < b.length; j++)
        res[i + j] ^= gmul(a[i], b[j]);
    return res;
  }
  // Generator polynomial for `degree` EC codewords: ∏ (x + α^i), i = 0..degree-1.
  // Written as an explicit polynomial multiply — the hand-rolled recurrence this
  // replaced had the two terms transposed, which silently produced valid-looking
  // but wrong EC bytes (the symbol renders fine and fails to decode).
  function rsPoly(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) poly = polyMul(poly, [1, EXP[d]]);
    return poly;
  }
  function rsEncode(data, ecLen) {
    var gen = rsPoly(ecLen);
    var rem = new Array(ecLen).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      rem.shift(); rem.push(0);
      for (var j = 0; j < ecLen; j++) rem[j] ^= gmul(gen[j + 1], factor);
    }
    return rem;
  }

  // ── Bit stream ────────────────────────────────────────────────────────────
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  function utf8Bytes(str) {
    var out = [], enc = encodeURIComponent(str);
    for (var i = 0; i < enc.length; i++) {
      if (enc[i] === '%') { out.push(parseInt(enc.substr(i + 1, 2), 16)); i += 2; }
      else out.push(enc.charCodeAt(i));
    }
    return out;
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 12; v++) {
      var dataCw = VER[v][1];
      var lenBits = v < 10 ? 8 : 16;              // byte-mode count field width
      var needBits = 4 + lenBits + byteLen * 8;   // mode + count + payload
      if (needBits <= dataCw * 8) return v;
    }
    throw new Error('QR: data too long (max ~290 bytes)');
  }

  function buildCodewords(bytes, version) {
    var spec = VER[version], dataCw = spec[1], ecLen = spec[2], blocks = spec[3];
    var buf = new BitBuf();
    buf.put(4, 4);                                        // byte mode
    buf.put(bytes.length, version < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) buf.put(bytes[i], 8);
    // terminator (up to 4 bits) then pad to a byte boundary
    var cap = dataCw * 8;
    for (var t = 0; t < 4 && buf.bits.length < cap; t++) buf.bits.push(0);
    while (buf.bits.length % 8) buf.bits.push(0);
    // alternating pad bytes
    var pads = [0xEC, 0x11], p = 0;
    while (buf.bits.length < cap) { buf.put(pads[p++ % 2], 8); }
    // bits -> bytes
    var data = [];
    for (var b = 0; b < buf.bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | buf.bits[b + k];
      data.push(v);
    }
    // Split into blocks. Short blocks come first; the spec distributes the
    // remainder across the LAST blocks, each holding one extra data codeword.
    var shortLen = Math.floor(dataCw / blocks), extra = dataCw % blocks;
    var dataBlocks = [], ecBlocks = [], pos = 0;
    for (var bl = 0; bl < blocks; bl++) {
      var len = shortLen + (bl >= blocks - extra ? 1 : 0);
      var chunk = data.slice(pos, pos + len); pos += len;
      dataBlocks.push(chunk);
      ecBlocks.push(rsEncode(chunk, ecLen));
    }
    // Interleave data, then EC.
    var out = [], maxData = shortLen + (extra ? 1 : 0);
    for (var c = 0; c < maxData; c++)
      for (var d = 0; d < blocks; d++)
        if (c < dataBlocks[d].length) out.push(dataBlocks[d][c]);
    for (var e = 0; e < ecLen; e++)
      for (var f = 0; f < blocks; f++) out.push(ecBlocks[f][e]);
    return out;
  }

  // ── Matrix ────────────────────────────────────────────────────────────────
  function newMatrix(size) {
    var m = new Array(size), r = new Array(size);
    for (var i = 0; i < size; i++) { m[i] = new Array(size).fill(null); r[i] = new Array(size).fill(false); }
    return { m: m, reserved: r };
  }
  function placeFinder(M, size, row, col) {
    for (var r = -1; r <= 7; r++) for (var c = -1; c <= 7; c++) {
      var rr = row + r, cc = col + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      var dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                 (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                 (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      M.m[rr][cc] = dark; M.reserved[rr][cc] = true;
    }
  }
  function buildMatrix(version, codewords, mask) {
    var size = version * 4 + 17, M = newMatrix(size);
    placeFinder(M, size, 0, 0); placeFinder(M, size, 0, size - 7); placeFinder(M, size, size - 7, 0);
    // timing patterns
    for (var i = 8; i < size - 8; i++) {
      M.m[6][i] = i % 2 === 0; M.reserved[6][i] = true;
      M.m[i][6] = i % 2 === 0; M.reserved[i][6] = true;
    }
    // alignment patterns (skipped where they'd collide with a finder)
    var pos = ALIGN[version];
    for (var a = 0; a < pos.length; a++) for (var b = 0; b < pos.length; b++) {
      var ar = pos[a], ac = pos[b];
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
        M.m[ar + dr][ac + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        M.reserved[ar + dr][ac + dc] = true;
      }
    }
    // dark module + reserve format areas
    M.m[size - 8][8] = true; M.reserved[size - 8][8] = true;
    for (var f = 0; f < 9; f++) {
      if (!M.reserved[8][f]) { M.m[8][f] = false; M.reserved[8][f] = true; }
      if (!M.reserved[f][8]) { M.m[f][8] = false; M.reserved[f][8] = true; }
    }
    for (var g = 0; g < 8; g++) {
      if (!M.reserved[8][size - 1 - g]) { M.m[8][size - 1 - g] = false; M.reserved[8][size - 1 - g] = true; }
      if (!M.reserved[size - 1 - g][8]) { M.m[size - 1 - g][8] = false; M.reserved[size - 1 - g][8] = true; }
    }
    // Version info (v7+): 6 data bits + BCH(18,6) remainder, mirrored into the
    // blocks left of the top-right finder and above the bottom-left one.
    if (version >= 7) {
      var rem18 = version;
      for (var q = 0; q < 12; q++) rem18 = (rem18 << 1) ^ (((rem18 >>> 11) & 1) * 0x1F25);
      var vbits = ((version << 12) | (rem18 & 0xFFF)) >>> 0;
      for (var t = 0; t < 18; t++) {
        var bit = ((vbits >>> t) & 1) === 1;
        var rr2 = Math.floor(t / 3), cc2 = size - 11 + (t % 3);
        M.m[rr2][cc2] = bit; M.reserved[rr2][cc2] = true;
        M.m[cc2][rr2] = bit; M.reserved[cc2][rr2] = true;
      }
    }
    // data placement — two-column zigzag from bottom-right, skipping column 6
    var bitIdx = 0, dirUp = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (var n = 0; n < size; n++) {
        var row = dirUp ? size - 1 - n : n;
        for (var w = 0; w < 2; w++) {
          var cc3 = col - w;
          if (M.reserved[row][cc3]) continue;
          var dark2 = false;
          if (bitIdx < codewords.length * 8) {
            dark2 = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
          }
          bitIdx++;
          if (maskFn(mask, row, cc3)) dark2 = !dark2;
          M.m[row][cc3] = dark2;
        }
      }
      dirUp = !dirUp;
    }
    return M;
  }
  function maskFn(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }
  // Format info: ECL M = 0b00, BCH(15,5) with mask 0x5412.
  function placeFormat(M, size, mask) {
    var data = (0x00 << 3) | mask;          // ECL M bits are 00
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
    var bits = (((data << 10) | rem) ^ 0x5412) & 0x7FFF;
    for (var k = 0; k < 15; k++) {
      // MSB first: spec bit 0 of the placement sequence is the HIGH bit of the
      // 15-bit format value, not the low one. Taking it LSB-first mirrors the
      // whole string and the symbol decodes as the wrong mask/EC level.
      var bit = ((bits >>> (14 - k)) & 1) === 1;
      // top-left
      if (k < 6)       M.m[8][k] = bit;
      else if (k < 8)  M.m[8][k + 1] = bit;
      else if (k === 8) M.m[7][8] = bit;
      else              M.m[14 - k][8] = bit;
      // Second copy: SEVEN bits run up the column under the bottom-left finder
      // (k 0-6), then EIGHT run right of the top-right finder (k 7-14). Using
      // eight in the column overwrites the mandatory dark module at
      // (size-8, 8) and shifts the whole horizontal run — the code still looks
      // plausible but decodes as garbage.
      if (k < 7) M.m[size - 1 - k][8] = bit;
      else       M.m[8][size - 15 + k] = bit;
    }
  }
  // Penalty scoring, used to pick the mask that scans most reliably.
  function penalty(m, size) {
    var score = 0, i, j, run, dark = 0;
    for (i = 0; i < size; i++) {
      run = 1;
      for (j = 1; j < size; j++) {
        if (m[i][j] === m[i][j - 1]) { run++; } else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
      run = 1;
      for (j = 1; j < size; j++) {
        if (m[j][i] === m[j - 1][i]) { run++; } else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
    for (i = 0; i < size - 1; i++) for (j = 0; j < size - 1; j++) {
      var a = m[i][j];
      if (a === m[i][j + 1] && a === m[i + 1][j] && a === m[i + 1][j + 1]) score += 3;
    }
    var pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    var pat2 = [false, false, false, false, true, false, true, true, true, false, true];
    function match(arr, p) { for (var z = 0; z < 11; z++) if (arr[z] !== p[z]) return false; return true; }
    for (i = 0; i < size; i++) for (j = 0; j < size - 10; j++) {
      var rowSeq = [], colSeq = [];
      for (var z = 0; z < 11; z++) { rowSeq.push(m[i][j + z]); colSeq.push(m[j + z][i]); }
      if (match(rowSeq, pat1) || match(rowSeq, pat2)) score += 40;
      if (match(colSeq, pat1) || match(colSeq, pat2)) score += 40;
    }
    for (i = 0; i < size; i++) for (j = 0; j < size; j++) if (m[i][j]) dark++;
    var pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function qrMatrix(text) {
    var bytes = utf8Bytes(String(text));
    var version = pickVersion(bytes.length);
    var cw = buildCodewords(bytes, version);
    var size = version * 4 + 17, best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var M = buildMatrix(version, cw, mask);
      placeFormat(M, size, mask);
      var s = penalty(M.m, size);
      if (s < bestScore) { bestScore = s; best = M; }
    }
    return { size: size, version: version, modules: best.m };
  }

  function qrSvg(text, opts) {
    opts = opts || {};
    var q = qrMatrix(text);
    var quiet = opts.quiet == null ? 4 : opts.quiet;
    var total = q.size + quiet * 2;
    var dark = opts.dark || '#000', light = opts.light || '#fff';
    var d = '';
    for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) {
      if (q.modules[y][x]) d += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" ' +
      'width="' + (opts.size || 220) + '" height="' + (opts.size || 220) + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/>' +
      '<path d="' + d + '" fill="' + dark + '"/></svg>';
  }

  window.qrMatrix = qrMatrix;
  window.qrSvg = qrSvg;
})();
