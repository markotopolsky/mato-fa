🟢 TERAZ — Phase 1: PDF → PNG

Toto máme prakticky hotové.

Čo ešte spraviť teraz

1. Final sanity check
Claude nech iba vypíše:

ktoré súbory zmenil,
finálny project tree,
aké testy spustil,
čo presne prešlo.

Bez ďalšieho refactoru.

2. Manuálny test reálnych faktúr
Zobrať cca 5–10 reálnych PDF.

Skontrolovať:

page count,
či každá stránka vyrenderuje,
ostrosť textu,
tabuľky,
malé fonty,
obrázky/fotky,
či sa nič neoreže,
reálny render time,
veľkosť PNG.

3. Zatiaľ uzamknúť 200 DPI
Neriešiť optimalizáciu. 200 DPI je náš baseline.

🟡 NEXT — Phase 2: PNG → Qwen

Toto je ďalší skutočný krok.

Pipeline:

PDF
 ↓
MuPDF
 ↓
PNG
 ↓
Qwen3.8 Max
 ↓
Structured JSON
 ↓
UI
V tejto fáze testujeme hlavne:

A. Extraction accuracy

invoice number
dates
supplier/customer
totals
VAT
IBAN
payment reference
line items

B. Kompletnosť
Najmä tvoj problém:

20 položiek vs 25 položiek.

Potrebujeme zistiť:
koľko položiek Qwen reálne vynechá.

C. Multi-page
Či Qwen spracuje napríklad 3-stranovú faktúru ako jeden dokument.

D. Cost
Pri každej faktúre chceme zapisovať:

input tokens,
output tokens,
total tokens,
cost,
latency.
🟡 Phase 2.5 — Ground Truth

Toto by som nepreskočil.

Vyberieme napríklad:

30–50 faktúr.

Ku každej budeme mať ručne správny výsledok.

Napr.:

invoice_001

Ground truth:
total = 1542.33

Qwen:
total = 1542.33

Potom automaticky:

Qwen vs Ground Truth

A začneme mať čísla.

Nie:

„Qwen je fakt dobrý.“

Ale:

„Qwen má 99.2 % accuracy na totals.“

To je obrovský rozdiel.

🟡 Phase 3 — Deterministic Validation

Až keď uvidíme Qwen output.

Potom pridáme:

Qwen
 ↓
JSON
 ↓
validation

Príklady:

subtotal + VAT ≈ total
sum(items) ≈ subtotal
IBAN checksum
required field types

A hlavne:

AI = extraction
Code = verification

To je jedna z najdôležitejších zásad celého systému.

🟠 Phase 4 — Error handling / second pass

Až keď máme dáta.

Potom môžeme urobiť:

Qwen
 ↓
validation
 ↓
PASS → done

alebo:

Qwen
 ↓
validation FAIL
 ↓
higher resolution
 ↓
Qwen again

A až potom prípadne:

still bad
 ↓
PaddleOCR / secondary model

Čiže PaddleOCR zatiaľ backlog.

Nie default pipeline.

🟠 Phase 5 — Adaptive pipeline

Keď budeme mať benchmark, môžeme zistiť:

150 DPI
200 DPI
300 DPI

a porovnať:

DPI	Accuracy	Cost	Time
150	?	?	?
200	?	?	?
300	?	?	?

A možno zistíme:

95 % faktúr → 150 DPI
4 % → 200 DPI
1 % → 300 DPI

To by bolo oveľa lepšie než blind-force 300 DPI na všetko.

🔴 BACKLOG — zatiaľ na to nesiahame

Toto je budúcnosť, nie dnešná robota.

Reliability
automatic retries
exponential backoff
idempotency
timeout handling
stuck-job detection
provider failover
Credit protection

Tvoja veľmi dôležitá obava:

render error
→ nesmie zavolať Qwen

Qwen error
→ nesmie sa nekontrolovane opakovať

same invoice
→ nesmie sa spracovať 5×

To bude neskôr veľmi dôležité.

PDF robustness
encrypted PDF fixtures
rotated documents
transparency
huge raster PDFs
weird page dimensions
corrupted documents
PDF with 100+ pages
OCR / secondary extraction
PaddleOCR
second vision model
disagreement detection
field-level fallback

Až podľa dát.

Template intelligence

Ak zistíme, že napr.:

Supplier A → 30 % faktúr
Supplier B → 20 %
SAP template → 40 %

môžeme robiť:

template detection
→ specialized extraction strategy

To môže dramaticky zvýšiť accuracy aj znížiť cost.

Evidence / explainability

Veľmi zaujímavé neskôr:

total = €1,234.55

source:
page 1
bounding box [x,y,w,h]

Klikneš na hodnotu → zobrazí sa miesto v PDF.

Toto by som osobne chcel mať.

🔵 A úplne na konci: Production architecture

Až keď vieme, že extraction funguje.

Potom:

Next.js
   ↓
API
   ↓
Queue / worker
   ↓
PDF processor
   ↓
Qwen
   ↓
Validation
   ↓
DB
   ↓
Human review

A tam príde:

authentication
database
audit log
persistent storage
queues
concurrency control
monitoring
rate limiting
permissions
encryption
backups
observability

Nie teraz.

Môj „roadmap na stenu“
✅ Phase 1
PDF → PNG
     ↓
     test rendering

➡️ Phase 2
PNG → Qwen
     ↓
     JSON

➡️ Phase 2.5
Ground truth
     ↓
     accuracy benchmark

➡️ Phase 3
Deterministic validation

➡️ Phase 4
Error handling + second pass

➡️ Phase 5
Adaptive DPI / optimization

⏳ Backlog
PaddleOCR
Templates
Bounding boxes
Retries
Credit protection
Queues
DB
Auth
Production infrastructure
Jedna vec by som teraz spravil okamžite

Nechaj Phase 1 zavretú.

Sprav 5–10 reálnych faktúr.

Potom mi daj výsledok typu:

10 PDFs
18 pages
18/18 rendered
200 DPI
average render time: X ms
average PNG size: X MB
problematic cases: X

A potom ideme rovno na Phase 2 — Qwen. To je teraz najcennejší experiment.