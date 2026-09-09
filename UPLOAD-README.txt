JINNYFIN — repo update bundle
=============================

Two notes before you start:

  * "github-workflows/" must go into the repo as ".github/workflows/".
    It is named without the dot here because Windows hides dot-folders and
    they are easy to lose in a drag-and-drop.

  * "test/gitignore.txt" must be renamed to ".gitignore" inside test/.
    Same reason.

  * NEVER upload the "data/" folder. seed-data.json is your real nine-year
    transaction history and this repo is public. It has never been there.
    Keep it off.


WHERE EACH FILE GOES
--------------------

repo root/
    AGENTS.md                  NEW  - rules for any AI working here
    .gitignore                 NEW  - stops seed-data.json ever being uploaded
    PUSH-SETUP.md              MISSING from your repo
    sw.js                      REPLACE  (1.39)

css/
    app.css                    REPLACE  (1.39)

js/
    app.js                     REPLACE  (1.39)
    charts.js                  REPLACE  (empty-chart fix)
    util.js                    REPLACE  (back-history fix)

supabase/                      ALL MISSING except schema.sql - check yours
    schema.sql
    migration-1.17.sql
    migration-1.18.sql
    migration-1.26.sql         <- creates push_subscriptions + push_log
    migration-1.27.sql
    push-cron.sql
    functions/jinnyfin-push/index.ts

.github/workflows/             MISSING - the whole folder
    expiry-email.yml

test/                          NEW - the automated checks
    run.mjs
    README.md
    package.json
    .gitignore                 (rename from gitignore.txt)
    stub/supabase.mjs
    stub/fixture.json


AFTER UPLOADING
---------------

Settings -> About should read 1.39, stylesheet 1.39.
If it still says 1.38, hard-refresh (Ctrl+Shift+R).
