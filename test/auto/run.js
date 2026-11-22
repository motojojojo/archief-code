// Vaste tests voor de Visualisator en de telefoon-plugin, op de NEP-kluis (test/kluis).
// Draaien:  cd test/auto && npm install && npx playwright install chromium && npm test
// (start zelf een testserver op poort 8770 vanuit de hoofdmap; staat er geen, dan start dit script er een)
const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..'), PORT = 8770, URL0 = `http://localhost:${PORT}/test/`;
const TYPES = { html: 'text/html', js: 'text/javascript', json: 'application/json', css: 'text/css', png: 'image/png', jpg: 'image/jpeg', md: 'text/markdown' };
const serve = () => new Promise(res => {
  const s = http.createServer((q, r) => {
    const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': TYPES[f.split('.').pop().toLowerCase()] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
  });
  s.once('error', () => res(null)); s.listen(PORT, () => res(s)); // poort bezet = er draait al een testserver
});
let fouten = 0, n = 0;
const ok = (wat, goed, extra = '') => { n++; if (!goed) fouten++; console.log(`${goed ? '  ok  ' : '  FOUT'} ${wat}${goed ? '' : ' ' + extra}`); };
const deel = async (naam, fn) => { console.log('\n' + naam); try { await fn(); } catch (e) { fouten++; console.log('  FOUT (gestopt): ' + String(e && e.message || e).split('\n')[0]); } };

