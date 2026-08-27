The experimental pipeline has now been validated.

Current proven pipeline:

PDF
→ PDF rendering
→ PNG
→ Qwen3.8 Max
→ structured JSON
→ deterministic validation

Now clean up and integrate the implementation into a minimal production-ready prototype.

Keep the application intentionally small.

Do not introduce unnecessary architecture.

Preserve the working rendering and extraction logic.

The final UI should contain:

1. PDF upload
2. Process button
3. Real-time pipeline status
4. PNG page previews
5. Extracted JSON
6. Validation result
7. Warnings
8. Processing time
9. Token usage
10. Estimated cost

Keep all API secrets server-side.

Do not add authentication yet.

Do not add a database yet.

Do not add PaddleOCR yet.

Do not add a second model yet.

Do not add automatic retries yet.

However, structure the code so these can be added later without rewriting the core extraction logic.

Before finishing:

- run the application
- run production build
- test with real invoices
- fix all errors
- document how the pipeline works