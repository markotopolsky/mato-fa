# Ground-truth fixtures

Each `*.expected.json` is one real invoice read by hand and frozen. `npm run eval`
runs the production extraction path over the matching file in `sources/` and
diffs the result field by field.

`sources/` is git-ignored: the files are real customer invoices.

## These fixtures are the exam, not the answer key

A change that raises the score by naming a specific invoice's column headers,
wording, or layout in the system prompt has made the pipeline worse — it now
measures memorisation instead of ability, and the next unseen invoice will fail.
Prompt rules must describe what invoices are like in general. If a rule cannot
be written without naming one of these documents, do not write it.

The eval cannot detect this. Only reading the prompt can.

## Provenance

Every fixture carries `_verified` and `_notes`. Values came from the PDF text
layer where one exists, so digits are exact rather than read off pixels;
`alimpek-210260059` is a scan with no text layer and was read visually, which
makes it the least certain of the six.

`_notes` records every judgement call — why a value was filed under one field
and not another, and what the document holds that the schema has no place for.

## What the six cover

| Fixture | System | Why it is here |
|---|---|---|
| `javor-20260192` | iDoklad | priced from round gross amounts; `qty × unit_price` cannot equal the printed net |
| `plastic-26201379` | POHODA | net prices; a neutral `J.cena` header that happens to be net |
| `kornfeil-2604003` | MRP | no per-line tax or gross column |
| `petrovics-26570` | MRP | tax-inclusive pricing, no net column at all; two-line description cell |
| `rdmoto-25oss00189` | POHODA | Czech, EUR invoice with a CZK tax summary; customer with no tax IDs; a neutral `J.cena` header that is gross — the opposite of `plastic` |
| `alimpek-210260059` | Helios | a scan; 19 % reduced rate; a value labelled `DIČ` that looks like a VAT number |

Still missing: a multi-page invoice, an invoice with many line items, and one
with more than one tax rate in use. Add them when real examples turn up.

## Measured limitations

Findings that survived more than one run. They are recorded rather than tuned
away, because tuning them away on six documents is the overfitting described
above.

- **The model corrects the source text.** `kornfeil-2604003` prints
  `dodanie materiálu dľa prílohy`; the extraction returns `podľa`. An explicit
  prompt rule against correcting spelling, abbreviations and dialect wording did
  not change this.
- **Scans are not reproducible run to run.** `alimpek-210260059` has eight
  numeric line columns; separate runs returned `2.90` (correct, the post-discount
  unit price) and `25` (the units-per-package column) for the same field.
- **A cryptic column header defeats `unit_price_includes_vat`.** A spelled-out
  header is read correctly in both directions, but the abbreviated
  `JC bez DPH po zľave` on the scan leaves the field null.
