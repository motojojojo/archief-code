// Nep-mapkiezer voor de Visualisator: doet alsof test/kluis de gekozen Archief-map is.
// Lezen komt uit test/kluis (via files.json); schrijven blijft in het geheugen van dit tabblad,
// dus niets aan de testmap verandert echt. window.MOCKFS.dump() laat zien wat er geschreven is.
(() => {
  const BASE = new URL('kluis/', document.currentScript ? document.currentScript.src : location.href).href;
  const err = n => Object.assign(new Error(n + ' niet gevonden'), { name: 'NotFoundError' });
  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  class FH {
    constructor(name, path, data) { this.kind = 'file'; this.name = name; this.path = path; this.data = data; this.mtime = Date.now(); }
    async getFile() {
      if (this.data === undefined) this.data = await (await fetch(BASE + enc(this.path))).blob();
      return new File([this.data], this.name, { lastModified: this.mtime, type: this.data.type || '' });
    }
    async createWritable() {
      const parts = [], fh = this;
      return { async write(d) { parts.push(d && d.data !== undefined ? d.data : d); }, async truncate() { parts.length = 0; }, async close() { fh.data = new Blob(parts); fh.mtime = Date.now(); WRITES.push(fh.path); } };
    }
    async isSameEntry(o) { return o === this; }
    async queryPermission() { return 'granted'; } async requestPermission() { return 'granted'; }
  }
  class DH {
    constructor(name, path) { this.kind = 'directory'; this.name = name; this.path = path; this.kids = new Map(); }
    async *entries() { for (const [n, h] of [...this.kids]) yield [n, h]; }
    async *values() { for (const h of [...this.kids.values()]) yield h; }
    async *keys() { for (const n of [...this.kids.keys()]) yield n; }
    [Symbol.asyncIterator]() { return this.entries(); }
    sub(n) { return this.path ? this.path + '/' + n : n; }
    async getFileHandle(n, o) { let h = this.kids.get(n); if (h && h.kind !== 'file') throw Object.assign(new Error(n), { name: 'TypeMismatchError' }); if (!h) { if (!(o && o.create)) throw err(n); h = new FH(n, this.sub(n), new Blob([])); this.kids.set(n, h); } return h; }
    async getDirectoryHandle(n, o) { let h = this.kids.get(n); if (h && h.kind !== 'directory') throw Object.assign(new Error(n), { name: 'TypeMismatchError' }); if (!h) { if (!(o && o.create)) throw err(n); h = new DH(n, this.sub(n)); this.kids.set(n, h); } return h; }
    async removeEntry(n) { if (!this.kids.delete(n)) throw err(n); WRITES.push('weg: ' + this.sub(n)); }
    async isSameEntry(o) { return o === this; }
    async resolve(h) { return h.path ? h.path.split('/') : null; }
    async queryPermission() { return 'granted'; } async requestPermission() { return 'granted'; }
  }
  const WRITES = [];
  const root = new DH('kluis', '');
  const ready = fetch(new URL('../files.json', BASE).href).then(r => r.json()).then(list => {
    for (const p of list) {
      const parts = p.split('/'); let d = root;
      for (const q of parts.slice(0, -1)) { if (!d.kids.has(q)) d.kids.set(q, new DH(q, d.sub(q))); d = d.kids.get(q); }
      const n = parts[parts.length - 1]; d.kids.set(n, new FH(n, p));
    }
  });
  window.showDirectoryPicker = async () => { await ready; return root; };
  window.MOCKFS = { root, ready, writes: WRITES, async dump(p) { const h = await p.split('/').slice(0, -1).reduce(async (d, q) => (await d).getDirectoryHandle(q), Promise.resolve(root)); return (await (await h.getFileHandle(p.split('/').pop())).getFile()).text(); } };
})();
