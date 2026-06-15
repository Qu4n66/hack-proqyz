# Legacy fixtures

These are the pre-recon MVP-0 and MVP-1 fixtures, kept here for
reference. They use the old question-type model (a single `type` field
on each question with 11 IELTS types, no `proqyzType`, no
`defaultOptions`, and a required `options[]` + label-matching `answer`).

The current model is described in the README at the project root, and
the live MVP-0 fixture is `fixtures/cam17-reading-test01-passage1.json`.

These files are NOT loaded by any test or by `bin/upload.js`. They are
preserved as historical snapshots of the design before the real
ProQyz workflow was captured in Phase 0.
