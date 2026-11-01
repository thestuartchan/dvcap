# dvcap — notes for Claude

## How Stu reads (UI text, chat replies, reports)

Stu scan-reads. Write for scanning, not reading:

- **No paragraphs by default.** Prefer label → value rows, short bullets, tables, stat tiles.
- **Paragraphs only when necessary**, and even then laid out logically: short, one idea each,
  with **bold** on the figure or phrase that matters so the eye can land on it.
- **Lead with the answer or the number**; put the reasoning after, and only if it's needed.
- **Format numbers for people**: `3.5%`, not `3.5000000000000004%` — round floats before display.
- In the dashboard, a card's explainer is a compact grid of labelled rows (see `src/MlsPanel.jsx`),
  not a sentence-long description of the rules.
