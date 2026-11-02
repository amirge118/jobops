# ADR 0015: The CV page starts from a file and explains it

- Status: Accepted
- Date: 2026-11-02

## Context

The CV page was a form: six tabs, with the CV as one title and one text box per section. Getting a CV in meant
pasting text, and nothing said what the CV meant. Updating it also did not change scores, because scoring reads the
`profile` document, and only small hints said so.

## Decision

- The uploaded PDF or DOCX is the main object of the page. Text is read from it locally and stored as the `resume`
  document, so everything that reads documents keeps working. The text editor stays, behind a disclosure.
- The file is never sent to AI. `pdfjs-dist` and `mammoth` read it inside a worker thread with memory and time limits,
  and the file's first bytes decide its type. `pdfjs-dist` is pinned to 4.10.38, because 5 needs a newer Node than the
  project requires. macOS `textutil` was not used since it would tie the app to one platform.
- An upload is saved at once, unlike a pasted draft, since the CV does not affect scores and versions can be restored.
  An AI-organized copy is used only if it kept the file's words and added no number. Otherwise, or if AI is down, the
  extracted text is saved as it is.
- What the AI says about a CV is display only. Nothing that scores or writes a CV reads `cv_insights`. It is cached per
  CV text and prompt version, so an unchanged CV costs nothing.
- Facts reach `profile` only through approval, which keeps hard rule 1 and keeps re-scoring the person's decision. A
  proposed fact must quote the CV, the server checks the quote, and approval sends ids rather than text. A disagreement
  between the CV and the profile is shown, and never applied.
- Search preferences and sources move to `/settings`, and stories to the personal area, so `/profile` is only about
  the person. Old links redirect.

## Consequences

- A file is stored as a BLOB, unencrypted, like the documents (ADR 0009). The last five per user are kept.
- Uploads are base64 in JSON, a third larger, so the request guard stays JSON-only (ADR 0008).
- A scanned PDF has no text to read. The page says so and offers pasting, since OCR would be a much heavier dependency.
- Reading order is by the PDF's own order, with right-to-left lines sorted by position. An unusual multi-column layout
  can still read out of order, which is why the text stays viewable.
