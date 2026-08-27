The PDF → PNG stage is now working.

Now implement ONLY the Qwen extraction stage.

Do not add PaddleOCR.

Do not add a second AI model.

Do not add a database.

Do not add queues.

Do not add authentication.

Do not redesign the UI.

The existing pipeline is:

PDF
→ PNG pages

Now extend it to:

PDF
→ PNG pages
→ Qwen3.8 Max through OpenRouter
→ structured JSON

## OpenRouter

Use:

OPENROUTER_API_KEY

The key must remain server-side.

Never expose it to the browser.

Use the OpenRouter API from server-side Next.js code only.

Use model:

qwen/qwen3.8-max

Inspect the current OpenRouter API requirements before implementing the request.

## Image input

Send the generated PNG pages to Qwen as image inputs.

Treat one PDF as ONE invoice extraction job.

If the PDF contains multiple pages, send all pages belonging to that invoice together when supported and practical.

Do not create separate AI conversations for every page.

## Extraction schema

Use structured JSON output.

Start with:

{
  "invoice_number": string | null,
  "invoice_date": string | null,
  "due_date": string | null,
  "supplier_name": string | null,
  "supplier_address": string | null,
  "supplier_tax_id": string | null,
  "customer_name": string | null,
  "customer_address": string | null,
  "customer_tax_id": string | null,
  "currency": string | null,
  "subtotal": number | null,
  "tax_total": number | null,
  "total": number | null,
  "payment_reference": string | null,
  "iban": string | null,
  "items": [
    {
      "description": string | null,
      "quantity": number | null,
      "unit_price": number | null,
      "tax_rate": number | null,
      "line_total": number | null
    }
  ]
}

The items array must support ANY number of items.

If there are 20 items, return 20.

If there are 25 items, return 25.

If there are 100 items, return 100.

Never truncate because of an assumed item count.

## Model instructions

Tell Qwen:

- extract all relevant visible invoice information
- process all pages
- extract all visible line items
- never invent missing values
- return null when a value cannot be determined
- preserve exact invoice numbers
- preserve exact IBAN values
- distinguish subtotal, tax and total
- do not summarize line items
- do not arbitrarily limit the number of line items
- prioritize document evidence over assumptions

## UI

Extend the existing status pipeline:

PDF uploaded
→ Rendering
→ PNG generated
→ Sending to Qwen
→ Qwen processing
→ JSON received
→ Completed

Display:

1. PNG previews
2. Raw JSON response
3. Parsed JSON response
4. Processing time

Also display token usage if the OpenRouter response provides usage information.

## Errors

Handle at least:

- OpenRouter authentication error
- network error
- API error
- timeout
- malformed model response
- invalid JSON
- structured output failure

Do NOT automatically retry yet.

Do NOT call Qwen again automatically.

## Security

Never expose:

OPENROUTER_API_KEY

to the client.

Do not put it in frontend code.

Do not log the API key.

## Testing

After implementation:

1. Run the app.
2. Upload a real invoice.
3. Confirm the PDF renders.
4. Confirm the PNGs are sent to Qwen.
5. Confirm Qwen returns JSON.
6. Display the JSON in the UI.
7. Fix all issues.

Do not add validation logic yet.

The definition of done:

PDF
→ PNG
→ Qwen3.8 Max
→ structured JSON
→ JSON displayed in the browser.