(async () => {
  const server = await serve(), b = await chromium.launch();

  // ---------- versie ----------
  await deel('Versie van de plugin', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/archief-mobiel/manifest.json'), 'utf8')).version;
    const c = (fs.readFileSync(path.join(ROOT, 'plugin/archief-mobiel/main.js'), 'utf8').match(/const BUILD = '([^']+)'/) || [])[1];
    ok(`manifest.json en BUILD zijn gelijk (${m})`, m === c, `manifest ${m}, BUILD ${c}`);
  });

  // ---------- Visualisator ----------
  for (const f of ['index.html', 'experiment.html']) await deel('Visualisator: ' + f, async () => {
    const p = await b.newPage({ viewport: { width: 1440, height: 860 } }), errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${URL0}visualisator.html?f=${f}`); await p.waitForFunction(() => typeof items !== 'undefined' && items.length >= 10, null, { timeout: 20000 }); await p.waitForTimeout(2500);
    ok('laadt de nepkluis (10 items)', await p.evaluate(() => items.length) === 10);
    ok('Stroom toont alle items', await p.$$eval('#stroom-g .node', e => e.length) >= 9);
    // slepen verschuift, het wiel zoomt, en een klik na slepen opent niets
    const tr = () => p.$eval('#stroom-g', e => e.getAttribute('transform'));
    const t0 = await tr(); await p.mouse.move(700, 660); await p.mouse.down(); await p.mouse.move(620, 640, { steps: 5 }); await p.mouse.up(); await p.waitForTimeout(300);
    const t1 = await tr(); ok('slepen verschuift de Stroom', t0 !== t1);
    await p.mouse.wheel(0, -300); await p.waitForTimeout(300); ok('het muiswiel zoomt', (await tr()) !== t1);
    await p.click('[data-z="fit"]'); await p.waitForTimeout(200);
    await p.click('#stroom-g .node >> nth=0'); await p.waitForTimeout(400);
    ok('klik op een item opent het', await p.evaluate(() => !!selected));
    for (const v of ['ideeen', 'beeldbank', 'netwerk', 'raster', 'producten', 'inbox', 'stroom']) { await p.click(`#tabs [data-view="${v}"]`); await p.waitForTimeout(250); ok('tabblad ' + v, await p.$eval('#view-' + v, e => e.classList.contains('on'))); }
    // de klok: in de nepkluis is op 6 nov vergeten uit te klokken
    await p.click('#tabs [data-view="raster"]'); await p.waitForTimeout(300);
    ok('klok meldt vergeten uitklokken', /Vergeten/.test(await p.textContent('#lb-klok')));
    p.once('dialog', d => d.accept('16:45')); await p.click('#lb-klok'); await p.waitForTimeout(900);
    ok('eindtijd wordt bewaard', /13:10-16:45/.test(await p.evaluate(() => MOCKFS.dump('Logboek/2026-11-06.md'))));
    ok('daarna gewoon inklokken', /Inklokken/.test(await p.textContent('#lb-klok')));
    ok('geen fouten in de pagina', !errs.length, errs.join(' | ')); await p.close();
  });
  await deel('Visualisator met 400 items', async () => {
    const p = await b.newPage({ viewport: { width: 1440, height: 860 } }), errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${URL0}visualisator.html?groot=400`); await p.waitForFunction(() => typeof items !== 'undefined' && items.length >= 400, null, { timeout: 40000 }); await p.waitForTimeout(1500);
    ok('laadt 410 items', await p.evaluate(() => items.length) === 410);
    ok('geen fouten in de pagina', !errs.length, errs.join(' | ')); await p.close();
  });
  for (const f of ['index.html', 'experiment.html']) await deel('Beeldbank: beelden uit je archief (' + f + ')', async () => {
    const p = await b.newPage({ viewport: { width: 1440, height: 860 } }), errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${URL0}visualisator.html?f=${f}`); await p.waitForFunction(() => typeof items !== 'undefined' && items.length >= 10, null, { timeout: 20000 }); await p.waitForTimeout(1500);
    await p.click('#tabs [data-view="beeldbank"]'); await p.waitForTimeout(400);
    const n0 = await p.evaluate(() => bankEntries.length);
    await p.click('#bb-pick'); await p.click('[role=menuitem]:has-text("Uit je archief")'); await p.waitForTimeout(300);
    await p.click('.bb-dumppick .ib >> nth=0'); await p.click('.bb-dumppick [data-dp="go"]');
    await p.waitForFunction(n => bankEntries.length === n + 1, n0, { timeout: 10000 }).catch(() => {});
    ok('beeld uit archief komt in de beeldbank', await p.evaluate(() => bankEntries.length) === n0 + 1);
    ok('kopie heeft een eigen naam', await p.evaluate(() => bankEntries.some(e => / \(beeldbank\)\./.test(e.path))));
    ok('items wijzen nog naar het origineel', await p.evaluate(() => !items.some(it => (it.imgs || []).some(im => im && im.entry && im.entry.path.startsWith('Beeldbank/')))));
    await p.evaluate(() => document.getElementById('bb-pick').click()); await p.click('[role=menuitem]:has-text("Uit je archief")'); await p.waitForTimeout(300);
    ok('al gekozen beeld staat als "al in beeldbank"', await p.$$eval('.bb-dumppick .ib.al', e => e.length) === 1);
    await p.keyboard.press('Escape');
    ok('geen fouten in de pagina', !errs.length, errs.join(' | ')); await p.close();
  });

  await deel('Beeldbank: gooien, botsen, box-rand en plaatsen', async () => {
    const p = await b.newPage({ viewport: { width: 1440, height: 860 } }), errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${URL0}visualisator.html`); await p.waitForFunction(() => typeof items !== 'undefined' && items.length >= 10, null, { timeout: 20000 }); await p.waitForTimeout(1500);
    await p.click('#tabs [data-view="beeldbank"]'); await p.waitForTimeout(4000);
    ok('beelden overlappen elkaar niet', await p.evaluate(() => { const L = [...sky.st.values()]; let n = 0; for (const a of L) for (const c of L) if (a !== c && (a.box || null) === (c.box || null) && a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h) n++; return n === 0; }));
    ok('boxnaam ligt boven de beelden', await p.$eval('.bb-box-head', e => getComputedStyle(e).zIndex === '4'));
    // een vrij beeld met de muis naar net binnen de rand van de box gooien
    const doel = await p.evaluate(() => {
      const g = document.getElementById('bb-grid'), R = g.getBoundingClientRect(), B = boxPx(bankBoxes()[0]), el = sky.els.find(e => !sky.st.get(e.dataset.bb).box), s = sky.st.get(el.dataset.bb);
      sky.v = { x: R.width / 2 - (B.x + B.w / 2), y: R.height / 2 - (B.y + B.h / 2), k: Math.min(1, R.width * .5 / (B.w + 400), R.height * .8 / B.h) }; skyApply();
      s.x = B.x - s.w - 120; s.y = B.y + B.h / 2 - s.h / 2; s.vx = s.vy = 0; s.hover = false; window.__gooi = el.dataset.bb;
      const k = sky.v.k, scr = (wx, wy) => [R.left + sky.v.x + wx * k, R.top + sky.v.y + wy * k];
      return { van: scr(s.x + s.w / 2, s.y + s.h / 2), naar: scr(B.x + 12, B.y + B.h / 2) };
    });
    await p.waitForTimeout(100);
    await p.mouse.move(...doel.van); await p.mouse.down(); await p.mouse.move(doel.naar[0], doel.naar[1], { steps: 6 }); await p.mouse.up();
    ok('gegooid beeld vliegt nog door', await p.evaluate(() => Math.hypot(sky.st.get(__gooi).vx || 0, sky.st.get(__gooi).vy || 0) > 40));
    await p.waitForTimeout(2500);
    ok('net binnen de rand losgelaten: blijft in de box', await p.evaluate(() => { const s = sky.st.get(__gooi), B = boxPx(bankBoxes()[0]); return s.box === bankBoxes()[0].id && s.x >= B.x - 1 && s.x + s.w <= B.x + B.w + 1; }));
    // meer beelden uit het archief: eerst vragen waar ze moeten komen
    await p.evaluate(() => document.getElementById('bb-pick').click()); await p.click('[role=menuitem]:has-text("Uit je archief")'); await p.waitForTimeout(300);
    await p.click('.bb-dumppick .ib:not(.al) >> nth=0'); await p.click('.bb-dumppick .ib:not(.al) >> nth=2'); await p.click('.bb-dumppick [data-dp="go"]');
    await p.waitForSelector('#bb-plaats', { timeout: 10000 }).catch(() => {});
    ok('"Hier plaatsen?" volgt de muis', await p.evaluate(() => !!document.getElementById('bb-plaats') && sky.wacht && sky.wacht.size === 2));
    await p.mouse.move(300, 700); await p.mouse.click(300, 700); await p.waitForTimeout(400);
    ok('na de klik staan ze er', await p.evaluate(() => !sky.wacht && !document.getElementById('bb-plaats') && !sky.els.some(e => e.style.visibility === 'hidden')));
    ok('geen fouten in de pagina', !errs.length, errs.join(' | ')); await p.close();
  });
  await deel('Beeldbank: niet vastlopen, volle box groeit (ook box in box)', async () => {
    const p = await b.newPage({ viewport: { width: 1440, height: 860 } }), errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${URL0}visualisator.html`); await p.waitForFunction(() => typeof items !== 'undefined' && items.length >= 10, null, { timeout: 20000 }); await p.waitForTimeout(1500);
    await p.click('#tabs [data-view="beeldbank"]'); await p.waitForTimeout(1500);
    // een grote box die bijna het hele vlak vult (zoals bij Milo): losse beelden mogen niet klem komen te zitten
    const k = await p.evaluate(() => {
      const M = bankMeta; M.boxes.push({ id: 'groot', naam: 'Groot', x: .15, y: -.05, w: .7, h: 1.1 }); skyBoxes();
      const k = [...sky.st].find(([, s]) => !s.box)[0], s = sky.st.get(k); s.x = .5 * sky.WW; s.y = -.05 * sky.WH - s.h - 10; s.a = Math.PI / 2; s.vx = s.vy = 0; window.__k = k; window.__p0 = [s.x, s.y]; return k;
    });
    await p.waitForTimeout(6000);
    ok('los beeld naast een grote box zweeft door (loopt niet vast)', await p.evaluate(() => { const s = sky.st.get(__k); return Math.hypot(s.x - __p0[0], s.y - __p0[1]) > 50; }));
    // box in een box: de binnenste vol maken, dan groeien ze allebei en blijft de binnenste erin
    const r = await p.evaluate(() => {
      const M = bankMeta; M.boxes = M.boxes.filter(b => b.id !== 'groot');
      M.boxes.push({ id: 'buiten', naam: 'Buiten', x: .55, y: .55, w: .2, h: .2 }, { id: 'binnen', naam: 'Binnen', x: .56, y: .58, w: .17, h: .15 }); skyBoxes();
      const vrij = [...sky.st].filter(([, s]) => !s.box).slice(0, 4), B = boxPx(M.boxes.find(b => b.id === 'binnen'));
      for (const [k, s] of vrij) { s.box = 'binnen'; s.x = B.x + 10; s.y = B.y + 20; const e = bankEntries.find(x => x.path === k); bankOf(e).box = 'binnen'; }
      const w0 = { bi: M.boxes.find(b => b.id === 'binnen').w, bu: M.boxes.find(b => b.id === 'buiten').w };
      boxGroei();
      const bi = M.boxes.find(b => b.id === 'binnen'), bu = M.boxes.find(b => b.id === 'buiten');
      return { groeiBinnen: bi.w > w0.bi, groeiBuiten: bu.w > w0.bu, erin: boxIn(bi, bu) };
    });
    ok('volle box groeit', r.groeiBinnen);
    ok('de buitenste box groeit mee', r.groeiBuiten);
    ok('de binnenste box ligt er nog helemaal in', r.erin);
    ok('geen fouten in de pagina', !errs.length, errs.join(' | ')); await p.close();
  });
  await deel('Visualisator: verversknop', async () => {
    const p = await b.newPage({ viewport: { width: 1440, height: 860 } }), errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${URL0}visualisator.html`); await p.waitForFunction(() => typeof items !== 'undefined' && items.length >= 10, null, { timeout: 20000 }); await p.waitForTimeout(1500);
    // een nieuwe notitie verschijnt in de map (alsof hij van de telefoon komt)
    await p.evaluate(async () => { const d = await MOCKFS.root.getDirectoryHandle('Onderzoek'); const w = await (await d.getFileHandle('Van de telefoon.md', { create: true })).createWritable(); await w.write(['---', 'datum: 2026-11-01', 'project: Proef B', 'type:', 'tags: []', '---', '', 'Nieuw.', ''].join(String.fromCharCode(10))); await w.close(); });
    await p.click('#btn-ververs'); await p.waitForFunction(() => items.length === 11, null, { timeout: 10000 }).catch(() => {});
    ok('↻ haalt het nieuwe item op', await p.evaluate(() => items.length) === 11);
    ok('geen fouten in de pagina', !errs.length, errs.join(' | ')); await p.close();
  });

  // ---------- telefoon-plugin ----------
  const telefoon = async (dev, q = '') => { const ctx = await b.newContext({ ...devices[dev] }), p = await ctx.newPage(), errs = []; p.on('pageerror', e => errs.push(e.message)); await p.goto(`${URL0}plugin.html${q}`); await p.waitForFunction(() => window.VIEW && document.querySelector('.am-tabs'), null, { timeout: 20000 }); await p.waitForTimeout(600); return { ctx, p, errs }; };
  const lees = (p, t) => p.evaluate(t => PLUGIN.app.vault.read(PLUGIN.app.vault.getMarkdownFiles().find(f => f.basename === t)), t);
  await deel('Telefoon: tabbladen, filter en klok (staand)', async () => {
    const { ctx, p, errs } = await telefoon('iPhone 13');
    await p.tap('.am-tabs button >> nth=1'); await p.waitForTimeout(600);
    ok('Archief toont 10 items', /10 items/.test(await p.textContent('.am-count')));
    ok('filters zitten dicht achter de knop', await p.isHidden('.am-filterbox'));
    await p.tap('.am-filter-btn'); await p.selectOption('.am-filterbox select >> nth=0', 'Proef B'); await p.waitForTimeout(300);
    ok('filter op project werkt', /4 van de 10/.test(await p.textContent('.am-count')) && /1/.test(await p.textContent('.am-filter-btn')));
    await p.tap('.am-tabs button >> nth=0'); await p.waitForTimeout(400); await p.tap('.am-subtabs button >> text=Logboek'); await p.waitForTimeout(800);
    ok('klok meldt vergeten uitklokken', /Vergeten/.test(await p.textContent('.am-klok')));
    await p.tap('.am-klok'); await p.waitForTimeout(300); await p.fill('.am-klok-eind', '16:20'); await p.tap('.am-sheet .am-primary'); await p.waitForTimeout(1000);
    ok('eindtijd wordt bewaard', /13:10-16:20/.test(await p.evaluate(() => STORE.get('Logboek/2026-11-06.md').text)));
    ok('geen fouten in de pagina', !errs.length, errs.join(' | ')); await ctx.close();
  });
  await deel('Telefoon: de stroom (liggend)', async () => {
    const { ctx, p, errs } = await telefoon('iPhone 13 landscape');
    const cdp = await ctx.newCDPSession(p), touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    await p.evaluate(() => VIEW.openStroom()); await p.waitForSelector('.am-stroom canvas'); await p.waitForTimeout(900);
    // waar een item op het scherm staat (via het testhaakje van de plugin)
    const plek = t => p.evaluate(t => { const d = VIEW.sDbg, n = d.SP.all.find(n => n.it.title === t), v = d.v(), b = document.querySelector('.am-stroom canvas').getBoundingClientRect(); return { x: b.left + v.x + n.X * v.k, y: b.top + v.y + n.Y * v.k }; }, t);
    const fit = async () => { await p.tap('.am-stroom .am-tool[title="Alles in beeld"]'); await p.waitForTimeout(700); };
    const gekozen = () => p.$eval('.am-stroom .am-plek-info b', e => e.textContent).catch(() => '');
    const kies = async t => { if (await gekozen() === t) return; await fit(); const q = await plek(t); await p.touchscreen.tap(q.x, q.y); await p.waitForTimeout(700); };
    const K0 = await lees(p, 'Klei gebakken');
    // één vinger schuift (zoomt niet), twee vingers zoomen
    await fit(); const v0 = await p.evaluate(() => ({ ...VIEW.sDbg.v() }));
    await touch('touchStart', [{ x: 400, y: 180 }]); for (let k = 1; k <= 6; k++) { await touch('touchMove', [{ x: 400 - k * 10, y: 180 }]); await p.waitForTimeout(20); } await touch('touchEnd', [{ x: 340, y: 180 }]); await p.waitForTimeout(900);
    const v1 = await p.evaluate(() => ({ ...VIEW.sDbg.v() })); ok('één vinger schuift en zoomt niet', v1.k === v0.k && v1.x < v0.x - 30, JSON.stringify([v0, v1]));
    const A = { x: 380, y: 180, id: 1 }, B = { x: 420, y: 180, id: 2 };
    await touch('touchStart', [A]); await touch('touchStart', [A, B]); for (let k = 1; k <= 8; k++) { await touch('touchMove', [{ ...A, x: A.x - k * 8 }, { ...B, x: B.x + k * 8 }]); await p.waitForTimeout(20); } await touch('touchEnd', [A, B]); await p.waitForTimeout(600);
    ok('twee vingers zoomen', (await p.evaluate(() => VIEW.sDbg.v().k)) > v1.k * 1.5);
    await kies('Klei gebakken');
    ok('tik kiest het item, met Bewerken en Verband leggen', await gekozen() === 'Klei gebakken' && /Bewerken.*Verband leggen/.test(await p.$$eval('.am-sacts button', e => e.map(x => x.textContent).join(' '))));
    ok('de scherpe foto ligt over het item', await p.isVisible('.am-selimg'));
    // verband leggen, veranderen, weghalen, en telkens terugdraaien
    await p.tap('.am-sacts button >> text=Verband leggen'); await fit(); const m = await plek('Metaal roest'); await p.touchscreen.tap(m.x, m.y); await p.waitForTimeout(500);
    await p.tap('.am-sheet .am-vb-row >> nth=1'); await p.waitForTimeout(1800);
    ok('verband leggen', /\[\[Metaal roest\]\] \| inspireerde/.test(await lees(p, 'Klei gebakken')));
    await p.tap('.am-sacts button >> text=Verbanden'); await p.waitForTimeout(300); await p.tap('.am-sheet .am-vb-row >> nth=0'); await p.waitForTimeout(300); await p.tap('.am-sheet button >> text=tegenstelling'); await p.waitForTimeout(1800);
    ok('verband van soort veranderen', /\[\[Metaal roest\]\] \| tegenstelling/.test(await lees(p, 'Klei gebakken')));
    await p.tap('.am-sacts button >> text=Verbanden'); await p.waitForTimeout(300); await p.tap('.am-sheet .am-vb-row >> nth=0'); await p.waitForTimeout(300); await p.tap('.am-sheet button >> text=omdraaien'); await p.waitForTimeout(1800);
    ok('verband omdraaien', !/verbanden/.test(await lees(p, 'Klei gebakken')) && /\[\[Klei gebakken\]\] \| tegenstelling/.test(await lees(p, 'Metaal roest')));
    await p.tap('.am-undo'); await p.waitForTimeout(1800);
    ok('ongedaan maken zet het terug', /\[\[Metaal roest\]\] \| tegenstelling/.test(await lees(p, 'Klei gebakken')) && !/verbanden/.test(await lees(p, 'Metaal roest')));
    await kies('Klei gebakken'); await p.tap('.am-sacts button >> text=Verbanden'); await p.waitForTimeout(300); await p.tap('.am-sheet .am-vb-row >> nth=0'); await p.waitForTimeout(300); await p.tap('.am-sheet button >> text=weghalen'); await p.waitForTimeout(1800);
    ok('verband weghalen', await lees(p, 'Klei gebakken') === K0);
    for (let k = 0; k < 3; k++) { await p.tap('.am-undo'); await p.waitForTimeout(1800); }
    ok('alles teruggedraaid: notitie weer als aan het begin', await lees(p, 'Klei gebakken') === K0 && await p.isDisabled('.am-undo'));
    // product kiezen
    await kies('Klei gebakken'); await p.tap('.am-sprod'); await p.waitForTimeout(300); await p.tap('.am-sheet .am-sprod-row'); await p.waitForTimeout(300); await p.tap('.am-sheet .am-primary'); await p.waitForTimeout(300);
    ok('product kiezen', /\[\[Proefklei\]\]/.test(await lees(p, 'Klei gebakken')));
    await p.tap('.am-undo'); await p.waitForTimeout(1800); ok('product terugdraaien', await lees(p, 'Klei gebakken') === K0);
    // foto's groot
    await kies('Klei met textiel'); const s = await p.$eval('.am-selimg', e => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }); await p.touchscreen.tap(s.x, s.y); await p.waitForTimeout(400);
    ok('nog eens tikken toont de foto groot (1 / 3)', /1 \/ 3/.test(await p.textContent('.am-groot-n').catch(() => '')));
    await touch('touchStart', [{ x: 500, y: 200 }]); await touch('touchMove', [{ x: 400, y: 200 }]); await touch('touchEnd', [{ x: 400, y: 200 }]); await p.waitForTimeout(300);
    ok('vegen bladert (2 / 3)', /2 \/ 3/.test(await p.textContent('.am-groot-n')));
    await p.tap('.am-groot .am-tool'); await p.waitForTimeout(200); ok('sluiten gaat terug naar de stroom', !(await p.$('.am-groot')) && await gekozen() === 'Klei met textiel', `groot: ${!!(await p.$('.am-groot'))}, gekozen: ${await gekozen()}`);
    ok('geen fouten in de pagina', !errs.length, errs.join(' | ')); await ctx.close();
  });
  await deel('Telefoon: plek kiezen in een zijtak', async () => {
    const { ctx, p, errs } = await telefoon('iPhone 13 landscape');
    // een verzonnen item dat al aan het idee hangt: daarnaast moet een nieuwe foto ook in de zijtak kunnen
    await p.evaluate(() => PLUGIN.app.vault.adapter.write('Onderzoek/Klei aan touw.md', '---\ndatum: 2026-09-28\nproject: Testproject A\naan: "[[Idee hangende klei]]"\nkant: rechts\n---\nVerzonnen.\n'));
    await p.evaluate(() => { window.NW = { datum: '2026-10-20' }; VIEW.pickPlek({ holder: NW, get: () => NW.datum, set: d => { NW.datum = d; }, skip: null }, [], () => {}); });
    await p.waitForSelector('.am-plek canvas'); await p.waitForTimeout(700);
    const q = await p.evaluate(() => { const d = VIEW.pDbg, n = d.SP.all.find(n => n.it.title === 'Klei aan touw'), v = d.v(), b = document.querySelector('.am-plek canvas').getBoundingClientRect(); return { x: b.left + v.x + (n.X + 60) * v.k, y: b.top + v.y + n.Y * v.k }; });
    await p.touchscreen.tap(q.x, q.y); await p.waitForTimeout(400);
    ok('na een item in de zijtak: blijft in de zijtak', /zijtak/.test(await p.textContent('.am-plek-info')));
    await p.tap('.am-plek-acts .am-primary'); await p.waitForTimeout(300);
    const pl = await p.evaluate(() => NW.plek);
    ok('hangt aan het idee van die zijtak', !!pl && !!pl.hang && pl.hang.aan === 'Idee hangende klei' && pl.hang.kant === 'rechts', JSON.stringify(pl));
    ok('geen fouten in de pagina', !errs.length, errs.join(' | ')); await ctx.close();
  });
  await deel('Telefoon: stroom met 400 items, plaatjes onthouden', async () => {
    const { ctx, p, errs } = await telefoon('iPhone 13 landscape', '?groot=400');
    let groot = 0, urls = []; p.on('request', r => { if (/kluis\/.*\.(jpe?g|png)$/i.test(r.url())) { groot++; urls.push(decodeURIComponent(r.url().split('/').pop())); } });
    await p.evaluate(() => VIEW.openStroom()); await p.waitForTimeout(800); await p.tap('.am-stroom .am-tool[title="Alles in beeld"]'); await p.waitForTimeout(3000);
    ok("eerste keer: de foto's worden geladen", groot > 0); groot = 0; urls = [];
    await p.reload(); await p.waitForFunction(() => window.VIEW && document.querySelector('.am-tabs')); await p.waitForTimeout(600);
    await p.evaluate(() => VIEW.openStroom()); await p.waitForTimeout(800); await p.tap('.am-stroom .am-tool[title="Alles in beeld"]'); await p.waitForTimeout(2500);
    ok("na opnieuw openen: geen grote foto's meer nodig", groot === 0, groot + ' geladen: ' + urls.join(', '));
    ok('geen fouten in de pagina', !errs.length, errs.join(' | ')); await ctx.close();
  });

  await b.close(); if (server) server.close();
  console.log(`\n${n - fouten} van ${n} goed${fouten ? `, ${fouten} FOUT` : ''}`); process.exit(fouten ? 1 : 0);
})();
