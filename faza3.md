The current pipeline is working:

PDF
→ PNG
→ Qwen3.8 Max
→ JSON

Now add deterministic validation and benchmarking.

IMPORTANT:

Do not add another AI model.

Do not add PaddleOCR.

Do not change the extraction model.

Do not add authentication.

Do not add a database.

Do not add queues.

The goal is to measure how reliable Qwen is on real invoices.

## Validation

Create deterministic validation functions in TypeScript.

At minimum validate:

1. JSON structure
2. invoice_number type
3. invoice_date type
4. due_date type
5. currency type
6. numeric fields
7. items array
8. item numeric fields

Add arithmetic checks when enough data is present:

subtotal + tax_total ≈ total

and:

sum(line_total) ≈ subtotal

Use a reasonable floating-point tolerance.

Do not modify Qwen's extracted values.

Only generate warnings/errors.

Example:

{
  "validation": {
    "valid": false,
    "warnings": [
      "subtotal + tax_total does not match total"
    ]
  }
}

## Missing information

A missing value should NOT automatically be treated as an error.

Distinguish:

- valid
- warning
- error

For example:

IBAN missing
→ warning

Invalid JSON
→ error

Arithmetic inconsistency
→ warning

## Benchmark information

Display:

- rendering time
- Qwen request time
- total processing time
- input tokens, if available
- output tokens, if available
- total tokens, if available
- estimated API cost, if enough information is available

Make the cost calculation transparent and keep pricing constants easy to change.

## Debugging

Display:

PDF pages
PNG pages
Image dimensions
Qwen response status
Validation status
Warnings
Errors
Token usage
Processing duration

## IMPORTANT

Do not implement automated retries yet.

Do not add credit protection yet.

Do not add production monitoring yet.

This is still an experiment.

The goal is to measure the system, not harden it.

## Testing

Test with multiple real invoices.

At minimum:

- single-page invoice
- multi-page invoice
- invoice with many line items
- invoice with missing fields
- invoice with different layout

Do not declare success because one invoice worked.

The goal is to make failures visible and measurable.