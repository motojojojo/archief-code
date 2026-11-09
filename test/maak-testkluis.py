"""Maakt test/kluis: een kleine NEP-kluis (verzonnen notities en gegenereerde plaatjes)
om de Visualisator en de telefoon-plugin op te testen. Er staat geen echte data in.
Opnieuw maken:  python test/maak-testkluis.py   (vanuit de hoofdmap van de repository)"""
import json, os, random, shutil
from PIL import Image, ImageDraw

HIER = os.path.dirname(os.path.abspath(__file__))
K = os.path.join(HIER, 'kluis')
random.seed(7)
if os.path.isdir(K): shutil.rmtree(K)

def schrijf(pad, tekst):
    p = os.path.join(K, pad); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='utf8', newline='\n').write(tekst)

def plaatje(pad, w, h, kleur):
    p = os.path.join(K, pad); os.makedirs(os.path.dirname(p), exist_ok=True)
    im = Image.new('RGB', (w, h), kleur); d = ImageDraw.Draw(im)
    for _ in range(14):
        x, y, r = random.randrange(w), random.randrange(h), random.randrange(min(w, h) // 12, min(w, h) // 3)
        c = tuple(random.randrange(40, 230) for _ in range(3))
        (d.ellipse if random.random() < .5 else d.rectangle)([x - r, y - r, x + r, y + r], fill=c)
    d.text((12, 12), os.path.basename(pad), fill=(0, 0, 0))
    if pad.endswith('.jpg'): im.save(p, quality=82)
    else: im.save(p)

def fm(velden, body):
    L = ['---']
    for k, v in velden.items():
        if isinstance(v, list):
            L.append(f'{k}:' if v else f'{k}: []'); L += [f'  - {x}' for x in v]
        else: L.append(f'{k}: {v}' if v != '' else f'{k}:')
    return '\n'.join(L) + '\n---\n\n' + body + '\n'

schrijf('.archief/taggroepen.json', json.dumps({'groepen': {
    'materiaal': ['papier', 'klei', 'textiel', 'metaal'],
    'type': ['materiaal-onderzoek', 'beeld-onderzoek', 'idee', 'vorm-onderzoek'],
    'locatie': ['atelier', 'buiten', 'school'],
    'techniek': ['verven', 'gieten', 'naaien']}}, indent=2, ensure_ascii=False))
schrijf('.archief/verbandsoorten.json', json.dumps({'soorten': [
    {'naam': 'bouwt voort op', 'kleur': '#e8c48a', 'stijl': 'lijn'},
    {'naam': 'inspireerde', 'kleur': '#e0915a', 'stijl': 'streep'},
    {'naam': 'tegenstelling', 'kleur': '#d9645c', 'stijl': 'streep'}]}, indent=2, ensure_ascii=False))

# producten
for naam, tags in [('Testverf', ['verven']), ('Proefklei', ['klei'])]:
    schrijf(f'Producten/{naam}.md', fm({'type': 'product', 'tags': tags}, f'Een verzonnen product: {naam}.'))
plaatje('Producten/Testverf.png', 400, 400, (200, 120, 90))

# onderzoek: twee projecten, een keten van verbanden, wat met meerdere plaatjes
notities = [
    ('Eerste proef met klei', '2026-09-02', 'Testproject A', ['materiaal-onderzoek', 'klei', 'atelier'], None, None, 2),
    ('Klei gebakken', '2026-09-09', 'Testproject A', ['materiaal-onderzoek', 'klei'], 'Eerste proef met klei', 'rechts', 1),
    ('Klei met textiel', '2026-09-20', 'Testproject A', ['vorm-onderzoek', 'klei', 'textiel'], 'Klei gebakken', 'rechts', 3),
    ('Kleurstaal papier', '2026-09-05', 'Proef B', ['beeld-onderzoek', 'papier', 'verven'], None, None, 1),
    ('Papier in de regen', '2026-09-14', 'Proef B', ['materiaal-onderzoek', 'papier', 'buiten'], 'Kleurstaal papier', 'onder', 2),
    ('Metaal roest', '2026-10-01', 'Proef B', ['materiaal-onderzoek', 'metaal'], 'Papier in de regen', 'boven', 1),
    ('Losse schets', '2026-10-10', '', ['vorm-onderzoek', 'school'], None, None, 1),
    ('Grote foto test', '2026-10-15', 'Testproject A', ['beeld-onderzoek'], None, None, 0),
]
for i, (titel, datum, proj, tags, aan, kant, n) in enumerate(notities):
    embeds = []
    for j in range(n):
        naam = f'{titel} {j + 1}.jpg'; embeds.append(f'![[{naam}]]')
        plaatje('Bijlagen/' + naam, random.choice([800, 1000, 600]), random.choice([600, 800, 1000]), tuple(random.randrange(120, 250) for _ in range(3)))
    if titel == 'Grote foto test':  # grote plaatjes, om snelheid te testen
        for j in range(3):
            naam = f'groot {j + 1}.jpg'; embeds.append(f'![[{naam}]]'); plaatje('Bijlagen/' + naam, 4000, 3000, (90 + j * 40, 140, 170))
    v = {'datum': datum, 'project': proj, 'type': '', 'tags': tags, 'volgorde': i + 1}
    if aan: v['aan'] = f'"[[{aan}]]"'; v['kant'] = kant
    if titel.startswith('Kleurstaal'): v['producten'] = ['"[[Testverf]]"']
    schrijf(f'Onderzoek/{titel}.md', fm(v, '\n'.join(embeds) + f'\n\nVerzonnen testnotitie over {titel.lower()}.'))

# ideeën
for titel, datum, aan, kant in [('Idee hangende klei', '2026-09-25', 'Klei met textiel', 'boven'), ('Idee papieren muur', '2026-10-05', None, None)]:
    plaatje(f'Ideeën/{titel}.png', 900, 700, (240, 235, 220))
    v = {'datum': datum, 'project': 'Testproject A' if 'klei' in titel else 'Proef B', 'type': 'idee', 'tags': ['idee'], 'rang': 'klein'}
    if aan: v['aan'] = f'"[[{aan}]]"'; v['kant'] = kant
    schrijf(f'Ideeën/{titel}.md', fm(v, f'![[{titel}.png]]\n\nEen verzonnen idee.'))

# logboek
for d, t in [('2026-09-09', 'Klei gebakken en laten afkoelen.'), ('2026-10-01', 'Roestproef buiten gezet.')]:
    schrijf(f'Logboek/{d}.md', f'---\ntype: logboek\ndatum: {d}\n---\n{t}\n')
# logboek met werktijden (in- en uitklokken); "13:10-" zonder eindtijd = de klok loopt nog (hier: vergeten uit te klokken)
for d, tijden, t in [('2026-11-03', ['09:15-12:30', '13:15-17:00'], 'Mal gegoten en laten drogen.'), ('2026-11-04', ['10:00-15:45'], ''),
                     ('2026-11-06', ['13:10-'], 'Schetsen voor de nieuwe serie.'), ('2026-11-09', ['09:00-12:15'], '')]:
    wt = ''.join(f'  - "{x}"\n' for x in tijden)
    schrijf(f'Logboek/{d}.md', f'---\ntype: logboek\ndatum: {d}\nwerktijden:\n{wt}---\n' + (t + '\n' if t else ''))

# beeldbank: losse plaatjes, een box, tags, een tekening en een briefje
beelden = {}
for j in range(8):
    w, h = random.choice([(800, 600), (600, 800), (700, 700), (1200, 500)])
    naam = f'beeld {j + 1}.png'; plaatje('Beeldbank/' + naam, w, h, tuple(random.randrange(60, 200) for _ in range(3)))
    beelden[naam] = {'datum': '2026-11-01', 'bron': 'verzonnen', 'notitie': '', 'tags': ['textuur'] if j % 2 else ['kleur'], 'ar': round(w / h, 4)}
for j in (0, 1, 2): beelden[f'beeld {j + 1}.png']['box'] = 'testbox1'
beelden['beeld 2.png']['tekening'] = [{'c': '#ff5a4f', 'w': 6, 'p': [100, 100, 300, 250, 500, 150, 700, 400]}]
beelden['beeld 2.png']['briefjes'] = [{'x': 120, 'y': 500, 't': 'testbriefje'}]
schrijf('Beeldbank/beeldbank.json', json.dumps({'tags': ['kleur', 'textuur'], 'beelden': beelden,
    'boxes': [{'id': 'testbox1', 'naam': 'Testbox', 'x': .1, 'y': .1, 'w': .3, 'h': .3}]}, indent=2, ensure_ascii=False))

schrijf('Sjablonen/Onderzoek.md', fm({'datum': '', 'project': '', 'type': '', 'tags': []}, ''))

# lijst van alle bestanden (de testpagina's gebruiken die om de kluis na te bootsen)
lijst = sorted(os.path.relpath(os.path.join(r, f), K).replace(os.sep, '/') for r, _, fs in os.walk(K) for f in fs)
open(os.path.join(HIER, 'files.json'), 'w', encoding='utf8').write(json.dumps(lijst, ensure_ascii=False, indent=0))
print(len(lijst), 'bestanden in', K)
