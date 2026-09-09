# Jinnyfin — automated checks

These run the **real app** in a **real browser**. Nothing inside the app is
faked; only the server it talks to is replaced, so the checks need no password,
touch no live data, and behave the same offline.

## Running them

```
cd test
npm install      # once
npm test
```

One check, or a few:

```
npm test -- transfer
npm test -- scroll typing
```

Playwright normally downloads its own browser. If one is already on the machine
and it cannot find it, point at it:

```
JF_CHROME=/path/to/chrome npm test
```

## What is in here

| file | what it is |
|---|---|
| `run.mjs` | the checks, and the harness that serves the app and drives the browser |
| `stub/supabase.mjs` | a stand-in for the Supabase library — the tests drive auth events and pulls through `window.__sb` |
| `stub/fixture.json` | 424 real transactions across ten years, five accounts, both currencies — cut from the original workbook import |

## The rule for adding one

**A check exists because that exact thing broke once.** Every case below is a
bug that shipped and had to be found by hand:

- a screen that would not open after a bad import
- a chart with no data drawing a stray triangle and logging an error
- account or category labels in chart tooltips being interpreted as markup
- alt-tabbing back and finding the page thrown to the top
- a background sync rebuilding the page mid-typing, cursor gone
- arrow keys dying after one press on a filter
- a transfer edited into an expense leaving its other half behind

So when something breaks, add the check first, watch it fail, then fix it. A
check that passes on the broken version is worse than none — it makes the
next person trust the wrong thing.

The easiest way to confirm a new check is honest: run it against the commit
before the fix.

```
sha=<the commit before the fix>
d=$(mktemp -d); git archive $sha | tar -x -C $d
cp -r test $d/test && ln -s "$PWD/test/node_modules" $d/test/node_modules
(cd $d/test && node run.mjs)     # the new check must FAIL here
```
