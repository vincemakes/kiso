# fixture-w — the wait chains' repo (ADR-0059 release 1)

fixture-t5's seed with only the two tests that concern the seeded code:
`clamp.test.js` fails on the seed's inclusive-clamp bug in `src/range.js`
and passes once it is fixed; `user.test.js` passes throughout. One known
bug, one line, so a W1/W2 leg's "fix" is unambiguous and its verify is
the suite: `node --test tests/*.test.js`.
