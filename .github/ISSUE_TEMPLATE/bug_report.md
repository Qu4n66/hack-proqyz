---
name: Bug report
about: Something broke — selectors failed, an upload crashed, an error message appeared.
title: "[bug] "
labels: bug
assignees: ""
---

## What happened

A clear, one-paragraph description of what went wrong.

## Reproduction steps

1. Command run: `node bin/upload.js ...`
2. The point at which it failed (e.g. "after creating the quiz, on question 5")
3. URL of the ProQyz page (if applicable)

## What I expected

One sentence on what should have happened.

## Screenshots / failure artifacts

- Drag `./failures/<timestamp>-*.png` files here.
- Drag `./failures/<timestamp>-*.html` files here.

## Environment

- Node.js version (`node --version`)
- OS (`uname -a` or Windows version)
- ProQyz URL (staging or production)
- Selectors version (printed in the failure artifact filename)

## Selectors version

Check `src/uploader/ui/selectors.js` line with `version: ...`.

## Relevant logs

Paste the relevant `pino` log output. Mark the line that looks like the error.
