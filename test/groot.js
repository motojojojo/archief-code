// Grote NEP-kluis: ?groot=400 op een testpagina voegt zoveel verzonnen items toe aan test/kluis (alleen in het geheugen).
// De plaatjes zijn die van test/kluis, steeds opnieuw gebruikt. Zo kun je snelheid en drukte testen zonder echte data.
window.NEP_GROOT = n => {
  let s = 11; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647, pick = a => a[Math.floor(rnd() * a.length)];
  const imgs = ['Klei gebakken 1.jpg', 'Metaal roest 1.jpg', 'Kleurstaal papier 1.jpg', 'Papier in de regen 1.jpg', 'Papier in de regen 2.jpg', 'Klei met textiel 1.jpg', 'Klei met textiel 2.jpg', 'Klei met textiel 3.jpg', 'Eerste proef met klei 1.jpg', 'Eerste proef met klei 2.jpg', 'Losse schets 1.jpg', 'groot 1.jpg', 'groot 2.jpg', 'groot 3.jpg'];
  const proj = ['Reeks rood', 'Reeks blauw', 'Vormen in was', 'Stof en draad', 'Licht en schaduw', 'Buiten gevonden', 'Gips proeven', 'Drukwerk', 'Kleine maquettes', 'Video schetsen', 'Verf op hout', 'Restmateriaal'];
  const tags = ['papier', 'klei', 'textiel', 'metaal', 'materiaal-onderzoek', 'beeld-onderzoek', 'vorm-onderzoek', 'atelier', 'buiten', 'school', 'verven', 'gieten', 'naaien'];
  const soorten = ['bouwt voort op', 'inspireerde', 'tegenstelling'], out = [], t0 = Date.UTC(2024, 0, 8), perProj = {};
  for (let i = 0; i < n; i++) {
    const idee = i % 11 === 5, p = i % 23 === 7 ? '' : proj[Math.floor(rnd() * rnd() * proj.length)], titel = `${idee ? 'Idee' : 'Nep'} ${String(i + 1).padStart(4, '0')}`;
    const d = new Date(t0 + Math.floor(i * 1000 / n) * 86400000).toISOString().slice(0, 10), eerder = perProj[p] || (perProj[p] = []);
    const L = [`datum: ${d}`, `project: ${p}`, `type: ${idee ? 'idee' : ''}`, 'tags:', ...[...new Set([pick(tags), pick(tags), ...(idee ? ['idee'] : [])])].map(t => '  - ' + t)];
    if (idee) { L.push('rang: ' + pick(['klein', 'middel', 'groot'])); if (eerder.length) L.push(`aan: "[[${eerder[eerder.length - 1]}]]"`, 'kant: ' + pick(['boven', 'onder'])); }
    else if (i % 7 === 3 && out.length > 20) L.push('verbanden:', `  - "[[${out[out.length - 3 - Math.floor(rnd() * 15)].titel}]] | ${pick(soorten)}"`);
    if (!idee && i % 9 === 0) L.push('producten:', '  - "[[Testverf]]"');
    const k = idee ? 1 : i % 13 === 0 ? 0 : 1 + (i % 5 === 0) + (i % 10 === 0);
    const body = Array.from({ length: k }, (_, j) => `![[${imgs[(i + j * 3) % imgs.length]}]]`).join('\n') + `\n\nVerzonnen item ${i + 1}: een proef met ${pick(tags)} en ${pick(tags)}.`;
    if (!idee) eerder.push(titel);
    out.push({ titel, path: `${idee ? 'Ideeën' : 'Onderzoek'}/${titel}.md`, text: `---\n${L.join('\n')}\n---\n\n${body}\n` });
  }
  return out;
};
window.NEP_N = +new URLSearchParams(location.search).get('groot') || 0;
