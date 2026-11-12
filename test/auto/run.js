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
