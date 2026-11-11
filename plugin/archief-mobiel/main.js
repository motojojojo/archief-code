'use strict';
// Archief mobiel: een simpel scherm om vanaf de telefoon items toe te voegen en te taggen.
// Schrijft notities in hetzelfde formaat als de visualisator (datum, lijn, type, tags, inbox).
const { Plugin, ItemView, Notice, normalizePath, requestUrl } = require('obsidian');

const VIEW = 'archief-mobiel';
// de versie van deze code zelf. Obsidian kan this.manifest al bijwerken na een sync terwijl de oude code nog draait,
// daarom vergelijkt de ↻-knop manifest.json op schijf met dit getal (moet gelijk zijn aan manifest.json)
const BUILD = '0.38.0';
// waar de nieuwste code staat: de ↻-knop haalt hem van GitHub (lukt dat niet, dan via Remotely Save zoals vroeger)
const REPO = 'motojojojo/archief-code', REPO_DIR = 'plugin/archief-mobiel';
const newerThan = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
const NOTE_DIR = 'Onderzoek', IDEA_DIR = 'Ideeën', ATTACH_DIR = 'Bijlagen', PROD_DIR = 'Producten', DUMP_DIR = 'Aanvullen';
// zoals de visualisator: de beeldbank (research en inspiratie, met beeldbank.json) en het logboek (één notitie per dag)
const BANK_DIR = 'Beeldbank', BANK_JSON = 'beeldbank.json', LOG_DIR = 'Logboek';
const mimeOf = ext => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4' })[String(ext).toLowerCase()] || '';
const MAX_SIDE = 2000, QUALITY = 0.85, KEEP_BELOW = 1.2 * 1024 * 1024;
const IMG_EXT = /\.(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/i, VID_EXT = /\.(mp4|mov|m4v|webm)$/i;
const PAGE = 40;
const cameraName = t => /^(img|dsc|dscn|pxl|vid|mov|plakbeeld|screenshot|schermafbeelding|whatsapp|photo|foto)[\s_-]*[\d-]/i.test(t) || /^whatsapp (image|video)/i.test(t) || /[_-]\d{3,}$/.test(t);
// zelfde groepen als in de visualisator; 'tags' = alles wat in geen andere groep staat
const TAG_GROUPS = [['tags', 'Tags'], ['materiaal', 'Materiaal'], ['type', 'Type'], ['locatie', 'Locatie'], ['techniek', 'Techniek'], ['software', 'Software']];
const ARCH_GROUPS = '.archief/taggroepen.json';
const PROD_GROUPS = ['materiaal', 'techniek']; // de groepen die je bij een product standaard ziet
const LONG_MS = 500;
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashRe = t => new RegExp(`(^|\\s)#(${escRe(t)})(?![\\p{L}\\p{N}_/-])`, 'giu');
const FM_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const TAG_KEYS = ['tags', 'tag', 'product_onbekend'];
const SYNC_CMD = 'remotely-save:start-sync';

/* ---------- kleine hulpjes ---------- */
const arr = v => v == null || v === '' ? [] : Array.isArray(v) ? v : [v];
const isoDay = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const safeName = s => s.replace(/\s*:\s*/g, ' - ').replace(/[\\/*?"<>|#^\[\]]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
const yamlVal = v => /^[^:#\[\]{},&*!|>'"%@`]+$/.test(v) && v.trim() === v && !/^[-?]/.test(v) ? v : JSON.stringify(v);
const linkTitle = v => String(v || '').replace(/^\s*\[\[|\]\]\s*$/g, '').split('|')[0].trim();
const cleanTag = t => String(t).replace(/^#/, '').trim().toLowerCase().replace(/\s+/g, '-');
const genericName = n => !n || /^(image|photo|foto|bestand|file)(\.\w+)?$/i.test(n) || /^[0-9a-f-]{30,}\.\w+$/i.test(n);
const isImg = f => /^image\//.test(f.type) || IMG_EXT.test(f.name);
const isVid = f => /^video\//.test(f.type) || VID_EXT.test(f.name);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

/* ---------- datum uit de foto (EXIF), zoals in de visualisator ---------- */
async function exifDate(file) {
  try {
    const buf = new DataView(await file.slice(0, 262144).arrayBuffer());
    if (buf.byteLength < 4 || buf.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o + 10 < buf.byteLength) {
      const marker = buf.getUint16(o), len = buf.getUint16(o + 2);
      if ((marker & 0xFF00) !== 0xFF00) break;
      if (marker === 0xFFE1 && buf.getUint32(o + 4) === 0x45786966) {
        const t = o + 10, le = buf.getUint16(t) === 0x4949;
        const u16 = q => buf.getUint16(q, le), u32 = q => buf.getUint32(q, le);
        const ifd = off => { const tags = {}, n = u16(t + off); for (let i = 0; i < n; i++) { const e = t + off + 2 + i * 12; tags[u16(e)] = e; } return tags; };
        const str = e => { const cnt = u32(e + 4), at = cnt > 4 ? t + u32(e + 8) : e + 8; let r = ''; for (let i = 0; i < cnt - 1 && at + i < buf.byteLength; i++) r += String.fromCharCode(buf.getUint8(at + i)); return r; };
        const i0 = ifd(u32(t + 4)); let d = null;
        if (i0[0x8769]) { const ex = ifd(u32(i0[0x8769] + 8)); if (ex[0x9003]) d = str(ex[0x9003]); }
        if (!d && i0[0x0132]) d = str(i0[0x0132]);
        const m = d && d.match(/^(\d{4}):(\d{2}):(\d{2})/);
        return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}` : null;
      }
      o += 2 + len;
    }
  } catch (e) {}
  return null;
}
function nameDate(name) {
  const m = String(name).match(/(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
// datum van een gekozen bestand: uit de foto, uit de naam, of de bestandsdatum als die niet van vandaag is
async function fileDate(f) {
  const ex = await exifDate(f); if (ex) return { datum: ex, bron: 'foto' };
  const nd = nameDate(f.name); if (nd) return { datum: nd, bron: 'naam' };
  if (f.lastModified && isoDay(f.lastModified) !== isoDay(Date.now())) return { datum: isoDay(f.lastModified), bron: 'bestand' };
  return { datum: '', bron: '' };
}

/* ---------- foto verkleinen ---------- */
function loadImage(file) {
  return new Promise((ok, fail) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => ok({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('kan beeld niet lezen')); };
    img.src = url;
  });
}
// geeft { data: ArrayBuffer, ext } terug; bij twijfel het origineel
async function shrink(file) {
  const ext0 = (file.name.match(/\.(\w+)$/) || [, (file.type.split('/')[1] || 'jpg')])[1].toLowerCase().replace('jpeg', 'jpg');
  const original = async () => ({ data: await file.arrayBuffer(), ext: ext0 });
  if (!isImg(file) || /gif|svg/.test(ext0)) return original();
  let got;
  try { got = await loadImage(file); } catch (e) { return original(); }
  const { img, url } = got;
  try {
    const w = img.naturalWidth, hgt = img.naturalHeight, s = Math.min(1, MAX_SIDE / Math.max(w, hgt));
    if (s === 1 && file.size <= KEEP_BELOW && /jpe?g|png|webp/.test(ext0)) return original();
    const c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(hgt * s);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', QUALITY));
    if (!blob || (blob.size >= file.size && /jpe?g/.test(ext0))) return original();
    return { data: await blob.arrayBuffer(), ext: 'jpg' };
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- schetsbord, in dezelfde vorm als de Ideeënfabriek van de visualisator ---------- */
const INKS = ['#141414', '#c8443a', '#4a78c0', '#5f9a5a', '#e08a3c', '#8a5cc0'], BORD_BG = '#f4f1ea';
const PEN_SIZES = [2, 4, 9, 18], TEXT_SIZES = { 2: 16, 4: 22, 9: 32, 18: 48 };
const BORD_PHONE_DIR = IDEA_DIR + '/borden'; // .archief synchroniseert niet; de visualisator haalt ze hier op
const oid = () => Math.random().toString(36).slice(2, 9);
const font = () => getComputedStyle(document.body).fontFamily;
function penPath(pts) {
  if (!pts.length) return '';
  const r = n => Math.round(n * 10) / 10;
  if (pts.length < 3) return `M${r(pts[0][0])},${r(pts[0][1])}L${r(pts[pts.length - 1][0]) + .01},${r(pts[pts.length - 1][1])}`;
  let d = `M${r(pts[0][0])},${r(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) d += `Q${r(pts[i][0])},${r(pts[i][1])} ${r((pts[i][0] + pts[i + 1][0]) / 2)},${r((pts[i][1] + pts[i + 1][1]) / 2)}`;
  const l = pts[pts.length - 1];
  return d + `L${r(l[0])},${r(l[1])}`;
}
const measureCtx = document.createElement('canvas').getContext('2d');
function textLines(o) {
  measureCtx.font = `${o.size}px ${font()}`;
  const out = [];
  for (const para of String(o.text).split('\n')) {
    let line = '';
    for (const w of para.split(/(\s+)/)) {
      if (measureCtx.measureText(line + w).width <= o.w || !line.trim()) {
        line += w;
        while (measureCtx.measureText(line).width > o.w && line.length > 1) { let k = line.length - 1; while (k > 1 && measureCtx.measureText(line.slice(0, k)).width > o.w) k--; out.push(line.slice(0, k)); line = line.slice(k); }
      } else { out.push(line.trimEnd()); line = w.trimStart(); }
    }
    out.push(line);
  }
  return out;
}
function objBox(o) {
  if (o.t === 'pen') { const xs = o.pts.map(p => p[0]), ys = o.pts.map(p => p[1]); return [Math.min(...xs) - o.w / 2, Math.min(...ys) - o.w / 2, Math.max(...xs) + o.w / 2, Math.max(...ys) + o.w / 2]; }
  if (o.t === 'text') return [o.x, o.y, o.x + o.w, o.y + textLines(o).length * o.size * 1.3];
  return [o.x, o.y, o.x + o.w, o.y + o.h];
}
const imgCache = new Map();
const imgEl = src => { if (!imgCache.has(src)) imgCache.set(src, new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; })); return imgCache.get(src); };
// overvloeimodi zoals in Photoshop; canvas en css kennen dezelfde namen
const BLENDS = [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'],
  ['color-dodge', 'Color Dodge'], ['color-burn', 'Color Burn'], ['hard-light', 'Hard Light'], ['soft-light', 'Soft Light'], ['difference', 'Difference'],
  ['exclusion', 'Exclusion'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity']];
/* ---------- fotobewerking (zoals Photoshop Mix) ----------
   Een foto op het bord houdt zijn origineel (orig) en de bewerking (edit: masker, aanpassingen, look, draaiing, spiegeling).
   src is altijd het resultaat; daardoor ziet de visualisator gewoon de bewerkte foto. */
const ADJ = [['belichting', 'Belichting'], ['contrast', 'Contrast'], ['hooglichten', 'Hooglichten'], ['schaduwen', 'Schaduwen'], ['verzadiging', 'Verzadiging'], ['warmte', 'Warmte']];
const LOOKS = [['', 'Geen'], ['zw', 'Zwart-wit'], ['sepia', 'Sepia'], ['vervaagd', 'Vervaagd'], ['warm', 'Warm'], ['koel', 'Koel'], ['hard', 'Hard'], ['vintage', 'Vintage'], ['nacht', 'Nacht']];
const LOOK_ADJ = { vervaagd: { contrast: -35, schaduwen: 35, verzadiging: -30 }, warm: { warmte: 45, verzadiging: 10 }, koel: { warmte: -45 }, hard: { contrast: 50, verzadiging: 20 },
  vintage: { warmte: 30, contrast: -20, verzadiging: -35, schaduwen: 25 }, nacht: { belichting: -30, warmte: -50, verzadiging: -20, contrast: 20 } };
const cloneObj = o => { const c = { ...o, pts: o.pts && o.pts.map(p => p.slice()) }; if (o.edit) c.edit = JSON.parse(JSON.stringify(o.edit)); delete c._prev; delete c._prevS; delete c._drot; return c; };
const cleanObjs = objs => objs.map(o => { const c = cloneObj(o); if (!c.pts) delete c.pts; return c; });
const hasAdj = e => !!(e && (e.look || Object.values(e.adj || {}).some(v => v)));
function adjustPixels(d, adj, look) {
  const A = { ...adj }; for (const [k, v] of Object.entries(LOOK_ADJ[look] || {})) A[k] = (A[k] || 0) + v;
  const ex = Math.pow(2, (A.belichting || 0) / 60), c = 1 + (A.contrast || 0) / 100, sat = 1 + (A.verzadiging || 0) / 100;
  const w = (A.warmte || 0) * .3, hl = (A.hooglichten || 0) / 100, sh = (A.schaduwen || 0) / 100, zw = look === 'zw', sep = look === 'sepia';
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] * ex, g = d[i + 1] * ex, b = d[i + 2] * ex;
    const L = Math.min(1, (.299 * r + .587 * g + .114 * b) / 255), dl = sh * (1 - L) * (1 - L) * 90 + hl * L * L * 90;
    r = (r + dl - 128) * c + 128; g = (g + dl - 128) * c + 128; b = (b + dl - 128) * c + 128;
    const m = .299 * r + .587 * g + .114 * b;
    r = m + (r - m) * sat + w; g = m + (g - m) * sat; b = m + (b - m) * sat - w;
    if (zw) { const y = .299 * r + .587 * g + .114 * b; r = g = b = y; }
    else if (sep) { const R = r, G = g, B = b; r = .393 * R + .769 * G + .189 * B; g = .349 * R + .686 * G + .168 * B; b = .272 * R + .534 * G + .131 * B; }
    d[i] = r < 0 ? 0 : r > 255 ? 255 : r; d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}
// begin met bewerken: het origineel apart zetten
const ensureEdit = o => { if (!o.orig) o.orig = o.src; if (!o.edit) o.edit = {}; return o.edit; };
// de foto opnieuw opbouwen uit origineel + bewerking. preview: kleiner en zonder opslaan als bestand (snel, tijdens schuiven)
async function bakeImg(o, preview) {
  const e = o.edit; if (!e || !o.orig) return;
  const im = await imgEl(o.orig), W0 = im.naturalWidth, H0 = im.naturalHeight, s = preview ? Math.min(1, 700 / Math.max(W0, H0)) : 1;
  const W = Math.max(1, Math.round(W0 * s)), H = Math.max(1, Math.round(H0 * s));
  const c1 = document.createElement('canvas'); c1.width = W; c1.height = H; const g = c1.getContext('2d');
  g.drawImage(im, 0, 0, W, H);
  if (hasAdj(e)) { const id = g.getImageData(0, 0, W, H); adjustPixels(id.data, e.adj || {}, e.look); g.putImageData(id, 0, 0); }
  if (e.mask) { g.globalCompositeOperation = 'destination-in'; g.drawImage(await imgEl(e.mask), 0, 0, W, H); g.globalCompositeOperation = 'source-over'; }
  const rad = (e.rot || 0) * Math.PI / 180, co = Math.abs(Math.cos(rad)), si = Math.abs(Math.sin(rad));
  const W2 = Math.max(1, Math.round(W * co + H * si)), H2 = Math.max(1, Math.round(W * si + H * co));
  const c2 = document.createElement('canvas'); c2.width = W2; c2.height = H2; const g2 = c2.getContext('2d');
  g2.translate(W2 / 2, H2 / 2); g2.rotate(rad); g2.scale(e.fx ? -1 : 1, e.fy ? -1 : 1); g2.drawImage(c1, -W / 2, -H / 2);
  // maat en midden op het bord blijven gelijk (per pixel van het origineel)
  const curW = o._prev ? o._prev.width / o._prevS : (await imgEl(o.src)).naturalWidth, k = o.w / curW, cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  o.w = Math.round(W2 / s * k); o.h = Math.round(H2 / s * k); o.x = Math.round(cx - o.w / 2); o.y = Math.round(cy - o.h / 2);
  if (preview) { o._prev = c2; o._prevS = s; return; }
  delete o._prev; delete o._prevS;
  const png = !!e.mask || (e.rot || 0) % 90 !== 0 || /^data:image\/png/.test(o.orig);
  o.src = png ? c2.toDataURL('image/png') : c2.toDataURL('image/jpeg', .88);
}
// een paar foto's samen tot één foto (met hun doorzichtigheid en blend)
async function mergeImgs(list) {
  const x0 = Math.min(...list.map(o => o.x)), y0 = Math.min(...list.map(o => o.y)), x1 = Math.max(...list.map(o => o.x + o.w)), y1 = Math.max(...list.map(o => o.y + o.h));
  let res = 1; for (const o of list) { try { res = Math.max(res, (await imgEl(o.src)).naturalWidth / o.w); } catch (e) {} }
  res = Math.min(res, 2400 / Math.max(x1 - x0, y1 - y0));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round((x1 - x0) * res)); c.height = Math.max(1, Math.round((y1 - y0) * res));
  const g = c.getContext('2d'); g.scale(res, res); g.translate(-x0, -y0);
  await paintBoard(g, list);
  return { id: oid(), t: 'img', x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), src: c.toDataURL('image/png') };
}
const GRID_SIZES = [10, 20, 40, 80];
// hoeveel moet er bij om de linker- of de rechterrand (welke het dichtst bij is) op het raster te zetten
function snapD(a, b, n) { const da = Math.round(a / n) * n - a, db = Math.round(b / n) * n - b; return Math.round(Math.abs(da) <= Math.abs(db) ? da : db); }
// 'slim samenvoegen' dat expres misgaat. Nagemaakt naar Milo's voorbeeld uit Photoshop Mix:
// modderige, vlakke kleur (olijf/khaki), reliëf en dubbele lichte randen waar de foto's net niet op elkaar liggen,
// het fijne krasjes-detail blijft, regelmatige strepen door het beeld, donkere rand met een dun blauw lijntje.
// Alles met toeval: elke keer een andere variant.
async function glitchMerge(list) {
  const rnd = (a, b) => a + Math.random() * (b - a), ri = (a, b) => Math.round(rnd(a, b)), pick = a => a[Math.floor(Math.random() * a.length)];
  const x0 = Math.min(...list.map(o => o.x)), y0 = Math.min(...list.map(o => o.y)), x1 = Math.max(...list.map(o => o.x + o.w)), y1 = Math.max(...list.map(o => o.y + o.h));
  let res = 1; for (const o of list) { try { res = Math.max(res, (await imgEl(o.src)).naturalWidth / o.w); } catch (e) {} }
  res = Math.min(res, 1000 / Math.max(x1 - x0, y1 - y0));
  const W = Math.max(8, Math.round((x1 - x0) * res)), H = Math.max(8, Math.round((y1 - y0) * res)), N = W * H;
  const L = [];
  for (const o of list) {
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    try { g.drawImage(o._prev || await imgEl(o.src), (o.x - x0) * res, (o.y - y0) * res, o.w * res, o.h * res); } catch (e) { continue; }
    L.push(g.getImageData(0, 0, W, H).data);
  }
  if (!L.length) throw new Error('geen foto\'s');
  // gemiddelde kleur van wat er ligt, en waar er iets ligt
  const avg = [0, 1, 2].map(() => new Float32Array(N)), A = new Uint8ClampedArray(N);
  for (let p = 0; p < N; p++) {
    let n = 0, r = 0, g = 0, b = 0;
    for (const d of L) { const i = p * 4; if (d[i + 3] < 100) continue; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; if (d[i + 3] > A[p]) A[p] = d[i + 3]; }
    if (n) { avg[0][p] = r / n; avg[1][p] = g / n; avg[2][p] = b / n; }
  }
  const lum = (d, p) => d[p * 4] * .3 + d[p * 4 + 1] * .59 + d[p * 4 + 2] * .11;
  // verschil tussen de bovenste en de onderste foto, met nog een kleine extra verschuiving: dat wordt het reliëf
  const top = L[L.length - 1], bot = L[0], jx = pick([-1, 1]) * ri(1, 4), jy = ri(-3, 3), diff = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, xx = Math.min(W - 1, Math.max(0, x + jx)), yy = Math.min(H - 1, Math.max(0, y + jy)), q = yy * W + xx;
    if (top[p * 4 + 3] > 100 && bot[q * 4 + 3] > 100) diff[p] = lum(top, p) - lum(bot, q);
  }
  // kastvervaging (snel, twee keer schuivend gemiddelde)
  const blur = (src, r) => {
    const t = new Float32Array(N), o = new Float32Array(N), k = 2 * r + 1;
    for (let y = 0; y < H; y++) { let s = 0; const row = y * W; for (let x = -r; x <= r; x++) s += src[row + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) { t[row + x] = s / k; s += src[row + Math.min(W - 1, x + r + 1)] - src[row + Math.max(0, x - r)]; } }
    for (let x = 0; x < W; x++) { let s = 0; for (let y = -r; y <= r; y++) s += t[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) { o[y * W + x] = s / k; s += t[Math.min(H - 1, y + r + 1) * W + x] - t[Math.max(0, y - r) * W + x]; } }
    return o;
  };
  const Rb = Math.max(4, Math.round(Math.max(W, H) / rnd(5, 12)));
  const big = avg.map(c => blur(blur(c, Rb), Rb)), small = avg.map(c => blur(c, 1)), glow = blur(diff.map(Math.abs), 1);
  // modderkleur: weinig verzadiging, een toevallige zweem (olijf, khaki, groenblauw, paarsbruin), weinig contrast
  const tint = pick([[1, 1.05, .62], [1.08, 1, .7], [.82, 1.02, .9], [1, .86, .92], [.95, 1, .75]]).map(t => t * rnd(.92, 1.08));
  const sat = rnd(.15, .45), dark = rnd(.55, .8), lift = rnd(15, 40);
  const gD = rnd(1.6, 3.2), gE = rnd(.5, 1.3) * pick([1, -1]), gG = rnd(.35, .9);
  const sh = [ri(-3, -1), 0, ri(1, 3)]; // kleuren van de lichte randen uit elkaar
  // strepen: regelmatig in de breedte, zwakker in de hoogte, plus wat toeval per kolom
  const P = rnd(6, 14), ph = rnd(0, 6.3), amp = rnd(2, 7), Py = rnd(18, 60), ampY = rnd(0, 3);
  const colN = new Float32Array(W).map(() => rnd(-3, 3)), rowN = new Float32Array(H).map(() => rnd(-1.5, 1.5));
  const vig = rnd(.25, .5), edge = ri(1, 3);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'), out = g.createImageData(W, H), od = out.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, i = p * 4;
    const bl = big[0][p] * .3 + big[1][p] * .59 + big[2][p] * .11;
    const band = amp * Math.sin(x / P * 6.283 + ph) + colN[x] + ampY * Math.sin(y / Py * 6.283) + rowN[y];
    const ex = Math.min(x, W - 1 - x) / W, ey = Math.min(y, H - 1 - y) / H, v = 1 - vig * Math.max(0, 1 - Math.min(ex, ey) * 9);
    for (let k = 0; k < 3; k++) {
      const base = (bl + (big[k][p] - bl) * sat) * tint[k] * dark + lift * tint[k];
      const det = (avg[k][p] - small[k][p]) * gD;
      const q = y * W + Math.min(W - 1, Math.max(0, x + sh[k]));
      let val = (base + det + diff[p] * gE + glow[q] * gG * 1.6 + band) * v;
      if (x < edge || x >= W - edge) val = k === 2 ? val + 60 : val * .6; // dun blauw lijntje links en rechts
      od[i + k] = val;
    }
    od[i + 3] = A[p];
  }
  g.putImageData(out, 0, 0);
  return { id: oid(), t: 'img', x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), src: c.toDataURL('image/png') };
}
async function paintBoard(g, objs) {
  for (const o of objs) if (o.t === 'img' && !o.hide) {
    try {
      const im = o._prev || await imgEl(o.src);
      g.save(); g.globalAlpha = o.op == null ? 1 : o.op; if (o.blend && o.blend !== 'normal') g.globalCompositeOperation = o.blend;
      // tijdens draaien met twee vingers: even gedraaid tekenen
      if (o._drot) { g.translate(o.x + o.w / 2, o.y + o.h / 2); g.rotate(o._drot * Math.PI / 180); g.drawImage(im, -o.w / 2, -o.h / 2, o.w, o.h); }
      else g.drawImage(im, o.x, o.y, o.w, o.h);
      g.restore();
    } catch (e) {}
  }
  g.lineCap = g.lineJoin = 'round';
  for (const o of objs) if (o.t === 'pen') { g.strokeStyle = o.c; g.lineWidth = o.w; g.stroke(new Path2D(penPath(o.pts))); }
  const fam = font();
  for (const o of objs) if (o.t === 'text') { g.fillStyle = o.c; g.font = `${o.size}px ${fam}`; g.textBaseline = 'middle'; textLines(o).forEach((l, i) => g.fillText(l, o.x, o.y + (i + .5) * o.size * 1.3)); }
}
// het bord als afbeelding, net als boardCanvas in de visualisator
async function boardCanvas(objs, max, pad = 40) {
  const bs = objs.map(objBox), bb = bs.length ? [Math.min(...bs.map(q => q[0])), Math.min(...bs.map(q => q[1])), Math.max(...bs.map(q => q[2])), Math.max(...bs.map(q => q[3]))] : [0, 0, 320, 240];
  const W = bb[2] - bb[0] + pad * 2, H = bb[3] - bb[1] + pad * 2, s = Math.min(2, max / Math.max(W, H));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(W * s)); c.height = Math.max(1, Math.round(H * s));
  const g = c.getContext('2d'); g.fillStyle = BORD_BG; g.fillRect(0, 0, c.width, c.height);
  g.setTransform(s, 0, 0, s, (pad - bb[0]) * s, (pad - bb[1]) * s);
  await paintBoard(g, objs);
  c.geo = { x0: bb[0] - pad, y0: bb[1] - pad, W, H };
  return c;
}
// een plaatje kleiner maken voor op het bord
async function boardImgData(file) {
  const { img, url } = await loadImage(file);
  try {
    const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return { src: /png|gif|webp/.test(file.type) ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', .86), w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}

const plekOk = (p, datum, lijnen) => !!p && p.datum === datum && lijnen.some(l => l.toLowerCase() === p.lijn.toLowerCase());
const short = (t, n = 22) => t.length > n ? t.slice(0, n - 1) + '…' : t;
/* ---------- in- en uitklokken: precies zoals in de visualisator ---------- */
// de werktijden staan in de frontmatter van de dagnotitie (Logboek/JJJJ-MM-DD.md):
//   werktijden:
//     - "09:05-12:30"
//     - "13:10-"        <- zonder eindtijd: de klok loopt nog (ook als de app dicht is)
const LOG_FM = /^---\r?\n[\s\S]*?\r?\n---[^\n]*\n?/;
const hhmm = t => { const x = new Date(t); return String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0'); };
const wtMin = s => +s.slice(0, 2) * 60 + +s.slice(3, 5);
const fmtDur = m => { m = Math.max(0, Math.round(m)); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'u' + (m % 60 ? ' ' + String(m % 60).padStart(2, '0') + 'm' : ''); };
function parseWerk(raw) {
  const fm = (String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1]; if (!fm) return [];
  const lines = fm.split(/\r?\n/), i = lines.findIndex(l => /^werktijden\s*:/.test(l)); if (i < 0) return [];
  const vals = [lines[i].replace(/^werktijden\s*:/, '')];
  for (let j = i + 1; j < lines.length && /^[\s-]/.test(lines[j]); j++) vals.push(lines[j]);
  const out = [];
  for (const v of vals.join('\n').split(/[\n,]/)) {
    const m = v.match(/(\d{1,2}):(\d\d)\s*-\s*(?:(\d{1,2}):(\d\d))?/);
    if (m) out.push({ van: m[1].padStart(2, '0') + ':' + m[2], tot: m[3] ? m[3].padStart(2, '0') + ':' + m[4] : '' });
  }
  return out;
}
// de notitie met andere werktijden; de rest van de frontmatter en de tekst blijven zoals ze waren
function withWerk(raw, d, list) {
  const m = raw && raw.match(LOG_FM), keep = [];
  if (m) { let skip = false; for (const l of m[0].replace(/^---\r?\n/, '').replace(/\r?\n---[^\n]*\n?$/, '').split(/\r?\n/)) { if (/^werktijden\s*:/.test(l)) { skip = true; continue; } if (skip && l.trim() && /^[\s-]/.test(l)) continue; skip = false; keep.push(l); } }
  else keep.push('type: logboek', 'datum: ' + d);
  const block = list.length ? ['werktijden:', ...list.map(w => `  - "${w.van}-${w.tot}"`)] : [];
  return `---\n${[...keep, ...block].join('\n')}\n---\n` + (m ? raw.slice(m[0].length) : (raw || ''));
}
// de notitie met een andere tekst; de frontmatter (met de werktijden) blijft staan
const withText = (raw, d, t) => { const m = raw && raw.match(LOG_FM); return (m ? m[0].replace(/\n?$/, '\n') : `---\ntype: logboek\ndatum: ${d}\n---\n`) + (t ? t + '\n' : ''); };
// minuten gewerkt op dag d; een tijd zonder eindtijd telt tot nu, een eindtijd vóór de begintijd is na middernacht
// een klok die al langer dan 12 uur loopt is vergeten: die telt niet mee tot je de eindtijd hebt ingevuld
const KLOK_MAX = 12 * 60;
const openMin = (d, van) => Math.max(0, (Date.now() - new Date(d + 'T' + van)) / 6e4);
const klokVergeten = run => !!run && openMin(run.d, run.van) > KLOK_MAX;
const eindGok = van => wtMin(van) < 17 * 60 ? '17:00' : wtMin(van) < 23 * 60 ? String(+van.slice(0, 2) + 1).padStart(2, '0') + van.slice(2) : '23:59';
const werkMin = (d, list) => (list || []).reduce((n, w) => { const o = w.tot ? 0 : openMin(d, w.van); return n + (w.tot ? (wtMin(w.tot) - wtMin(w.van) + 1440) % 1440 : o > KLOK_MAX ? 0 : o); }, 0);
const sortWerk = l => l.filter(w => /^\d\d:\d\d$/.test(w.van)).sort((a, b) => a.van.localeCompare(b.van));
const addDay = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return isoDay(x); };
/* ---------- mini-stroom: zelfde regels als de Stroom van de visualisator, maar simpel getekend ---------- */
// per project een rij, alles op datum (en op dezelfde dag de volgorde); een project dat uit een item voortkomt
// (komt_uit op de projectpagina) staat onder het project van dat item, met een tak vanaf dat item.
// Wat aan een idee hangt (aan/kant) krijgt, net als in de visualisator, een eigen zijrij boven of onder zijn anker;
// rechts van iets blijft in dezelfde rij, op datum
const STROOM_PAL = ['#e8c48a', '#9fc4e8', '#e8a09a', '#a8d8a0', '#c9a8e8', '#e8dc8a', '#8ad8d0', '#e8a8cf', '#b8b0a0', '#a0b8e8'];
const MND = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const fmtD = d => d ? `${+d.slice(8, 10)} ${MND[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}` : '';
const stroomKey = it => (it.datum || '9999') + '\u0000' + String(it.volgorde ?? 99999).padStart(5, '0') + '\u0000' + it.title.toLowerCase();
const SCOL = 30, SROW = 58;
function miniStroom(items, pages) {
  const low = s => String(s).toLowerCase(), byT = new Map(items.map(i => [low(i.title), i]));
  const cmp = (a, b) => { const x = stroomKey(a), y = stroomKey(b); return x < y ? -1 : x > y ? 1 : 0; };
  for (const it of items) { const a = it.aan && byT.get(low(it.aan)); it.aanIt = a && a !== it && ['boven', 'onder', 'rechts'].includes(it.kant) && (it.idee || a.idee) ? a : null; }
  const same = (a, b) => a.lijnen.some(l => b.lijnen.some(m => low(l) === low(m)));
  const hangs = (it, k = 0) => !!it.aanIt && !(it.kant === 'rechts' && same(it, it.aanIt) && k < 50 && !hangs(it.aanIt, k + 1));
  const sorted = [...items].sort(cmp), rowsBy = new Map();
  for (const it of sorted) {
    if (hangs(it)) continue;
    for (const l of it.lijnen) { const k = low(l); if (!rowsBy.has(k)) rowsBy.set(k, { lijn: l, list: [], nodes: [], extra: [] }); rowsBy.get(k).list.push(it); }
  }
  const rows0 = [...rowsBy.values()];
  // kleur: van de projectpagina, anders zoals de visualisator (op volgorde van het eerste item)
  rows0.slice().sort((a, b) => cmp(a.list[0], b.list[0])).forEach((r, i) => { const pg = pages.get(low(r.lijn)); r.kleur = pg && /^#[0-9a-f]{3,8}$/i.test(pg.kleur) ? pg.kleur : STROOM_PAL[i % STROOM_PAL.length]; });
  for (const r of rows0) {
    const pg = pages.get(low(r.lijn)), src = pg && pg.komtUit && byT.get(low(pg.komtUit));
    r.src = src && src.lijnen.length && !hangs(src) && !src.lijnen.some(l => low(l) === low(r.lijn)) && rowsBy.has(low(src.lijnen[0])) ? src : null;
  }
  const first = (a, b) => cmp(a.list[0], b.list[0]), order = [], seen = new Set();
  const visit = r => { if (seen.has(r)) return; seen.add(r); order.push(r); rows0.filter(k => k.src && low(k.src.lijnen[0]) === low(r.lijn)).sort(first).forEach(visit); };
  rows0.filter(r => !r.src).sort(first).forEach(visit); rows0.sort(first).forEach(visit);
  // kolommen: elke datum zo breed als de drukste dag in één rij, zodat datums in alle rijen onder elkaar staan
  const wide = new Map();
  for (const it of sorted) if (!wide.has(it.datum)) wide.set(it.datum, 1);
  for (const r of order) { const c = new Map(); for (const it of r.list) c.set(it.datum, (c.get(it.datum) || 0) + 1); for (const [d, n] of c) wide.set(d, Math.max(wide.get(d), n)); }
  const dates = [...wide.keys()].sort(), x0 = new Map(); { let x = 0; for (const d of dates) { x0.set(d, x); x += wide.get(d); } }
  const at = new Map(); // item -> zijn plek (in de rij van zijn eerste project)
  for (const r of order) {
    const c = new Map();
    r.nodes = r.list.map(it => { const k = c.get(it.datum) || 0; c.set(it.datum, k + 1); const n = { it, x: (x0.get(it.datum) + k) * SCOL, row: r }; if (!at.has(it) || low(it.lijnen[0]) === low(r.lijn)) at.set(it, n); return n; });
  }
  // wat aan een idee hangt: boven/onder = eigen zijrij vlak bij de rij van het anker; rechts = dezelfde rij, op datum
  for (let pass = 0, todo = sorted.filter(it => hangs(it)); todo.length && pass < 8; pass++) {
    const rest = [];
    for (const it of todo) {
      const a = at.get(it.aanIt); if (!a) { rest.push(it); continue; }
      const ar = a.row, dx = x0.get(it.datum) * SCOL;
      let row, x;
      if (it.kant === 'rechts') { row = ar; x = Math.max(a.x + SCOL, dx); }
      else {
        row = { lijn: '', side: true, kleur: ar.kleur, from: a, kant: it.kant, list: [], nodes: [], extra: [] };
        const i = order.indexOf(ar); order.splice(it.kant === 'boven' ? i : i + 1, 0, row);
        // een idee boven of onder een item staat precies op de plek van dat item
        x = it.idee && !it.aanIt.idee ? a.x : Math.max(a.x, dx);
      }
      while (row.nodes.some(n => Math.abs(n.x - x) < 1) || row.extra.some(n => Math.abs(n.x - x) < 1)) x += SCOL;
      const node = { it, x, row, a }; row.extra.push(node); at.set(it, node);
    }
    todo = rest;
  }
  order.forEach((r, i) => { r.y = i * SROW; for (const n of [...r.nodes, ...r.extra]) n.y = r.y; r.extra.sort((p, q) => p.x - q.x); });
  const branches = order.filter(r => r.src && at.get(r.src) && r.nodes.length).map(r => ({ a: at.get(r.src), b: r.nodes[0], kleur: r.kleur }));
  const W = Math.max(SCOL, ...order.flatMap(r => [...r.nodes, ...r.extra].map(n => n.x))), H = Math.max(0, (order.length - 1) * SROW);
  return { rows: order, main: order.filter(r => !r.side && r.nodes.length), branches, dates, x0, W, H };
}

/* ---------- de stroom tekenen zoals de visualisator (kaartjes, banden, verbanden) ---------- */
// maten van de visualisator: kaartjes van 72, kolommen van 116, rijen van 176. miniStroom rekent in SCOL/SROW;
// FX en FY zetten dat om, zodat zoomen in beide richtingen even veel doet
const S_CARD = 72, S_CH = S_CARD / 2, S_COL = 116, S_ROW = 176, S_FX = S_COL / SCOL, S_FY = S_ROW / SROW;
const S_RANG = { groot: 104, middel: S_CARD, klein: 50 };
const S_BG = '#0a0a0a', S_INK = '#ece8e0', S_MUTED = '#8d8a84', S_LINE = 'rgba(255,255,255,.32)', S_SOFT = 'rgba(255,255,255,.14)', S_MONO = 'ui-monospace, Menlo, Consolas, monospace';
const VB_BASE = 'bouwt voort op';
const VB_STD = [
  { naam: VB_BASE, kleur: '#e8c48a', stijl: 'lijn' },
  { naam: 'inspireerde', kleur: '#e0915a', stijl: 'lijn' },
  { naam: 'zelfde materiaal', kleur: '#8fbf8a', stijl: 'stippel' },
  { naam: 'tegenstelling', kleur: '#d9645c', stijl: 'streep' },
  { naam: 'vraag', kleur: '#9a9a9a', stijl: 'streep' }
];
// verbanden uit de notitie: "[[titel]] | soort | woordje", en het oude volgt_op
function parseVb(v, legacy) {
  const out = [], name = t => t.split('|')[0].split('#')[0].split('/').pop().trim();
  for (const x of arr(v)) {
    const m = String(x).match(/^\s*\[\[([^\]]+)\]\]\s*(?:\|\s*([^|]*?)\s*)?(?:\|\s*(.*?)\s*)?$/);
    if (m && name(m[1])) out.push({ to: name(m[1]), soort: (m[2] || VB_BASE).toLowerCase(), label: m[3] || '' });
  }
  for (const t of arr(legacy)) { const n = name(linkTitle(t)); if (n && !out.some(o => o.soort === VB_BASE && o.to.toLowerCase() === n.toLowerCase())) out.push({ to: n, soort: VB_BASE, label: '' }); }
  return out;
}
/* ---------- verbanden routeren: overgenomen van de visualisator (rijen op y = i*ROW, kolommen op x = i*COL) ---------- */
const arrowAt = (ex, ey, ang, al = 9, aw = .42) => `M${ex},${ey}L${ex - al * Math.cos(ang - aw)},${ey - al * Math.sin(ang - aw)}L${ex - al * Math.cos(ang + aw)},${ey - al * Math.sin(ang + aw)}Z`;
const segHits = (ob, x1, y1, x2, y2) => ob.some(([a, b, c, d]) => Math.max(x1, x2) > a && Math.min(x1, x2) < c && Math.max(y1, y2) > b && Math.min(y1, y2) < d);
// lijnen die dezelfde gang of dezelfde kant van een item delen, schuiven een stukje uit elkaar.
// In een gang (lo..hi = het stuk dat de lijn erin aflegt) krijgt elke lijn de eerste baan waar niets anders
// overheen loopt; lijnen die elkaar niet raken mogen een baan delen. Zo lopen ze nooit over elkaar, welk soort ook
function laneCounter() {
  const n = new Map(), used = new Map(), step = k => k % 2 ? (k + 1) / 2 : -k / 2;
  // fat = een lijn met een tekstlabel: die houdt ook de baan erboven en eronder vrij, zodat het label op niets ligt
  const fn = (key, w, lo, hi, fat) => {
    if (lo == null) { const k = n.get(key) || 0; n.set(key, k + 1); return step(k % 7) * w; }
    if (lo > hi) [lo, hi] = [hi, lo];
    const lanes = used.get(key) || []; used.set(key, lanes);
    // niet verder dan de ruimte tussen de rijen (of kolommen) toelaat
    const max = Math.floor(40 / w), r = fat ? 1.5 : 0;
    for (let k = 0; k <= 2 * max; k++) {
      const o = step(k); if (Math.abs(o) + (fat ? 1 : 0) > max) continue;
      if (!lanes.some(e => Math.abs(e.o - o) <= e.r + r && lo < e.hi + 14 && hi > e.lo - 14)) { lanes.push({ o, r, lo, hi }); return o * w; }
    }
    return 0;
  };
  // welke plekken op een kant van een item al door lijnen bezet zijn (voor de verbanden die daarna komen)
  fn.taken = (key, w) => { const k = n.get(key) || 0; return [...Array(k)].map((_, i) => step(i % 7) * w); };
  // een kopie van wat er nu in de gangen ligt (om later te zien wat al van andere lijnen was)
  fn.snap = () => new Map([...used].map(([k, v]) => [k, v.map(e => ({ ...e }))]));
  return fn;
}

// a en b: {x, y, k, ht, hb} (midden, sleutel, afstand tot de boven- en onderkant). Geeft hoekpunten.
// port(p, kant, eind): een vaste plek op de rand van het item (zie vbLayer); anders schuift de teller ze uit elkaar
function route(a, b, ob, lane, fat, port) {
  const half = S_ROW / 2;
  const at = (p, s, end) => port ? port(p, s, end) : lane('p' + p.k + s, 10);
  if (Math.abs(b.y - a.y) < 1) {
    // dezelfde rij: erboven langs, of eronder als daar iets in de weg zit
    const up = a.y - half, s = segHits(ob, a.x, up, b.x, up) && !segHits(ob, a.x, a.y + half, b.x, a.y + half) ? 1 : -1, c = a.y + s * half;
    const ax = a.x + at(a, s, 'a'), bx = b.x + at(b, s, 'b'), cy = c + lane('h' + Math.round(c), 7, ax, bx, fat);
    return [[ax, a.y + (s > 0 ? a.hb : -a.ht)], [ax, cy], [bx, cy], [bx, b.y + (s > 0 ? b.hb : -b.ht)]];
  }
  const s = Math.sign(b.y - a.y), c1 = a.y + s * half, c2 = b.y - s * half;
  const ax = a.x + at(a, s, 'a'), bx = b.x + at(b, -s, 'b');
  const start = [ax, a.y + (s > 0 ? a.hb : -a.ht)], end = [bx, b.y + (s > 0 ? -b.ht : b.hb)];
  if (Math.abs(c1 - c2) < 1) { const y1 = c1 + lane('h' + Math.round(c1), 7, ax, bx, fat); return [start, [ax, y1], [bx, y1], end]; }
  // verder weg: via een vrije gang tussen twee kolommen, zo dicht mogelijk bij de kortste weg
  const gaps = [], lo = Math.min(a.x, b.x) - 4 * S_COL, hi = Math.max(a.x, b.x) + 4 * S_COL;
  for (let g = 0 - S_COL / 2 + Math.ceil((lo - 0 + S_COL / 2) / S_COL) * S_COL; g <= hi; g += S_COL) gaps.push(g);
  gaps.sort((g, h) => Math.abs(g - a.x) + Math.abs(g - b.x) - Math.abs(h - a.x) - Math.abs(h - b.x));
  const g0 = gaps.find(g => !segHits(ob, g, Math.min(c1, c2), g, Math.max(c1, c2))) ?? gaps[0];
  const gx = g0 + lane('v' + g0, 6, c1, c2), y1 = c1 + lane('h' + Math.round(c1), 7, ax, gx, fat), y2 = c2 + lane('h' + Math.round(c2), 7, gx, bx, fat);
  return [start, [ax, y1], [gx, y1], [gx, y2], [bx, y2], end];
}
// hoekpunten naar een pad met afgeronde hoeken
function roundPath(pts, r = 14) {
  let p = pts.filter((q, i) => !i || Math.abs(q[0] - pts[i - 1][0]) + Math.abs(q[1] - pts[i - 1][1]) > .5);
  p = p.filter((c, i) => !i || i === p.length - 1 || !((Math.abs(p[i - 1][0] - c[0]) < .5 && Math.abs(c[0] - p[i + 1][0]) < .5) || (Math.abs(p[i - 1][1] - c[1]) < .5 && Math.abs(c[1] - p[i + 1][1]) < .5)));
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [px, py] = p[i - 1], [x, y] = p[i], [nx, ny] = p[i + 1];
    const l1 = Math.hypot(x - px, y - py), l2 = Math.hypot(nx - x, ny - y), k = Math.min(r, l1 / 2, l2 / 2);
    d += `L${x - (x - px) / l1 * k},${y - (y - py) / l1 * k}Q${x},${y} ${x + (nx - x) / l2 * k},${y + (ny - y) / l2 * k}`;
  }
  const [lx, ly] = p[p.length - 1];
  return d + `L${lx},${ly}`;
}

function vbFromPts(pts, a, b) {
  const [ex, ey] = pts[pts.length - 1], [px, py] = pts[pts.length - 2];
  // het label komt midden op het langste liggende stuk
  let mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, best = -1;
  for (let i = 1; i < pts.length; i++) { const [x1, y1] = pts[i - 1], [x2, y2] = pts[i]; if (Math.abs(y1 - y2) < .5 && Math.abs(x2 - x1) > best) { best = Math.abs(x2 - x1); mx = (x1 + x2) / 2; my = y1; } }
  return { d: roundPath(pts), arrow: arrowAt(ex, ey, Math.atan2(ey - py, ex - px)), mx, my, pts };
}
// hoe vaak lopen deze lijnen (lijsten hoekpunten) door elkaar heen
function crossings(lines) {
  const o = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const hit = (p, q, r, s) => o(p, q, r) * o(p, q, s) < 0 && o(r, s, p) * o(r, s, q) < 0;
  let n = 0;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i], B = lines[j];
    for (let k = 1; k < A.length; k++) for (let m = 1; m < B.length; m++) if (hit(A[k - 1], A[k], B[m - 1], B[m])) n++;
  }
  return n;
}
// banen in een gang op volgorde: elk liggend stuk heeft aan beide kanten een staand stuk dat omhoog (naar de rij
// erboven) of omlaag gaat. Een lijn die bij een ander omhoog gaat, hoort daarboven; een lijn die omlaag gaat eronder.
// Zo ligt een lijn die over een andere heen spant aan de buitenkant en kruisen ze elkaar niet twee keer.
// Alleen toegepast als er daardoor echt minder kruisingen zijn
function orderLanes(list, before) {
  const half = S_ROW / 2, segs = [];
  for (const r of list) {
    const p = r.g.pts; if (!r.routed || !p || p.length < 4) continue;
    for (let k = 1; k + 1 < p.length - 1; k++) if (Math.abs(p[k][1] - p[k + 1][1]) < .5) {
      const y = p[k][1], c = Math.round((y - half) / S_ROW) * S_ROW + half;
      if (Math.abs(y - c) > 45) continue;
      const ends = [[p[k][0], Math.sign(p[k - 1][1] - y)], [p[k + 1][0], Math.sign(p[k + 2][1] - y)]];
      segs.push({ r, k, y, c, ends, x1: Math.min(p[k][0], p[k + 1][0]), x2: Math.max(p[k][0], p[k + 1][0]) });
    }
  }
  const over = (a, b) => a.x1 < b.x2 + 14 && b.x1 < a.x2 + 14;
  const inside = (x, s) => x > s.x1 + 1 && x < s.x2 - 1;
  // hoe vaak kruisen ze als a boven b ligt: b gaat omhoog door a heen, of a gaat omlaag door b heen
  const cost = (a, b) => b.ends.filter(([x, d]) => d < 0 && inside(x, a)).length + a.ends.filter(([x, d]) => d > 0 && inside(x, b)).length;
  const byC = new Map(); for (const sg of segs) { if (!byC.has(sg.c)) byC.set(sg.c, []); byC.get(sg.c).push(sg); }
  for (const [c, ss] of byC) {
    ss.sort((a, b) => a.x1 - b.x1);
    const comps = []; let cur = null, end = -Infinity;
    for (const sg of ss) { if (cur && sg.x1 < end + 14) { cur.push(sg); end = Math.max(end, sg.x2); } else { cur = [sg]; comps.push(cur); end = sg.x2; } }
    const others = before.get('h' + c) || [];
    for (const comp of comps) {
      if (comp.length < 2) continue;
      // beginvolgorde: wie omhoog gaat bovenaan, wie omlaag gaat onderaan; bij gelijk: wie verder links begint
      // en dus om de anderen heen spant, aan de buitenkant
      const tilt = sg => sg.ends.reduce((n, [, d]) => n + d, 0);
      const order = comp.slice().sort((a, b) => tilt(a) - tilt(b) || (tilt(a) > 0 ? a.x1 - b.x1 : tilt(a) < 0 ? b.x1 - a.x1 : 0) || a.x1 - b.x1);
      // dan buren omwisselen zolang dat kruisingen scheelt
      for (let pass = 0, better = true; better && pass < 40; pass++) {
        better = false;
        for (let i = 0; i + 1 < order.length; i++) {
          const a = order[i], b = order[i + 1]; if (!over(a, b)) continue;
          if (cost(b, a) < cost(a, b)) { order[i] = b; order[i + 1] = a; better = true; }
        }
      }
      // laag per stuk: net onder alles wat erboven hoort en ermee overlapt
      const lvl = new Map();
      for (const sg of order) { let l = 0; for (const [q, lq] of lvl) if (over(q, sg)) l = Math.max(l, lq + 1); lvl.set(sg, l); }
      const m = Math.max(...lvl.values()) + 1, mid = Math.floor((m - 1) / 2), maxO = Math.floor(40 / 7);
      if (mid > maxO || m - 1 - mid > maxO) continue;
      const ny = sg => c + (lvl.get(sg) - mid) * 7;
      // niet op een baan waar al een tak van de lijn loopt
      if (comp.some(sg => others.some(e => Math.abs(e.o * 7 - (ny(sg) - c)) < 3.5 + e.r * 7 && sg.x1 < e.hi + 14 && sg.x2 > e.lo - 14))) continue;
      const lo = Math.min(...comp.map(sg => sg.x1)), hi = Math.max(...comp.map(sg => sg.x2));
      const rs = list.filter(r => r.g.pts && r.g.pts.some(([x, y]) => x > lo - S_COL && x < hi + S_COL && Math.abs(y - c) < S_ROW));
      const set = f => comp.forEach(sg => { const y = f(sg); sg.r.g.pts[sg.k][1] = y; sg.r.g.pts[sg.k + 1][1] = y; });
      const n0 = crossings(rs.map(r => r.g.pts));
      set(ny);
      if (crossings(rs.map(r => r.g.pts)) < n0) comp.forEach(sg => { sg.y = ny(sg); });
      else set(sg => sg.y);
    }
  }
}
// in elke gang tussen twee rijen: de liggende stukken van verbanden die elkaar overlappen in de volgorde zetten
// (van boven naar onder) waarbij ze elkaar het minst kruisen. Ze houden dezelfde banen, alleen wie welke krijgt verandert
function untangleVbs(list, before) {
  const half = S_ROW / 2, segs = [];
  for (const r of list) {
    const p = r.g.pts; if (!r.routed || !p || p.length < 4) continue;
    for (let k = 1; k + 1 < p.length - 1; k++) if (Math.abs(p[k][1] - p[k + 1][1]) < .5) {
      const y = p[k][1], c = Math.round((y - half) / S_ROW) * S_ROW + half;
      if (Math.abs(y - c) > 45) continue;
      segs.push({ r, k, y, c, x1: Math.min(p[k][0], p[k + 1][0]), x2: Math.max(p[k][0], p[k + 1][0]) });
    }
  }
  const byC = new Map(); for (const s of segs) { if (!byC.has(s.c)) byC.set(s.c, []); byC.get(s.c).push(s); }
  for (const [c, ss] of byC) {
    // groepjes stukken die elkaar (via elkaar) overlappen
    ss.sort((a, b) => a.x1 - b.x1);
    const comps = []; let cur = null, end = -Infinity;
    for (const s of ss) { if (cur && s.x1 < end + 14) { cur.push(s); end = Math.max(end, s.x2); } else { cur = [s]; comps.push(cur); end = s.x2; } }
    const others = (before.get('h' + c) || []);
    for (const comp of comps) {
      if (comp.length < 2 || comp.length > 6 || new Set(comp.map(s => s.y)).size !== comp.length) continue;
      const ys = comp.map(s => s.y).sort((a, b) => a - b), lo = Math.min(...comp.map(s => s.x1)), hi = Math.max(...comp.map(s => s.x2));
      // meetellen: deze verbanden, en de andere die door hetzelfde stuk van de gang lopen
      const rs = list.filter(r => r.g.pts && r.g.pts.some(([x, y]) => x > lo - S_COL && x < hi + S_COL && Math.abs(y - c) < S_ROW));
      // botst een baan met een lijnstuk dat er al lag (een tak van de lijn)?
      const clash = (s, y) => others.some(e => Math.abs(e.o * 7 - (y - c)) < 3.5 + e.r * 7 && s.x1 < e.hi + 14 && s.x2 > e.lo - 14);
      const apply = perm => comp.forEach((s, i) => { const y = ys[perm[i]]; s.r.g.pts[s.k][1] = y; s.r.g.pts[s.k + 1][1] = y; });
      const perms = []; const gen = (p, rest) => { if (!rest.length) return perms.push(p); rest.forEach((x, i) => gen([...p, x], rest.filter((_, j) => j !== i))); };
      gen([], comp.map((_, i) => i));
      let best = null, bestN = Infinity;
      const start = comp.map(s => ys.indexOf(s.y));
      for (const perm of [start, ...perms]) {
        if (perm !== start && comp.some((s, i) => clash(s, ys[perm[i]]))) continue;
        apply(perm); const n = crossings(rs.map(r => r.g.pts));
        if (n < bestN) { bestN = n; best = perm; }
      }
      apply(best);
    }
  }
  for (const r of list) if (r.routed) r.g = vbFromPts(r.g.pts, r.a, r.b);
}
// het labeltje bij een verband: op een liggend stuk van die lijn, op een plek waar het geen andere lijn bedekt.
// Eerst zo dicht mogelijk bij het midden van het langste stuk, dan steeds verder opzij, dan op een ander stuk
function placeVbLabels(list) {
  const segs = [];
  list.forEach((r, i) => { const p = r.g.pts; for (let k = 1; k < p.length; k++) segs.push({ i, x1: Math.min(p[k - 1][0], p[k][0]), x2: Math.max(p[k - 1][0], p[k][0]), y1: Math.min(p[k - 1][1], p[k][1]), y2: Math.max(p[k - 1][1], p[k][1]) }); });
  const placed = [];
  const free = (i, x1, y1, x2, y2) => !segs.some(s => s.i !== i && s.x2 > x1 && s.x1 < x2 && s.y2 > y1 && s.y1 < y2) && !placed.some(b => b[2] > x1 && b[0] < x2 && b[3] > y1 && b[1] < y2);
  list.forEach((r, i) => {
    if (!r.v.label) return;
    const w = Math.min(r.v.label.length, 30) * 6 + 12, hs = segs.filter(s => s.i === i && s.y2 - s.y1 < .5 && s.x2 - s.x1 > w + 8).sort((a, b) => (b.x2 - b.x1) - (a.x2 - a.x1));
    for (const s of hs) {
      const mid = (s.x1 + s.x2) / 2, room = (s.x2 - s.x1 - w) / 2 - 4;
      for (let d = 0; d <= room; d += 8) for (const x of d ? [mid - d, mid + d] : [mid]) {
        if (free(i, x - w / 2 - 3, s.y1 - 11, x + w / 2 + 3, s.y1 + 11)) { r.g.mx = x; r.g.my = s.y1; placed.push([x - w / 2 - 3, s.y1 - 11, x + w / 2 + 3, s.y1 + 11]); return; }
      }
    }
  });
}

// de stroom hoeft niet scherper dan 2x: op een iPhone (3x) scheelt dat ruim de helft van het tekenwerk
// kleine plaatjes voor de stroom: onthouden zolang Obsidian open is (THUMBS) en bewaard op de telefoon (IndexedDB),
// zodat ze niet bij elke keer openen opnieuw van de grote foto's gemaakt worden. De sleutel verandert als de foto verandert.
const THUMB_Q = 160, THUMBS = new Map();
const thumbKey = f => f.path + '|' + ((f.stat && f.stat.mtime) || 0) + '|' + ((f.stat && f.stat.size) || 0);
let thumbDbP = null;
const thumbDb = () => thumbDbP || (thumbDbP = new Promise(res => { try { const r = indexedDB.open('archief-mobiel-plaatjes', 1); r.onupgradeneeded = () => r.result.createObjectStore('t'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null); } catch (e) { res(null); } }));
const thumbGet = k => thumbDb().then(db => db ? new Promise(res => { try { const r = db.transaction('t').objectStore('t').get(k); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); } catch (e) { res(null); } }) : null);
const thumbPut = (k, b) => thumbDb().then(db => { if (db) try { db.transaction('t', 'readwrite').objectStore('t').put(b, k); } catch (e) {} });
const SDPR = () => Math.min(2, window.devicePixelRatio || 1);
// het beeld van a naar b laten glijden (afremmend); een nieuwe beweging of aanraking stopt de vorige
function animV(get, set, to, ms = 380) {
  const from = { ...get() }, t0 = performance.now(), id = (animV.id = (animV.id || 0) + 1);
  const ease = t => 1 - Math.pow(1 - t, 3);
  // zoomen gaat op een log-schaal, dan voelt het gelijkmatig
  const step = now => {
    if (animV.id !== id) return;
    const t = Math.min(1, (now - t0) / ms), e = ease(t), k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
    // het punt in het midden van de beweging blijft netjes op zijn baan: x/y lopen mee met de zoom
    const f = (from.k === to.k) ? e : (k - from.k) / (to.k - from.k);
    set({ k, x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f });
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
animV.stop = () => { animV.id = (animV.id || 0) + 1; };
function stroomPainter(app, M, imgOf, onPic, opt = {}) {
  const low = s => String(s).toLowerCase();
  const all = M.rows.flatMap(r => [...r.nodes, ...r.extra]);
  all.forEach((n, i) => { n.id = i; n.X = n.x * S_FX; n.Y = n.y * S_FY; n.S = n.it.idee ? (S_RANG[n.it.rang] || S_CARD) : S_CARD; n.img = imgOf(n.it); });
  const rowsD = M.rows.map(r => ({ r, ns: [...r.nodes, ...r.extra].sort((p, q) => p.X - q.X) })).filter(o => o.ns.length);
  // een idee loopt door tot het laatste wat (via 'aan', ook verder doorgehangen) aan hem hangt: zover schuift zijn titel mee
  for (const n of all) n.tail = n.X;
  for (const m of all) for (let a = m.a, k = 0; a && k < 50; a = a.a, k++) if (a.it.idee && m.X > a.tail) a.tail = m.X;
  const WX = Math.max(...all.map(n => n.X)), HY = Math.max(...all.map(n => n.Y));
  // verbanden: van een item naar het item waar het naar wijst (pijl aan die kant); elk item telt één keer, op zijn eigen plek
  const first = new Map(); for (const n of all) { const k = low(n.it.title); if (!first.has(k) || low(n.it.lijnen[0] || '') === low(n.row.lijn)) first.set(k, n); }
  const vbs = [], done = new Set();
  if (opt.vb !== false) for (const n of all) {
    if (done.has(n.it)) continue; done.add(n.it);
    const a = first.get(low(n.it.title));
    (n.it.verbanden || []).forEach((v, i) => { const b = first.get(low(v.to)); if (a && b && a !== b && !vbs.some(x => x.a === a && x.b === b && x.v.soort === v.soort)) vbs.push({ a, b, v, i }); });
  }
  let soorten = VB_STD;
  const soort = n => soorten.find(s => s.naam === n) || { kleur: '#9a9a9a', stijl: 'lijn' };
  const DASH = { lijn: [], stippel: [1, 5], streep: [7, 5] };
  // de routes zoals de visualisator ze legt: door de gangen tussen de rijen en kolommen, nooit dwars over een item
  let geo = null;
  const route_ = () => {
    const ob = [];
    for (const n of all) { const h = n.S / 2; ob.push([n.X - h - 3, n.Y - h - 3, n.X + h + 3, n.Y + h + 24]); }
    const lane = laneCounter(), box = n => ({ x: n.X, y: n.Y, k: n.id, ht: n.S / 2 + 4, hb: n.S / 2 + 4 });
    const xsAt = new Map(); for (const n of all) { if (!xsAt.has(n.Y)) xsAt.set(n.Y, []); xsAt.get(n.Y).push(n.X); }
    const near = (a, b) => Math.abs(a.y - b.y) < 1 && a.x !== b.x && !(xsAt.get(a.y) || []).some(x => x > Math.min(a.x, b.x) + 1 && x < Math.max(a.x, b.x) - 1);
    const stack = new Map(), H = S_CARD / 2, list = [], todo = [];
    for (const r of vbs) {
      const a = box(r.a), b = box(r.b);
      if (near(a, b) && !r.v.label) {
        const key = Math.min(a.x, b.x) + ',' + a.y, k = stack.get(key) || 0;
        if (k < 3) {
          stack.set(key, k + 1);
          const dir = Math.sign(b.x - a.x), y = a.y - 10 - k * 9, sx = a.x + dir * (H + 4), ex = b.x - dir * (H + 4);
          list.push({ r, v: r.v, g: { d: `M${sx},${y}L${ex},${y}`, arrow: arrowAt(ex, y, dir > 0 ? 0 : Math.PI, 7), mx: (sx + ex) / 2, my: y, pts: [[sx, y], [ex, y]] } });
          continue;
        }
      }
      todo.push({ r, v: r.v, a, b, id: list.length + todo.length });
    }
    // elke lijn een eigen plek op de rand van een item, zodat ze elkaar daar niet kruisen
    const groups = new Map(), probe = laneCounter();
    const note = (p, s, end, id, turn, next) => {
      const key = p.k + ':' + s; if (!groups.has(key)) groups.set(key, { p, s, list: [] });
      groups.get(key).list.push({ who: id + end, dir: Math.sign(next[0] - turn[0]), dist: Math.abs(turn[1] - p.y) });
    };
    for (const t of todo) {
      const pts = route(t.a, t.b, ob, probe, !!t.v.label, () => 0), n = pts.length;
      note(t.a, Math.sign(pts[0][1] - t.a.y), 'a', t.id, pts[1], pts[2]);
      note(t.b, Math.sign(pts[n - 1][1] - t.b.y), 'b', t.id, pts[n - 2], pts[n - 3]);
    }
    const spot = new Map();
    for (const { p, s, list: ls } of groups.values()) {
      const rank = e => e.dir < 0 ? [0, e.dist] : e.dir > 0 ? [2, -e.dist] : [1, 0];
      ls.sort((x, y) => { const [g1, d1] = rank(x), [g2, d2] = rank(y); return g1 - g2 || d1 - d2; });
      const offs = ls.map((_, i) => (i - (ls.length - 1) / 2) * 10);
      ls.forEach((e, i) => spot.set(p.k + ':' + s + ':' + e.who, offs[i]));
    }
    const before = lane.snap();
    for (const t of todo) {
      const port = (p, s, end) => spot.get(p.k + ':' + s + ':' + t.id + end) ?? 0;
      list.push({ r: t.r, v: t.v, a: t.a, b: t.b, routed: true, g: vbFromPts(route(t.a, t.b, ob, lane, !!t.v.label, port), t.a, t.b) });
    }
    orderLanes(list, before);
    untangleVbs(list, before);
    placeVbLabels(list);
    return list.map(x => ({ a: x.r.a, b: x.r.b, v: x.v, line: new Path2D(x.g.d), arrow: new Path2D(x.g.arrow), mx: x.g.mx, my: x.g.my }));
  };
  // oplichten zoals op de computer: de tak van het gekozen item (en wat er later van aftakt) houdt zijn kleur,
  // de hele verbandenreeks blijft licht ('inspireerde' onderbreekt de reeks), bij een idee ook alles wat eraan hangt
  const kidsOf = new Map(); const kid = (r, x, c) => { if (!kidsOf.has(r)) kidsOf.set(r, []); kidsOf.get(r).push({ x, row: c }); };
  for (const b of M.branches) kid(b.a.row, b.a.X, b.b.row);
  for (const { r } of rowsD) if (r.side && r.from) kid(r.from.row, r.from.X, r);
  const insp = v => low(v.soort) === 'inspireerde';
  let lit = null, litFor;
  const light = sel => {
    if (litFor === sel) return lit; litFor = sel; if (!sel) return lit = null;
    const ys = new Set([sel.row]), todo = (kidsOf.get(sel.row) || []).filter(k => k.x >= sel.X - S_CH).map(k => k.row);
    while (todo.length) { const r = todo.pop(); if (ys.has(r)) continue; ys.add(r); for (const k of kidsOf.get(r) || []) todo.push(k.row); }
    const me = first.get(low(sel.it.title)) || sel, ring = new Set(), ends = new Set();
    for (const t = [me]; t.length;) {
      const o = t.pop(); if (ring.has(o.it)) continue; ring.add(o.it);
      for (const x of vbs) { const other = x.a === o ? x.b : x.b === o ? x.a : null; if (!other || ring.has(other.it)) continue; if (!insp(x.v)) t.push(other); else if (o === me) ends.add(other.it); }
    }
    for (const it of ends) ring.add(it);
    if (sel.it.idee) for (const t = [sel.it], seen = new Set(); t.length;) { const o = t.pop(); if (seen.has(o)) continue; seen.add(o); ring.add(o); for (const n of all) if (n.it.aanIt === o) t.push(n.it); }
    const bron = new Set(vbs.filter(x => x.b === me && insp(x.v)).map(x => x.a.it));
    return lit = { ys, ring, bron, me };
  };
  // plaatjes: alleen wat in beeld is laden, en verkleind bewaren zodat tekenen snel blijft
  const pics = new Map(), widths = new Map(); let loading = 0, need = [], dead = false;
  // al eerder gemaakt (deze keer dat Obsidian open is): meteen gebruiken, dan staat de stroom direct vol
  for (const n of all) if (n.img) { const e = THUMBS.get(thumbKey(n.img)); if (e) pics.set(n.img.path, e); }
  const pump = () => {
    while (loading < 4 && need.length) {
      const f = need.shift(); if (pics.has(f.path)) continue;
      const key = thumbKey(f); pics.set(f.path, null); loading++;
      const done = e => { loading--; pics.set(f.path, e); if (e) THUMBS.set(key, e); if (!dead) { onPic(); pump(); } };
      // van een vierkant plaatje (canvas of bewaard bestandje) de twee versies maken: vierkant en rond (voor ideeën)
      const make = src => {
        const q = THUMB_Q, c = document.createElement('canvas'); c.width = c.height = q; c.getContext('2d').drawImage(src, 0, 0, q, q);
        const o = document.createElement('canvas'); o.width = o.height = q; const og = o.getContext('2d');
        og.fillStyle = '#f4f1ea'; og.beginPath(); og.arc(q / 2, q / 2, q / 2, 0, 7); og.fill(); og.clip(); og.drawImage(c, 0, 0);
        const e = { sq: c, rd: o };
        if (window.createImageBitmap) Promise.all([createImageBitmap(c), createImageBitmap(o)]).then(([a, b]) => { e.sq = a; e.rd = b; }).catch(() => {});
        return e;
      };
      const fresh = () => {
        const im = new Image();
        im.onload = () => {
          if (!im.naturalWidth) return done(false);
          const q = THUMB_Q, c = document.createElement('canvas'), s0 = Math.min(im.naturalWidth, im.naturalHeight);
          c.width = c.height = q; c.getContext('2d').drawImage(im, (im.naturalWidth - s0) / 2, (im.naturalHeight - s0) / 2, s0, s0, 0, 0, q, q);
          try { c.toBlob(bl => { if (bl) thumbPut(key, bl); }, 'image/jpeg', .82); } catch (e) {}
          done(make(c));
        };
        im.onerror = () => done(false); im.src = app.vault.getResourcePath(f);
      };
      // bewaard van een vorige keer? dan hoeft de grote foto niet geladen te worden
      thumbGet(key).then(bl => {
        if (!bl) return fresh();
        const im = new Image(), u = URL.createObjectURL(bl);
        im.onload = () => { URL.revokeObjectURL(u); done(make(im)); }; im.onerror = () => { URL.revokeObjectURL(u); fresh(); }; im.src = u;
      });
    }
  };
  const paint = (g, v, W, H, o = {}) => {
    const k = v.k, sx = x => v.x + x * k, sy = y => v.y + y * k; need = [];
    const L = light(o.sel || null), DIM = .15;
    const rr = (x, y, w, hh, rad) => { rad = Math.max(0, Math.min(rad, w / 2, hh / 2)); g.beginPath(); g.moveTo(x + rad, y); g.arcTo(x + w, y, x + w, y + hh, rad); g.arcTo(x + w, y + hh, x, y + hh, rad); g.arcTo(x, y + hh, x, y, rad); g.arcTo(x, y, x + w, y, rad); g.closePath(); };
    g.fillStyle = S_BG; g.fillRect(0, 0, W, H);
    const vis = n => { const x = sx(n.X), y = sy(n.Y), r = n.S * k + 40; return x > -r && x < W + r && y > -r && y < H + r; };
    // maanden
    g.font = `11px ${S_MONO}`; g.textBaseline = 'top'; let lastM = '', lastX = -1e9, lastY = '';
    for (const d of M.dates) {
      const m = d.slice(0, 7); if (m === lastM) continue; lastM = m;
      const x = sx(M.x0.get(d) * S_COL) - S_COL * k / 2; if (x > W + 10) break;
      const y = m.slice(0, 4), lbl = MND[+m.slice(5) - 1].toUpperCase() + (y !== lastY ? ' ' + y : ''); lastY = y;
      if (x < -120 || x < lastX + 10) continue; lastX = x + 4 + g.measureText(lbl).width;
      g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(Math.round(x), 20, 1, H); g.fillStyle = S_MUTED; g.fillText(lbl, x + 4, 5);
    }
    // kleurbanden per rij: vol om de items heen, een dun lint waar lang niets gebeurt
    for (const { r, ns } of rowsD) {
      const y = sy(ns[0].Y); if (y < -S_ROW * k || y > H + S_ROW * k) continue;
      g.globalAlpha = r === o.hot ? .3 : .09; g.fillStyle = r.kleur;
      let from = ns[0].X;
      for (let i = 1; i <= ns.length; i++) {
        if (i < ns.length && ns[i].X - ns[i - 1].X <= S_COL * 3) continue;
        const a = from, b = ns[i - 1].X; rr(sx(a - S_CH - 12), y - (S_CH + 12) * k, (b - a + S_CARD + 24) * k, (S_CARD + 24) * k, 16 * k); g.fill();
        if (i < ns.length) { g.fillRect(sx(b + S_CH), y - 11 * k, (ns[i].X - b - S_CARD) * k, 22 * k); from = ns[i].X; }
      }
    }
    g.globalAlpha = 1;
    // lijnen tussen de items van een rij; bij een gekozen item kleurt zijn tak, de rest wordt vaag
    for (const { r, ns } of rowsD) {
      const on = L && L.ys.has(r);
      g.globalAlpha = L && !on ? DIM : 1; g.strokeStyle = on ? r.kleur : S_LINE; g.lineWidth = on ? 2.5 : 1.2; g.beginPath();
      for (let i = 1; i < ns.length; i++) { const a = ns[i - 1], b = ns[i]; g.moveTo(sx(a.X + a.S / 2), sy(a.Y)); g.lineTo(sx(b.X - b.S / 2), sy(b.Y)); }
      g.stroke();
    }
    for (const { r, ns } of rowsD) if (r.side && r.from) {
      const a = r.from, b = ns[0], up = b.Y < a.Y, ay = sy(a.Y) + (up ? -1 : 1) * a.S * k / 2, by = sy(b.Y) + (up ? 1 : -1) * b.S * k / 2;
      g.globalAlpha = L && !L.ys.has(r) ? DIM : 1; g.strokeStyle = r.kleur; g.lineWidth = L && L.ys.has(r) ? 2.5 : 1.4; g.beginPath(); g.moveTo(sx(a.X), ay);
      if (Math.abs(a.X - b.X) < 1) g.lineTo(sx(b.X), by); else g.bezierCurveTo(sx(a.X), (ay + by) / 2, sx(b.X), (ay + by) / 2, sx(b.X), by);
      g.stroke();
    }
    g.lineWidth = 2.2;
    for (const b of M.branches) { const A = b.a, B = b.b, x1 = sx(A.X + A.S / 2), y1 = sy(A.Y), x2 = sx(B.X - B.S / 2), y2 = sy(B.Y); g.globalAlpha = L && !L.ys.has(B.row) ? DIM : .85; g.strokeStyle = b.kleur; g.beginPath(); g.moveTo(x1, y1); g.bezierCurveTo(x1 + 60 * k, y1, x2 - 60 * k, y2, x2, y2); g.stroke(); }
    g.globalAlpha = 1;
    // verbanden, getekend zoals op de computer (in de maten van de stroom, meegeschaald met het zoomen)
    if (vbs.length) {
      if (!geo) geo = route_();
      g.save(); g.translate(v.x, v.y); g.scale(k, k); g.lineCap = 'butt';
      const lbls = [];
      for (const x of geo) {
        const sk = soort(x.v.soort), own = L && (x.a === L.me || x.b === L.me), hl = L && (own || (L.ring.has(x.a.it) && L.ring.has(x.b.it) && !insp(x.v)));
        g.globalAlpha = L && !hl ? .12 : hl ? 1 : .85; g.strokeStyle = g.fillStyle = sk.kleur; g.lineWidth = Math.max(hl ? 3 : 1.8, 1 / k);
        g.setLineDash(DASH[sk.stijl] || []); g.stroke(x.line); g.setLineDash([]);
        g.globalAlpha = L && !hl ? .12 : .9; g.fill(x.arrow);
        if (x.v.label) lbls.push([x, sk, L && !hl]);
      }
      g.font = `10px ${S_MONO}`; g.textBaseline = 'middle'; g.textAlign = 'center';
      for (const [x, sk, dim] of lbls) {
        const t = short(x.v.label, 30), w = Math.min(x.v.label.length, 30) * 6 + 12;
        g.globalAlpha = dim ? .12 : 1; rr(x.mx - w / 2, x.my - 9, w, 18, 9); g.fillStyle = S_BG; g.fill(); g.strokeStyle = sk.kleur; g.lineWidth = 1; g.stroke();
        g.fillStyle = S_INK; g.fillText(t, x.mx, x.my + 1);
      }
      g.textAlign = 'left'; g.globalAlpha = 1; g.restore();
    }
    // de items: vierkante kaartjes met foto; ideeën rond. Uit de reeks: groter; de bron van 'inspireerde': kleiner
    const scaleOf = n => !L ? 1 : n === o.sel ? 1.9 : L.bron.has(n.it) ? .85 : L.ring.has(n.it) ? 1.15 : 1;
    const order = o.sel ? [...all.filter(n => n !== o.sel), o.sel] : all;
    for (const n of order) {
      if (!vis(n)) continue;
      const S = n.S * k * scaleOf(n), x = sx(n.X) - S / 2, y = sy(n.Y) - S / 2, c = n.row.kleur, idee = n.it.idee, ringed = L && L.ring.has(n.it);
      g.globalAlpha = L && !ringed ? DIM : 1;
      let pic = n.img ? pics.get(n.img.path) : false;
      if (pic === undefined) { if (S > 5) need.push(n.img); pic = null; }
      if (pic && n !== o.sel) g.drawImage(idee ? pic.rd : pic.sq, x, y, S, S); // snel: zonder knippen
      else {
      if (n === o.sel) { g.shadowColor = 'rgba(0,0,0,.7)'; g.shadowBlur = 14; g.shadowOffsetY = 4; }
      g.save(); g.beginPath();
      if (idee) g.arc(x + S / 2, y + S / 2, S / 2, 0, 7); else g.rect(x, y, S, S);
      g.fillStyle = idee ? '#f4f1ea' : '#1a1a1a'; g.fill(); g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
      g.clip();
      if (pic) g.drawImage(pic.sq, x, y, S, S);
      else {
        if (!idee) { g.fillStyle = c; g.fillRect(x, y, S, Math.max(1, 3 * k)); }
        if (S > 34 && !n.img) {
          const fs = Math.max(8, Math.min(12, 10 * k)), lh = fs * 1.25; g.font = `${fs}px ${S_MONO}`; g.fillStyle = idee ? '#141414' : S_INK; g.textBaseline = 'top'; g.textAlign = idee ? 'center' : 'left';
          const lines = []; let ln = '';
          for (const w of n.it.title.split(/\s+/)) { const t = ln ? ln + ' ' + w : w; if (ln && g.measureText(t).width > S - 10) { lines.push(ln); ln = w; } else ln = t; }
          if (ln) lines.push(ln);
          const sh = lines.slice(0, Math.max(1, Math.floor((S - 10) / lh))), y0 = idee ? y + S / 2 - sh.length * lh / 2 : y + 6;
          sh.forEach((t, i) => g.fillText(t, idee ? x + S / 2 : x + 5, y0 + i * lh));
          g.textAlign = 'left';
        }
      }
      g.restore();
      }
      const on = n === o.sel || ringed;
      g.strokeStyle = on ? c : S_SOFT; g.lineWidth = on ? 2.5 : 1; g.beginPath();
      if (idee) g.arc(x + S / 2, y + S / 2, S / 2, 0, 7); else g.rect(x + .5, y + .5, S - 1, S - 1);
      g.stroke();
      if (idee) {
        const rang = S_RANG[n.it.rang] ? n.it.rang : 'middel', ga = g.globalAlpha;
        g.strokeStyle = c; g.lineWidth = rang === 'groot' ? 2.2 : 1.4; g.globalAlpha = ga * (rang === 'groot' ? 1 : .8); g.lineCap = 'round';
        g.setLineDash(rang === 'groot' ? [] : rang === 'klein' ? [1, 3] : [2, 4]);
        g.beginPath(); g.arc(x + S / 2, y + S / 2, S / 2 + (rang === 'klein' ? 4 : 5) * k, 0, 7); g.stroke();
        if (rang === 'groot') { g.setLineDash([]); g.lineWidth = 1; g.globalAlpha = ga * .55; g.beginPath(); g.arc(x + S / 2, y + S / 2, S / 2 + 11 * k, 0, 7); g.stroke(); }
        g.setLineDash([]); g.lineCap = 'butt';
      }
      g.globalAlpha = 1;
    }
    // namen: van ideeën altijd (als er plek is), van items als je ver genoeg ingezoomd bent
    g.textBaseline = 'top'; g.textAlign = 'center';
    for (const { ns } of rowsD) {
      let right = -1e9;
      for (const n of ns) {
        if ((n.it.idee ? k < .28 || o.ideeT === false : k < .55) && n !== o.sel) continue;
        // een idee met iets eraan: zijn titel blijft aan de linkerrand staan zolang dat in beeld is (zoals de projectnamen)
        const stick = n.it.idee && n.tail > n.X && n !== o.sel;
        if (stick ? !(sy(n.Y) > -40 && sy(n.Y) < H + 40 && sx(n.tail) > 0 && sx(n.X) < W + 60) : !vis(n)) continue;
        let x = sx(n.X); g.font = n.it.idee ? `600 11px ${S_MONO}` : `10px ${S_MONO}`;
        const t = short(n.it.title, n.it.idee ? 22 : Math.max(8, Math.round(S_COL * k / 7))), wk = g.font + '|' + t;
        let w = widths.get(wk); if (w === undefined) { w = g.measureText(t).width; widths.set(wk, w); }
        let stuck = false;
        if (stick && x - w / 2 < 6) { x = Math.min(6 + w / 2, Math.max(x, sx(n.tail) + n.S * k / 2 - w / 2)); stuck = true; }
        if (x - w / 2 < right + 6 && n !== o.sel) continue; right = x + w / 2;
        g.globalAlpha = L && !L.ring.has(n.it) ? DIM : 1;
        const ty = sy(n.Y) + n.S * k * scaleOf(n) / 2 + (n.it.idee ? 8 : 5);
        // aan de rand: een donker blokje erachter, zodat hij leesbaar blijft boven de lijnen
        if (stuck) { g.fillStyle = 'rgba(10,10,10,.85)'; rr(x - w / 2 - 6, ty - 3, w + 12, 18, 4); g.fill(); g.strokeStyle = n.row.kleur; g.lineWidth = 1; g.stroke(); }
        g.fillStyle = n.it.idee ? S_INK : S_MUTED; g.fillText(t, x, ty);
      }
    }
    g.globalAlpha = 1; g.textAlign = 'left';
    // projectnamen: een blokje in de kleur van het project boven de rij, zodat de plaatjes vrij blijven;
    // het schuift mee langs de linkerrand zolang de rij in beeld is
    g.font = `11px ${S_MONO}`; g.textBaseline = 'middle'; const took = [];
    for (const { r, ns } of rowsD) {
      if (r.side || !r.lijn || o.projT === false) continue;
      const top = sy(ns[0].Y) - Math.max(...ns.map(n => n.S * scaleOf(n))) / 2 * k, y = top - 6 - 10; if (y < 4 || y > H + 14) continue;
      const w = g.measureText(r.lijn).width + 16, nat = sx(ns[0].X - ns[0].S / 2), endX = sx(ns[ns.length - 1].X + S_CH) - w;
      const x = Math.min(Math.max(6, nat), Math.max(nat, endX));
      if (x + w < -10 || took.some(t => Math.abs(t[1] - y) < 22 && x < t[0] + t[2] + 4 && t[0] < x + w + 4)) continue; took.push([x, y, w]);
      g.globalAlpha = L && !L.ys.has(r) ? DIM : 1;
      g.fillStyle = r.kleur; rr(x, y - 10, w, 20, 3); g.fill();
      g.fillStyle = S_BG; g.fillText(r.lijn, x + 8, y + 1); g.globalAlpha = 1;
    }
    if (need.length) pump();
  };
  // het item onder een vinger (of het dichtstbijzijnde, binnen een vingertop)
  const hit = (v, px, py) => {
    let best = null, bd = 1e9;
    for (const n of all) { const r = Math.max(22, n.S * v.k / 2 + 4), d = Math.hypot(v.x + n.X * v.k - px, v.y + n.Y * v.k - py); if (d < r && d < bd) { bd = d; best = n; } }
    return best;
  };
  return { all, rowsD, WX, HY, vbs, paint, hit, light, setSoorten: s => { if (s && s.length) { soorten = s; } }, stop: () => { dead = true; } };
}

/* ---------- notitie opbouwen, zelfde vorm als de visualisator ---------- */
function buildNote(f, body) {
  const L = [`datum: ${f.datum || ''}`.trimEnd()];
  // het veld heette vroeger lijn; sinds 2026-11 project
  if (f.lijnen.length > 1) L.push('project:', ...f.lijnen.map(x => `  - ${yamlVal(x)}`));
  else L.push(f.lijnen[0] ? `project: ${yamlVal(f.lijnen[0])}` : 'project:');
  L.push(f.type ? `type: ${yamlVal(f.type)}` : 'type:');
  L.push(...(f.tags.length ? ['tags:', ...f.tags.map(t => `  - ${yamlVal(t)}`)] : ['tags: []']));
  if (f.producten && f.producten.length) L.push('producten:', ...f.producten.map(t => `  - ${JSON.stringify(`[[${t}]]`)}`));
  if (f.onbekend && f.onbekend.length) L.push('product_onbekend:', ...f.onbekend.map(t => `  - ${yamlVal(t)}`));
  if (f.inbox) L.push('inbox: ja');
  if (f.bord) L.push(`bord: ${f.bord}`);
  L.push('telefoon: ja');
  const text = body.replace(/^\s*\n/, '');
  return `---\n${L.join('\n')}\n---\n\n${text}${text.endsWith('\n') ? '' : '\n'}`;
}

module.exports = class ArchiefMobiel extends Plugin {
  async onload() {
    this.registerView(VIEW, leaf => new ArchiefView(leaf, this));
    this.addRibbonIcon('lightbulb', 'Idee', () => this.open('idee'));
    this.addRibbonIcon('camera', 'Inladen', () => this.open('aanvullen'));
    this.addRibbonIcon('library', 'Archief', () => this.open('archief'));
    this.addCommand({ id: 'nieuw', name: 'Idee', callback: () => this.open('idee') });
    this.addCommand({ id: 'taggen', name: 'Archief', callback: () => this.open('archief') });
    this.addCommand({ id: 'aanvullen', name: 'Inladen', callback: () => this.open('aanvullen') });
    this.addCommand({ id: 'logboek', name: 'Logboek', callback: () => this.open('logboek') });
    // in dit scherm hoort Obsidians eigen knoppenbalk onderin niet over de Opslaan-knop te liggen
    const mark = () => { const l = this.app.workspace.activeLeaf; document.body.classList.toggle('am-actief', !!(l && l.view && l.view.getViewType && l.view.getViewType() === VIEW)); for (const x of this.app.workspace.getLeavesOfType(VIEW)) x.view && x.view.fitBottom && x.view.fitBottom(); };
    this.registerEvent(this.app.workspace.on('active-leaf-change', mark));
    this.app.workspace.onLayoutReady(mark);
    let rt; const later = f => { if (f && f.path && /^Logboek\//.test(f.path)) { clearTimeout(this.lbRt); this.lbRt = setTimeout(() => this.refreshViews(false, 'logboek'), 1500); return; } if (f && f.path && !/^(Onderzoek|Ideeën|Aanvullen)\//.test(f.path)) return; clearTimeout(rt); rt = setTimeout(() => this.refreshViews(false), 1500); };
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.metadataCache.on('changed', later));
      this.registerEvent(this.app.vault.on('delete', later)); this.registerEvent(this.app.vault.on('rename', later)); this.registerEvent(this.app.vault.on('create', later));
    });
    this.addCommand({ id: 'bijwerken', name: 'Bijwerken naar de nieuwste versie', callback: () => this.update() });
  }
  // eerst kijken of GitHub een nieuwere versie heeft; anders (of zonder internet) synchroniseren zoals vroeger
  async update() {
    if (this.updating) return; this.updating = true;
    const note = new Notice(`Synchroniseren… (nu versie ${BUILD})`, 0);
    // in één tik: eerst synchroniseren (je wijzigingen van de pc), daarna kijken of GitHub een nieuwere versie heeft
    try { await this.syncUpdate(note); } finally { this.updating = false; }
  }
  // de code van GitHub halen en over de plugin heen zetten; geeft de nieuwe versie terug, of null als er niets nieuwers is
  async fromGitHub() {
    const get = async f => {
      const r = await requestUrl({ url: `https://api.github.com/repos/${REPO}/contents/${REPO_DIR}/${f}?ref=main`, headers: { Accept: 'application/vnd.github.raw' }, throw: false });
      if (r.status !== 200) throw new Error(`GitHub gaf ${r.status} voor ${f}`);
      return r.text;
    };
    const mf = await get('manifest.json'), v = JSON.parse(mf).version;
    if (!newerThan(v, BUILD)) return null;
    const [js, css] = await Promise.all([get('main.js'), get('styles.css')]);
    const m = js.match(/const BUILD = '([\d.]+)'/);
    if (!m || m[1] !== v || js.length < 10000) throw new Error(`main.js op GitHub (${m ? m[1] : '?'}) past niet bij manifest.json (${v})`);
    // manifest.json als laatste: dan klopt hij pas als de code er al staat. taggroepen.json blijft altijd met rust
    const dir = this.manifest.dir, A = this.app.vault.adapter;
    await A.write(`${dir}/styles.css`, css); await A.write(`${dir}/main.js`, js); await A.write(`${dir}/manifest.json`, mf);
    return v;
  }
  // synchroniseren en, als er daarna een nieuwere versie van deze plugin staat, Obsidian herladen
  async syncUpdate(note) {
    const was = BUILD, mf = `${this.manifest.dir}/manifest.json`;
    const onDisk = async () => { try { return JSON.parse(await this.app.vault.adapter.read(mf)).version; } catch (e) { return was; } };
    // de versie die in main.js op schijf staat: manifest.json komt vaak eerder binnen dan de code zelf
    const codeOnDisk = async () => { try { const m = (await this.app.vault.adapter.read(`${this.manifest.dir}/main.js`)).match(/const BUILD = '([\d.]+)'/); return m ? m[1] : null; } catch (e) { return null; } };
    const rs = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins['remotely-save'];
    const knows = !!(rs && 'syncStatus' in rs), busy = () => knows && !/^(idle|finish)$/.test(String(rs.syncStatus));
    const synced = this.sync();
    if (synced) {
      // wachten tot de sync helemaal klaar is (Remotely Save houdt syncStatus bij), hoogstens 2 minuten.
      // Niet eerder stoppen: anders herlaadt Obsidian terwijl main.js nog binnenkomt
      const t0 = Date.now(); let started = false;
      while (Date.now() - t0 < 120000) {
        await new Promise(r => setTimeout(r, 1000));
        const b = busy(); if (b) started = true;
        const el = Date.now() - t0;
        if (knows ? (started && !b) || (!started && el > 10000) : el > 20000) break;
      }
    }
    if (note.setMessage) note.setMessage('Kijken of er een nieuwe versie is…');
    let v = null;
    try { v = await this.fromGitHub(); } catch (e) { console.warn('archief-mobiel: bijwerken via GitHub lukte niet', e); }
    note.hide();
    if (v) {
      new Notice(`${synced ? 'Gesynchroniseerd en n' : 'N'}ieuwe versie ${v} binnen. Obsidian herlaadt…`, 3000);
      await new Promise(r => setTimeout(r, 1200));
      this.app.commands.executeCommandById('app:reload'); return;
    }
    if (!synced) { new Notice('Remotely Save staat niet aan; kan niet synchroniseren.', 6000); return; }
    {
      const code = await codeOnDisk(), now = await onDisk();
      if (code && code !== was) {
        new Notice(`Nieuwe versie ${code} binnen. Obsidian herlaadt…`, 3000);
        await new Promise(r => setTimeout(r, 1200));
        this.app.commands.executeCommandById('app:reload');
      } else if (now !== was) new Notice(`Versie ${now} is onderweg maar nog niet helemaal binnen. Wacht even (staat de computer aan en is OneDrive klaar?) en tik dan nog eens op ↻.`, 9000);
      else { new Notice(`Je hebt de nieuwste versie (${was}). Lijsten zijn ververst.`, 5000); await new Promise(r => setTimeout(r, 800)); this.refreshViews(true); }
    }
  }
  onunload() { document.body.classList.remove('am-actief'); }
  // het scherm opnieuw opbouwen met wat er nu in de kluis staat (niet tijdens bewerken, aanvullen of een idee)
  refreshViews(force, only) {
    for (const l of this.app.workspace.getLeavesOfType(VIEW)) {
      const v = l.view; if (!v || !v.render || (only && v.tab !== only) || v.editing || v.tab === 'idee' || v.lbDirty || (v.form && v.form.vullen) || v.closeSheet || v.closeFull || document.querySelector('.am-crop')) continue;
      const a = document.activeElement; if (!force && a && v.contentEl.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) continue;
      const y = v.contentEl.scrollTop; v.render().then(() => { v.contentEl.scrollTop = y; });
    }
  }
  async open(tab) {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = ws.getLeaf(true); await leaf.setViewState({ type: VIEW, active: true }); }
    ws.revealLeaf(leaf);
    if (leaf.view && leaf.view.show) leaf.view.show(tab);
  }

  /* ---------- archief lezen ---------- */
  items() {
    const out = [], mc = this.app.metadataCache;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(NOTE_DIR + '/') && !f.path.startsWith(IDEA_DIR + '/')) continue;
      const c = mc.getFileCache(f) || {}, fm = c.frontmatter || {};
      if (/^(nee|false)$/i.test(String(fm.archief ?? '').trim())) continue;
      if (String(fm.type || '').toLowerCase() === 'mijlpaal') continue;
      const imgs = [];
      for (const e of c.embeds || []) {
        const t = mc.getFirstLinkpathDest(e.link.split('|')[0].split('#')[0], f.path);
        if (t && IMG_EXT.test(t.path) && !imgs.includes(t)) imgs.push(t);
      }
      const img = imgs[0] || null;
      out.push({ imgs,
        file: f, title: f.basename, datum: String(fm.datum || '').slice(0, 10),
        idee: String(fm.type || '').toLowerCase() === 'idee' || f.path.startsWith(IDEA_DIR + '/'),
        lijnen: arr(fm.project ?? fm.lijn).map(String).map(s => s.trim()).filter(Boolean),
        tags: arr(fm.tags ?? fm.tag).map(cleanTag).filter(Boolean), img,
        producten: arr(fm.producten).map(linkTitle).filter(Boolean),
        onbekend: arr(fm.product_onbekend).map(cleanTag).filter(Boolean),
        inbox: /^(ja|true|yes)$/i.test(String(fm.inbox ?? '').trim()), geenDatum: !fm.datum,
      });
    }
    return out.sort((a, b) => (b.datum || '').localeCompare(a.datum || '') || b.file.stat.mtime - a.file.stat.mtime);
  }
  // Te doen, met dezelfde regels als de visualisator: ingeladen materiaal (inbox: ja of nog een cameranaam)
  // waar nog iets ontbreekt: beschrijving, project, tags (niet bij een idee) of datum
  async teDoen(items) {
    const out = [];
    for (const it of items) {
      if (!it.inbox && !cameraName(it.title)) continue;
      let mist = !it.lijnen.length || (!it.idee && !it.tags.length) || it.geenDatum;
      if (!mist) { const t = (await this.app.vault.cachedRead(it.file)).replace(/^---\r?\n[\s\S]*?\r?\n---[^\n]*\n?/, '').replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim(); mist = t.length < 3; }
      if (mist) out.push(it);
    }
    return out;
  }
  // lijnen, nieuwste eerst; tags gegroepeerd zoals in .archief/taggroepen.json
  async choices() {
    const items = this.items(), lijn = new Map(), tag = new Map();
    // wat nog in Te doen hoort (zelfde regel als de visualisator); dat staat niet in de stroom
    try { this.todo = new Set((await this.teDoen(items)).map(it => it.file.path)); } catch (e) { this.todo = null; }
    for (const it of items) {
      for (const l of it.lijnen) lijn.set(l, (lijn.get(l) || '') > it.datum ? lijn.get(l) : it.datum);
      for (const t of it.tags) tag.set(t, (tag.get(t) || 0) + 1);
    }
    const groepen = (await this.readGroepen()).groepen;
    const used = new Set(), groups = [];
    for (const [naam, list] of Object.entries(groepen)) {
      const ts = list.map(cleanTag).filter(t => tag.has(t) && !used.has(t));
      ts.forEach(t => used.add(t));
      if (ts.length) groups.push({ naam, tags: ts.sort((a, b) => tag.get(b) - tag.get(a)) });
    }
    const rest = [...tag.keys()].filter(t => !used.has(t) && t !== 'idee').sort((a, b) => tag.get(b) - tag.get(a));
    if (rest.length) groups.push({ naam: groups.length ? 'overig' : 'tags', tags: rest });
    return { items, lijnen: [...lijn.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(x => x[0]), groups, products: this.products() };
  }
  // producten: notities in Producten/ met de tag(s) waar ze bij horen, zoals in de visualisator
  products() {
    const out = [], mc = this.app.metadataCache;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(PROD_DIR + '/')) continue;
      const c = mc.getFileCache(f) || {}, fm = c.frontmatter || {};
      let img = null;
      for (const e of c.embeds || []) {
        const t = mc.getFirstLinkpathDest(e.link.split('|')[0].split('#')[0], f.path);
        if (t && IMG_EXT.test(t.path)) { img = t; break; }
      }
      out.push({ file: f, title: f.basename, tags: arr(fm.tags ?? fm.tag).map(cleanTag).filter(Boolean), img, merk: String(fm.merk ?? ''), grootte: String(fm.grootte ?? ''), prijs: String(fm.prijs ?? ''), winkel: String(fm.winkel ?? '') });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /* ---------- taggroepen ---------- */
  // .archief synchroniseert niet naar de telefoon; daarom ligt er een kopie in de pluginmap.
  // Wie het laatst iets veranderde (bijgewerkt) wint; de visualisator houdt beide bij
  phoneGroups() { return this.manifest && this.manifest.dir ? `${this.manifest.dir}/taggroepen.json` : null; }
  async readGroepen() {
    let best = { groepen: {}, bijgewerkt: -1 };
    for (const p of [ARCH_GROUPS, this.phoneGroups()].filter(Boolean)) {
      try {
        if (!await this.app.vault.adapter.exists(p)) continue;
        const j = JSON.parse(await this.app.vault.adapter.read(p));
        if (j && j.groepen && (j.bijgewerkt || 0) > best.bijgewerkt) best = { groepen: j.groepen, bijgewerkt: j.bijgewerkt || 0 };
      } catch (e) {}
    }
    return best;
  }
  async saveGroepen(groepen) {
    const txt = JSON.stringify({ groepen, bijgewerkt: Date.now() }, null, 2), ad = this.app.vault.adapter;
    if (this.phoneGroups()) await ad.write(this.phoneGroups(), txt);
    try { if (await ad.exists(ARCH_GROUPS)) await ad.write(ARCH_GROUPS, txt); } catch (e) {}
  }
  groupOf(groepen, t) { return (Object.entries(groepen).find(([, v]) => v.some(x => cleanTag(x) === t)) || ['tags'])[0]; }
  async moveTag(t, g) {
    const groepen = {};
    for (const [k, v] of Object.entries((await this.readGroepen()).groepen)) groepen[k] = v.filter(x => cleanTag(x) !== t);
    if (g !== 'tags') (groepen[g] = groepen[g] || []).push(t);
    await this.saveGroepen(groepen);
  }
  // alle notities (items, ideeën, producten) waar de tag in staat
  tagFiles(t) {
    const mc = this.app.metadataCache;
    return this.app.vault.getMarkdownFiles().filter(f => [NOTE_DIR, IDEA_DIR, PROD_DIR].some(d => f.path.startsWith(d + '/'))
      && this.hasTag(((mc.getFileCache(f) || {}).frontmatter) || {}, t));
  }
  hasTag(fm, t) { return TAG_KEYS.some(k => arr(fm[k]).some(x => cleanTag(x) === t)); }
  // een tag overal hernoemen (nieuw) of overal weghalen (nieuw = null); de items zelf blijven staan
  async retag(t, nieuw) {
    const files = this.tagFiles(t), re = hashRe(t);
    for (const f of files) {
      await this.app.fileManager.processFrontMatter(f, fm => {
        for (const k of TAG_KEYS) {
          if (fm[k] == null || !arr(fm[k]).some(x => cleanTag(x) === t)) continue;
          const next = [];
          for (const x of arr(fm[k])) { const v = cleanTag(x) === t ? nieuw : x; if (v && !next.some(y => cleanTag(y) === cleanTag(v))) next.push(v); }
          if (k === 'product_onbekend' && !next.length) delete fm[k]; else fm[k] = next;
        }
      });
      // ook een #tag in de tekst zelf (bij verwijderen blijft het woord staan, alleen het hekje gaat eraf)
      const text = await this.app.vault.read(f), m = text.match(FM_RE), head = m ? m[0] : '', body = text.slice(head.length);
      if (body.search(re) >= 0) await this.app.vault.modify(f, head + body.replace(re, nieuw ? `$1#${nieuw}` : '$1$2'));
    }
    const groepen = (await this.readGroepen()).groepen;
    if (Object.values(groepen).flat().some(x => cleanTag(x) === t)) {
      const next = {}, seen = new Set();
      for (const [k, v] of Object.entries(groepen)) {
        next[k] = [];
        for (const x of v) { const y = cleanTag(x) === t ? nieuw : x; if (y && !seen.has(cleanTag(y))) { seen.add(cleanTag(y)); next[k].push(y); } }
      }
      await this.saveGroepen(next);
    }
    await this.settle(files, fm => this.hasTag(fm, t));
    return files.length;
  }
  // wachten tot Obsidian de aangepaste notities opnieuw heeft gelezen (hoogstens 3 seconden)
  async settle(files, stale) {
    for (let i = 0; i < 30 && files.some(f => stale(((this.app.metadataCache.getFileCache(f) || {}).frontmatter) || {})); i++) await new Promise(r => setTimeout(r, 100));
  }

  /* ---------- producten aanpassen ---------- */
  async productNote(p) {
    const text = await this.app.vault.read(p.file), m = text.match(FM_RE);
    return (m ? text.slice(m[0].length) : text).replace(/!\[\[[^\]]+\]\]/, '').trim();
  }
  // nieuwe naam: het bestand hernoemen en in elk item de verwijzing (producten: [[...]]) meenemen
  async renameProduct(p, naam) {
    const want = safeName(naam).slice(0, 80);
    if (!want || want === p.title) return p.title;
    const title = want.toLowerCase() === p.title.toLowerCase() ? want : this.unique(PROD_DIR, `${want}.md`, this.taken()).replace(/\.md$/, '');
    const old = p.title.toLowerCase(), mc = this.app.metadataCache;
    const uses = fm => arr(fm.producten).some(x => linkTitle(x).toLowerCase() === old);
    await this.app.fileManager.renameFile(p.file, normalizePath(`${PROD_DIR}/${title}.md`));
    // Obsidian past links soms zelf aan (instelling); voor de zekerheid doen we het hier ook
    const users = this.app.vault.getMarkdownFiles().filter(f => uses(((mc.getFileCache(f) || {}).frontmatter) || {}));
    for (const f of users) await this.app.fileManager.processFrontMatter(f, fm => { fm.producten = arr(fm.producten).map(x => linkTitle(x).toLowerCase() === old ? `[[${title}]]` : x); });
    await this.settle(users, uses);
    return title;
  }
  // info en foto aanpassen; de oude foto gaat naar .trash
  async editProduct(p, np) {
    const tags = [...new Set(np.tags.map(cleanTag).filter(Boolean))];
    await this.app.fileManager.processFrontMatter(p.file, fm => {
      if (!fm.type) fm.type = 'product';
      fm.tags = tags;
      for (const k of ['merk', 'grootte', 'prijs', 'winkel']) { const v = String(np[k] || '').trim(); if (v) fm[k] = v; else delete fm[k]; }
    });
    const text = await this.app.vault.read(p.file), m = text.match(FM_RE), head = m ? m[0] : '';
    let embed = (text.slice(head.length).match(/!\[\[[^\]]+\]\]/) || [''])[0];
    if (np.file) {
      const { data, ext } = await shrink(np.file);
      const name = this.unique(PROD_DIR, `${p.title}.${ext}`, this.taken());
      await this.app.vault.createBinary(normalizePath(`${PROD_DIR}/${name}`), data);
      // de oude foto alleen weg als geen andere notitie hem gebruikt
      const mc = this.app.metadataCache, shared = p.img && this.app.vault.getMarkdownFiles().some(f => f.path !== p.file.path
        && ((mc.getFileCache(f) || {}).embeds || []).some(e => { const t = mc.getFirstLinkpathDest(e.link.split('|')[0].split('#')[0], f.path); return t && t.path === p.img.path; }));
      if (p.img && !shared && p.img.path.startsWith(PROD_DIR + '/')) { try { await this.app.vault.trash(p.img, false); } catch (e) { console.error(e); } }
      embed = `![[${name}]]`;
    }
    const body = [embed, String(np.notitie || '').trim()].filter(Boolean).join('\n\n');
    await this.app.vault.modify(p.file, `${head.replace(/\r?\n?$/, '\n')}\n${body}${body ? '\n' : ''}`);
    await this.settle([p.file], fm => arr(fm.tags).map(cleanTag).join() !== tags.join());
    return np.naam.trim() ? this.renameProduct(p, np.naam.trim()) : p.title;
  }

  /* ---------- schrijven ---------- */
  // foto's die klaarstaan om aan te vullen (nieuwste eerst)
  dumpFiles() { return this.app.vault.getFiles().filter(f => f.path.startsWith(DUMP_DIR + '/') && (IMG_EXT.test(f.name) || VID_EXT.test(f.name))).sort((a, b) => b.stat.mtime - a.stat.mtime || a.name.localeCompare(b.name)); }
  // de datum gaat vooraan in de naam, zodat hij later nog klopt (ook als de foto zelf geen datum bevat)
  async dumpSave(f, taken) {
    await this.ensureDir(DUMP_DIR);
    // meteen verkleinen (zoals bij een item): veel sneller synchroniseren en tonen. De datum komt uit het origineel en staat in de naam
    const d = await fileDate(f), { data, ext } = await shrink(f);
    let nm = safeName(f.name || 'foto.jpg') || 'foto.jpg'; nm = nm.replace(/\.[^.]+$/, '') + '.' + ext;
    const name = this.unique(DUMP_DIR, d.datum && !nameDate(nm) ? `${d.datum} ${nm}` : nm, taken);
    taken.add(normalizePath(`${DUMP_DIR}/${name}`).toLowerCase());
    await this.app.vault.createBinary(normalizePath(`${DUMP_DIR}/${name}`), data);
  }
  taken() { return new Set(this.app.vault.getFiles().map(f => f.path.toLowerCase())); }
  unique(dir, name, taken) {
    const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    let n = name, i = 2;
    while (taken.has(normalizePath(`${dir}/${n}`).toLowerCase())) n = `${stem} ${i++}${ext}`;
    taken.add(normalizePath(`${dir}/${n}`).toLowerCase());
    return n;
  }
  // foto's uit Inladen naar de beeldbank: verplaatsen en in beeldbank.json zetten (datum = vandaag, zoals op de computer)
  async toBank(files) {
    const imgs = files.filter(f => IMG_EXT.test(f.name)); if (!imgs.length) return 0;
    await this.ensureDir(BANK_DIR);
    const jp = normalizePath(`${BANK_DIR}/${BANK_JSON}`), jf = this.app.vault.getAbstractFileByPath(jp);
    let M = { tags: [], beelden: {} };
    try { const j = JSON.parse(jf ? await this.app.vault.read(jf) : (await this.app.vault.adapter.exists(jp)) ? await this.app.vault.adapter.read(jp) : '{}'); if (j && j.beelden) M = { ...j, tags: j.tags || [], beelden: j.beelden }; } catch (e) {}
    const taken = this.taken(), today = isoDay(Date.now());
    for (const f of imgs) {
      const name = this.unique(BANK_DIR, f.name, taken);
      await this.app.vault.rename(f, normalizePath(`${BANK_DIR}/${name}`));
      M.beelden[name] = { datum: today, bron: '', notitie: '', tags: [] };
    }
    const txt = JSON.stringify(M, null, 2);
    if (jf) await this.app.vault.modify(jf, txt); else await this.app.vault.create(jp, txt);
    return imgs.length;
  }
  async trashItems(list, all) {
    const gone = new Set(list.map(it => it.file.path));
    for (const it of list) {
      for (const f of it.imgs || []) {
        if (all.some(x => !gone.has(x.file.path) && (x.imgs || []).some(m => m.path === f.path))) continue;
        const t = this.app.vault.getAbstractFileByPath(f.path); if (t) await this.app.vault.trash(t, false);
      }
      const t = this.app.vault.getAbstractFileByPath(it.file.path); if (t) await this.app.vault.trash(t, false);
    }
  }
  logFile(d) { return this.app.vault.getAbstractFileByPath(normalizePath(`${LOG_DIR}/${d}.md`)); }
  async logRaw(d) { const f = this.logFile(d); return f ? await this.app.vault.read(f) : ''; }
  async logRead(d) { return (await this.logRaw(d)).replace(LOG_FM, '').trim(); }
  async logPut(d, body) { const f = this.logFile(d); if (f) await this.app.vault.modify(f, body); else { await this.ensureDir(LOG_DIR); await this.app.vault.create(normalizePath(`${LOG_DIR}/${d}.md`), body); } }
  // de notitie van een dag; de werktijden blijven staan (een lege notitie zonder werktijden gaat naar .trash)
  async logWrite(d, text) {
    const f = this.logFile(d), t = text.trim(), raw = f ? await this.app.vault.read(f) : '';
    if (!t && !parseWerk(raw).length) { if (f) await this.app.vault.trash(f, false); return; }
    await this.logPut(d, withText(raw, d, t));
  }
  async werk(d) { return parseWerk(await this.logRaw(d)); }
  async werkSave(d, change) { const raw = await this.logRaw(d), list = sortWerk(change(parseWerk(raw))); await this.logPut(d, withWerk(raw, d, list)); return list; }
  // loopt de klok? (de laatste dag met een tijd zonder eindtijd)
  async klokLoopt() {
    for (const d of this.logDays().slice(0, 60)) { const w = (await this.werk(d)).find(x => !x.tot); if (w) return { d, van: w.van }; }
    return null;
  }
  // in- of uitklokken; geeft terug wat er gebeurde
  async klok(eind) {
    const run = await this.klokLoopt(), now = Date.now(), today = isoDay(now);
    // vergeten uit te klokken en de eindtijd is gekozen
    if (run && eind) { await this.werkSave(run.d, l => { const w = l.find(x => !x.tot && x.van === run.van); if (w) w.tot = eind; return l.filter(x => x !== w || x.tot !== x.van); }); return { msg: `Uitgeklokt: ${fmtD(run.d)} ${run.van}–${eind}` }; }
    if (!run) { await this.werkSave(today, l => [...l, { van: hhmm(now), tot: '' }]); return { msg: `Ingeklokt om ${hhmm(now)}` }; }
    let tot = hhmm(now), lang = false;
    // vergeten uit te klokken op een eerdere dag: dan stopt hij om 23:59 die dag (behalve als je net na middernacht doorwerkte)
    if (run.d !== today && !(run.d === addDay(today, -1) && wtMin(tot) < wtMin(run.van) && now - new Date(run.d + 'T' + run.van) < 16 * 36e5)) { tot = '23:59'; lang = true; }
    await this.werkSave(run.d, l => { const w = l.find(x => !x.tot && x.van === run.van); if (w) w.tot = tot; return l.filter(x => x !== w || x.tot !== x.van); });
    return lang ? { msg: `De klok liep nog sinds ${fmtD(run.d)} ${run.van}. Hij is gestopt om 23:59 die dag; pas daar de eindtijd aan.`, dag: run.d } : { msg: `Uitgeklokt om ${tot}` };
  }
  logDays() { return this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(LOG_DIR + '/') && /^\d{4}-\d\d-\d\d$/.test(f.basename)).map(f => f.basename).sort().reverse(); }
  async ensureDir(dir) { if (!this.app.vault.getAbstractFileByPath(dir)) { try { await this.app.vault.createFolder(dir); } catch (e) {} } }
  // bewaart één foto in Bijlagen en geeft de bestandsnaam terug
  async saveMedia(file, taken, stamp) {
    await this.ensureDir(ATTACH_DIR);
    const { data, ext } = await shrink(file);
    let stem = genericName(file.name) ? `foto-${stamp}` : safeName(file.name.replace(/\.[^.]+$/, ''));
    const name = this.unique(ATTACH_DIR, `${stem || 'foto'}.${ext}`, taken);
    await this.app.vault.createBinary(normalizePath(`${ATTACH_DIR}/${name}`), data);
    return name;
  }
  // maakt een item; geeft het pad van de notitie terug
  // een nieuw product: Producten/<naam>.md met de tag, en de foto ernaast (zoals de visualisator het doet)
  async createProduct({ naam, tag, tags, file, merk = '', grootte = '', prijs = '', winkel = '', notitie = '' }) {
    tags = [...new Set((tags || [tag]).map(cleanTag).filter(Boolean))];
    const taken = this.taken();
    await this.ensureDir(PROD_DIR);
    const title = this.unique(PROD_DIR, `${safeName(naam).slice(0, 80) || 'product'}.md`, taken).replace(/\.md$/, '');
    let img = null, body = '';
    if (file) {
      const { data, ext } = await shrink(file);
      const name = this.unique(PROD_DIR, `${title}.${ext}`, taken);
      img = await this.app.vault.createBinary(normalizePath(`${PROD_DIR}/${name}`), data);
      body = `![[${name}]]`;
    }
    // zelfde velden en volgorde als het productformulier van de visualisator
    const L = ['type: product', 'tags:', ...tags.map(t => `  - ${yamlVal(t)}`)];
    for (const [k, v] of Object.entries({ merk, grootte, prijs, winkel })) if (String(v).trim()) L.push(`${k}: ${yamlVal(String(v).trim())}`);
    body = [body, notitie.trim()].filter(Boolean).join('\n\n');
    const md = await this.app.vault.create(normalizePath(`${PROD_DIR}/${title}.md`), `---\n${L.join('\n')}\n---\n\n${body}${body ? '\n' : ''}`);
    return { file: md, title, tags, img, merk: merk.trim(), grootte: grootte.trim(), prijs: prijs.trim(), winkel: winkel.trim() };
  }
  // een schets wordt een idee: afbeelding + notitie in Ideeën, het bord zelf in Ideeën/borden (zie BORD_PHONE_DIR)
  async createIdea({ naam, lijnen, objs, datum }) {
    const taken = this.taken(); datum = datum || isoDay(Date.now());
    const b = { id: 'b' + Date.now().toString(36) + oid().slice(0, 4), naam: naam.trim(), created: Date.now(), updated: Date.now(), objs };
    const cv = await boardCanvas(objs, 1800);
    b.export = cv.geo;
    b.thumb = (await boardCanvas(objs, 160, 20)).toDataURL('image/jpeg', .75);
    const png = await new Promise(r => cv.toBlob(r, 'image/png'));
    await this.ensureDir(IDEA_DIR);
    const base = safeName(naam.trim()).slice(0, 80) || `Idee ${datum}`;
    const pngName = this.unique(IDEA_DIR, `${base}.png`, taken);
    await this.app.vault.createBinary(normalizePath(`${IDEA_DIR}/${pngName}`), await png.arrayBuffer());
    const texts = objs.filter(o => o.t === 'text').map(o => o.text.trim()).filter(Boolean).join('\n\n');
    const note = this.unique(IDEA_DIR, `${base}.md`, taken);
    const path = normalizePath(`${IDEA_DIR}/${note}`);
    await this.app.vault.create(path, buildNote({ datum, lijnen, type: 'idee', tags: ['idee'], inbox: true, bord: b.id }, [`![[${pngName}]]`, texts].filter(Boolean).join('\n\n') + '\n'));
    await this.ensureDir(BORD_PHONE_DIR);
    await this.app.vault.adapter.write(normalizePath(`${BORD_PHONE_DIR}/${b.id}.json`), JSON.stringify(b));
    return path;
  }
  // gekozen producten en vraagtekens die nog bij een gekozen tag horen (tag uitgezet = product eruit)
  keepProducts(tags, prods, onb, products) {
    const byTitle = new Map(products.map(p => [p.title.toLowerCase(), p]));
    const keep = prods.filter(t => { const p = byTitle.get(t.toLowerCase()); return !p || p.tags.some(x => tags.includes(x)); });
    return { producten: [...new Set(keep)], onbekend: [...new Set(onb.filter(t => tags.includes(t)))] };
  }
  async createItem({ files, titel, tekst, datum, lijnen, tags, idee, producten = [], onbekend = [] }, taken) {
    const d = new Date(), two = n => String(n).padStart(2, '0');
    const stamp = `${isoDay(d).replace(/-/g, '')}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
    const names = [];
    for (const [i, f] of files.entries()) names.push(await this.saveMedia(f, taken, stamp + (i ? `-${i + 1}` : '')));
    const dir = idee ? IDEA_DIR : NOTE_DIR;
    await this.ensureDir(dir);
    const words = tekst.trim().split(/\s+/).slice(0, 7).join(' ');
    const base = safeName(titel.trim() || words || (names[0] || '').replace(/\.[^.]+$/, '') || `item ${datum || isoDay(Date.now())}`).slice(0, 80);
    const note = this.unique(dir, `${base || 'item'}.md`, taken);
    const tagList = [...new Set([...(idee ? ['idee'] : []), ...tags])];
    const inbox = !lijnen.length || (!idee && !tagList.length) || !tekst.trim() || !datum;
    const body = [names.map(n => `![[${n}]]`).join('\n'), tekst.trim()].filter(Boolean).join('\n\n') + '\n';
    const path = normalizePath(`${dir}/${note}`);
    await this.app.vault.create(path, buildNote({ datum, lijnen, type: idee ? 'idee' : '', tags: tagList, inbox, producten, onbekend }, body));
    return path;
  }
  async updateItem(file, { datum, lijnen, tags, producten, onbekend }) {
    await this.app.fileManager.processFrontMatter(file, fm => {
      if (datum) fm.datum = datum;
      fm.project = lijnen.length > 1 ? lijnen : (lijnen[0] || '');
      if ('lijn' in fm) delete fm.lijn;
      fm.tags = tags;
      if ('tag' in fm) delete fm.tag;
      if (producten.length) fm.producten = producten.map(t => `[[${t}]]`); else delete fm.producten;
      if (onbekend.length) fm.product_onbekend = onbekend; else delete fm.product_onbekend;
    });
  }
  // alles wat in de Stroom kan staan: items met een project (of die aan iets hangen) en de projectpagina's
  stroom(skip) {
    const mc = this.app.metadataCache, items = [], pages = new Map(), last = v => linkTitle(v).split('/').pop();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path === skip || /^(Sjablonen|Producten|\.)/.test(f.path)) continue;
      const fc = mc.getFileCache(f) || {}, fm = fc.frontmatter; if (!fm) continue;
      if (/^(nee|false)$/i.test(String(fm.archief ?? '').trim())) continue;
      const type = String(fm.type ?? '').toLowerCase().trim();
      if (type === 'project' || type === 'lijn') { pages.set(f.basename.toLowerCase(), { komtUit: last(arr(fm.komt_uit ?? fm['komt uit'])[0]), kleur: String(fm.kleur ?? fm.color ?? '').trim() }); continue; }
      // mijlpalen, producten en wat nog in Te Doen staat horen niet in de Stroom
      // zoals de visualisator: alleen als er ook nog iets ontbreekt (een compleet item met inbox: ja staat er gewoon in)
      if (type === 'mijlpaal' || type === 'product' || (this.todo ? this.todo.has(f.path) : /^(ja|true|yes)$/i.test(String(fm.inbox ?? '').trim()))) continue;
      const lijnen = arr(fm.project ?? fm.projecten ?? fm.lijn ?? fm.lijnen).map(linkTitle).filter(Boolean), aan = last(arr(fm.aan)[0]);
      if (!lijnen.length && !aan) continue;
      let datum = String(fm.datum ?? fm.date ?? '').slice(0, 10); if (!/^\d{4}-\d\d-\d\d$/.test(datum)) datum = isoDay(f.stat.mtime);
      const vo = parseFloat(fm.volgorde);
      items.push({ path: f.path, title: f.basename, datum, volgorde: Number.isFinite(vo) ? vo : null, lijnen, idee: type === 'idee', aan, kant: String(fm.kant ?? '').toLowerCase().trim(), rang: String(fm.rang ?? '').toLowerCase().trim(), fc, verbanden: parseVb(fm.verbanden, fm.volgt_op ?? fm['volgt op'] ?? fm.volgtop) });
    }
    return { items, pages };
  }
  // de soorten verband (naam, kleur, stijl) zoals de visualisator ze bewaart
  async vbSoorten() {
    try { const j = JSON.parse(await this.app.vault.adapter.read('.archief/verbandsoorten.json')); if (j && Array.isArray(j.soorten) && j.soorten.length) return j.soorten; } catch (e) {}
    return VB_STD;
  }
  // de gekozen plek: op dezelfde dag de volgorde (1, 2, 3…) voor het item en zijn buren; in een project zetten = niet meer ergens aan hangen
  async applyPlek(plek, path, unhang) {
    const self = this.app.vault.getAbstractFileByPath(path); if (!self) return;
    for (const [k, q] of (plek.day || []).entries()) {
      const f = q ? this.app.vault.getAbstractFileByPath(q) : self; if (!f) continue;
      const fm0 = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      if (f !== self && parseFloat(fm0.volgorde) === k + 1) continue;
      await this.app.fileManager.processFrontMatter(f, fm => { fm.volgorde = k + 1; });
    }
    if (plek.hang) await this.app.fileManager.processFrontMatter(self, fm => { fm.aan = `[[${plek.hang.aan}]]`; fm.kant = plek.hang.kant; });
    else if (unhang) await this.app.fileManager.processFrontMatter(self, fm => { if ('aan' in fm || 'kant' in fm) { delete fm.aan; delete fm.kant; } });
  }
  sync() {
    const cmds = this.app.commands;
    if (cmds && cmds.commands && cmds.commands[SYNC_CMD]) { cmds.executeCommandById(SYNC_CMD); return true; }
    return false;
  }
};

/* ---------- het scherm ---------- */
class ArchiefView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.tab = 'aanvullen'; this.resetForm(); this.filter = 'tags'; this.zoek = ''; this.shown = PAGE; }
  getViewType() { return VIEW; }
  getDisplayText() { return 'Archief'; }
  getIcon() { return 'camera'; }
  async onOpen() { await this.render(); }
  async onClose() { clearInterval(this.klokTimer); this.clearPreviews(); this.closeSheet && this.closeSheet(); document.querySelectorAll('.am-crop').forEach(x => x.remove()); if (this.closeFull) { const f = this.closeFull; this.closeFull = null; f(); } }
  async show(tab) { if (tab === 'taggen') tab = 'archief'; if (tab === 'nieuw') tab = 'idee'; if (tab) { if (tab !== this.tab) this.shown = PAGE; this.tab = tab; } this.editing = null; await this.render(); }
  resetForm() {
    this.clearPreviews && this.clearPreviews();
    this.form = { files: [], previews: [], dates: [], titel: '', tekst: '', datum: isoDay(Date.now()), datumBron: 'vandaag', lijnen: [], tags: [], producten: [], onbekend: [], idee: false, los: true, busy: false };
  }
  // Obsidian op de telefoon heeft onderin een eigen knoppenbalk; de Opslaan-balk moet daarboven staan
  fitBottom() {
    const root = this.contentEl;
    const nav = [...document.querySelectorAll('.mobile-navbar, .mobile-toolbar')].find(el => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top < window.innerHeight && getComputedStyle(el).visibility !== 'hidden'; });
    // alleen Obsidians eigen balk (die verbergen we meestal); gokken naar andere zwevende dingen zette de knoppen soms halverwege het scherm
    let cover = nav ? Math.max(0, Math.round(window.innerHeight - nav.getBoundingClientRect().top)) : 0;
    cover = Math.min(cover, 160);
    root.style.setProperty('--am-bottom', cover + 'px');
    root.style.setProperty('--am-safe', cover ? '0px' : 'env(safe-area-inset-bottom)');
    if (!this.fitHooked) { this.fitHooked = true; this.registerDomEvent(window, 'resize', () => this.fitBottom()); }
  }
  clearPreviews() { if (this.form) for (const u of this.form.previews) URL.revokeObjectURL(u); }

  async render() {
    this.closeSheet && this.closeSheet();
    const data = await this.plugin.choices();
    if (this.tab === 'aanvullen' && !this.form.vullen && !this.editing) data.teDoen = await this.plugin.teDoen(data.items);
    this.data = data;
    const root = this.contentEl; root.empty ? root.empty() : (root.innerHTML = '');
    root.classList.add('am-root');
    this.fitBottom();
    // twee vakken: Inladen (met daaronder Idee, Foto en Logboek) en Archief
    const inl = this.tab !== 'archief';
    if (inl) this.sub = this.tab;
    root.append(h('div', { class: 'am-tabs' },
      h('button', { class: inl ? 'am-on' : '', onclick: () => this.show(inl ? this.tab : this.sub || 'aanvullen') }, 'Inladen'),
      h('button', { class: !inl ? 'am-on' : '', title: 'Nog eens tikken: de stroom', onclick: () => this.tab === 'archief' && !this.editing ? this.openStroom() : this.show('archief') }, 'Archief'),
      h('button', { class: 'am-upd', title: 'Bijwerken naar de nieuwste versie', onclick: () => this.plugin.update() }, '↻ ', h('small', {}, BUILD))));
    if (inl && !this.editing && !(this.tab === 'aanvullen' && this.form.vullen)) root.append(h('div', { class: 'am-subtabs' },
      ...[['aanvullen', 'Foto'], ['idee', 'Idee'], ['logboek', 'Logboek']].map(([k, l]) => h('button', { class: this.tab === k ? 'am-on' : '', onclick: () => this.tab !== k && this.show(k) }, l))));
    const body = h('div', { class: 'am-body' }); root.append(body);
    const again = () => { const y = this.contentEl.scrollTop; this.render().then(() => { this.contentEl.scrollTop = y; }); };
    if (this.tab === 'idee') this.renderIdea(body, again);
    else if (this.editing) this.renderEdit(body);
    else if (this.tab === 'aanvullen' && this.form.vullen) this.renderNew(body);
    else if (this.tab === 'aanvullen') this.renderAanvullen(body);
    else if (this.tab === 'logboek') this.renderLogboek(body, again);
    else this.renderArchief(body);
  }

  /* chips: options = lijst, sel = array (wordt aangepast) */
  chips(options, sel, onChange, onLong) {
    const wrap = h('div', { class: 'am-chips' });
    for (const o of options) {
      const b = h('button', { class: 'am-chip' + (sel.includes(o) ? ' am-on' : ''), onclick: () => {
        if (this.wasLong(b)) return;
        const i = sel.indexOf(o); if (i >= 0) sel.splice(i, 1); else sel.push(o);
        b.classList.toggle('am-on', sel.includes(o)); onChange && onChange();
      } }, o);
      if (onLong) this.longPress(b, () => onLong(o));
      wrap.append(b);
    }
    return wrap;
  }
  // lang indrukken (een halve seconde) opent een menu; de tik bij het loslaten telt dan niet
  longPress(el, fn) {
    let t = null, x0 = 0, y0 = 0;
    const stop = () => { clearTimeout(t); t = null; };
    el.addEventListener('pointerdown', e => {
      el.amLong = false; x0 = e.clientX; y0 = e.clientY; stop();
      t = setTimeout(() => { t = null; el.amLong = true; if (navigator.vibrate) navigator.vibrate(15); fn(); }, LONG_MS);
    });
    el.addEventListener('pointermove', e => { if (t && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) stop(); });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, stop);
    el.addEventListener('contextmenu', e => e.preventDefault());
    return el;
  }
  wasLong(el) { if (el.amLong) { el.amLong = false; return true; } return false; }
  // een menu dat van onderen omhoog komt
  sheet(title, onClose, clear, cls = '') {
    this.closeSheet && this.closeSheet();
    const box = h('div', { class: 'am-sheet ' + cls }), back = h('div', { class: 'am-sheet-back' + (clear ? ' am-clear' : '') + (cls.includes('am-strip') ? ' am-pass' : '') }, box);
    back.style.setProperty('--am-bottom', this.contentEl.style.getPropertyValue('--am-bottom') || '0px');
    let down = false;
    back.addEventListener('pointerdown', e => { down = e.target === back; });
    back.addEventListener('click', e => { if (down && e.target === back) close(); });
    const close = () => { if (!back.isConnected) return; back.remove(); if (this.closeSheet === close) this.closeSheet = null; onClose && onClose(); };
    this.closeSheet = close;
    document.body.append(back);
    const set = (...kids) => { box.replaceChildren(h('div', { class: 'am-sheet-title' }, title), ...kids.flat()); box.scrollTop = 0; };
    // iets doen, ondertussen 'bezig' tonen, daarna het menu dicht en het scherm opnieuw
    const busy = async (label, job, after) => {
      set(h('p', { class: 'am-hint' }, label));
      try { await job(); } catch (e) { console.error(e); new Notice('Dat lukte niet: ' + (e && e.message || e), 8000); }
      close(); after && after();
    };
    return { set, close, busy, box };
  }
  // tag: verplaatsen naar een andere groep, hernoemen, verwijderen
  async tagMenu(t, after) {
    const P = this.plugin, M = this.sheet('#' + t), n = P.tagFiles(t).length, cur = P.groupOf((await P.readGroepen()).groepen, t);
    const nn = `${n} notitie${n === 1 ? '' : 's'}`;
    const main = () => M.set(
      h('div', { class: 'am-group' }, h('span', {}, 'Verplaatsen naar groep'), h('div', { class: 'am-chips' }, TAG_GROUPS.map(([g, name]) =>
        h('button', { class: 'am-chip' + (g === cur ? ' am-on' : ''), onclick: () => g === cur ? M.close()
          : M.busy('Verplaatsen…', async () => { await P.moveTag(t, g); new Notice(`#${t} staat nu bij ${name}`); P.sync(); }, after) }, name)))),
      h('button', { class: 'am-menu-btn', onclick: rename }, '✎  Hernoemen'),
      h('button', { class: 'am-menu-btn am-danger', onclick: del }, '×  Verwijderen'),
      h('button', { class: 'am-menu-btn', onclick: () => M.close() }, 'Annuleren'));
    const rename = () => {
      const inp = h('input', { type: 'text', autocapitalize: 'none', enterkeyhint: 'done' }); inp.value = t;
      const go = () => {
        const nt = cleanTag(inp.value); if (!nt || nt === t) return M.close();
        const merge = this.data.groups.some(g => g.tags.includes(nt));
        M.busy('Hernoemen…', async () => { const k = await P.retag(t, nt); this.mapTag(t, nt); new Notice(`#${t} heet nu #${nt}${merge ? ' (samengevoegd)' : ''}, in ${k} notitie${k === 1 ? '' : 's'}`); P.sync(); }, after);
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      M.set(h('p', { class: 'am-hint' }, `Wordt overal aangepast: ${nn} en de taggroepen. Bestaat de nieuwe naam al, dan worden ze samengevoegd.`), inp,
        h('button', { class: 'am-menu-btn am-primary', onclick: go }, 'Hernoemen'), h('button', { class: 'am-menu-btn', onclick: main }, 'Terug'));
      setTimeout(() => inp.focus(), 50);
    };
    const del = () => M.set(h('p', { class: 'am-hint' }, `#${t} weghalen bij ${nn}? De items zelf blijven gewoon staan.`),
      h('button', { class: 'am-menu-btn am-danger', onclick: () => M.busy('Verwijderen…', async () => { const k = await P.retag(t, null); this.mapTag(t, null); new Notice(`#${t} weggehaald bij ${k} notitie${k === 1 ? '' : 's'}`); P.sync(); }, after) }, 'Ja, verwijderen'),
      h('button', { class: 'am-menu-btn', onclick: main }, 'Terug'));
    main();
  }
  // product: hernoemen, of info en foto aanpassen
  productMenu(p, after) {
    const P = this.plugin, M = this.sheet(p.title);
    const main = () => M.set(
      h('button', { class: 'am-menu-btn', onclick: rename }, '✎  Hernoemen'),
      h('button', { class: 'am-menu-btn', onclick: edit }, '⚙  Aanpassen (info en foto)'),
      h('button', { class: 'am-menu-btn', onclick: () => M.close() }, 'Annuleren'));
    const rename = () => {
      const inp = h('input', { type: 'text', enterkeyhint: 'done' }); inp.value = p.title;
      const go = () => { const v = inp.value.trim(); if (!v || v === p.title) return M.close(); M.busy('Hernoemen…', async () => { const nt = await P.renameProduct(p, v); this.mapProduct(p.title, nt); new Notice(`Heet nu ${nt}`); P.sync(); }, after); };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      M.set(h('p', { class: 'am-hint' }, 'Items die dit product gebruiken gaan mee.'), inp,
        h('button', { class: 'am-menu-btn am-primary', onclick: go }, 'Hernoemen'), h('button', { class: 'am-menu-btn', onclick: main }, 'Terug'));
      setTimeout(() => inp.focus(), 50);
    };
    const edit = async () => {
      const np = { naam: p.title, tags: [...p.tags], file: null, prev: '', img: p.img, merk: p.merk, grootte: p.grootte, prijs: p.prijs, winkel: p.winkel, notitie: await P.productNote(p) };
      const drop = () => { if (np.prev) URL.revokeObjectURL(np.prev); };
      const draw = () => M.set(this.productForm(np, draw),
        h('button', { class: 'am-menu-btn am-primary', onclick: () => {
          if (!np.naam.trim()) return new Notice('Geef het product een naam.');
          if (!np.tags.length) return new Notice('Kies minstens één tag.');
          M.busy('Opslaan…', async () => { const nt = await P.editProduct(p, np); drop(); this.mapProduct(p.title, nt); new Notice(`${nt} aangepast`); P.sync(); }, after);
        } }, 'Opslaan'),
        h('button', { class: 'am-menu-btn', onclick: () => { drop(); M.close(); } }, 'Annuleren'));
      draw();
    };
    main();
  }
  // het bord als plaatje: strak om wat erop staat (het lege bord eromheen telt niet mee), op volle scherpte.
  // Via het deelmenu van de telefoon (daar zit 'Bewaar afbeelding'); lukt dat niet, dan in het archief.
  async exportBoard(S) {
    const objs = S.objs.filter(o => !o.hide);
    if (!objs.length) return new Notice('Het bord is nog leeg.');
    const n = new Notice('Plaatje maken…', 0);
    try {
      const bs = objs.map(objBox), x0 = Math.min(...bs.map(b => b[0])), y0 = Math.min(...bs.map(b => b[1])), x1 = Math.max(...bs.map(b => b[2])), y1 = Math.max(...bs.map(b => b[3]));
      let res = 2; for (const o of objs) if (o.t === 'img') { try { res = Math.max(res, (await imgEl(o.src)).naturalWidth / o.w); } catch (e) {} }
      res = Math.min(res, 4000 / Math.max(1, x1 - x0, y1 - y0));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round((x1 - x0) * res)); c.height = Math.max(1, Math.round((y1 - y0) * res));
      const g = c.getContext('2d'); g.fillStyle = BORD_BG; g.fillRect(0, 0, c.width, c.height);
      g.setTransform(res, 0, 0, res, -x0 * res, -y0 * res);
      await paintBoard(g, objs);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const name = `idee-${isoDay(Date.now())}-${Date.now().toString(36).slice(-4)}.png`;
      const file = new File([blob], name, { type: 'image/png' });
      n.hide();
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
      } catch (e) { if (e && e.name === 'AbortError') return; }
      const dir = `${IDEA_DIR}/Export`; await this.plugin.ensureDir(IDEA_DIR); await this.plugin.ensureDir(dir);
      await this.app.vault.createBinary(normalizePath(`${dir}/${name}`), await blob.arrayBuffer());
      new Notice(`Opgeslagen in je archief: ${dir}/${name}`, 8000);
    } catch (e) { n.hide(); console.error(e); new Notice('Exporteren lukte niet: ' + (e && e.message || e), 8000); }
  }
  // dubbeltik met het handje: een dun strookje 'verwijderen?'
  deleteMenu(C, o) {
    const M = this.sheet('Verwijderen', () => C.refresh(), true, 'am-strip');
    M.set(h('div', { class: 'am-strip-panel' }, h('div', { class: 'am-strip-op' }, h('span', { class: 'am-strip-ask' }, 'Deze foto verwijderen?'),
      h('button', { class: 'am-strip-mini am-del', onclick: () => { C.push(); C.S.objs = C.S.objs.filter(x => x !== o); M.close(); } }, '× Verwijderen'),
      h('button', { class: 'am-strip-mini', onclick: () => { M.close(); this.photoMenu(C, o); } }, 'Nee'))));
  }
  // menu voor een foto op het bord (dubbeltik of via Lagen)
  photoMenu(C, o) {
    const { S } = C; let pushed = false; const once = () => { if (!pushed) { C.push(); pushed = true; } };
    // een dunne strook onderaan die opzij scrolt; dekking en blend klappen erboven open
    const M = this.sheet('Foto', () => C.refresh(), true, 'am-strip');
    const bake = async () => { await bakeImg(o); C.draw(); };
    const panel = h('div', { class: 'am-strip-panel' });
    const opPanel = () => {
      const pct = Math.round((o.op == null ? 1 : o.op) * 100), val = h('span', { class: 'am-op-val' }, pct + '%');
      const range = h('input', { type: 'range', min: 5, max: 100, step: 1, class: 'am-range' }); range.value = pct;
      range.addEventListener('input', () => { once(); o.op = range.value / 100; if (o.op >= 1) delete o.op; val.textContent = range.value + '%'; C.draw(); });
      return h('div', { class: 'am-strip-op' }, h('span', {}, 'Dekking'), range, val);
    };
    const blendPanel = () => h('div', { class: 'am-strip-chips' }, BLENDS.map(([k, n]) => h('button', { class: 'am-chip' + ((o.blend || 'normal') === k ? ' am-on' : ''), onclick: e => {
      once(); if (k === 'normal') delete o.blend; else o.blend = k;
      for (const b of e.currentTarget.parentElement.children) b.classList.toggle('am-on', b === e.currentTarget);
      C.draw();
    } }, n)));
    const toggle = (k, make) => e => {
      const btn = e.currentTarget, open = panel.dataset.k !== k;
      for (const b of M.box.querySelectorAll('.am-strip-btn')) b.classList.remove('am-on');
      panel.dataset.k = open ? k : ''; panel.replaceChildren(...(open ? [make()] : []));
      btn.classList.toggle('am-on', open);
    };
    // een stap naar voren (+1) of naar achteren (-1) tussen de foto's
    const order = d => { const imgs = S.objs.filter(x => x.t === 'img'), other = imgs[imgs.indexOf(o) + d]; if (!other) return; C.push(); const a = S.objs.indexOf(o), b = S.objs.indexOf(other); S.objs[a] = other; S.objs[b] = o; C.draw(); };
    // nudge: 1 pixel, of met raster naar de volgende rasterlijn; ingedrukt houden herhaalt
    const nudgeBy = (dx, dy) => {
      once(); const n = S.grid, items = o.grp ? S.objs.filter(x => x.grp === o.grp) : [o];
      const step = (v, d) => !d ? 0 : !n ? d : (d > 0 ? Math.floor(v / n + 1e-6) * n + n : Math.ceil(v / n - 1e-6) * n - n) - v;
      const mx = step(o.x, dx), my = step(o.y, dy);
      for (const x of items) { x.x += mx; x.y += my; }
      C.draw();
    };
    // pas bij loslaten (of na even vasthouden) schuiven: wie over de strook scrolt, nudget niet per ongeluk
    const nudge = (ic, dx, dy) => {
      let tm = null, x0 = 0, y0 = 0, live = false, done = false; const stop = () => { clearTimeout(tm); clearInterval(tm); tm = null; live = false; };
      return h('button', { class: 'am-strip-btn am-nudge', 'aria-label': 'nudge',
        onpointerdown: e => { stop(); x0 = e.clientX; y0 = e.clientY; live = true; done = false; tm = setTimeout(() => { done = true; nudgeBy(dx, dy); tm = setInterval(() => nudgeBy(dx, dy), 70); }, 400); },
        onpointermove: e => { if (live && Math.hypot(e.clientX - x0, e.clientY - y0) > 8) { done = true; stop(); } },
        onpointerup: () => { if (live && !done) nudgeBy(dx, dy); stop(); },
        onpointerleave: () => { done = true; stop(); }, onpointercancel: () => { done = true; stop(); } }, h('span', { class: 'am-strip-ic' }, ic));
    };
    const it = (ic, label, fn, cls = '') => h('button', { class: 'am-strip-btn ' + cls, onclick: fn }, h('span', { class: 'am-strip-ic' }, ic), h('span', {}, label));
    const grp = (name, ...items) => h('div', { class: 'am-strip-grp' }, h('div', { class: 'am-strip-lbl' }, name), h('div', { class: 'am-strip-row' }, items.filter(Boolean)));
    M.set(panel, h('div', { class: 'am-strip-main' }, h('div', { class: 'am-strip-scroll' },
      grp('Vorm',
        it('⬚', 'Bijsnijden', () => { M.close(); this.cropImage(o, () => C.push(), () => C.refresh(), () => this.photoMenu(C, o)); }),
        it('✂', 'Uitknippen', () => { M.close(); this.cutOut(C, o); }),
        it('↻', 'Draai 90°', async () => { C.push(); const e = ensureEdit(o); e.rot = (((e.rot || 0) + 90) % 360); await bake(); }),
        it('⇋', 'Spiegel', async () => { C.push(); const e = ensureEdit(o); e.fx = !e.fx; await bake(); }),
        it('⇅', 'Spiegel', async () => { C.push(); const e = ensureEdit(o); e.fy = !e.fy; await bake(); })),
      grp(C.S.grid ? `Nudge · ${C.S.grid}` : 'Nudge · 1 px', nudge('←', -1, 0), nudge('↑', 0, -1), nudge('↓', 0, 1), nudge('→', 1, 0)),
      grp('Kleur',
        it('☀', 'Aanpassen', () => this.adjustMenu(C, o)),
        it('◐', 'Looks', () => this.looksMenu(C, o)),
        o.orig ? it('⟲', 'Origineel', async () => { C.push(); o.edit = {}; await bake(); M.close(); }) : null),
      grp('Laag',
        it('◑', 'Dekking', toggle('op', opPanel)),
        it('◧', 'Blend', toggle('blend', blendPanel)),
        it('⬆', 'Naar voren', () => order(1)),
        it('⬇', 'Naar achter', () => order(-1)),
        it('⧉', 'Dupliceer', () => { C.push(); const c = cloneObj(o); c.id = oid(); delete c.grp; c.x += 24; c.y += 24; S.objs.splice(S.objs.indexOf(o) + 1, 0, c); M.close(); })),
      grp('',
        it('×', 'Weg', () => { C.push(); S.objs = S.objs.filter(x => x !== o); M.close(); }, 'am-danger'))),
      h('button', { class: 'am-strip-done', title: 'Klaar', onclick: () => M.close() }, h('span', { class: 'am-strip-ic' }, '✓'), h('span', {}, 'Klaar'))));
  }
  // schuifjes: belichting, contrast, hooglichten, schaduwen, verzadiging, warmte
  adjustMenu(C, o) {
    C.push(); const e = ensureEdit(o); e.adj = e.adj || {}; const before = JSON.stringify(e.adj);
    // bij sluiten altijd de volle foto opbouwen (tijdens schuiven is het een snelle, kleinere voorvertoning)
    const M = this.sheet('Aanpassen', async () => { if (JSON.stringify(e.adj) === before) C.S.undo.pop(); await idle(); await bakeImg(o); C.refresh(); }, true, 'am-strip');
    let busy = null, again = false, wantFull = false;
    const idle = async () => { while (busy) await busy; };
    const live = async full => {
      wantFull = wantFull || full;
      if (busy) { again = true; return; }
      const f = wantFull; wantFull = false;
      busy = bakeImg(o, !f).then(() => C.draw()); await busy; busy = null;
      if (again) { again = false; live(false); }
    };
    let cur = ADJ[0][0];
    const v = h('span', { class: 'am-op-val' }), r = h('input', { type: 'range', min: -100, max: 100, step: 1, class: 'am-range' });
    const chips = ADJ.map(([k, n]) => h('button', { class: 'am-chip', onclick: () => pick(k) }, n));
    // een stipje bij wat al veranderd is
    const mark = () => ADJ.forEach(([k, n], i) => { chips[i].classList.toggle('am-on', k === cur); chips[i].textContent = n + (e.adj[k] ? ' •' : ''); });
    const pick = k => { cur = k; r.value = e.adj[k] || 0; v.textContent = String(e.adj[k] || 0); mark(); };
    r.addEventListener('input', () => { e.adj[cur] = +r.value; if (!e.adj[cur]) delete e.adj[cur]; v.textContent = r.value; mark(); live(false); });
    r.addEventListener('change', () => live(true));
    M.set(h('div', { class: 'am-strip-panel' }, h('div', { class: 'am-strip-chips' }, chips)),
      h('div', { class: 'am-strip-panel' }, h('div', { class: 'am-strip-op' }, r, v,
        h('button', { class: 'am-strip-mini', title: 'Alles op 0', onclick: () => { e.adj = {}; pick(cur); live(true); } }, '0'),
        h('button', { class: 'am-strip-mini am-primary', title: 'Klaar', onclick: () => { M.close(); this.photoMenu(C, o); } }, '✓'))));
    pick(cur);
  }
  // kant-en-klare looks; ze tellen op bij je eigen aanpassingen
  looksMenu(C, o) {
    C.push(); const e = ensureEdit(o), before = e.look || '';
    const M = this.sheet('Looks', () => { if ((e.look || '') === before) C.S.undo.pop(); C.refresh(); }, true, 'am-strip');
    const chips = h('div', { class: 'am-chips' }, LOOKS.map(([k, n]) => h('button', { class: 'am-chip' + ((e.look || '') === k ? ' am-on' : ''), onclick: async ev => {
      if (k) e.look = k; else delete e.look;
      for (const b of ev.currentTarget.parentElement.children) b.classList.toggle('am-on', b === ev.currentTarget);
      await bakeImg(o); C.draw();
    } }, n)));
    chips.className = 'am-strip-chips';
    M.set(h('div', { class: 'am-strip-panel' }, h('div', { class: 'am-strip-op' }, chips, h('button', { class: 'am-strip-mini am-primary', title: 'Klaar', onclick: () => { M.close(); this.photoMenu(C, o); } }, '✓'))));
  }
  // uitknippen: met een kwast delen wegvegen of terughalen (het masker), met twee vingers zoomen
  async cutOut(C, o) {
    const e = ensureEdit(o), im = await imgEl(o.orig), W = im.naturalWidth, H = im.naturalHeight;
    // de foto met aanpassingen, nog zonder masker en zonder draaiing
    const base = document.createElement('canvas'); base.width = W; base.height = H; const bg = base.getContext('2d'); bg.drawImage(im, 0, 0);
    if (hasAdj(e)) { const id = bg.getImageData(0, 0, W, H); adjustPixels(id.data, e.adj || {}, e.look); bg.putImageData(id, 0, 0); }
    const mask = document.createElement('canvas'); mask.width = W; mask.height = H; const mg = mask.getContext('2d');
    if (e.mask) mg.drawImage(await imgEl(e.mask), 0, 0, W, H); else { mg.fillStyle = '#fff'; mg.fillRect(0, 0, W, H); }
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; const tg = tmp.getContext('2d');
    const T = { wis: true, size: 40, zacht: true, feather: 50 };
    const hist = [];
    const save = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(mask, 0, 0); hist.push(c); if (hist.length > 12) hist.shift(); };
    const back = () => { const c = hist.pop(); if (!c) return false; mg.save(); mg.globalCompositeOperation = 'copy'; mg.drawImage(c, 0, 0); mg.restore(); paint(); return true; };
    const cv = h('canvas', { class: 'am-cut-cv' }), wrap = h('div', { class: 'am-full-cv' }, cv), opts = h('div', { class: 'am-cut-opts' });
    const done = h('button', { class: 'am-menu-btn am-primary' }, 'Klaar');
    const root = h('div', { class: 'am-full am-cut' }, opts, wrap, h('div', { class: 'am-crop-bar' }, h('button', { class: 'am-menu-btn', onclick: () => { root.remove(); this.photoMenu(C, o); } }, 'Annuleren'), done));
    document.body.append(root);
    const g = cv.getContext('2d'); let SW = 0, SH = 0, v = { x: 0, y: 0, k: 1 };
    const size = () => { const r = window.devicePixelRatio || 1; SW = wrap.clientWidth; SH = wrap.clientHeight; cv.style.width = SW + 'px'; cv.style.height = SH + 'px'; cv.width = Math.round(SW * r); cv.height = Math.round(SH * r); };
    const fitV = () => { const k = Math.min((SW - 24) / W, (SH - 24) / H); v = { k, x: (SW - W * k) / 2, y: (SH - H * k) / 2 }; };
    const paint = () => {
      tg.globalCompositeOperation = 'source-over'; tg.clearRect(0, 0, W, H); tg.drawImage(base, 0, 0);
      tg.globalCompositeOperation = 'destination-in'; tg.drawImage(mask, 0, 0);
      const r = window.devicePixelRatio || 1;
      g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, cv.width, cv.height);
      g.setTransform(r * v.k, 0, 0, r * v.k, r * v.x, r * v.y);
      // dambord voor wat doorzichtig wordt
      const q = 16 / v.k; g.fillStyle = '#bbb'; g.fillRect(0, 0, W, H); g.fillStyle = '#eee';
      for (let y = 0, row = 0; y < H; y += q, row++) for (let x = (row % 2) * q; x < W; x += 2 * q) g.fillRect(x, y, Math.min(q, W - x), Math.min(q, H - y));
      g.globalAlpha = .22; g.drawImage(base, 0, 0); g.globalAlpha = 1; g.drawImage(tmp, 0, 0);
    };
    const drawOpts = () => opts.replaceChildren(
      h('div', { class: 'am-seg' },
        h('button', { class: T.wis ? 'am-on' : '', onclick: () => { T.wis = true; drawOpts(); } }, 'Wegvegen'),
        h('button', { class: T.wis ? '' : 'am-on', onclick: () => { T.wis = false; drawOpts(); } }, 'Terughalen'),
        h('button', { class: T.zacht ? 'am-on' : '', onclick: () => { T.zacht = !T.zacht; drawOpts(); } }, T.zacht ? 'Zachte rand' : 'Harde rand')),
      (() => { const r = h('input', { type: 'range', min: 6, max: 160, step: 1, class: 'am-range' }); r.value = T.size; r.addEventListener('input', () => { T.size = +r.value; }); return h('div', { class: 'am-group' }, h('span', {}, 'Grootte van de kwast'), r); })(),
      T.zacht ? (() => { const v = h('span', { class: 'am-op-val' }, T.feather + '%'), r = h('input', { type: 'range', min: 5, max: 100, step: 1, class: 'am-range' }); r.value = T.feather; r.addEventListener('input', () => { T.feather = +r.value; v.textContent = r.value + '%'; }); return h('div', { class: 'am-group' }, h('span', {}, 'Zachtheid van de rand ', v), r); })() : null,
      h('div', { class: 'am-seg' },
        h('button', { onclick: () => { if (!back()) new Notice('Niets meer om terug te zetten'); } }, '↶ Stap terug'),
        h('button', { onclick: () => { save(); mg.globalCompositeOperation = 'source-over'; mg.fillStyle = '#fff'; mg.fillRect(0, 0, W, H); paint(); } }, 'Alles terug'),
        h('button', { onclick: () => { save(); mg.globalCompositeOperation = 'xor'; mg.fillStyle = '#fff'; mg.fillRect(0, 0, W, H); mg.globalCompositeOperation = 'source-over'; paint(); } }, 'Omkeren')));
    drawOpts();
    requestAnimationFrame(() => { size(); fitV(); paint(); });
    const dab = (x, y) => {
      const rad = T.size / 2 / v.k;
      mg.globalCompositeOperation = T.wis ? 'destination-out' : 'source-over';
      // zachtheid = welk deel van de straal uitloopt naar niets (5% bijna hard, 100% helemaal zacht)
      if (T.zacht) { const f = T.feather / 100, gr = mg.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1 - f, 'rgba(255,255,255,1)'); gr.addColorStop(1 - f / 2, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); mg.fillStyle = gr; }
      else mg.fillStyle = '#fff';
      mg.beginPath(); mg.arc(x, y, rad, 0, Math.PI * 2); mg.fill();
    };
    const P = new Map(); let md = null, last = null, G = null;
    const sp = ev => { const b = cv.getBoundingClientRect(); return [ev.clientX - b.left, ev.clientY - b.top]; };
    const wp = p => [(p[0] - v.x) / v.k, (p[1] - v.y) / v.k];
    cv.addEventListener('pointerdown', ev => {
      ev.preventDefault(); try { cv.setPointerCapture(ev.pointerId); } catch (err) {}
      P.set(ev.pointerId, sp(ev));
      if (P.size === 2) { if (md === 'brush') back(); const [a, b] = [...P.values()]; G = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v: { ...v } }; md = 'pinch'; return; }
      if (P.size > 2) return;
      md = 'brush'; save(); last = wp(sp(ev)); dab(...last); paint();
    });
    cv.addEventListener('pointermove', ev => {
      if (!P.has(ev.pointerId)) return; P.set(ev.pointerId, sp(ev));
      if (md === 'pinch' && P.size >= 2) {
        const [a, b] = [...P.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const k = Math.min(20, Math.max(.05, G.v.k * d / G.d0)), wx = (G.m0[0] - G.v.x) / G.v.k, wy = (G.m0[1] - G.v.y) / G.v.k;
        v = { k, x: m[0] - wx * k, y: m[1] - wy * k }; paint();
      } else if (md === 'brush') {
        const p = wp(sp(ev)), step = Math.max(1, T.size / 6 / v.k), dist = Math.hypot(p[0] - last[0], p[1] - last[1]);
        for (let t = step; t <= dist; t += step) dab(last[0] + (p[0] - last[0]) * t / dist, last[1] + (p[1] - last[1]) * t / dist);
        if (dist >= step) last = p;
        paint();
      }
    });
    const end = ev => { P.delete(ev.pointerId); if (!P.size) md = null; else if (md === 'pinch') md = 'wait'; };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    done.addEventListener('click', async () => {
      C.push();
      // helemaal wit = geen masker
      const d = mg.getImageData(0, 0, W, H).data; let full = true; for (let i = 3; i < d.length; i += 16) if (d[i] < 255) { full = false; break; }
      if (full) delete e.mask; else e.mask = mask.toDataURL('image/png');
      await bakeImg(o); root.remove(); C.refresh(); this.photoMenu(C, o);
    });
  }
  // alle foto's als lagen: volgorde, zichtbaar, kiezen om samen te voegen of te groeperen
  layersMenu(C) {
    const { S } = C, sel = new Set();
    const M = this.sheet('Lagen', () => C.refresh(), true);
    const draw = () => {
      const imgs = S.objs.filter(o => o.t === 'img'), list = [...imgs].reverse();
      if (!list.length) return M.set(h('p', { class: 'am-hint' }, 'Nog geen foto\'s op het bord. Zet er een op met 📷.'), h('button', { class: 'am-menu-btn am-primary', onclick: () => M.close() }, 'Klaar'));
      // slepen aan ≡: de rij schuift mee, de andere rijen wijken uit; bij loslaten de nieuwe volgorde
      const grab = (o, ev) => {
        ev.preventDefault(); const row = ev.currentTarget.closest('.am-layer'), all = [...row.parentElement.children];
        const from = all.indexOf(row), hgt = row.getBoundingClientRect().height + 6, y0 = ev.clientY; let to = from;
        try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) {}
        row.classList.add('am-dragging');
        const mv = e => {
          const dy = e.clientY - y0; to = Math.max(0, Math.min(all.length - 1, Math.round(from + dy / hgt)));
          row.style.transform = `translateY(${dy}px)`;
          all.forEach((r, i) => { if (r !== row) r.style.transform = i > from && i <= to ? `translateY(${-hgt}px)` : i < from && i >= to ? `translateY(${hgt}px)` : ''; });
        };
        const up = () => {
          ev.target.removeEventListener('pointermove', mv); ev.target.removeEventListener('pointerup', up); ev.target.removeEventListener('pointercancel', up);
          if (to === from) { all.forEach(r => r.style.transform = ''); row.classList.remove('am-dragging'); return; }
          C.push(); const nl = [...list]; nl.splice(from, 1); nl.splice(to, 0, o);
          // de plekken van de foto's in S.objs blijven, alleen wie waar staat verandert (tekeningen en tekst blijven waar ze zijn)
          const slots = S.objs.map((x, i) => x.t === 'img' ? i : -1).filter(i => i >= 0), order = nl.reverse();
          slots.forEach((si, k) => { S.objs[si] = order[k]; });
          C.draw(); draw();
        };
        ev.target.addEventListener('pointermove', mv); ev.target.addEventListener('pointerup', up); ev.target.addEventListener('pointercancel', up);
      };
      const rows = list.map(o => h('div', { class: 'am-layer' + (sel.has(o) ? ' am-on-row' : '') },
        h('button', { class: 'am-lay-sel', 'aria-label': 'kiezen', onclick: () => { sel.has(o) ? sel.delete(o) : sel.add(o); draw(); } }, sel.has(o) ? '☑' : '☐'),
        h('img', { src: o.src, class: 'am-lay-img' + (o.hide ? ' am-dim' : ''), alt: '', onclick: () => { M.close(); this.photoMenu(C, o); } }),
        h('span', { class: 'am-lay-name' }, `Foto ${imgs.indexOf(o) + 1}`, o.grp ? h('small', {}, ' · groep') : null, o.blend ? h('small', {}, ' · ' + (BLENDS.find(b => b[0] === o.blend) || [, o.blend])[1]) : null),
        h('button', { class: 'am-lay-btn', 'aria-label': 'zichtbaar', onclick: () => { C.push(); o.hide = !o.hide; if (!o.hide) delete o.hide; C.draw(); draw(); } }, o.hide ? '◌' : '👁'),
        h('span', { class: 'am-lay-drag', 'aria-label': 'slepen', onpointerdown: ev => grab(o, ev) }, '≡')));
      const chosen = imgs.filter(o => sel.has(o)), grouped = chosen.some(o => o.grp);
      // glitchy 'slim samenvoegen': steeds een andere variant, de originelen blijven bewaard tot je Klaar zegt
      const glitch = async () => {
        const src = chosen.filter(o => !o.hide).length >= 2 ? chosen.filter(o => !o.hide) : chosen;
        C.push(); let m = null;
        const run = async () => {
          M.set(h('p', { class: 'am-hint' }, 'Slim samenvoegen… (gaat expres mis)'));
          await new Promise(r => setTimeout(r, 30));
          const n = await glitchMerge(src);
          if (m) S.objs[S.objs.indexOf(m)] = n;
          else { const at = Math.max(...src.map(o => S.objs.indexOf(o))); S.objs.splice(at + 1, 0, n); for (const o of src) o.hide = true; }
          m = n; C.draw();
          M.set(
            h('button', { class: 'am-menu-btn', onclick: run }, '↻  Andere variant'),
            h('button', { class: 'am-menu-btn', onclick: () => { S.objs = S.objs.filter(x => x !== m); for (const o of src) delete o.hide; sel.clear(); C.draw(); draw(); } }, 'Toch niet'),
            h('button', { class: 'am-menu-btn am-primary', onclick: () => { S.objs = S.objs.filter(x => !src.includes(x)); sel.clear(); C.draw(); draw(); } }, 'Houden'));
        };
        await run();
      };
      M.set(
        h('div', { class: 'am-layers' }, rows),
        h('div', { class: 'am-grid-acts' },
          h('button', { class: 'am-grid-btn', disabled: chosen.length < 2, onclick: async () => {
            C.push(); const vis = chosen.filter(o => !o.hide), m = await mergeImgs(vis.length ? vis : chosen);
            const at = Math.max(...chosen.map(o => S.objs.indexOf(o))); S.objs.splice(at + 1, 0, m); S.objs = S.objs.filter(o => !chosen.includes(o));
            sel.clear(); C.draw(); draw(); new Notice(`${chosen.length} foto's samengevoegd tot één`);
          } }, '⧈  Samenvoegen tot 1'),
          h('button', { class: 'am-grid-btn', disabled: chosen.length < 2, onclick: glitch }, '⚡  Slim samenvoegen'),
          h('button', { class: 'am-grid-btn', disabled: chosen.length < 2, onclick: () => { C.push(); const g = oid(); for (const o of chosen) o.grp = g; sel.clear(); draw(); new Notice('Gegroepeerd: ze schuiven nu samen'); } }, '⛓  Groeperen'),
          h('button', { class: 'am-grid-btn', disabled: !grouped, onclick: () => { C.push(); for (const o of chosen) delete o.grp; sel.clear(); draw(); } }, '✂  Groep los'),
          h('button', { class: 'am-grid-btn', disabled: !chosen.length, onclick: () => { C.push(); for (const o of chosen) { const c = cloneObj(o); c.id = oid(); delete c.grp; S.objs.splice(S.objs.indexOf(o) + 1, 0, c); } sel.clear(); C.draw(); draw(); new Notice(chosen.length === 1 ? 'Gedupliceerd, precies op dezelfde plek' : `${chosen.length} lagen gedupliceerd, op dezelfde plek`); } }, '⧉  Dupliceren'),
          h('button', { class: 'am-grid-btn am-danger', disabled: !chosen.length, onclick: () => { C.push(); S.objs = S.objs.filter(o => !sel.has(o)); sel.clear(); C.draw(); draw(); new Notice(`${chosen.length} foto${chosen.length === 1 ? '' : "'s"} verwijderd (↶ zet ze terug)`); } }, '×  Verwijderen')),
        h('button', { class: 'am-menu-btn am-primary', onclick: () => M.close() }, 'Klaar'));
    };
    draw();
  }
  // bijsnijden: sleep de hoeken of het vak; het bijgesneden deel wordt de nieuwe foto en blijft op dezelfde plek staan
  cropImage(o, beforeChange, done, after) {
    const r = { x: 0, y: 0, w: 1, h: 1 };
    const img = h('img', { class: 'am-crop-img', src: o.src, alt: '' });
    const box = h('div', { class: 'am-crop-box' }, ...['nw', 'ne', 'sw', 'se'].map(k => h('i', { class: 'am-crop-h am-' + k, 'data-h': k })));
    const stage = h('div', { class: 'am-crop-stage' }, h('div', { class: 'am-crop-in' }, img, box));
    const close = () => { root.remove(); after && after(); };
    const ok = h('button', { class: 'am-menu-btn am-primary' }, 'Bijsnijden');
    const root = h('div', { class: 'am-crop' }, stage, h('div', { class: 'am-crop-bar' }, h('button', { class: 'am-menu-btn', onclick: close }, 'Annuleren'), ok));
    document.body.append(root);
    const place = () => { box.style.left = r.x * 100 + '%'; box.style.top = r.y * 100 + '%'; box.style.width = r.w * 100 + '%'; box.style.height = r.h * 100 + '%'; };
    place();
    let drag = null;
    box.addEventListener('pointerdown', e => {
      e.preventDefault(); try { box.setPointerCapture(e.pointerId); } catch (err) {}
      drag = { k: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, r: { ...r } };
    });
    box.addEventListener('pointermove', e => {
      if (!drag) return;
      const b = img.getBoundingClientRect(), dx = (e.clientX - drag.x) / b.width, dy = (e.clientY - drag.y) / b.height, q = drag.r, MIN = .05;
      if (drag.k === 'move') { r.x = Math.min(1 - q.w, Math.max(0, q.x + dx)); r.y = Math.min(1 - q.h, Math.max(0, q.y + dy)); }
      else {
        let x0 = q.x, y0 = q.y, x1 = q.x + q.w, y1 = q.y + q.h;
        if (drag.k.includes('w')) x0 = Math.min(x1 - MIN, Math.max(0, x0 + dx)); else x1 = Math.max(x0 + MIN, Math.min(1, x1 + dx));
        if (drag.k.includes('n')) y0 = Math.min(y1 - MIN, Math.max(0, y0 + dy)); else y1 = Math.max(y0 + MIN, Math.min(1, y1 + dy));
        Object.assign(r, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
      place();
    });
    const stop = () => { drag = null; };
    box.addEventListener('pointerup', stop); box.addEventListener('pointercancel', stop);
    ok.addEventListener('click', async () => {
      if (r.w > .995 && r.h > .995) return close();
      try {
        const im = await imgEl(o.src), W = im.naturalWidth, H = im.naturalHeight;
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(W * r.w)); c.height = Math.max(1, Math.round(H * r.h));
        c.getContext('2d').drawImage(im, W * r.x, H * r.y, W * r.w, H * r.h, 0, 0, c.width, c.height);
        const png = /^data:image\/png/.test(o.src);
        beforeChange();
        o.src = png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', .86);
        // het bijgesneden resultaat wordt het nieuwe origineel (aanpassingen en uitknippen zitten er dan in vast)
        delete o.orig; delete o.edit;
        o.x = Math.round(o.x + o.w * r.x); o.y = Math.round(o.y + o.h * r.y); o.w = Math.round(o.w * r.w); o.h = Math.round(o.h * r.h);
      } catch (e) { console.error(e); new Notice('Bijsnijden lukte niet.'); }
      close(); done();
    });
  }
  // wat nog niet is opgeslagen (nieuw item, item dat je aan het taggen bent) meenemen
  mapTag(t, nt) {
    for (const S of [this.form, this.editing]) if (S) {
      for (const k of ['tags', 'onbekend']) { const v = []; for (const x of S[k] || []) { const y = x === t ? nt : x; if (y && !v.includes(y)) v.push(y); } S[k] = v; }
      if (S.np) S.np.tags = [...new Set(S.np.tags.map(x => x === t ? nt : x).filter(Boolean))];
    }
  }
  mapProduct(old, nt) {
    for (const S of [this.form, this.editing]) if (S) S.producten = (S.producten || []).map(x => x.toLowerCase() === old.toLowerCase() ? nt : x);
  }
  // nieuwe waarde intikken (lijn of tag)
  adder(placeholder, onAdd) {
    const inp = h('input', { type: 'text', class: 'am-add', placeholder, enterkeyhint: 'done', autocapitalize: 'none' });
    // Enter: toevoegen en tonen. Wegtikken: wel onthouden, maar niet opnieuw tekenen (anders mist een tik op Opslaan)
    const go = quiet => { const v = inp.value.trim(); if (v) { inp.value = ''; onAdd(v, quiet); } };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(false); } });
    inp.addEventListener('blur', () => go(true));
    return inp;
  }
  lijnBlock(sel, rerender, C) {
    const opts = [...new Set([...sel, ...this.data.lijnen])];
    return h('div', { class: 'am-field' }, h('label', {}, 'Project'), this.chips(opts, sel),
      this.adder('+ nieuw project', (v, quiet) => { if (!sel.includes(v)) sel.push(v); if (!quiet) rerender(); }),
      C ? h('button', { class: 'am-plek-open', onclick: () => this.pickPlek(C, sel, rerender) }, '⤳  Plek kiezen in de stroom') : null,
      C ? this.plekLine(C, rerender) : null);
  }
  // de gekozen plek in de stroom, als regel onder de projecten (× haalt hem weg)
  plekLine(C, rerender) {
    const p = C.holder.plek; if (!p) return null;
    const where = p.nieuw ? 'nieuw project' : p.hang ? (p.hang.kant === 'rechts' ? `zijtak, rechts naast “${short(p.hang.aan)}”` : `zijtak, ${p.hang.kant} “${short(p.hang.aan)}”`) : p.a && p.b ? `tussen “${short(p.a.title)}” en “${short(p.b.title)}”` : p.a ? `na “${short(p.a.title)}”` : p.b ? `vóór “${short(p.b.title)}”` : 'op zijn plek in de tijd';
    return h('div', { class: 'am-plek-line' }, h('span', {}, `📍 ${p.lijn} · ${where} · ${fmtD(p.datum)}`),
      h('button', { class: 'am-plek-x', 'aria-label': 'plek weghalen', onclick: () => { C.holder.plek = null; rerender(); } }, '×'));
  }
  // de stroom op het hele scherm, met een HIER-pin om te slepen. Neerzetten volgt de regels van de visualisator:
  // in een project staat alles op datum; past de datum niet tussen de buren, dan kies je: datum aanpassen of
  // de datum houden (dan komt hij vanzelf op zijn plek in de tijd). Op dezelfde dag bepaalt de volgorde de plek
  // drag (mag weg): vanuit de stroom, het item zit al aan je vinger ({ cx, cy, v, title }); geeft { move, end } terug
  pickPlek(C, sel, rerender, drag) {
    const { items, pages } = this.plugin.stroom(C.skip), M = miniStroom(items, pages);
    if (!M.main.length) return new Notice('Er staan nog geen items in projecten.');
    const low = s => String(s).toLowerCase();
    const cv = h('canvas'), pin = h('div', { class: 'am-pin' }, 'HIER');
    // vanuit de stroom: de pin is het item zelf (zijn plaatje, anders zijn naam), zodat je ziet wat je verplaatst
    if (drag) { pin.classList.add('am-pin-item'); if (drag.idee) pin.classList.add('am-pin-idee'); pin.replaceChildren(drag.img ? h('img', { src: drag.img, alt: '' }) : h('span', {}, short(drag.title, 18))); }
    const wrap = h('div', { class: 'am-full-cv am-plek-cv' }, cv, pin);
    const info = h('div', { class: 'am-plek-info' }), acts = h('div', { class: 'am-plek-acts' });
    const close = () => { SP.stop(); root.remove(); window.removeEventListener('resize', onResize); };
    const root = h('div', { class: 'am-full am-plek' },
      h('div', { class: 'am-full-bar' },
        h('button', { class: 'am-tool am-close', title: 'Sluiten', onclick: close }, '✕'),
        h('span', { class: 'am-plek-title' }, drag ? `“${short(drag.title, 26)}” verplaatsen` : 'Sleep HIER naar de plek'),
        h('button', { class: 'am-plek-new', onclick: () => askNew() }, '+ Nieuw project'),
        h('button', { class: 'am-tool', title: 'Alles in beeld', onclick: () => { fitAll(); draw(); } }, '⤢')),
      wrap, h('div', { class: 'am-plek-bar' }, info, acts));
    (drag && drag.parent || document.body).append(root); // binnen de stroom als die het hele scherm vult
    const g = cv.getContext('2d'); let W = 0, H = 0, v = { x: 0, y: 0, k: 1 }, raf = 0;
    const soon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (root.isConnected) draw(); }); };
    // dezelfde tekening als de stroom zelf (en de visualisator)
    const SP = stroomPainter(this.app, M, it => this.stroomImg(it), soon, { vb: false });
    const size = () => { const r = SDPR(); W = wrap.clientWidth; H = wrap.clientHeight; cv.style.width = W + 'px'; cv.style.height = H + 'px'; cv.width = Math.round(W * r); cv.height = Math.round(H * r); };
    const onResize = () => { size(); draw(); };
    window.addEventListener('resize', onResize);
    // de plek wordt in de maten van miniStroom bepaald; op het scherm in die van de visualisator, in beide richtingen even groot
    const sx = x => v.x + x * S_FX * v.k, sy = y => v.y + y * S_FY * v.k, toW = (x, y) => [(x - v.x) / (S_FX * v.k), (y - v.y) / (S_FY * v.k)];
    const fitAll = () => { const k = Math.max(.03, Math.min(1, (W - 40) / (SP.WX + S_COL * 2.4), (H - 70) / (SP.HY + S_ROW))); v = { k, x: (W - SP.WX * k) / 2 + S_COL * .7 * k, y: 30 + (H - 30 - SP.HY * k) / 2 }; };
    // waar valt de pin: in de dichtstbijzijnde rij, tussen welke twee items
    const ns = r => r.side ? r.extra : r.nodes;
    // is het nieuwe item zelf een idee? (aanhangen mag alleen als één van de twee een idee is)
    const isIdee = C.holder === this.sketch || !!(C.holder.it && C.holder.it.idee);
    const sides = M.rows.filter(r => r.side && r.extra.length);
    const rootOf = r => { for (let k = 0; r.side && k < 50; k++) r = r.from.row; return r; };
    const gapX = (r, i) => { const a = ns(r)[i - 1], b = ns(r)[i]; return a && b ? (a.x + b.x) / 2 : a ? a.x + SCOL * .6 : b.x - SCOL * .6; };
    // boven of onder een item (met een idee), of boven/onder een idee: dezelfde vakjes als in de visualisator
    // met een vinger is dat lastig mikken: de vakjes zijn wat ruimer dan in de visualisator en het dichtstbijzijnde item wint
    const attAt = (mx, my) => {
      const X = mx * S_FX, Y = my * S_FY; let best = null, bd = 1e9;
      for (const n of SP.all) {
        if (!(isIdee || n.it.idee) || Math.abs(X - n.X) >= S_COL * .5) continue;
        const kant = Y < n.Y - S_CH + 6 && Y > n.Y - S_ROW / 2 - 14 ? 'boven' : Y > n.Y + S_CH - 6 && Y < n.Y + S_ROW / 2 + 14 ? 'onder' : null;
        const d = Math.hypot(X - n.X, Math.abs(Y - n.Y) - S_ROW / 3);
        if (kant && d < bd) { bd = d; best = attT(n, kant); }
      }
      return best;
    };
    const attT = (n, kant) => ({ r: n.row, side: true, att: true, anchor: n, kant, a: null, b: null, gx: n.x, gy: n.y + (kant === 'boven' ? -1 : 1) * SROW / 2 });
    const target = (mx, my) => {
      const A = attAt(mx, my); if (A) return A;
      // in een project, of in een zijtak van een idee (dan hangt hij eraan, net als in de visualisator)
      let r = M.main[0]; for (const q of M.main) if (Math.abs(q.y - my) < Math.abs(r.y - my)) r = q;
      const near = sides.filter(q => Math.abs(q.y - my) < Math.abs(r.y - my)).sort((p, q) => Math.abs(p.y - my) - Math.abs(q.y - my));
      for (const q of near) {
        let i = q.extra.findIndex(n => n.x >= mx); if (i < 0) i = q.extra.length;
        const a = q.extra[i - 1] || null, anchor = a || q.from;
        if (isIdee || anchor.it.idee) return { r: q, a, b: q.extra[i] || null, gx: gapX(q, i), side: true, anchor, kant: a ? 'rechts' : q.kant };
      }
      let i = r.nodes.findIndex(n => n.x >= mx); if (i < 0) i = r.nodes.length;
      return { r, a: r.nodes[i - 1] || null, b: r.nodes[i] || null, gx: gapX(r, i) };
    };
    // beginplek: de plek van eerder, anders in het gekozen project op de datum, anders aan het eind van de eerste rij
    const d0 = C.get(), p0 = C.holder.plek;
    let T;
    if (p0 && p0.hang) {
      const q = sides.find(q => q.extra.some(n => n.it.title === p0.hang.aan) || (q.from.it.title === p0.hang.aan && q.kant === p0.hang.kant)), n = q && q.extra.find(n => n.it.title === p0.hang.aan);
      if (q) T = target(n ? n.x + 1 : q.extra[0].x - 1, q.y);
      else if (p0.hang.kant !== 'rechts') { const a = SP.all.find(x => x.it.title === p0.hang.aan); if (a) T = attT(a, p0.hang.kant); }
    }
    if (!T) {
      // zonder gekozen project: het project waar het laatst iets in gebeurde
      const recent = M.main.reduce((x, q) => stroomKey(q.list[q.list.length - 1]) > stroomKey(x.list[x.list.length - 1]) ? q : x, M.main[0]);
      const r = M.main.find(q => p0 ? low(q.lijn) === low(p0.lijn) : sel.some(l => low(l) === low(q.lijn))) || recent;
      let i = p0 && p0.a ? r.nodes.findIndex(n => n.it.title === p0.a.title) + 1 : p0 && p0.b ? r.nodes.findIndex(n => n.it.title === p0.b.title) : r.nodes.filter(n => !d0 || n.it.datum <= d0).length;
      if (i < 0 || i > r.nodes.length) i = r.nodes.length;
      T = { r, a: r.nodes[i - 1] || null, b: r.nodes[i] || null, gx: gapX(r, i) };
    }
    let mk = { x: T.gx, y: T.gy ?? T.r.y };
    const rr = (x, y, w, hh, rad) => { g.beginPath(); g.moveTo(x + rad, y); g.arcTo(x + w, y, x + w, y + hh, rad); g.arcTo(x + w, y + hh, x, y + hh, rad); g.arcTo(x, y + hh, x, y, rad); g.arcTo(x, y, x + w, y, rad); g.closePath(); };
    const draw = () => {
      const pr = SDPR();
      g.setTransform(pr, 0, 0, pr, 0, 0); SP.paint(g, v, W, H, { hot: T && T.r });
      // waar hij komt: paars streepje in de rij
      if (T && T.att) {
        // het vakje boven of onder het anker, met een streepje ernaartoe
        const x = sx(T.gx), y = sy(T.gy), q = S_CARD * .4 * v.k, sg = T.kant === 'boven' ? -1 : 1, ay = sy(T.anchor.y) + sg * S_CH * v.k;
        g.strokeStyle = '#a58cff'; g.lineWidth = 2; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(x, ay); g.lineTo(x, y - sg * q); g.stroke();
        g.fillStyle = 'rgba(165,140,255,.18)'; g.beginPath(); g.rect(x - q, y - q, 2 * q, 2 * q); g.fill(); g.stroke(); g.setLineDash([]);
      } else if (T) { const x = sx(T.gx), y = sy(T.r.y), hh = Math.max(15, (S_CH + 10) * v.k); g.strokeStyle = '#a58cff'; g.lineWidth = 4; g.beginPath(); g.moveTo(x, y - hh); g.lineTo(x, y + hh); g.stroke(); }
      pin.style.left = sx(mk.x) + 'px'; pin.style.top = sy(mk.y) + 'px';
    };
    const btn = (label, fn, cls = '') => h('button', { class: 'am-menu-btn ' + cls, onclick: fn }, label);
    // de regels: past de datum tussen de buren? anders kiezen
    const describe = () => {
      lastKey = keyOf(T); if (newBox) { newBox.remove(); newBox = null; }
      const d = C.get();
      if (T.side) {
        const an = T.anchor.it, lo2 = an.datum, root = rootOf(T.r);
        info.replaceChildren(h('b', {}, root.lijn), ` · zijtak: ${T.kant === 'rechts' ? `rechts naast “${short(an.title)}”` : `${T.kant} “${short(an.title)}”`} (${fmtD(lo2)})`);
        // nooit links van waar hij aan hangt: dat is terug in de tijd
        if (d && (!lo2 || d >= lo2)) return acts.replaceChildren(btn(`Hier hangen · datum blijft ${fmtD(d)}`, () => done(d, true), 'am-primary'));
        return acts.replaceChildren(btn(`Hier hangen: datum wordt ${fmtD(lo2)}`, () => done(lo2, true), 'am-primary'));
      }
      const { r, a, b } = T, lo = a && a.it.datum, hi = b && b.it.datum;
      const where = a && b ? `tussen “${short(a.it.title)}” (${fmtD(lo)}) en “${short(b.it.title)}” (${fmtD(hi)})` : a ? `na “${short(a.it.title)}” (${fmtD(lo)}), aan het eind` : `vóór “${short(b.it.title)}” (${fmtD(hi)}), aan het begin`;
      info.replaceChildren(h('b', {}, r.lijn), ` · ${where}`);
      const fits = d && (!lo || d >= lo) && (!hi || d <= hi);
      if (fits) return acts.replaceChildren(btn(`Hier zetten · datum blijft ${fmtD(d)}`, () => done(d, true), 'am-primary'));
      const nd = lo || hi;
      acts.replaceChildren(btn(`Hierheen: datum wordt ${fmtD(nd)}`, () => done(nd, true), 'am-primary'),
        d ? btn(`In dit project, datum blijft ${fmtD(d)} (op zijn plek in de tijd)`, () => done(d, false)) : null);
    };
    const done = (d, exact) => {
      if (T.side) {
        const root = rootOf(T.r);
        C.holder.plek = { lijn: root.lijn, datum: d, hang: { aan: T.anchor.it.title, kant: T.kant }, a: null, b: null, day: null };
        if (!sel.some(l => low(l) === low(root.lijn))) { if (sel.length <= 1) sel.splice(0, sel.length, root.lijn); else sel.push(root.lijn); }
        C.set(d); close(); rerender(); return;
      }
      const { r, a, b } = T; let day = null;
      // zelfde dag als een buur: de volgorde op die dag (het nieuwe item = null)
      if (exact && ((a && a.it.datum === d) || (b && b.it.datum === d))) {
        const list = r.list.filter(o => o.datum === d), i = a && a.it.datum === d ? list.indexOf(a.it) + 1 : Math.max(0, list.indexOf(b.it));
        day = list.map(o => o.path); day.splice(i, 0, null);
      }
      C.holder.plek = { lijn: r.lijn, datum: d, a: exact && a ? { title: a.it.title } : null, b: exact && b ? { title: b.it.title } : null, day };
      if (!sel.some(l => low(l) === low(r.lijn))) { if (sel.length <= 1) sel.splice(0, sel.length, r.lijn); else sel.push(r.lijn); }
      C.set(d); close(); rerender();
    };
    // de knoppen onder alleen opnieuw maken als de plek verandert (niet bij elke beweging van je vinger)
    let lastKey = null, newBox = null;
    const keyOf = t => t ? [t.r.lijn, t.r.y, t.a && t.a.it.path, t.b && t.b.it.path, t.att, t.kant, t.anchor && t.anchor.it.path].join('|') : '';
    const describeSoon = () => { const k = keyOf(T); if (k !== lastKey) { lastKey = k; describe(); } };
    // in een nieuw project: het item begint een eigen rij (bestaat de naam al, dan in dat project op zijn plek in de tijd)
    const askNew = () => {
      const inp = h('input', { type: 'text', class: 'am-add am-plek-newname', placeholder: 'Naam van het nieuwe project', enterkeyhint: 'done' });
      const go = () => {
        let name = inp.value.trim(); if (!name) return inp.focus();
        const old = M.main.find(q => low(q.lijn) === low(name)) || { lijn: (this.data.lijnen || []).find(l => low(l) === low(name)) };
        if (old.lijn) name = old.lijn;
        const d = C.get() || isoDay(Date.now());
        C.holder.plek = { lijn: name, datum: d, a: null, b: null, day: null, nieuw: !old.lijn };
        if (sel.length <= 1) sel.splice(0, sel.length, name); else if (!sel.some(l => low(l) === low(name))) sel.push(name);
        C.set(d); close(); rerender();
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      // bovenin het scherm, zodat het toetsenbord er niet overheen valt
      if (newBox) newBox.remove();
      newBox = h('div', { class: 'am-plek-newbox' }, h('div', { class: 'am-plek-info' }, h('b', {}, 'Nieuw project'), ' · het item komt in een eigen, nieuwe rij'), inp,
        h('div', { class: 'am-plek-newbtns' }, btn('Terug', () => { newBox.remove(); newBox = null; }), btn('Maken', go, 'am-primary')));
      wrap.append(newBox);
      setTimeout(() => inp.focus(), 50);
    };
    // de pin slepen; vlak bij de rand schuift de stroom mee
    let grab = null;
    const grabAt = (cx, cy) => {
      // de plek ligt boven je vinger (het wolkje daar weer boven), zodat je vinger niet voor de plek zit
      grab = [0, 70]; pin.classList.add('am-pin-drag');
      const b = wrap.getBoundingClientRect(), [wx, wy] = toW(cx - b.left, cy - b.top - 70); mk = { x: wx, y: wy }; T = target(wx, wy); draw(); describe();
    };
    const moveTo = (cx, cy) => {
      if (!grab) return; const b = wrap.getBoundingClientRect(), px = cx - b.left, py = cy - b.top;
      if (px < 36) v.x += 10; else if (px > W - 36) v.x -= 10;
      if (py - grab[1] < 36) v.y += 8; else if (py > H - 20) v.y -= 8;
      const [wx, wy] = toW(px - grab[0], py - grab[1]); mk = { x: wx, y: wy }; T = target(wx, wy); soon(); describeSoon();
    };
    const drop = () => { if (!grab) return; grab = null; pin.classList.remove('am-pin-drag'); mk = { x: T.gx, y: T.gy ?? T.r.y }; draw(); describe(); };
    if (drag) { size(); v = { ...drag.v }; grabAt(drag.cx, drag.cy); }
    else requestAnimationFrame(() => { size(); const k = Math.min(.8, Math.max(.4, H / (S_ROW * 2.4))); v = { k, x: W / 2 - mk.x * S_FX * k, y: H / 2 - mk.y * S_FY * k }; draw(); describe(); });
    pin.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); try { pin.setPointerCapture(e.pointerId); } catch (err) {} grabAt(e.clientX, e.clientY); });
    pin.addEventListener('pointermove', e => moveTo(e.clientX, e.clientY));
    pin.addEventListener('pointerup', drop); pin.addEventListener('pointercancel', drop);
    // de stroom zelf: één vinger schuift (een tik zet de pin daar), twee vingers zoomen
    this.panZoom(cv, () => v, nv => { v = nv; soon(); }, (px, py) => { const [wx, wy] = toW(px, py); T = target(wx, wy); mk = { x: T.gx, y: T.gy ?? T.r.y }; const py2 = sy(mk.y), px2 = sx(mk.x); if (py2 < 60 || py2 > H - 20) v.y += H / 2 - py2; if (px2 < 20 || px2 > W - 20) v.x += W / 2 - px2; draw(); describe(); }, .03, 3);
    return drag ? { move: moveTo, end: drop } : null;
  }

  // de stroom op het hele scherm, om te bekijken. Liggend is er meer ruimte (Android draait vanzelf, op een iPhone draai je zelf).
  // Eén vinger schuift, twee vingers zoomen, tik op een bolletje voor het item
  // de eerste afbeelding van een stroom-item (zoals de visualisator)
  stroomImg(it) {
    const d = this.data.items.find(x => x.file.path === it.path); if (d && d.img) return d.img;
    const mc = this.app.metadataCache;
    for (const e of (it.fc && it.fc.embeds) || []) { const t = mc.getFirstLinkpathDest(e.link.split('|')[0].split('#')[0], it.path); if (t && IMG_EXT.test(t.path)) return t; }
    return null;
  }
  openStroom(keepV, selPath) {
    const { items, pages } = this.plugin.stroom(null), M = miniStroom(items, pages);
    if (!M.main.length) return new Notice('Er staan nog geen items in projecten.');
    // projectnamen en idee-titels aan/uit (onthouden op dit toestel)
    let T = { proj: true, idee: true }; try { T = { ...T, ...JSON.parse(localStorage.getItem('am-stroom-titels') || '{}') }; } catch (e) {}
    const tog = (key, label) => { const b = h('button', { class: 'am-tchip' + (T[key] ? ' am-on' : ''), title: label + ' aan/uit', onclick: () => { T[key] = !T[key]; b.classList.toggle('am-on', T[key]); try { localStorage.setItem('am-stroom-titels', JSON.stringify(T)); } catch (e) {} draw(); } }, label); return b; };
    const tProj = tog('proj', 'Projecten'), tIdee = tog('idee', 'Ideeën');
    const byPath = new Map(this.data.items.map(it => [it.file.path, it]));
    // ongedaan maken: vóór elke wijziging in de stroom wordt de tekst van de notities die veranderen onthouden;
    // terugdraaien zet die tekst terug. De stapel blijft staan als de stroom opnieuw getekend wordt.
    const U = this.sUndo || (this.sUndo = []);
    const snap = async paths => { const out = []; for (const p of new Set(paths.filter(Boolean))) { const f = this.app.vault.getAbstractFileByPath(p); if (f && f.extension === 'md') out.push({ path: p, text: await this.app.vault.read(f) }); } return out; };
    const remember = (label, files) => { if (!files.length) return; U.push({ label, files }); if (U.length > 30) U.shift(); undoBtn.disabled = false; };
    const reopen = async (keep, path) => { await new Promise(r => setTimeout(r, 700)); close(); this.data = await this.plugin.choices(); this.openStroom(keep, path); };
    const undoBtn = h('button', { class: 'am-tool am-undo', title: 'Ongedaan maken', disabled: !U.length, onclick: async () => {
      const u = U.pop(); if (!u) return; undoBtn.disabled = true;
      try {
        for (const x of u.files) { const f = this.app.vault.getAbstractFileByPath(x.path); if (f) await this.app.vault.modify(f, x.text); }
        new Notice('Teruggedraaid: ' + u.label); this.plugin.sync();
      } catch (e) { console.error(e); new Notice('Terugdraaien lukte niet: ' + (e && e.message || e), 8000); }
      await reopen({ ...v }, sel && sel.it.path);
    } }, '↶');
    const cv = h('canvas'), wrap = h('div', { class: 'am-full-cv' }, cv);
    const info = h('div', { class: 'am-plek-info' }, 'Tik op een item.'), acts = h('div', { class: 'am-plek-acts' });
    const close = () => {
      SP.stop(); root.remove(); window.removeEventListener('resize', onResize);
      try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (e) {}
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    };
    const root = h('div', { class: 'am-full am-plek am-stroom' },
      h('div', { class: 'am-full-bar' },
        h('button', { class: 'am-tool am-close', title: 'Sluiten', onclick: close }, '✕'),
        h('span', { class: 'am-plek-title' }, 'Stroom'),
        tProj, tIdee, undoBtn,
        h('button', { class: 'am-tool', title: 'Alles in beeld', onclick: () => { const o = v; fitAll(); const t = v; v = o; glideTo(t); } }, '⤢'),
        h('button', { class: 'am-tool', title: 'Naar het nieuwste', onclick: () => { const o = v; toEnd(); const t = v; v = o; glideTo(t); } }, '⇥')),
      wrap, h('div', { class: 'am-plek-bar' }, info, acts));
    document.body.append(root);
    // liggend als het toestel dat toestaat (alleen op het hele scherm)
    (async () => { try { if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' }); if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (e) {} })();
    const g = cv.getContext('2d'); let W = 0, H = 0, v = { x: 0, y: 0, k: 1 }, sel = null, raf = 0;
    const soon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (root.isConnected) draw(); }); };
    const SP = stroomPainter(this.app, M, it => this.stroomImg(it), soon);
    this.plugin.vbSoorten().then(s => { SP.setSoorten(s); soon(); });
    const size = () => { const r = SDPR(); W = wrap.clientWidth; H = wrap.clientHeight; cv.style.width = W + 'px'; cv.style.height = H + 'px'; cv.width = Math.round(W * r); cv.height = Math.round(H * r); };
    const onResize = () => { size(); draw(); };
    window.addEventListener('resize', onResize);
    const KMIN = .03, KMAX = 3;
    const fitAll = () => { const k = Math.max(KMIN, Math.min(1, (W - 40) / (SP.WX + S_COL * 2.4), (H - 50) / (SP.HY + S_ROW))); v = { k, x: (W - SP.WX * k) / 2 + S_COL * .7 * k, y: (H - SP.HY * k) / 2 }; };
    // het nieuwste item rechts in beeld, op de hoogte van zijn eigen rij
    const toEnd = () => { const k = Math.min(.9, Math.max(.45, H / (S_ROW * 2.6))), n = SP.all.reduce((p, q) => q.X > p.X ? q : p, SP.all[0]); v = { k, x: W - 40 - (n.X + S_CH) * k, y: H / 2 - n.Y * k }; };
    const draw = () => {
      const pr = SDPR(); g.setTransform(pr, 0, 0, pr, 0, 0); SP.paint(g, v, W, H, { sel, projT: T.proj, ideeT: T.idee });
      // verband leggen: een stippellijn van het item naar je vinger
      if (sel && link && link.to) {
        const x0 = v.x + sel.X * v.k, y0 = v.y + sel.Y * v.k, [x1, y1] = link.to, t = SP.hit(v, x1, y1);
        g.strokeStyle = '#a58cff'; g.lineWidth = 3; g.setLineDash([8, 6]); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#a58cff'; g.beginPath(); g.arc(x1, y1, 6, 0, 7); g.fill();
        if (t && t !== sel) { const S = t.S * v.k + 10; g.lineWidth = 3; g.strokeRect(v.x + t.X * v.k - S / 2, v.y + t.Y * v.k - S / 2, S, S); }
      }
      placeProds(); placeSel();
    };
    // zacht naar een nieuwe plek glijden (knoppen, item kiezen) in plaats van verspringen
    const glideTo = nv => animV(() => v, x => { v = x; soon(); }, nv);
    // een gekozen item groot in een paneel rechts (staand: onderin, half scherm), met de foto's, tekst en Openen
    const side = h('div', { class: 'am-stroom-side', hidden: true }), bar = root.querySelector('.am-plek-bar');
    wrap.append(side);
    const unpick = () => { sel = null; link = null; prodBox.replaceChildren(); side.hidden = true; bar.hidden = false; info.replaceChildren('Tik op een item.'); acts.replaceChildren(); draw(); };
    // boven het gekozen item: de producten die erbij horen (of een vraagteken per tag waar nog geen product bij gekozen is)
    const prodBox = h('div', { class: 'am-sprods', hidden: true }); wrap.append(prodBox);
    // het gekozen item scherp: de echte foto als afbeelding over de stroom (de stroom zelf tekent kleinere plaatjes, voor de snelheid)
    const selImg = h('img', { class: 'am-selimg', alt: '', decoding: 'async', hidden: true }); wrap.append(selImg);
    let selSrc = '';
    const placeSel = () => {
      const f = sel && sel.img;
      if (!f) { selImg.hidden = true; selSrc = ''; return; }
      const src = this.app.vault.getResourcePath(f);
      if (src !== selSrc) { selSrc = src; selImg.hidden = true; selImg.classList.toggle('am-selimg-rond', !!sel.it.idee); selImg.onload = () => { if (selSrc === src) { selImg.hidden = false; placeSel(); } }; selImg.src = src; return; }
      if (!selImg.complete || !selImg.naturalWidth) return;
      // net binnen de gekleurde rand van het kaartje
      const S = sel.S * v.k * 1.9 - 4; selImg.hidden = false;
      selImg.style.width = selImg.style.height = S + 'px';
      selImg.style.transform = `translate(${v.x + sel.X * v.k - S / 2}px, ${v.y + sel.Y * v.k - S / 2}px)`;
    };
    let link = null; // verband leggen: { to: [x, y] } zolang je een lijn trekt
    const placeProds = () => {
      if (!sel || !prodBox.childElementCount || link || !side.hidden) { prodBox.hidden = true; return; }
      prodBox.hidden = false;
      prodBox.style.transform = `translate(${Math.round(v.x + sel.X * v.k)}px, ${Math.round(v.y + sel.Y * v.k - sel.S * v.k * 1.9 / 2 - 10)}px) translate(-50%, -100%)`;
    };
    const lw = s => String(s).toLowerCase();
    const slotsOf = it => {
      const P = this.data.products || [], out = [], seen = new Set();
      for (const t of it.tags) {
        const ps = P.filter(p => p.tags.includes(t)); if (!ps.length) continue;
        const mine = ps.filter(p => it.producten.some(x => lw(x) === lw(p.title)));
        for (const p of mine) if (!seen.has(p)) { seen.add(p); out.push({ tag: t, p }); }
        if (!mine.length) out.push({ tag: t, p: null, unknown: it.onbekend.includes(t) });
      }
      return out;
    };
    const showProds = it => {
      const slots = it ? slotsOf(it) : [];
      prodBox.replaceChildren(...slots.map((s, i) => h('button', { class: 'am-sprod' + (s.p ? '' : s.unknown ? ' am-sprod-unk' : ' am-sprod-q'), style: `--d:${i * 60}ms`, onclick: () => prodSheet(it, s.tag) },
        s.p && s.p.img ? h('img', { src: this.app.vault.getResourcePath(s.p.img), alt: '' }) : h('span', { class: 'am-sprod-box' }, s.p ? short(s.p.title, 14) : '?'),
        h('small', {}, s.p ? short(s.p.title, 14) : s.tag))));
      prodBox.classList.remove('am-open'); placeProds(); requestAnimationFrame(() => requestAnimationFrame(() => prodBox.classList.add('am-open')));
    };
    // een sheet bovenop de stroom: binnen de stroom zelf (die vult soms het hele scherm, dan is de rest onzichtbaar)
    const topSheet = title => { const M = this.sheet(title), back = M.box.parentElement; back.style.zIndex = 80; root.append(back); return M; };
    // welk product (meer mag), of 'weet ik niet meer'; meteen bewaard
    const prodSheet = (it, tag) => {
      const M = topSheet(`Welk ${tag}? (meer dan één mag)`); let vooraf = snap([it.file.path]);
      const save = async () => {
        const f = this.app.vault.getAbstractFileByPath(it.file.path); if (!f) return;
        if (vooraf) { remember(`product bij “${short(it.file.basename, 20)}”`, await vooraf); vooraf = null; }
        await this.app.fileManager.processFrontMatter(f, fm => {
          if (it.producten.length) fm.producten = it.producten.map(t => `[[${t}]]`); else delete fm.producten;
          if (it.onbekend.length) fm.product_onbekend = it.onbekend; else delete fm.product_onbekend;
        });
        this.plugin.sync();
      };
      const fill = () => {
        const has = p => it.producten.some(x => lw(x) === lw(p.title)), unk = it.onbekend.includes(tag);
        M.set(...(this.data.products || []).filter(p => p.tags.includes(tag)).map(p => h('button', { class: 'am-menu-btn am-sprod-row' + (has(p) ? ' am-on' : ''), onclick: async () => {
            if (has(p)) it.producten = it.producten.filter(x => lw(x) !== lw(p.title)); else { it.producten = [...it.producten, p.title]; it.onbekend = it.onbekend.filter(x => x !== tag); }
            fill(); showProds(it); await save();
          } }, p.img ? h('img', { src: this.app.vault.getResourcePath(p.img), alt: '' }) : h('span', { class: 'am-sprod-ph' }), h('span', {}, (has(p) ? '✓ ' : '') + p.title))),
          h('button', { class: 'am-menu-btn' + (unk ? ' am-on' : ''), onclick: async () => {
            if (unk) it.onbekend = it.onbekend.filter(x => x !== tag);
            else { it.onbekend = [...it.onbekend, tag]; it.producten = it.producten.filter(x => !(this.data.products || []).some(p => p.tags.includes(tag) && lw(p.title) === lw(x))); }
            fill(); showProds(it); await save();
          } }, (unk ? '✓ ' : '') + `Weet ik niet meer welk ${tag}`),
          h('button', { class: 'am-menu-btn am-primary', onclick: () => M.close() }, 'Klaar'));
      };
      fill();
    };
    // verband: soort kiezen en in de notitie zetten ("[[titel]] | soort", zoals de visualisator)
    const vbSheet = async (a, b) => {
      const M = topSheet(`Verband: “${short(a.it.title, 18)}” → “${short(b.it.title, 18)}”`), soorten = await this.plugin.vbSoorten();
      const has = s => (a.it.verbanden || []).some(x => lw(x.to) === lw(b.it.title) && x.soort === s);
      const add = async soort => {
        soort = soort.trim().toLowerCase().replace(/[|\[\]"]/g, ''); if (!soort) return;
        if (has(soort)) return new Notice('Dat verband bestaat al.');
        M.close();
        const f = this.app.vault.getAbstractFileByPath(a.it.path); if (!f) return;
        try {
          const was = await snap([a.it.path]);
          await this.app.fileManager.processFrontMatter(f, fm => { fm.verbanden = [...arr(fm.verbanden).map(String), `[[${b.it.title}]] | ${soort}`]; });
          remember('verband gelegd', was);
          new Notice(`“${short(a.it.title, 20)}” ${soort} “${short(b.it.title, 20)}”`); this.plugin.sync();
        } catch (e) { console.error(e); return new Notice('Verband leggen lukte niet: ' + (e && e.message || e), 8000); }
        // even wachten tot Obsidian de notitie opnieuw gelezen heeft; dan de stroom opnieuw, met het item nog gekozen
        await reopen({ ...v }, a.it.path);
      };
      const nieuw = this.adder('+ nieuw soort verband', v2 => add(v2));
      M.set(...soorten.map(sk => h('button', { class: 'am-menu-btn am-vb-row', onclick: () => add(sk.naam) }, h('span', { class: 'am-vb-dot', style: `background:${sk.kleur}` }), (has(sk.naam) ? '✓ ' : '') + sk.naam)),
        nieuw, h('button', { class: 'am-menu-btn', onclick: () => M.close() }, 'Annuleren'));
    };
    // de verbanden van het gekozen item: tik er een aan om het soort te veranderen, de pijl om te draaien of het weg te halen
    const vbList = node => {
      const mine = SP.vbs.filter(x => x.a === node || x.b === node), M = topSheet(`Verbanden van “${short(node.it.title, 22)}”`);
      this.plugin.vbSoorten().then(soorten => {
        const kleur = s => (soorten.find(k => lw(k.naam) === lw(s)) || {}).kleur || '#9a9a9a';
        M.set(...mine.map(x => h('button', { class: 'am-menu-btn am-vb-row', onclick: () => vbEdit(x, node, soorten) }, h('span', { class: 'am-vb-dot', style: `background:${kleur(x.v.soort)}` }),
          h('span', {}, x.a === node ? `${x.v.soort} → ${short(x.b.it.title, 26)}` : `${short(x.a.it.title, 26)} → ${x.v.soort}`))),
          h('button', { class: 'am-menu-btn', onclick: () => M.close() }, 'Sluiten'));
      });
    };
    const vbEdit = (x, node, soorten) => {
      const a = x.a, b = x.b, M = topSheet(`“${short(a.it.title, 16)}” ${x.v.soort} “${short(b.it.title, 16)}”`);
      // is dit het verband naar b met dit soort? (een oud 'volgt op' telt als 'bouwt voort op')
      const is = raw => parseVb([raw]).some(o => lw(o.to) === lw(b.it.title) && o.soort === x.v.soort);
      const oud = raw => x.v.soort === VB_BASE && lw(linkTitle(raw).split('/').pop()) === lw(b.it.title);
      // haalt het verband uit de notitie van a; met 'nieuw' komt er een ander voor in de plaats (in a, of in b bij omdraaien)
      const change = async (label, nieuw, naarB) => {
        M.close();
        const fa = this.app.vault.getAbstractFileByPath(a.it.path), fb = this.app.vault.getAbstractFileByPath(b.it.path); if (!fa || (naarB && !fb)) return;
        try {
          const was = await snap([a.it.path, naarB ? b.it.path : null]);
          await this.app.fileManager.processFrontMatter(fa, fm => {
            const keep = arr(fm.verbanden).map(String).filter(r => !is(r));
            if (nieuw && !naarB) keep.push(nieuw);
            if (keep.length) fm.verbanden = keep; else delete fm.verbanden;
            for (const k of ['volgt_op', 'volgt op', 'volgtop']) if (k in fm) { const rest = arr(fm[k]).map(String).filter(r => !oud(r)); if (rest.length) fm[k] = rest; else delete fm[k]; }
          });
          if (nieuw && naarB) await this.app.fileManager.processFrontMatter(fb, fm => { fm.verbanden = [...arr(fm.verbanden).map(String), nieuw]; });
          remember(label, was); new Notice('Verband ' + label.replace(/^verband /, '')); this.plugin.sync();
        } catch (e) { console.error(e); return new Notice('Dat lukte niet: ' + (e && e.message || e), 8000); }
        await reopen({ ...v }, node.it.path);
      };
      const tail = x.v.label ? ' | ' + x.v.label : '';
      M.set(h('p', { class: 'am-hint' }, 'Ander soort verband:'),
        ...soorten.map(sk => h('button', { class: 'am-menu-btn am-vb-row' + (lw(sk.naam) === x.v.soort ? ' am-on' : ''), onclick: () => lw(sk.naam) === x.v.soort ? M.close() : change('verband veranderd', `[[${b.it.title}]] | ${lw(sk.naam)}${tail}`) },
          h('span', { class: 'am-vb-dot', style: `background:${sk.kleur}` }), (lw(sk.naam) === x.v.soort ? '✓ ' : '') + sk.naam)),
        h('button', { class: 'am-menu-btn', onclick: () => change('verband omgedraaid', `[[${a.it.title}]] | ${x.v.soort}${tail}`, true) }, '⇄ Pijl omdraaien'),
        h('button', { class: 'am-menu-btn am-vb-weg', onclick: () => change('verband weggehaald') }, 'Verband weghalen'),
        h('button', { class: 'am-menu-btn', onclick: () => M.close() }, 'Annuleren'));
    };
    const linkMode = () => {
      link = {}; prodBox.hidden = true;
      info.replaceChildren(h('b', {}, 'Verband leggen'), ` · tik op het item waar “${short(sel.it.title, 20)}” mee verbonden wordt, of trek een lijn vanaf het item`);
      acts.replaceChildren(h('button', { class: 'am-menu-btn', onclick: () => pickNode(sel) }, 'Annuleren'));
      draw();
    };
    // tikken op een item: het licht op, de producten springen erboven, onderin de knoppen
    const pickNode = best => {
      sel = best; link = null; side.hidden = true; bar.hidden = false;
      if (!best) return unpick();
      const it = byPath.get(best.it.path), proj = best.row.side ? '' : best.row.lijn, nv = SP.vbs.filter(x => x.a === best || x.b === best).length;
      info.replaceChildren(h('b', {}, best.it.title), ' · ' + [fmtD(best.it.datum), proj || (best.it.lijnen[0] || ''), best.it.idee ? 'idee' : '', nv ? `${nv} verband${nv === 1 ? '' : 'en'}` : ''].filter(Boolean).join(' · '));
      acts.replaceChildren(h('div', { class: 'am-sacts' },
        it ? h('button', { class: 'am-menu-btn am-primary', onclick: () => {
          const terug = { ...v }; close(); this.tab = 'archief';
          // na opslaan (of Terug) weer naar de stroom, op dezelfde plek
          this.editing = { it, datum: it.datum, lijnen: [...it.lijnen], tags: [...it.tags], producten: [...it.producten], onbekend: [...it.onbekend], stroom: terug };
          this.render().then(() => { this.contentEl.scrollTop = 0; });
        } }, 'Bewerken') : null,
        h('button', { class: 'am-menu-btn', onclick: linkMode }, 'Verband leggen'),
        nv ? h('button', { class: 'am-menu-btn', onclick: () => vbList(best) }, `Verbanden · ${nv}`) : null));
      showProds(it);
      draw();
      // het item (en de producten erboven) in beeld houden
      requestAnimationFrame(() => {
        const x = v.x + best.X * v.k, y = v.y + best.Y * v.k, top = y - best.S * v.k * 1.9 / 2 - (prodBox.childElementCount ? 90 : 10), nv2 = { ...v };
        if (x > W - 50 || x < 50) nv2.x += W / 2 - x;
        if (top < 6) nv2.y += 20 - top; else if (y > H - 40) nv2.y += H / 2 - y;
        if (nv2.x !== v.x || nv2.y !== v.y) glideTo(nv2);
      });
    };
    // alle foto's van een item schermvullend: vegen of op de zijkant tikken bladert, ✕ of omlaag vegen sluit
    const groot = node => {
      const mc = this.app.metadataCache, fs = [];
      for (const e of (node.it.fc && node.it.fc.embeds) || []) { const t = mc.getFirstLinkpathDest(e.link.split('|')[0].split('#')[0], node.it.path); if (t && IMG_EXT.test(t.path) && !fs.includes(t)) fs.push(t); }
      if (!fs.length) fs.push(node.img);
      let i = Math.max(0, fs.indexOf(node.img)), x0 = null, y0 = 0;
      const img = h('img', { class: 'am-groot-img', alt: '', draggable: false }), teller = h('span', { class: 'am-groot-n' });
      const show = d => { i = (i + d + fs.length) % fs.length; img.src = this.app.vault.getResourcePath(fs[i]); teller.textContent = fs.length > 1 ? `${i + 1} / ${fs.length}` : ''; };
      const G = h('div', { class: 'am-groot' }, img, h('div', { class: 'am-groot-top' }, h('span', { class: 'am-groot-t' }, node.it.title), teller, h('button', { class: 'am-tool', title: 'Sluiten', onclick: e => { e.stopPropagation(); G.remove(); } }, '✕')));
      G.addEventListener('pointerdown', e => { x0 = e.clientX; y0 = e.clientY; });
      G.addEventListener('pointerup', e => {
        if (x0 == null || e.target.closest('button')) return;
        const dx = e.clientX - x0, dy = e.clientY - y0; x0 = null;
        if (Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx)) return G.remove();
        if (fs.length < 2) { if (Math.abs(dx) < 10 && Math.abs(dy) < 10) G.remove(); return; }
        if (Math.abs(dx) > 40) show(dx < 0 ? 1 : -1);
        else if (Math.abs(dx) < 10) show(e.clientX > G.getBoundingClientRect().width / 2 ? 1 : -1);
      });
      show(0); root.append(G);
    };
    const pick = (px, py) => {
      const best = SP.hit(v, px, py);
      if (link) { if (best && best !== sel) { const a = sel; link = null; draw(); vbSheet(a, best); } return; }
      // nog een keer tikken op het gekozen item: de foto's schermvullend
      if (best && best === sel && best.img) return groot(best);
      pickNode(best);
    };
    // lijn trekken vanaf het gekozen item (alleen bij Verband leggen)
    const grabLine = (px, py) => {
      if (!link || !sel || SP.hit(v, px, py) !== sel) return null;
      const b0 = cv.getBoundingClientRect();
      link.to = [px, py]; draw();
      return { move: (cx, cy) => { link.to = [cx - b0.left, cy - b0.top]; soon(); },
        end: () => { const [x, y] = link.to || [0, 0], t = SP.hit(v, x, y), a = sel; link.to = null; draw(); if (t && t !== a) { link = null; draw(); vbSheet(a, t); } } };
    };
    requestAnimationFrame(() => { size(); if (keepV) v = keepV; else toEnd(); draw(); if (selPath) { const n = SP.all.find(n => n.it.path === selPath); if (n) pickNode(n); } });
    // lang indrukken op een item: het komt los en je sleept het naar een andere plek (dezelfde regels als Plek kiezen)
    const grab = (px, py, cx, cy) => {
      const n = SP.hit(v, px, py); if (!n) return null;
      unpick();
      const from = n.row.side ? '' : n.row.lijn, low = s => String(s).toLowerCase();
      const E = { it: { idee: n.it.idee }, datum: n.it.datum, lijnen: [...n.it.lijnen] };
      const C = { holder: E, get: () => E.datum, set: d => { E.datum = d; }, skip: n.it.path };
      return this.pickPlek(C, E.lijnen, async () => {
        if (!E.plek) return;
        // verplaatst naar een ander project: uit het project waar je hem uit haalde
        if (from && low(from) !== low(E.plek.lijn)) E.lijnen = E.lijnen.filter(l => low(l) !== low(from));
        const f = this.app.vault.getAbstractFileByPath(n.it.path); if (!f) return;
        const keep = { ...v };
        try {
          remember(`“${short(n.it.title, 20)}” verplaatst`, await snap([n.it.path, ...(E.plek.day || [])]));
          await this.app.fileManager.processFrontMatter(f, fm => {
            if (E.datum) fm.datum = E.datum;
            fm.project = E.lijnen.length > 1 ? E.lijnen : (E.lijnen[0] || '');
            if ('lijn' in fm) delete fm.lijn;
          });
          await this.plugin.applyPlek(E.plek, n.it.path, true);
          new Notice(`“${short(n.it.title, 30)}” verplaatst`); this.plugin.sync();
        } catch (e) { console.error(e); new Notice('Verplaatsen lukte niet: ' + (e && e.message || e), 8000); }
        // even wachten tot Obsidian de notitie opnieuw heeft gelezen, dan de stroom opnieuw tekenen op dezelfde plek
        await reopen(keep);
      }, { cx, cy, v: { ...v }, title: n.it.title, parent: root, idee: n.it.idee, img: n.img ? this.app.vault.getResourcePath(n.img) : '' });
    };
    this.panZoom(cv, () => v, nv => { v = nv; soon(); }, pick, KMIN, KMAX, (px, py, cx, cy) => link ? null : grab(px, py, cx, cy), grabLine);
  }
  // schuiven met één vinger, zoomen met twee (of het muiswiel); een tik zonder schuiven gaat naar onTap
  // onLong (mag weg): lang indrukken zonder te schuiven; geeft het { move, end } terug, dan krijgt dat de rest van het gebaar
  // onGrab (mag weg): bij neerzetten; geeft het { move, end } terug, dan krijgt dat meteen het hele gebaar (bijv. een lijn trekken)
  panZoom(cv, getV, setV, onTap, KMIN, KMAX, onLong, onGrab) {
    const P = new Map(); let G = null, last = null, moved = false, lt = 0, LH = null, vel = [], pinched = false;
    const sp = e => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    // na loslaten glijdt de stroom nog even door en remt af (zoals een gewone lijst op de telefoon)
    let glide = 0;
    const fling = () => {
      const now = performance.now(), rec = vel.filter(q => now - q[0] < 90); vel = [];
      if (rec.length < 2) return;
      const a = rec[0], b = rec[rec.length - 1], dt = Math.max(8, b[0] - a[0]);
      let vx = (b[1] - a[1]) / dt, vy = (b[2] - a[2]) / dt; // pixels per ms
      if (Math.hypot(vx, vy) < .15) return;
      const lim = 4; vx = Math.max(-lim, Math.min(lim, vx)); vy = Math.max(-lim, Math.min(lim, vy));
      let t = performance.now(); const id = ++glide;
      const step = now => {
        if (id !== glide) return;
        const dt2 = Math.min(40, now - t); t = now;
        const v = getV(); setV({ k: v.k, x: v.x + vx * dt2, y: v.y + vy * dt2 });
        const f = Math.pow(.9965, dt2); vx *= f; vy *= f; // afremmen
        if (Math.hypot(vx, vy) > .02) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    cv.addEventListener('pointerdown', e => {
      glide++; animV.stop(); // een aanraking houdt een glijdende beweging meteen tegen
      // de eerste vinger van een nieuwe aanraking: vingers die nog 'vast' stonden vergeten (soms mist de telefoon een loslaten,
      // dan telde die oude vinger mee en zoomde één vinger)
      if (e.isPrimary && P.size) { P.clear(); G = null; if (LH) { const l = LH; LH = null; try { l.end(); } catch (err) {} } }
      if (!P.size) { vel = []; pinched = false; }
      e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch (err) {}
      P.set(e.pointerId, sp(e)); last = sp(e); moved = false; clearTimeout(lt);
      if (P.size === 1 && onGrab) { const q = sp(e), hnd = onGrab(q[0], q[1]); if (hnd) { LH = hnd; moved = true; return; } }
      if (P.size === 1 && onLong) { const p0 = sp(e), cx = e.clientX, cy = e.clientY; lt = setTimeout(() => { if (moved || P.size !== 1) return; LH = onLong(p0[0], p0[1], cx, cy); if (LH && navigator.vibrate) navigator.vibrate(25); }, 450); }
      if (P.size === 2) { const [a, b] = [...P.values()].slice(-2); G = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v: { ...getV() } }; moved = true; pinched = true; }
    });
    cv.addEventListener('pointermove', e => {
      if (LH) { LH.move(e.clientX, e.clientY); return; }
      if (!P.has(e.pointerId)) return; const p = sp(e); P.set(e.pointerId, p);
      if (P.size >= 2 && G) {
        const [a, b] = [...P.values()].slice(-2), d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const k = Math.min(KMAX, Math.max(KMIN, G.v.k * d / G.d0)), wx = (G.m0[0] - G.v.x) / G.v.k, wy = (G.m0[1] - G.v.y) / G.v.k;
        setV({ k, x: m[0] - wx * k, y: m[1] - wy * k });
      } else if (P.size === 1) {
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 6) moved = true;
        if (moved) { const v = getV(); setV({ k: v.k, x: v.x + p[0] - last[0], y: v.y + p[1] - last[1] }); last = p; vel.push([performance.now(), p[0], p[1]]); if (vel.length > 12) vel.shift(); }
      }
    });
    const end = e => {
      if (!P.has(e.pointerId)) return;
      const p = P.get(e.pointerId); P.delete(e.pointerId); clearTimeout(lt);
      if (LH) { const l = LH; LH = null; if (!P.size) l.end(); return; }
      if (!P.size && !moved && p) onTap(...p);
      if (!P.size && moved && !pinched) fling();
      if (P.size < 2) G = null; if (P.size === 1) { last = [...P.values()][0]; vel = []; }
    };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end); cv.addEventListener('lostpointercapture', end);
    cv.addEventListener('wheel', e => { e.preventDefault(); const v = getV(), [mx, my] = sp(e), wx = (mx - v.x) / v.k, wy = (my - v.y) / v.k, k = Math.min(KMAX, Math.max(KMIN, v.k * Math.exp(-e.deltaY / 400))); setV({ k, x: mx - wx * k, y: my - wy * k }); }, { passive: false });
  }

  // per gekozen tag waar producten bij horen: welk product precies (meer mag), of 'weet ik niet meer'
  productBlock(S, refresh, rerender) {
    const out = h('div', { class: 'am-prodgroups' }), P = this.data.products;
    const tags = S.tags.filter(t => P.some(p => p.tags.includes(t)));
    if (!tags.length) return out;
    const has = title => S.producten.some(x => x.toLowerCase() === title.toLowerCase());
    for (const t of tags) {
      const wrap = h('div', { class: 'am-chips' });
      for (const p of P.filter(p => p.tags.includes(t))) wrap.append(this.longPress(h('button', { class: 'am-chip am-prod' + (has(p.title) ? ' am-on' : ''), onclick: e => {
        if (this.wasLong(e.currentTarget)) return;
        if (has(p.title)) S.producten = S.producten.filter(x => x.toLowerCase() !== p.title.toLowerCase());
        else { S.producten = [...S.producten, p.title]; S.onbekend = S.onbekend.filter(x => x !== t); }
        refresh();
      } }, p.img ? h('img', { src: this.app.vault.getResourcePath(p.img), loading: 'lazy', alt: '' }) : null, p.title), () => this.productMenu(p, rerender)));
      wrap.append(h('button', { class: 'am-chip' + (S.onbekend.includes(t) ? ' am-on' : ''), onclick: () => {
        if (S.onbekend.includes(t)) S.onbekend = S.onbekend.filter(x => x !== t);
        else { S.onbekend = [...S.onbekend, t]; S.producten = S.producten.filter(x => !P.some(p => p.tags.includes(t) && p.title.toLowerCase() === x.toLowerCase())); }
        refresh();
      } }, '? weet ik niet meer'));
      out.append(h('div', { class: 'am-group' }, h('span', {}, `welk ${t}?`), wrap));
    }
    return out;
  }
  // foto, naam, tag(s) en de rest van wat je op de computer bij Producten invult (nieuw en aanpassen)
  productForm(np, redraw, more = []) {
    const naam = h('input', { type: 'text', placeholder: 'Naam van het product' }); naam.value = np.naam;
    naam.addEventListener('input', () => { np.naam = naam.value; });
    const pick = h('input', { type: 'file', accept: 'image/*', class: 'am-hidden' });
    pick.addEventListener('change', () => { const f = pick.files[0]; if (!f) return; if (np.prev) URL.revokeObjectURL(np.prev); np.file = f; np.prev = URL.createObjectURL(f); redraw(); });
    const src = np.prev || (np.img ? this.app.vault.getResourcePath(np.img) : '');
    const known = new Set(this.data.groups.flatMap(g => g.tags));
    const extra = [...new Set([...more, ...np.tags])].filter(t => t !== 'idee' && !known.has(t));
    // standaard alleen materiaal en techniek; 'alle tags…' laat de rest zien. Een gekozen tag uit een andere groep blijft zichtbaar
    const shown = np.alleTags ? this.data.groups : this.data.groups.filter(g => PROD_GROUPS.includes(g.naam));
    const other = np.tags.filter(t => known.has(t) && !shown.some(g => g.tags.includes(t)));
    const tg = h('div', { class: 'am-group' }, h('span', {}, 'hoort bij tag'));
    if (extra.length) tg.append(h('div', { class: 'am-np-tg' }, h('small', {}, 'nieuw'), this.chips(extra, np.tags)));
    if (other.length) tg.append(h('div', { class: 'am-np-tg' }, h('small', {}, 'gekozen'), this.chips(other, np.tags)));
    for (const g of shown) { const ts = g.tags.filter(t => t !== 'idee'); if (ts.length) tg.append(h('div', { class: 'am-np-tg' }, h('small', {}, g.naam), this.chips(ts, np.tags))); }
    tg.append(h('button', { class: 'am-chip am-addprod am-alle', onclick: () => { np.alleTags = !np.alleTags; redraw(); } }, np.alleTags ? 'minder tags' : 'alle tags…'));
    const field = (k, label, ph, opts = {}) => {
      const el = h(opts.area ? 'textarea' : 'input', { type: opts.area ? null : 'text', placeholder: ph, inputmode: opts.mode || null, rows: opts.area ? 2 : null });
      el.value = np[k] || ''; el.addEventListener('input', () => { np[k] = el.value; });
      return h('label', { class: 'am-np-f' + (opts.half ? ' am-half' : '') }, h('span', {}, label), el);
    };
    return [h('div', { class: 'am-np-row' }, h('label', { class: 'am-np-pic' }, pick, src ? h('img', { src, alt: '' }) : '+ foto'), naam), tg,
      h('div', { class: 'am-np-grid' },
        field('merk', 'Merk', '', { half: true }), field('prijs', 'Prijs', '€ 3,50', { half: true, mode: 'decimal' }),
        field('grootte', 'Grootte per verpakking', '500 ml, 22 cm, 50 vel…'), field('winkel', 'Winkel of link', 'waar je het kocht'),
        field('notitie', 'Notitie', 'formaat, kleur, wat opviel…', { area: true }))];
  }
  // nieuw product, altijd te maken (ook zonder gekozen tag); het product en zijn tag komen meteen bij dit item
  newProduct(S, refresh, rerender) {
    const np = S.np;
    if (!np) return h('button', { class: 'am-chip am-addprod', onclick: () => { S.np = { naam: '', tags: S.tags.filter(t => this.data.groups.some(g => PROD_GROUPS.includes(g.naam) && g.tags.includes(t))).slice(-1), file: null, prev: '', merk: '', grootte: '', prijs: '', winkel: '', notitie: '' }; refresh(); } }, '+ nieuw product');
    const close = () => { if (np.prev) URL.revokeObjectURL(np.prev); S.np = null; refresh(); };
    const add = h('button', { class: 'am-np-add' }, 'Product toevoegen');
    add.addEventListener('click', async () => {
      if (!np.naam.trim()) return new Notice('Geef het product een naam.');
      if (!np.tags.length) return new Notice('Kies bij welke tag het hoort.');
      add.disabled = true;
      try {
        const p = await this.plugin.createProduct(np);
        for (const t of p.tags) if (!S.tags.includes(t)) S.tags.push(t);
        S.producten = [...S.producten, p.title]; S.onbekend = S.onbekend.filter(x => !p.tags.includes(x));
        if (np.prev) URL.revokeObjectURL(np.prev); S.np = null;
        await this.plugin.settle([p.file], fm => !arr(fm.tags).length);
        new Notice(`Product ${p.title} toegevoegd`); rerender();
      } catch (e) { console.error(e); new Notice('Dat lukte niet: ' + (e && e.message || e), 8000); add.disabled = false; }
    });
    return h('div', { class: 'am-np' }, ...this.productForm(np, refresh, S.tags), h('div', { class: 'am-np-row' }, add, h('button', { onclick: close }, 'Annuleren')));
  }
  tagAndProducts(S, rerender) {
    // altijd een kopje Producten; eerst de producten van de gekozen tags, daaronder '+ nieuw product'
    const box = h('div', { class: 'am-field am-np-slot' });
    const fill = () => box.replaceChildren(h('label', {}, 'Producten'), this.productBlock(S, fill, rerender), this.newProduct(S, fill, rerender));
    fill();
    return [this.tagBlock(S.tags, rerender, fill), box];
  }
  tagBlock(sel, rerender, changed) {
    const known = new Set(this.data.groups.flatMap(g => g.tags));
    const extra = sel.filter(t => !known.has(t) && t !== 'idee');
    const out = h('div', { class: 'am-field' }, h('label', {}, 'Tags', h('span', { class: 'am-src' }, ' · lang indrukken voor meer')));
    if (extra.length) out.append(h('div', { class: 'am-group' }, h('span', {}, 'nieuw'), this.chips(extra, sel)));
    for (const g of this.data.groups) out.append(h('div', { class: 'am-group' }, h('span', {}, g.naam), this.chips(g.tags, sel, changed, t => this.tagMenu(t, rerender))));
    out.append(this.adder('+ nieuwe tag', (v, quiet) => { const t = cleanTag(v); if (t && !sel.includes(t)) sel.push(t); if (!quiet) rerender(); else if (changed) changed(); }));
    return out;
  }

  /* ---------- nieuw item ---------- */
  renderNew(body) {
    const F = this.form, again = () => { const y = this.contentEl.scrollTop; this.render().then(() => { this.contentEl.scrollTop = y; }); };
    const input = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, class: 'am-hidden' });
    input.addEventListener('change', async () => {
      const picked = [...input.files].filter(f => isImg(f) || isVid(f));
      for (const f of picked) { F.files.push(f); F.previews.push(isImg(f) ? URL.createObjectURL(f) : ''); F.dates.push(await fileDate(f)); }
      this.pickDate(); again();
    });
    // aanvullen van de gekozen foto's uit Inladen; terug = niets opslaan, de foto's blijven in Inladen staan
    body.append(h('div', { class: 'am-dump-head' }, h('b', {}, `Aanvullen (${F.files.length} foto${F.files.length === 1 ? '' : "'s"})`),
      h('button', { class: 'am-filter-x', onclick: () => { this.resetForm(); again(); } }, '← Terug')));
    body.append(h('label', { class: 'am-pick' }, input, F.files.length ? '+ Meer foto\'s' : 'Foto maken of kiezen'));
    if (F.files.length) {
      const strip = h('div', { class: 'am-strip' });
      F.files.forEach((f, i) => strip.append(h('div', { class: 'am-th' },
        F.previews[i] ? h('img', { src: F.previews[i] }) : h('div', { class: 'am-vid' }, 'video'),
        F.dates[i].datum ? h('span', { class: 'am-th-date' }, F.dates[i].datum) : null,
        h('button', { class: 'am-x', 'aria-label': 'weghalen', onclick: () => {
          if (F.previews[i]) URL.revokeObjectURL(F.previews[i]);
          F.files.splice(i, 1); F.previews.splice(i, 1); F.dates.splice(i, 1); this.pickDate(); again();
        } }, '×'))));
      body.append(strip);
      const big = F.files.find(f => f.size > 30 * 1024 * 1024);
      if (big) body.append(h('p', { class: 'am-hint am-warn' }, `Let op: ${big.name || 'een video'} is ${Math.round(big.size / 1048576)} MB. Dat duurt lang om te synchroniseren.`));
      if (F.files.length > 1) body.append(h('div', { class: 'am-seg' },
        h('button', { class: F.los ? 'am-on' : '', onclick: () => { F.los = true; this.pickDate(); again(); } }, `Elk een eigen item (${F.files.length})`),
        h('button', { class: F.los ? '' : 'am-on', onclick: () => { F.los = false; this.pickDate(); again(); } }, 'Samen één item')));
    }

    const los = F.files.length > 1 && F.los;
    if (!los) {
      const t = h('input', { type: 'text', placeholder: 'Titel (mag leeg)', value: F.titel });
      t.addEventListener('input', () => { F.titel = t.value; });
      body.append(h('div', { class: 'am-field' }, h('label', {}, 'Titel'), t));
    }
    const ta = h('textarea', { rows: 3, placeholder: los ? 'Beschrijving (voor alle items)' : 'Wat zie je?' });
    ta.value = F.tekst; ta.addEventListener('input', () => { F.tekst = ta.value; });
    body.append(h('div', { class: 'am-field' }, h('label', {}, 'Beschrijving'), ta));

    if (!los) {
      const d = h('input', { type: 'date', value: F.datum });
      d.addEventListener('change', () => { F.datum = d.value; F.datumBron = 'zelf'; });
      const hint = { foto: 'uit de foto', naam: 'uit de bestandsnaam', bestand: 'datum van het bestand', vandaag: F.files.length ? 'geen datum in de foto gevonden, staat op vandaag' : 'vandaag', zelf: '' }[F.datumBron];
      body.append(h('div', { class: 'am-field' }, h('label', {}, 'Datum', hint ? h('span', { class: 'am-src' }, ` · ${hint}`) : null), d));
    }
    body.append(this.lijnBlock(F.lijnen, again, { holder: F, get: () => F.datum, set: d => { F.datum = d; F.datumBron = 'zelf'; }, skip: null }), ...this.tagAndProducts(F, again));

    const save = h('button', { class: 'am-save', disabled: F.busy }, F.busy ? 'Opslaan…' : 'Opslaan');
    save.addEventListener('click', () => this.saveNew());
    body.append(h('div', { class: 'am-bar' }, save));
  }
  /* ---------- idee: schetsen zoals in de Ideeënfabriek ---------- */
  renderIdea(body, again) {
    const S = this.sketch || (this.sketch = { objs: [], undo: [], redo: [], ink: INKS[0], size: 4, tool: 'pen', naam: '', lijnen: [], tekst: false, busy: false, v: null });
    const naam = h('input', { type: 'text', placeholder: 'Naam van het idee', value: S.naam });
    naam.addEventListener('input', () => { S.naam = naam.value; });
    body.append(naam);
    // klein voorbeeld van het bord; tikken opent het bord op het hele scherm
    const prev = h('button', { class: 'am-preview', onclick: () => this.openBoardAnim(prev, S, again) },
      h('span', { class: 'am-preview-tip' }, S.objs.length ? 'Tik om te bewerken' : 'Tik om te tekenen'));
    if (S.objs.length) boardCanvas(S.objs, 700).then(c => { c.className = 'am-preview-img'; prev.prepend(c); });
    body.append(prev);
    // alleen de plek in de stroom; het project volgt vanzelf uit die plek
    const C = { holder: S, get: () => S.datum || isoDay(Date.now()), set: d => { S.datum = d; }, skip: null };
    const after = () => { S.lijnen.splice(0, S.lijnen.length, ...(S.plek ? [S.plek.lijn] : [])); again(); };
    body.append(h('div', { class: 'am-field' }, h('button', { class: 'am-plek-open', onclick: () => this.pickPlek(C, S.lijnen, after) }, '⤳  Plek kiezen in de stroom'), this.plekLine(C, after)));
    const save = h('button', { class: 'am-save', disabled: S.busy }, S.busy ? 'Bewaren…' : 'Klaar → opslaan');
    save.addEventListener('click', async () => {
      if (!S.objs.length) return new Notice('Het bord is nog leeg.');
      S.busy = true; save.disabled = true; save.textContent = 'Bewaren…';
      try {
        const made = await this.plugin.createIdea({ naam: S.naam, lijnen: [...S.lijnen], objs: cleanObjs(S.objs), datum: S.datum });
        if (plekOk(S.plek, S.datum || isoDay(Date.now()), S.lijnen)) await this.plugin.applyPlek(S.plek, made);
        new Notice('Het idee is opgeslagen (in de visualisator bij Te Doen).');
        this.sketch = null; this.plugin.sync();
      } catch (e) { console.error(e); new Notice('Bewaren mislukt: ' + (e && e.message || e), 8000); S.busy = false; }
      again();
    });
    body.append(h('div', { class: 'am-bar' }, save));
  }
  // openen met een animatie, in twee stappen:
  // 1. het crème vlak groeit uit tot het hele scherm; een tekening die er al staat schuift en groeit mee naar zijn plek op het bord
  // 2. daarna schuiven de balk bovenin en de strook onderin binnen
  openBoardAnim(from, S, done) {
    const r = from.getBoundingClientRect();
    if (!r.width || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return this.openBoard(S, done);
    const T1 = 560, T2 = 460, dpr = window.devicePixelRatio || 1;
    const pc = from.querySelector('canvas.am-preview-img'), pr = pc && pc.geo && pc.width > 1 ? pc.getBoundingClientRect() : null;
    const px = n => n + 'px', put = (el, q) => Object.assign(el.style, { left: px(q.l), top: px(q.t), width: px(q.w), height: px(q.h) });
    // waar de tekening (met een randje eromheen) nu in het kleine vlak staat
    const M = 20, bs = S.objs.map(objBox), bb = bs.length ? [Math.min(...bs.map(q => q[0])) - M, Math.min(...bs.map(q => q[1])) - M, Math.max(...bs.map(q => q[2])) + M, Math.max(...bs.map(q => q[3])) + M] : null;
    let pic = null, start = null;
    if (pr && bb) try {
      const g0 = pc.geo, sc = pc.width / g0.W, a = pc.width / pc.height, dw = pr.width / pr.height > a ? pr.height * a : pr.width, d = dw / pc.width;
      const ox = pr.left + (pr.width - dw) / 2, oy = pr.top + (pr.height - dw / a) / 2, f = sc * d;
      start = { l: ox + (bb[0] - g0.x0) * f, t: oy + (bb[1] - g0.y0) * f, w: (bb[2] - bb[0]) * f, h: (bb[3] - bb[1]) * f };
      // eerst een uitsnede van het kleine plaatje, meteen op zijn plek (anders flitst hij een beeldje los over het scherm)
      pic = h('canvas', { class: 'am-grow-pic' }); pic.width = Math.max(1, Math.round((bb[2] - bb[0]) * sc)); pic.height = Math.max(1, Math.round((bb[3] - bb[1]) * sc));
      pic.getContext('2d').drawImage(pc, (bb[0] - g0.x0) * sc, (bb[1] - g0.y0) * sc, pic.width, pic.height, 0, 0, pic.width, pic.height);
      put(pic, start);
    } catch (e) { console.warn(e); pic = null; }
    this.openBoard(S, done);
    const root = document.body.lastElementChild; if (!root || !root.classList.contains('am-full')) return;
    // het menu bovenin (balk + kleuren + de strook boven de balk) schuift als één geheel binnen: even ver als het samen hoog is
    // meten met offsetTop/offsetHeight (die tellen geen verschuiving mee), en de beginstand neerzetten zónder overgang:
    // anders zie je het menu eerst even staan en wegschuiven voordat het binnenkomt
    const ex = root.querySelector('.am-full-extra'), last = ex && ex.offsetHeight ? ex : root.querySelector('.am-full-bar');
    root.style.setProperty('--am-top', Math.ceil(last.offsetTop + last.offsetHeight + 16) + 'px');
    root.classList.add('am-notrans', 'am-enter', 'am-enter-start');
    root.append(h('div', { class: 'am-enter-strip am-enter-top' }), h('div', { class: 'am-enter-strip am-enter-bot' }));
    const fx = h('div', { class: 'am-grow' }); put(fx, { l: r.left, t: r.top, w: r.width, h: r.height });
    document.body.append(fx); if (pic) document.body.append(pic);
    root.offsetHeight; root.classList.remove('am-notrans');
    const finish = () => { root.classList.remove('am-enter', 'am-enter-done', 'am-enter-board'); root.style.removeProperty('--am-top'); root.querySelectorAll('.am-enter-strip').forEach(x => x.remove()); requestAnimationFrame(() => { fx.remove(); pic && pic.remove(); }); };
    // twee beeldjes later staat het bord klaar (maat en 'alles in beeld' bepaald): dan weten we waar de tekening heen moet
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      // eerst de scherpe tekening klaarzetten, dan vlak en tekening in hetzelfde beeldje laten beginnen (anders lopen ze uit de pas)
      let go = null;
      if (pic) try {
        const wr = root.querySelector('.am-full-cv').getBoundingClientRect(), v = S.v || { x: 0, y: 0, k: 1 };
        const to = { l: wr.left + v.x + bb[0] * v.k, t: wr.top + v.y + bb[1] * v.k, w: (bb[2] - bb[0]) * v.k, h: (bb[3] - bb[1]) * v.k };
        if (![to.w, to.h, start.w, start.h].every(n => n > 0 && isFinite(n))) throw new Error('geen maat');
        // scherp op de eindmaat tekenen, zodat er aan het eind geen sprong van wazig naar scherp is
        const hi = h('canvas', { class: 'am-grow-pic' }); hi.width = Math.round(to.w * dpr); hi.height = Math.round(to.h * dpr);
        const g = hi.getContext('2d'); g.fillStyle = BORD_BG; g.fillRect(0, 0, hi.width, hi.height);
        g.setTransform(v.k * dpr, 0, 0, v.k * dpr, -bb[0] * v.k * dpr, -bb[1] * v.k * dpr); await paintBoard(g, S.objs);
        put(hi, to); hi.style.transform = `translate(${start.l - to.l}px, ${start.t - to.t}px) scale(${start.w / to.w}, ${start.h / to.h})`;
        pic.replaceWith(hi); pic = hi; hi.getBoundingClientRect();
        go = () => { hi.classList.add('am-grow-on'); hi.style.transform = 'none'; };
      } catch (e) { console.warn(e); }
      fx.classList.add('am-grow-on'); put(fx, { l: 0, t: 0, w: window.innerWidth, h: window.innerHeight }); go && go();
      // stap 2: menu en strook schuiven binnen; daarna verdwijnt de schaduw onder het menu zacht
      // zodra het vlak het scherm vult, neemt het echte bord het over (dan kun je ook meteen tekenen)
      setTimeout(() => { root.classList.add('am-enter-board'); requestAnimationFrame(() => { pic && pic.remove(); pic = null; }); }, T1 + 30);
      // het menu begint al als het vlak bijna klaar is (het laatste stukje gaat heel langzaam), zodat er geen stilstand is
      setTimeout(() => { root.classList.remove('am-enter-start'); setTimeout(() => { root.classList.add('am-enter-done'); setTimeout(finish, 220); }, T2); }, Math.round(T1 * .8));
    }));
  }
  // het bord op het hele scherm: tekenen, gum, handje (verschuiven, met twee vingers groter/kleiner), tekst, foto.
  // Met twee vingers (buiten een foto) zoom en schuif je het hele bord
  openBoard(S, done) {
    this.closeFull && this.closeFull();
    const snap = () => S.objs.map(cloneObj);
    const push = () => { S.undo.push(snap()); if (S.undo.length > 40) S.undo.shift(); S.redo = []; };
    const bar = h('div', { class: 'am-full-bar' }), extra = h('div', { class: 'am-full-extra' });
    const wrap = h('div', { class: 'am-full-cv' }), cv = h('canvas', { class: 'am-board' }); wrap.append(cv);
    const root = h('div', { class: 'am-full' }, bar, extra, wrap);
    document.body.append(root);
    const close = () => { this.closeSheet && this.closeSheet(); root.remove(); window.removeEventListener('resize', onResize); if (this.closeFull === close) this.closeFull = null; done(); };
    this.closeFull = close;
    const g = cv.getContext('2d');
    let W = 0, H = 0;
    const V = () => S.v || (S.v = { x: 0, y: 0, k: 1 });
    const toWorld = (sx, sy) => { const v = V(); return [(sx - v.x) / v.k, (sy - v.y) / v.k]; };
    const fit = () => {
      if (!S.objs.length) { S.v = { x: 0, y: 0, k: 1 }; return; }
      const bs = S.objs.map(objBox), x0 = Math.min(...bs.map(b => b[0])), y0 = Math.min(...bs.map(b => b[1])), x1 = Math.max(...bs.map(b => b[2])), y1 = Math.max(...bs.map(b => b[3]));
      const k = Math.min(1.5, (W - 40) / Math.max(1, x1 - x0), (H - 40) / Math.max(1, y1 - y0));
      S.v = { k, x: W / 2 - (x0 + x1) / 2 * k, y: H / 2 - (y0 + y1) / 2 * k };
    };
    const size = () => {
      const r = window.devicePixelRatio || 1;
      W = wrap.clientWidth; H = wrap.clientHeight;
      cv.style.width = W + 'px'; cv.style.height = H + 'px'; cv.width = Math.round(W * r); cv.height = Math.round(H * r);
    };
    const view = () => { const r = window.devicePixelRatio || 1, v = V(); g.setTransform(r * v.k, 0, 0, r * v.k, r * v.x, r * v.y); };
    let drawing = 0;
    const draw = async () => {
      const me = ++drawing;
      g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = BORD_BG; g.fillRect(0, 0, cv.width, cv.height);
      view(); if (me === drawing) await paintBoard(g, S.objs);
      if (me === drawing && S.grid) drawGrid();
    };
    // raster: dunne lijnen; als ze op het scherm te dicht op elkaar komen, alleen elke 2e/4e/…
    const drawGrid = () => {
      const v = V(), r = window.devicePixelRatio || 1; let st = S.grid; while (st * v.k < 8) st *= 2;
      const [x0, y0] = toWorld(0, 0), [x1, y1] = toWorld(W, H);
      g.setTransform(r, 0, 0, r, 0, 0); g.lineWidth = 1; g.beginPath();
      for (let x = Math.floor(x0 / st) * st; x <= x1; x += st) { const sx = Math.round(v.x + x * v.k) + .5; g.moveTo(sx, 0); g.lineTo(sx, H); }
      for (let y = Math.floor(y0 / st) * st; y <= y1; y += st) { const sy = Math.round(v.y + y * v.k) + .5; g.moveTo(0, sy); g.lineTo(W, sy); }
      g.strokeStyle = 'rgba(120,90,200,.28)'; g.stroke();
    };
    const onResize = () => { size(); draw(); };
    // voor de foto- en lagenmenu's
    const ctx = { S, push, draw: () => draw(), refresh: () => { tools(); draw(); } };
    window.addEventListener('resize', onResize);

    // knoppen
    const pick = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'am-hidden' });
    pick.addEventListener('change', async () => {
      const files = [...pick.files]; if (!files.length) return;
      push();
      const v = V(), [cx, cy] = toWorld(W / 2, H / 2); let n = 0;
      for (const f of files) {
        try {
          const d = await boardImgData(f), w = Math.min(d.w, W * .7 / v.k), hh = w * d.h / d.w;
          S.objs.push({ id: oid(), t: 'img', x: Math.round(cx - w / 2 + n * 20), y: Math.round(cy - hh / 2 + n * 20), w: Math.round(w), h: Math.round(hh), src: d.src });
          n++;
        } catch (e) { new Notice('Dit plaatje kon niet gelezen worden.'); }
      }
      pick.value = ''; S.tool = 'hand'; tools(); draw();
    });
    const tools = () => {
      const tool = (k, label, tip) => h('button', { class: 'am-tool' + (S.tool === k && !S.tekst ? ' am-on' : ''), title: tip, onclick: () => { S.tool = k; S.tekst = false; S.edit = null; tools(); } }, label);
      bar.replaceChildren(
        h('button', { class: 'am-tool am-close', title: 'Sluiten', 'aria-label': 'sluiten', onclick: close }, '✕'),
        tool('pen', '✎', 'Tekenen'), tool('gum', '⌫', 'Gum'), tool('hand', '✋', 'Verschuiven en groter/kleiner'),
        h('button', { class: 'am-tool' + (S.tekst ? ' am-on' : ''), title: 'Tekst', onclick: () => { S.tekst = !S.tekst; S.edit = null; tools(); } }, 'T'),
        h('label', { class: 'am-tool', title: 'Foto erop' }, pick, '📷'),
        h('button', { class: 'am-tool', title: 'Ongedaan maken', disabled: !S.undo.length, onclick: () => { if (!S.undo.length) return; S.redo.push(snap()); S.objs = S.undo.pop(); tools(); draw(); } }, '↶'),
        h('button', { class: 'am-tool', title: 'Opnieuw', disabled: !S.redo.length, onclick: () => { if (!S.redo.length) return; S.undo.push(snap()); S.objs = S.redo.pop(); tools(); draw(); } }, '↷'),
        h('button', { class: 'am-tool' + (S.grid ? ' am-on' : ''), title: 'Raster', onclick: () => { S.grid = S.grid ? 0 : (S.gridSize || 40); tools(); draw(); } }, '#'),
        h('button', { class: 'am-tool', title: 'Lagen', onclick: () => this.layersMenu(ctx) }, '▤'),
        h('button', { class: 'am-tool', title: 'Exporteren', onclick: () => this.exportBoard(S) }, '⤓'),
        h('button', { class: 'am-tool', title: 'Alles in beeld', onclick: () => { fit(); draw(); } }, '⤢'));
      const inks = h('div', { class: 'am-tools' });
      for (const c of INKS) inks.append(h('button', { class: 'am-ink' + (S.ink === c ? ' am-sel' : ''), style: `background:${c}`, 'aria-label': 'kleur', onclick: () => { S.ink = c; if (S.tool === 'gum') S.tool = 'pen'; tools(); } }));
      for (const z of PEN_SIZES) inks.append(h('button', { class: 'am-size' + (S.size === z ? ' am-on' : ''), 'aria-label': 'dikte', onclick: () => { S.size = z; tools(); } }, h('i', { style: `width:${Math.max(3, z)}px;height:${Math.max(3, z)}px` })));
      // kleuren en diktes alleen bij de pen of de tekst
      const kids = (S.tool === 'pen' || S.tekst) ? [inks] : [];
      if (S.grid && !kids.length) kids.push(h('div', { class: 'am-tools am-grid-sizes' }, h('span', { class: 'am-grid-lbl' }, 'Raster'),
        GRID_SIZES.map(n => h('button', { class: 'am-chip' + (S.grid === n ? ' am-on' : ''), onclick: () => { S.grid = S.gridSize = n; tools(); draw(); } }, String(n)))));
      if (S.tekst) {
        // een tekst die al op het bord staat: aanpassen (leeg maken haalt hem weg)
        const ed = S.edit && S.objs.find(o => o.id === S.edit && o.t === 'text');
        const ti = h('textarea', { rows: 2, placeholder: 'Tekst voor op het bord' });
        if (ed) ti.value = ed.text;
        const put = h('button', { class: 'am-np-add' }, ed ? 'Klaar' : 'Op het bord zetten');
        put.addEventListener('click', () => {
          const text = ti.value.trim();
          if (ed) {
            if (text !== ed.text || S.ink !== ed.c) { push(); if (text) { ed.text = text; ed.c = S.ink; } else S.objs = S.objs.filter(o => o !== ed); }
            S.edit = null; S.tekst = false; S.tool = 'hand'; tools(); draw(); return;
          }
          if (!text) return;
          push();
          const v = V(), size = (TEXT_SIZES[S.size] || 22) / v.k, w = Math.min(280, W - 40) / v.k, [cx, cy] = toWorld(W / 2, H / 2);
          S.objs.push({ id: oid(), t: 'text', x: Math.round(cx - w / 2), y: Math.round(cy - size), w: Math.round(w), size: Math.round(size), c: S.ink, text });
          S.tekst = false; S.tool = 'hand'; tools(); draw();
        });
        // een tekst uit je logboek: kies een dag, de notitie komt in het tekstvak (daar kun je hem nog inkorten)
        const logList = h('div', { class: 'am-log-pick', hidden: true });
        const fromLog = h('button', { class: 'am-np-add am-log-from', onclick: async () => {
          if (!logList.hidden) { logList.hidden = true; return; }
          const days = this.plugin.logDays().slice(0, 30);
          if (!days.length) return new Notice('Je logboek is nog leeg.');
          logList.replaceChildren(...await Promise.all(days.map(async d => {
            const t = await this.plugin.logRead(d);
            return h('button', { class: 'am-log-item', onclick: () => { ti.value = ti.value.trim() ? ti.value.trimEnd() + '\n\n' + t : t; logList.hidden = true; ti.focus(); requestAnimationFrame(() => { size(); draw(); }); } },
              h('b', {}, fmtD(d)), h('span', { class: 'am-log-prev' }, short(t.replace(/\s+/g, ' '), 80)));
          })));
          logList.hidden = false; requestAnimationFrame(() => { size(); draw(); });
        } }, '📓 Uit logboek');
        kids.push(h('div', { class: 'am-full-text' }, ti, h('div', { class: 'am-log-btns' }, fromLog, put), logList));
        if (!this.plugin.logDays().length) fromLog.hidden = true;
        setTimeout(() => ti.focus(), 50);
      }
      extra.replaceChildren(...kids);
      // de balk kan in hoogte veranderen (tekstvak): het bord past zich aan
      requestAnimationFrame(() => { if (wrap.clientHeight !== H || wrap.clientWidth !== W) { size(); draw(); } });
    };
    tools();
    requestAnimationFrame(() => { size(); fit(); draw(); }); // bij openen alles in beeld

    // aanraken: één vinger tekent/gumt/verschuift, twee vingers zoomen (of maken een foto/tekst groter en kleiner)
    const P = new Map(); // pointerId -> [x, y] op het scherm
    const spos = e => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    const hitAt = (x, y) => [...S.objs].reverse().find(o => o.t !== 'pen' && (() => { const b = objBox(o); return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]; })());
    const two = () => { const [a, b] = [...P.values()]; return { d: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }; };
    let mode = null, cur = null, moving = null, erased = false, last = null, G = null;
    // dubbeltik op een foto: menu (bijsnijden, doorzichtigheid, blend, verwijderen)
    let tap = null, down = null, lastTap = null;
    const imgAt = (x, y) => [...S.objs].reverse().find(o => o.t === 'img' && x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h);
    const eraseAt = (x, y) => {
      const before = S.objs.length, k = V().k;
      S.objs = S.objs.filter(o => o.t === 'pen' ? !o.pts.some(p => Math.hypot(p[0] - x, p[1] - y) < 12 / k + o.w / 2) : (() => { const b = objBox(o); return !(x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]); })());
      if (S.objs.length !== before) { erased = true; draw(); }
    };
    cv.addEventListener('pointerdown', e => {
      e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch (err) {}
      // een nieuwe aanraking: vingers die nog 'vast' stonden vergeten (anders zoomt één vinger)
      if (e.isPrimary && P.size) { P.clear(); if (mode === 'pinch' || mode === 'scale' || mode === 'wait' || mode === 'wait-scale') { mode = null; moving = null; G = null; } }
      P.set(e.pointerId, spos(e));
      if (P.size === 2) {
        // tweede vinger: wat de eerste vinger begon terugdraaien en gaan knijpen
        if (mode === 'pen' && cur) { S.objs = S.objs.filter(o => o !== cur); S.undo.pop(); cur = null; }
        if (mode === 'erase') { if (erased) S.objs = S.undo[S.undo.length - 1]; S.undo.pop(); erased = false; }
        const t = two(), v = V();
        if (mode === 'move' && moving) {
          const b = objBox(moving), [a1, b1] = [...P.values()];
          G = { d0: t.d, m0: t.m, o: { ...moving }, c: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], a0: Math.atan2(b1[1] - a1[1], b1[0] - a1[0]) }; mode = 'scale';
        } else { G = { d0: t.d, m0: t.m, v: { ...v } }; mode = 'pinch'; }
        draw(); return;
      }
      if (P.size > 2) return;
      const [x, y] = toWorld(...spos(e)); last = spos(e);
      const im = imgAt(x, y);
      if (im && tap && tap.id === im.id && Date.now() - tap.t < 350) {
        // het stipje van de eerste tik weer weg
        if (tap.dot) { S.objs = S.objs.filter(o => o.id !== tap.dot); S.undo.pop(); }
        tap = null; mode = 'wait'; draw();
        this.photoMenu(ctx, im);
        return;
      }
      const tx = !im && S.tool === 'hand' && !S.tekst ? hitAt(x, y) : null;
      down = { t: Date.now(), p: last, id: im ? im.id : tx && tx.t === 'text' ? tx.id : null };
      if (S.tool === 'pen' && !S.tekst) {
        push(); mode = 'pen'; cur = { id: oid(), t: 'pen', c: S.ink, w: Math.round(S.size / V().k * 10) / 10, pts: [[x, y]] }; S.objs.push(cur);
        view(); g.lineCap = g.lineJoin = 'round'; g.strokeStyle = cur.c; g.lineWidth = cur.w; g.beginPath(); g.moveTo(x, y); g.lineTo(x + .01, y); g.stroke();
      } else if (S.tool === 'gum') { push(); mode = 'erase'; erased = false; eraseAt(x, y); }
      else {
        const hit = hitAt(x, y);
        if (hit) { push(); moving = hit; mode = 'move'; G = { tx: 0, ty: 0, items: (hit.grp ? S.objs.filter(o => o.grp === hit.grp) : [hit]).map(o => [o, o.x, o.y]) }; } else mode = 'pan';
      }
    });
    cv.addEventListener('pointermove', e => {
      if (!P.has(e.pointerId)) return;
      P.set(e.pointerId, spos(e));
      if (mode === 'pinch' && P.size >= 2) {
        const t = two(), k = Math.min(8, Math.max(.15, G.v.k * t.d / G.d0));
        const wx = (G.m0[0] - G.v.x) / G.v.k, wy = (G.m0[1] - G.v.y) / G.v.k;
        S.v = { k, x: t.m[0] - wx * k, y: t.m[1] - wy * k }; draw();
      } else if (mode === 'scale' && P.size >= 2) {
        const t = two(), f = Math.min(20, Math.max(.05, t.d / G.d0)), o = moving, k = V().k;
        const cx = G.c[0] + (t.m[0] - G.m0[0]) / k, cy = G.c[1] + (t.m[1] - G.m0[1]) / k;
        o.w = Math.max(10, Math.round(G.o.w * f));
        if (o.t === 'img') o.h = Math.max(10, Math.round(G.o.h * f));
        else o.size = Math.max(6, Math.round(G.o.size * f));
        const b = objBox(o), bw = b[2] - b[0], bh = b[3] - b[1];
        o.x = Math.round(cx - bw / 2); o.y = Math.round(cy - bh / 2);
        if (o.t === 'img') {
          const [a1, b1] = [...P.values()]; let dr = (Math.atan2(b1[1] - a1[1], b1[0] - a1[0]) - G.a0) * 180 / Math.PI;
          dr = ((dr + 540) % 360) - 180; const tot = ((o.edit && o.edit.rot) || 0) + dr, near = Math.round(tot / 90) * 90;
          if (Math.abs(tot - near) < 5) dr += near - tot; // klikt vast op recht
          o._drot = Math.abs(dr) < 1.5 ? 0 : dr;
        }
        draw();
      } else if (P.size === 1) {
        const p = spos(e), [x, y] = toWorld(...p);
        if (mode === 'pen' && cur) {
          const q = cur.pts[cur.pts.length - 1]; if (Math.hypot(x - q[0], y - q[1]) < 1.5 / V().k) return;
          cur.pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]); view(); g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(x, y); g.stroke();
        } else if (mode === 'move' && moving) {
          const k = V().k; G.tx += (p[0] - last[0]) / k; G.ty += (p[1] - last[1]) / k;
          let dx = Math.round(G.tx), dy = Math.round(G.ty);
          if (S.grid) { const b = objBox(moving), [, mx, my] = G.items.find(q => q[0] === moving); dx = snapD(mx + dx, mx + dx + b[2] - b[0], S.grid) + dx; dy = snapD(my + dy, my + dy + b[3] - b[1], S.grid) + dy; }
          for (const [o, ox, oy] of G.items) { o.x = ox + dx; o.y = oy + dy; }
          last = p; draw();
        }
        else if (mode === 'pan') { const v = V(); v.x += p[0] - last[0]; v.y += p[1] - last[1]; last = p; draw(); }
        else if (mode === 'erase') eraseAt(x, y);
      }
    });
    const end = e => {
      P.delete(e.pointerId);
      // een korte tik zonder schuiven onthouden voor de dubbeltik
      if (down && !P.size && Date.now() - down.t < 300 && Math.hypot(spos(e)[0] - down.p[0], spos(e)[1] - down.p[1]) < 10 && down.id)
        tap = { id: down.id, t: Date.now(), dot: mode === 'pen' && cur ? cur.id : null };
      else if (!P.size) tap = null;
      if (tap && !tap.dot && S.tool === 'hand' && !S.tekst && mode === 'move') {
        const im = S.objs.find(o => o.id === tap.id), dbl = lastTap && lastTap.id === tap.id && Date.now() - lastTap.t < 400;
        lastTap = dbl ? null : { id: tap.id, t: Date.now() };
        S.undo.pop(); tap = null; down = null; mode = null; moving = null; G = null;
        // tik op een tekst: hem aanpassen
        if (im && im.t === 'text') { lastTap = null; S.tekst = true; S.edit = im.id; S.ink = im.c; tools(); return; }
        tools();
        // één tik: de strook; dubbeltik: meteen vragen of hij weg mag
        if (im) dbl ? this.deleteMenu(ctx, im) : this.photoMenu(ctx, im);
        return;
      }
      down = null;
      if (P.size) {
        // van twee naar één vinger: met die ene vinger gewoon doorgaan (de foto/tekst verplaatsen, of het bord verschuiven)
        if (P.size === 1 && (mode === 'scale' || mode === 'wait-scale') && moving) {
          mode = 'move'; G = { tx: 0, ty: 0, items: (moving.grp ? S.objs.filter(o => o.grp === moving.grp) : [moving]).map(o => [o, o.x, o.y]) }; last = [...P.values()][0];
        } else if (P.size === 1 && mode === 'pinch') { mode = 'pan'; last = [...P.values()][0]; }
        else if (mode === 'pinch' || mode === 'scale') mode = mode === 'scale' ? 'wait-scale' : 'wait';
        return;
      }
      if (cur) { cur = null; draw(); }
      if (mode === 'erase' && !erased) S.undo.pop();
      // gedraaid met twee vingers: de foto echt draaien
      if (moving && moving._drot) { const o = moving, e = ensureEdit(o); e.rot = Math.round(((e.rot || 0) + o._drot) * 10) / 10; delete o._drot; bakeImg(o).then(() => draw()); }
      mode = null; moving = null; erased = false; G = null;
      for (const o of S.objs) if (o._drot === 0) delete o._drot;
      tools();
    };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  }
  // de datum van het item: de oudste foto met een datum, anders vandaag
  pickDate() {
    const F = this.form; if (F.datumBron === 'zelf') return;
    const ds = F.dates.filter(d => d.datum).sort((a, b) => a.datum.localeCompare(b.datum));
    if (ds.length) { F.datum = ds[0].datum; F.datumBron = ds[0].bron; } else { F.datum = isoDay(Date.now()); F.datumBron = 'vandaag'; }
  }
  async saveNew() {
    const F = this.form; if (F.busy) return;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // een half ingetikte tag telt mee
    if (!F.files.length && !F.tekst.trim() && !F.titel.trim()) { new Notice('Kies eerst een foto of schrijf iets.'); return; }
    F.busy = true; await this.render();
    const P = this.plugin, taken = P.taken(), made = [];
    try {
      const common = { tekst: F.tekst, lijnen: [...F.lijnen], tags: [...F.tags], idee: false, ...P.keepProducts(F.tags, F.producten, F.onbekend, this.data.products) };
      if (F.files.length > 1 && F.los) {
        for (const [i, f] of F.files.entries()) {
          new Notice(`Opslaan ${i + 1} / ${F.files.length}…`, 1500);
          made.push(await P.createItem({ ...common, files: [f], titel: '', datum: F.dates[i].datum || isoDay(Date.now()) }, taken));
        }
      } else {
        made.push(await P.createItem({ ...common, files: F.files, titel: F.titel, datum: F.datum }, taken));
        if (plekOk(F.plek, F.datum, F.lijnen)) await P.applyPlek(F.plek, made[0]);
      }
      new Notice(made.length === 1 ? `Opgeslagen: ${made[0].split('/').pop().replace(/\.md$/, '')}` : `${made.length} items opgeslagen`);
      for (const f of F.files) if (f.dumpPath) { const t = this.app.vault.getAbstractFileByPath(f.dumpPath); if (t) await this.app.vault.trash(t, false); }
      this.resetForm(); P.sync();
    } catch (e) {
      console.error(e); new Notice('Opslaan mislukt: ' + (e && e.message || e), 8000); F.busy = false;
    }
    await this.render();
  }

  /* ---------- taggen ---------- */
  // een kaartje van een item; tikken = aanpassen
  card(it, tap) {
    return h('button', { class: 'am-card', onclick: e => { if (tap) return tap(e.currentTarget); this.editing = { it, datum: it.datum, lijnen: [...it.lijnen], tags: [...it.tags], producten: [...it.producten], onbekend: [...it.onbekend] }; this.render().then(() => { this.contentEl.scrollTop = 0; }); } },
      it.img ? h('img', { src: this.app.vault.getResourcePath(it.img), loading: 'lazy', decoding: 'async' }) : h('div', { class: 'am-noimg' }, it.title.slice(0, 40)),
      h('div', { class: 'am-cap' }, h('b', {}, it.title), h('span', {}, [it.datum, it.lijnen[0], it.tags.length ? `${it.tags.length} tags` : ''].filter(Boolean).join(' · '))));
  }
  /* ---------- archief: alles, zoeken op titel, tag, project en datum ---------- */
  renderArchief(body) {
    const Z = this.zoekF || (this.zoekF = { q: '', project: '', tag: '', product: '', van: '', tot: '' });
    const items = this.data.items;
    const z = h('input', { type: 'search', placeholder: 'Zoek op titel, #tag, project, product of datum', value: Z.q, class: 'am-search' });
    const opt = (v, label, cur) => { const o = h('option', { value: v }, label); if (v === cur) o.selected = true; return o; };
    const pSel = h('select', { class: 'am-filter' }, opt('', 'Alle projecten', Z.project), this.data.lijnen.map(l => opt(l, l, Z.project)));
    const allTags = [...new Set(this.data.groups.flatMap(g => g.tags))];
    const tSel = h('select', { class: 'am-filter' }, opt('', 'Alle tags', Z.tag), allTags.map(t => opt(t, '#' + t, Z.tag)));
    // producten: alleen die echt bij een item horen, op naam
    const prods = [...new Set(items.flatMap(it => it.producten))].sort((a, b) => a.localeCompare(b));
    const prSel = h('select', { class: 'am-filter' }, opt('', 'Alle producten', Z.product), prods.map(t => opt(t, t, Z.product)));
    const van = h('input', { type: 'date', class: 'am-filter', value: Z.van }), tot = h('input', { type: 'date', class: 'am-filter', value: Z.tot });
    const wis = h('button', { class: 'am-filter-x', onclick: () => { this.zoekF = null; this.shown = PAGE; this.render(); } }, 'Wissen');
    const count = h('p', { class: 'am-hint am-count' });
    // de filters zitten achter één knop, zodat de items meteen in beeld staan; het getal zegt hoeveel filters aan staan
    const fBox = h('div', { class: 'am-filterbox' }, h('div', { class: 'am-filters' }, pSel, tSel), prods.length ? h('div', { class: 'am-filters' }, prSel) : null, h('div', { class: 'am-filters' }, h('label', { class: 'am-van' }, 'van', van), h('label', { class: 'am-van' }, 'tot', tot), wis));
    const fBtn = h('button', { class: 'am-filter-btn', onclick: () => { this.filterOpen = !this.filterOpen; fLabel(); } });
    const fLabel = () => { const n = ['project', 'tag', 'product', 'van', 'tot'].filter(k => Z[k]).length; fBtn.textContent = 'Filter' + (n ? ' · ' + n : ''); fBtn.classList.toggle('am-on', !!n || !!this.filterOpen); fBox.hidden = !this.filterOpen; };
    fLabel();
    body.append(h('button', { class: 'am-stroom-open', onclick: () => this.openStroom() }, '〰 Stroom bekijken', h('small', {}, ' · of tik nog eens op Archief')), h('div', { class: 'am-zoekrij' }, z, fBtn), fBox, count);
    const grid = h('div', { class: 'am-grid' }); body.append(grid);
    const more = h('button', { class: 'am-more' }, 'Meer laden'); body.append(more);
    // elk woord moet ergens passen: titel, een tag (#mag), een project, of de datum (2026-10, okt, 7 okt 2026)
    const hay = it => [it.title, ...it.tags.map(t => '#' + t), ...it.lijnen, ...it.producten, it.datum, fmtD(it.datum)].join('\u0001').toLowerCase();
    // keep: tijdens zoeken blijft het zoekveld precies waar het staat (anders springt het beeld bij elke letter)
    const fill = keep => {
      const top0 = keep && z.isConnected ? z.getBoundingClientRect().top : null;
      if (keep) grid.style.minHeight = this.contentEl.clientHeight + 'px';
      const words = Z.q.toLowerCase().split(/\s+/).filter(Boolean), low = s => s.toLowerCase();
      const list = items.filter(it =>
        (!Z.project || it.lijnen.some(l => low(l) === low(Z.project))) && (!Z.tag || it.tags.includes(Z.tag)) && (!Z.product || it.producten.includes(Z.product)) &&
        (!Z.van || (it.datum && it.datum >= Z.van)) && (!Z.tot || (it.datum && it.datum <= Z.tot)) &&
        (!words.length || (s => words.every(w => s.includes(w)))(hay(it))));
      grid.innerHTML = '';
      count.textContent = list.length === items.length ? `${items.length} items` : `${list.length} van de ${items.length} items`;
      if (!list.length) grid.append(h('p', { class: 'am-hint' }, 'Niets gevonden.'));
      for (const it of list.slice(0, this.shown)) grid.append(this.card(it));
      more.hidden = list.length <= this.shown;
      more.onclick = () => { this.shown += PAGE; fill(); };
      if (top0 != null) { const dy = z.getBoundingClientRect().top - top0; if (Math.abs(dy) > 1) this.contentEl.scrollTop += dy; }
    };
    const set = (k, v) => { Z[k] = v; this.shown = PAGE; fill(true); fLabel(); };
    let tm; z.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => set('q', z.value), 150); });
    pSel.addEventListener('change', () => set('project', pSel.value)); tSel.addEventListener('change', () => set('tag', tSel.value)); prSel.addEventListener('change', () => set('product', prSel.value));
    van.addEventListener('change', () => set('van', van.value)); tot.addEventListener('change', () => set('tot', tot.value));
    fill();
  }
  /* ---------- inladen: veel foto's tegelijk inladen, later per stuk of in groepjes aanvullen ---------- */
  renderAanvullen(body) {
    const P = this.plugin, files = P.dumpFiles(), sel = this.dumpSel || (this.dumpSel = new Set());
    for (const p of [...sel]) if (!files.some(f => f.path === p)) sel.delete(p);
    const again = () => { const y = this.contentEl.scrollTop; this.render().then(() => { this.contentEl.scrollTop = y; }); };
    const input = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, class: 'am-hidden' });
    input.addEventListener('change', async () => {
      const picked = [...input.files].filter(f => isImg(f) || isVid(f)); if (!picked.length) return;
      const n = new Notice(`Inladen 0 / ${picked.length}…`, 0), taken = P.taken();
      try { for (const [i, f] of picked.entries()) { n.setMessage ? n.setMessage(`Inladen ${i + 1} / ${picked.length}…`) : 0; await P.dumpSave(f, taken); } }
      catch (e) { console.error(e); new Notice('Inladen lukte niet helemaal: ' + (e && e.message || e), 8000); }
      n.hide(); new Notice(`${picked.length} foto${picked.length === 1 ? '' : "'s"} staan klaar om aan te vullen`); P.sync(); again();
    });
    body.append(h('label', { class: 'am-pick' }, input, '+ Foto\'s inladen'));
    if (files.length) {
      // tikken verandert alleen het vakje, de kop en de knoppen; het scherm blijft staan
      const chosen = () => files.filter(f => sel.has(f.path));
      const headTxt = h('span'), allBtn = h('button', { class: 'am-filter-x' });
      const go = h('button', { class: 'am-save', onclick: () => { const c = chosen(); if (c.length) this.dumpToNew(c); } });
      const bank = h('button', { class: 'am-dump-bank', onclick: async () => {
        const c = chosen(); if (!c.length) return;
        bank.disabled = true;
        try {
          const n = await P.toBank(c), skip = c.length - n;
          c.forEach(f => sel.delete(f.path));
          new Notice(`${n} foto${n === 1 ? '' : "'s"} naar de beeldbank${skip ? ` · ${skip} video${skip === 1 ? '' : "'s"} bleef staan (de beeldbank is voor beelden)` : ''}`);
        } catch (e) { console.error(e); new Notice('Naar de beeldbank lukte niet: ' + (e && e.message || e), 8000); }
        P.sync(); again();
      } });
      const del = h('button', { class: 'am-dump-del', 'aria-label': 'weghalen', onclick: async () => {
        const c = chosen(); if (!c.length) return;
        for (const f of c) await this.app.vault.trash(f, false);
        sel.clear(); new Notice(`${c.length} weggehaald (staan in .trash)`); P.sync(); again();
      } }, '🗑');
      const ths = new Map();
      const mark = f => { const b = ths.get(f.path), on = sel.has(f.path); b.classList.toggle('am-on', on); b.querySelector('.am-dump-ok').hidden = !on; };
      const upd = () => {
        const n = sel.size;
        headTxt.textContent = n ? `${n} van ${files.length} gekozen` : `${files.length} foto${files.length === 1 ? '' : "'s"} · tik om te kiezen`;
        allBtn.textContent = n === files.length ? 'Niets' : 'Alles';
        go.disabled = del.disabled = bank.disabled = !n; go.textContent = n ? `Als item (${n})` : 'Kies foto\'s'; bank.textContent = n ? `Beeldbank (${n})` : 'Beeldbank';
      };
      allBtn.onclick = () => { if (sel.size === files.length) sel.clear(); else files.forEach(f => sel.add(f.path)); files.forEach(mark); upd(); };
      body.append(h('div', { class: 'am-dump-head' }, headTxt, allBtn));
      const grid = h('div', { class: 'am-dump' });
      for (const f of files) {
        const b = h('button', { class: 'am-dump-th', onclick: () => { sel.has(f.path) ? sel.delete(f.path) : sel.add(f.path); mark(f); upd(); } },
          IMG_EXT.test(f.name) ? h('img', { src: this.app.vault.getResourcePath(f), loading: 'lazy', decoding: 'async' }) : h('div', { class: 'am-vid' }, 'video'),
          h('span', { class: 'am-dump-ok' }, '✓'));
        b.dataset.i = ths.size; ths.set(f.path, b); grid.append(b); mark(f);
      }
      // vegen om te kiezen: begin opzij te vegen op een foto, dan wordt alles van die foto tot waar je vinger is gekozen
      // (of juist uitgezet, als de eerste al gekozen was). Recht omhoog of omlaag vegen scrolt gewoon
      let sw = null, noClick = false;
      const at = t => { const el = document.elementFromPoint(t.clientX, t.clientY), c = el && el.closest('.am-dump-th'); return c && grid.contains(c) ? +c.dataset.i : -1; };
      grid.addEventListener('touchstart', e => { const i = e.touches.length === 1 ? at(e.touches[0]) : -1; sw = i < 0 ? null : { i, x: e.touches[0].clientX, y: e.touches[0].clientY, on: false }; }, { passive: true });
      grid.addEventListener('touchmove', e => {
        if (!sw) return;
        const t = e.touches[0];
        if (!sw.on) {
          const dx = Math.abs(t.clientX - sw.x), dy = Math.abs(t.clientY - sw.y);
          if (dy > 10 && dy >= dx) { sw = null; return; } // scrollen
          if (dx < 10) return;
          sw.on = true; sw.keep = new Set(sel); sw.to = !sel.has(files[sw.i].path);
        }
        e.preventDefault();
        // bij de rand van het scherm schuift de lijst mee
        const r = this.contentEl.getBoundingClientRect();
        if (t.clientY > r.bottom - 120) this.contentEl.scrollTop += 14; else if (t.clientY < r.top + 140) this.contentEl.scrollTop -= 14;
        const j = at(t); if (j < 0 || j === sw.j) return; sw.j = j;
        const lo = Math.min(sw.i, j), hi = Math.max(sw.i, j);
        files.forEach((f, k) => { const want = k >= lo && k <= hi ? sw.to : sw.keep.has(f.path); if (want !== sel.has(f.path)) { want ? sel.add(f.path) : sel.delete(f.path); mark(f); } });
        upd();
      }, { passive: false });
      const end = () => { if (sw && sw.on) { noClick = true; setTimeout(() => { noClick = false; }, 400); } sw = null; };
      grid.addEventListener('touchend', end); grid.addEventListener('touchcancel', end);
      grid.addEventListener('click', e => { if (noClick) { e.stopPropagation(); e.preventDefault(); noClick = false; } }, true);
      body.append(grid, h('div', { class: 'am-bar am-dump-bar' }, bank, go, del)); upd();
    }
    // items in je archief waar nog tags of een project aan ontbreken
    const open = this.data.teDoen;
    if (open.length) {
      // Kiezen: tikken kiest (in plaats van openen), onderin verschijnt Weghalen
      const td = this.tdSel || (this.tdSel = new Set()), mode = !!this.tdMode;
      for (const p of [...td]) if (!open.some(it => it.file.path === p)) td.delete(p);
      const delBtn = h('button', { class: 'am-save am-danger', onclick: async () => {
        const list = open.filter(it => td.has(it.file.path)); if (!list.length) return;
        if (!confirm(`${list.length} item${list.length === 1 ? '' : 's'} weghalen? Ze gaan naar de prullenbak (.trash), met hun foto's.`)) return;
        delBtn.disabled = true;
        try { await P.trashItems(list, this.data.items); new Notice(`${list.length} weggehaald (staan in .trash)`); }
        catch (e) { console.error(e); new Notice('Weghalen lukte niet helemaal: ' + (e && e.message || e), 8000); }
        td.clear(); this.tdMode = false; P.sync(); again();
      } });
      const updDel = () => { delBtn.disabled = !td.size; delBtn.textContent = td.size ? `🗑 Weghalen (${td.size})` : 'Kies wat weg mag'; };
      body.append(h('div', { class: 'am-sub-head' }, h('h4', { class: 'am-sub' }, `Nog aan te vullen in je archief (${open.length})`),
        h('button', { class: 'am-filter-x', onclick: () => { this.tdMode = !mode; if (mode) td.clear(); again(); } }, mode ? 'Klaar' : 'Kiezen')));
      const grid = h('div', { class: 'am-grid' });
      for (const it of open.slice(0, this.shown)) {
        const c = this.card(it, mode ? el => { td.has(it.file.path) ? td.delete(it.file.path) : td.add(it.file.path); mk(el); updDel(); } : null);
        const ok = h('span', { class: 'am-dump-ok' }, '✓'), mk = el => { const on = td.has(it.file.path); el.classList.toggle('am-on', on); ok.hidden = !on; };
        if (mode) { c.classList.add('am-card-sel'); c.append(ok); mk(c); }
        grid.append(c);
      }
      body.append(grid);
      if (mode) { body.querySelectorAll('.am-dump-bar').forEach(b => b.remove()); body.append(h('div', { class: 'am-bar' }, delBtn)); updDel(); }
      if (open.length > this.shown) body.append(h('button', { class: 'am-more', onclick: () => { this.shown += PAGE; again(); } }, 'Meer laden'));
    }
  }
  /* ---------- logboek: één notitie per dag (Logboek/JJJJ-MM-DD.md), dezelfde als in de visualisator ---------- */
  async renderLogboek(body, again) {
    const P = this.plugin, today = isoDay(Date.now()), d = this.lbDag || (this.lbDag = today);
    const old = await P.logRead(d);
    await this.renderKlok(body, d, again);
    const date = h('input', { type: 'date', value: d, max: today });
    date.addEventListener('change', () => { if (!date.value) return; if (this.lbDirty && !confirm('Je notitie is nog niet bewaard. Toch naar een andere dag?')) { date.value = d; return; } this.lbDirty = false; this.lbDag = date.value; again(); });
    const ta = h('textarea', { class: 'am-log-ta', rows: 9, placeholder: 'Wat deed je vandaag, wat lukte, wat niet, wat wil je morgen proberen?' }); ta.value = old;
    const save = h('button', { class: 'am-save', disabled: true }, old ? 'Bewaard' : 'Opslaan');
    ta.addEventListener('input', () => { this.lbDirty = ta.value.trim() !== old; save.disabled = !this.lbDirty; save.textContent = 'Opslaan'; });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try { const leeg = !ta.value.trim() && !(await P.werk(d)).length; await P.logWrite(d, ta.value); this.lbDirty = false; new Notice(ta.value.trim() ? 'Logboek bewaard' : leeg ? 'Lege notitie weggehaald (staat in .trash)' : 'Notitie leeggemaakt (de werktijden blijven staan)'); P.sync(); setTimeout(again, 300); }
      catch (e) { console.error(e); new Notice('Bewaren lukte niet: ' + (e && e.message || e), 8000); save.disabled = false; }
    });
    const step = n => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); const nd = isoDay(x); if (nd > today) return; if (this.lbDirty && !confirm('Je notitie is nog niet bewaard. Toch naar een andere dag?')) return; this.lbDirty = false; this.lbDag = nd; again(); };
    body.append(h('div', { class: 'am-log-day' }, h('button', { class: 'am-log-step', 'aria-label': 'dag eerder', onclick: () => step(-1) }, '‹'), date, h('button', { class: 'am-log-step', 'aria-label': 'dag later', disabled: d >= today, onclick: () => step(1) }, '›')));
    body.append(h('div', { class: 'am-field' }, h('label', {}, d === today ? 'Vandaag' : fmtD(d)), ta));
    await this.renderWerk(body, d, again);
    // wat je die dag aan het archief toevoegde
    const made = this.data.items.filter(it => it.datum === d);
    if (made.length) {
      body.append(h('h4', { class: 'am-sub' }, `Die dag in je archief (${made.length})`));
      const grid = h('div', { class: 'am-grid' }); for (const it of made.slice(0, 12)) grid.append(this.card(it)); body.append(grid);
    }
    const days = P.logDays().filter(x => x !== d).slice(0, 14);
    if (days.length) {
      body.append(h('h4', { class: 'am-sub' }, 'Eerdere dagen'));
      const list = h('div', { class: 'am-log-list' });
      for (const x of days) list.append(h('button', { class: 'am-log-item', onclick: () => { if (this.lbDirty && !confirm('Je notitie is nog niet bewaard. Toch naar een andere dag?')) return; this.lbDirty = false; this.lbDag = x; again(); this.contentEl.scrollTop = 0; } }, h('b', {}, fmtD(x), h('span', { class: 'am-log-uren' })), h('span', { class: 'am-log-prev' }, '…')));
      body.append(list);
      // een stukje van elke notitie erbij, en hoe lang je die dag werkte
      days.forEach(async (x, i) => {
        const raw = await P.logRaw(x), c = list.children[i]; if (!c) return;
        c.querySelector('.am-log-prev').textContent = short(raw.replace(LOG_FM, '').trim().replace(/\s+/g, ' '), 70);
        const w = parseWerk(raw); if (w.length) c.querySelector('.am-log-uren').textContent = ` · ⏱ ${fmtDur(werkMin(x, w))}${w.some(y => !y.tot) ? ' (loopt)' : ''}`;
      });
    }
    body.append(h('div', { class: 'am-bar' }, save));
  }
  // de klok bovenaan het logboek: één knop (inklokken / uitklokken), met vandaag en deze week eronder
  async renderKlok(body, d, again) {
    const P = this.plugin, today = isoDay(Date.now()), ma = addDay(today, -((new Date().getDay() + 6) % 7));
    const run = await P.klokLoopt(), week = [];
    for (let i = 0; i < 7; i++) { const x = addDay(ma, i); if (x > today) break; week.push([x, await P.werk(x)]); }
    const btn = h('button', { class: 'am-klok' + (run ? ' am-klok-aan' : '') }), sub = h('div', { class: 'am-klok-sub' });
    const upd = () => {
      btn.textContent = klokVergeten(run) ? '⏹ Vergeten uit te klokken?' : run ? `⏹ Uitklokken · ${fmtDur(werkMin(run.d, [{ van: run.van, tot: '' }]))}` : '⏱ Inklokken';
      const vd = week.find(([x]) => x === today), wm = week.reduce((n, [x, w]) => n + werkMin(x, w), 0);
      sub.textContent = (run ? `Ingeklokt sinds ${run.d === today ? '' : fmtD(run.d) + ' '}${run.van} · ` : '') + `vandaag ${fmtDur(vd ? werkMin(today, vd[1]) : 0)} · deze week ${fmtDur(wm)}`;
    };
    upd();
    clearInterval(this.klokTimer);
    if (run) this.klokTimer = setInterval(() => { if (!btn.isConnected) return clearInterval(this.klokTimer); upd(); }, 20000);
    btn.addEventListener('click', async () => {
      if (this.lbDirty && !confirm('Je notitie is nog niet bewaard. Toch in- of uitklokken? (de notitie blijft in het vak staan)')) return;
      // vergeten uit te klokken: vragen tot hoe laat je werkte
      let eind = '';
      if (klokVergeten(run)) {
        eind = await new Promise(res => {
          let uit = null; const M = this.sheet('Vergeten uit te klokken?', () => res(uit));
          const t = h('input', { type: 'time', class: 'am-klok-eind', value: eindGok(run.van) });
          M.set(h('p', { class: 'am-hint' }, `De klok loopt nog sinds ${fmtD(run.d)} ${run.van}. Tot hoe laat werkte je toen?`), t,
            h('button', { class: 'am-primary am-wide', onclick: () => { if (!/^\d\d:\d\d$/.test(t.value)) return t.focus(); uit = t.value; M.close(); } }, 'Bewaar eindtijd'));
        });
        if (!eind) return;
      }
      btn.disabled = true;
      try {
        const r = await P.klok(eind); new Notice(r.msg, r.dag ? 10000 : 4000);
        if (r.dag) { this.lbDirty = false; this.lbDag = r.dag; }
        P.sync(); setTimeout(again, 300);
      } catch (e) { console.error(e); new Notice('In- of uitklokken lukte niet: ' + (e && e.message || e), 8000); btn.disabled = false; }
    });
    body.append(h('div', { class: 'am-klok-box' }, btn, sub));
  }
  // de werktijden van de gekozen dag: aanpassen (bijvoorbeeld als je vergat uit te klokken), weghalen of erbij zetten
  async renderWerk(body, d, again) {
    const P = this.plugin, list = await P.werk(d), box = h('div', { class: 'am-werk' });
    const save = async rows => {
      if (rows.filter(w => !w.tot).length > 1) return new Notice('Maar één tijd mag zonder eindtijd zijn (de klok die nog loopt).', 6000);
      try { await P.werkSave(d, () => rows); new Notice('Werktijden bewaard'); P.sync(); setTimeout(again, 300); }
      catch (e) { console.error(e); new Notice('Bewaren lukte niet: ' + (e && e.message || e), 8000); }
    };
    const row = (w, i) => {
      const van = h('input', { type: 'time', value: w.van, 'aria-label': 'begin' }), tot = h('input', { type: 'time', value: w.tot, 'aria-label': 'eind' });
      const nieuw = i == null;
      // een bestaande tijd wordt meteen bewaard; een nieuwe pas als begin en eind er allebei staan
      const changed = () => {
        if (!van.value) return;
        if (nieuw) { if (tot.value) save([...list, { van: van.value, tot: tot.value }]); return; }
        if (!tot.value && list[i].tot) { tot.value = list[i].tot; return; } // een eindtijd leeg maken zou de klok weer laten lopen
        save(list.map((x, j) => j === i ? { van: van.value, tot: tot.value } : x));
      };
      van.addEventListener('change', changed); tot.addEventListener('change', changed);
      return h('div', { class: 'am-werk-row' }, van, h('span', {}, '–'), tot, !w.tot && !nieuw ? h('span', { class: 'am-werk-loopt' }, 'loopt') : null,
        h('button', { class: 'am-werk-del', 'aria-label': 'weghalen', onclick: () => nieuw ? again() : confirm(`${w.van}–${w.tot || '…'} weghalen?`) && save(list.filter((x, j) => j !== i)) }, '×'));
    };
    list.forEach((w, i) => box.append(row(w, i)));
    const add = h('button', { class: 'am-werk-add', onclick: () => { add.before(row({ van: '', tot: '' })); add.remove(); } }, '+ Werktijd toevoegen');
    box.append(add);
    body.append(h('div', { class: 'am-field' }, h('label', {}, `Gewerkt${list.length ? ' · ' + fmtDur(werkMin(d, list)) : ''}`), box));
  }
  // gekozen foto's aanvullen; na opslaan gaan ze uit Inladen weg (naar .trash)
  async dumpToNew(chosen) {
    const n = new Notice('Foto\'s klaarzetten…', 0);
    try {
      this.resetForm(); const F = this.form;
      for (const f of chosen) {
        const file = new File([await this.app.vault.readBinary(f)], f.name, { type: mimeOf(f.extension), lastModified: f.stat.mtime });
        file.dumpPath = f.path;
        F.files.push(file); F.previews.push(isImg(file) ? URL.createObjectURL(file) : ''); F.dates.push(await fileDate(file));
      }
      this.pickDate(); this.dumpSel.clear(); F.vullen = true; this.tab = 'aanvullen'; this.editing = null;
    } catch (e) { console.error(e); new Notice('Dat lukte niet: ' + (e && e.message || e), 8000); }
    n.hide(); await this.render(); this.contentEl.scrollTop = 0;
  }
  renderEdit(body) {
    const E = this.editing, again = () => { const y = this.contentEl.scrollTop; this.render().then(() => { this.contentEl.scrollTop = y; }); };
    body.append(h('button', { class: 'am-back', onclick: async () => { const st = E.stroom; this.editing = null; await this.render(); if (st) this.openStroom(st); } }, E.stroom ? '‹ Terug naar de stroom' : '‹ Terug'));
    const fotos = E.it.imgs && E.it.imgs.length ? E.it.imgs : E.it.img ? [E.it.img] : [];
    if (fotos.length === 1) body.append(h('img', { class: 'am-big', src: this.app.vault.getResourcePath(fotos[0]) }));
    else if (fotos.length > 1) {
      // meer foto's in één item: met de pijltjes (of vegen) erdoorheen
      const n = fotos.length; E.fi = Math.min(E.fi || 0, n - 1);
      const im = h('img', { class: 'am-big', src: this.app.vault.getResourcePath(fotos[E.fi]) }), cnt = h('span', { class: 'am-foto-n' }, `${E.fi + 1} / ${n}`);
      const go = d => { E.fi = (E.fi + d + n) % n; im.src = this.app.vault.getResourcePath(fotos[E.fi]); cnt.textContent = `${E.fi + 1} / ${n}`; };
      let x0 = null;
      im.addEventListener('pointerdown', e => { x0 = e.clientX; });
      im.addEventListener('pointerup', e => { if (x0 != null && Math.abs(e.clientX - x0) > 40) go(e.clientX < x0 ? 1 : -1); x0 = null; });
      body.append(h('div', { class: 'am-foto' }, im,
        h('button', { class: 'am-foto-pijl am-foto-prev', 'aria-label': 'vorige foto', onclick: () => go(-1) }, '‹'),
        h('button', { class: 'am-foto-pijl am-foto-next', 'aria-label': 'volgende foto', onclick: () => go(1) }, '›'), cnt));
    }
    body.append(h('h3', { class: 'am-title' }, E.it.title));
    const d = h('input', { type: 'date', value: E.datum });
    d.addEventListener('change', () => { E.datum = d.value; });
    body.append(h('div', { class: 'am-field' }, h('label', {}, 'Datum'), d));
    body.append(this.lijnBlock(E.lijnen, again, { holder: E, get: () => E.datum, set: d => { E.datum = d; }, skip: E.it.file.path })); if (!E.it.idee) body.append(...this.tagAndProducts(E, again));
    const save = h('button', { class: 'am-save' }, 'Opslaan');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await this.plugin.updateItem(E.it.file, { ...E, ...this.plugin.keepProducts(E.tags, E.producten, E.onbekend, this.data.products) });
        if (plekOk(E.plek, E.datum, E.lijnen)) await this.plugin.applyPlek(E.plek, E.it.file.path, true);
        new Notice('Opgeslagen'); const st = E.stroom; this.editing = null; this.plugin.sync();
        // even wachten tot Obsidian de notitie opnieuw heeft gelezen; kwam je uit de stroom, dan weer daarheen
        setTimeout(async () => { await this.render(); if (st) this.openStroom(st); }, st ? 700 : 300);
      } catch (e) { console.error(e); new Notice('Opslaan mislukt: ' + (e && e.message || e), 8000); save.disabled = false; }
    });
    body.append(h('div', { class: 'am-bar' }, save));
  }
}
