# Jinnyfin — Setup Guide

Aake 4 step. Ellam free. Card details onnum ippo venda — app install cheythu
kazhinjittu ninte phone-il irunnu ninakku thanne add cheyyam.

> ### ⚠️ Aadyam ith ariyanam
> **`index.html` double-click cheythu thurannal app work cheyyilla.** Address bar-il
> `file:///…` ennu varum, browser security-inte peril JavaScript module block cheyyum,
> "Loading your ledger" ennum parayum karangi നിൽക്കും. Ith bug alla — ella modern
> web app-inteyum swabhavam aanu. App-inu oru **web address** venam (`http://` or
> `https://`). Athanu Step 3.
>
> Ippo thanne PC-yil onnu kaananamenkil: folder-il oru terminal / PowerShell
> thurannu `python -m http.server 8080` (or `npx serve`) run cheythu
> `http://localhost:8080` thurakku. Illenkil neritte Step 3-lekku pokku.

---

## STEP 1 — Supabase (ninte data ivide irikkum) · ~6 minute

Ithanu mobile-um PC-um thammil sync cheyyunna "server". Free tier mathi;
card details onnum chodhikkilla.

1. https://supabase.com → **Start your project** → GitHub or Google vechu sign up.
2. **New project**
   - Name: `jinnyfin`
   - Database password: oru strong password kodukku, **ith evideyenkilum ezhuthi vekku**
     (pinne venam ennilla, but marannal recover cheyyan budhimuttanu)
   - Region: **Asia-Pacific → Mumbai (ap-south-1)**. Jeddah-il ninnu ettavum
     അടുത്തത് athanu; list-il Mumbai illenkil Singapore edukku. Ith
     milliseconds-inte kaaryam mathram, ethu edutthalum app work cheyyum.
   - **Security** box-il:
     - **Enable Data API** ✅ — **nirbandham**. Ith illenkil app-inu database-il
       ninnu onnum vayikkan pattilla.
     - **Automatically expose new tables** ✅ — **on aakki thanne vekku**. Nammude
       14 table ee vazhi aanu app kaananuka. (Supabase "off aakkan" recommend
       cheyyunnath aarkkokke access undennu manually control cheyyendavarkku
       aanu — nammude schema ella table-inum RLS on aakkunnundu, so on aayirunnal
       mathi.)
     - **Enable automatic RLS** — ninte ishtam. `schema.sql` ella table-inum RLS
       explicit aayi on aakkunnundu, so **off aayalum ninte data safe aanu**.
       Tick cheythal bhaviyil nee undakkunna puthiya table-inum athe suraksha
       kittum — oru extra belt. Njan tick cheyyan paranju parayum.
   - GitHub (optional) — **onnum cheyyanda**, skip.
   - **Create new project** → 2 minute wait
3. Idathe menu-il **SQL Editor** → **New query**.
4. Ee repo-yile `supabase/schema.sql` file thurannu **muzhuvan copy cheythu**
   avide paste cheyyu → **Run** (or Ctrl+Enter).
   Query-inte peru "Untitled query" ennu kaanum — athu veruthe oru tab name aanu,
   onnum cheyyanda.

   **"Potential issues detected" ennoru warning varum. Bhayakkenda —
   `Run and enable RLS` അമർത്തുക.** Randu warning-um ithanu artham:
   - *"destructive operations"* → script-il `drop trigger if exists` /
     `drop policy if exists` undu, randum udane thanne veendum undakkunnundu.
     Ithanu script randam thavana odichaalum kuzhappam varaathirikkan.
     **`drop table`-oo `delete`-oo `truncate`-oo onnum illa** — puthiya
     project-il nashippikkan onnum thanne illa.
   - *"creates tables without RLS"* → Supabase-inte checker script vaayichu
     nokkumbol RLS on aakkunnath kaananilla, karanam njan athu avasaanathe
     `DO` block-il loop aayi ezhuthiyirikkunnu (14 table-inum onnichu). Checker-inu
     aa loop-inullilekku nokkan pattilla. `Run and enable RLS` അമർത്തിയാൽ
     Supabase-um enable cheyyum, script-um cheyyum — randum onnu thanne, onnum
     ottum kuzhappam illa.

5. **Sheriyaayo ennu നേരിട്ട് നോക്കാം.** SQL Editor-il puthiya query-yil ith
   paste cheythu Run cheyyu:

   ```sql
   select t.tablename,
          t.rowsecurity as rls_on,
          (select count(*) from pg_policies p
            where p.schemaname = 'public' and p.tablename = t.tablename) as policies
   from pg_tables t
   where t.schemaname = 'public'
   order by t.tablename;
   ```

   **14 row** varanam, ellaam `rls_on = true`, `policies = 1`. Athu kandal
   ninte data purathulla aarkkum kaanan pattilla ennu urappu.
6. Idathe menu-il **Authentication → Users → Add user → Create new user**
   - Email: ninte email (app-il login cheyyan use cheyyunnath)
   - Password: ninte app password (ith aanu app-il login cheyyan use cheyyunnath)
   - **Auto Confirm User** ✅ tick cheyyanam
   - Create user
7. Idathe menu-il **Project Settings → Data API**. Randu value copy cheyyu:
   - **Project URL** — `https://xxxxxxxx.supabase.co` ennu thudangunnath
   - **anon public** key — nallonam neelamullath (`eyJ...`)

> anon key public aayi kodukkunnath kuzhappam illa. Schema-yile Row Level
> Security ninte login illathe oru row polum vayikkan sammathikkilla.

---

## STEP 2 — config.js · ✅ കഴിഞ്ഞു

Ninte project-inte URL-um publishable key-um **njan `config.js`-il ezhuthi
vechittundu**. Nee onnum edit cheyyenda. Onnu നോക്കണമെങ്കിൽ:

```js
SUPABASE_URL: 'https://rghhuttvobghtkthpsej.supabase.co',   // /rest/v1/ illa
SUPABASE_ANON_KEY: 'sb_publishable_...',                    // secret key alla
```

> Publishable key browser-il വെക്കാൻ വേണ്ടി thanne undakkiyathaanu — login
> illathe athinu oru row polum kaanan pattilla. `sb_secret_...` / `service_role`
> key mathram evideyum idaruth: athu RLS muzhuvan bypass cheyyum.

---

## STEP 3 — GitHub-il upload cheythu live aakkuka · ~5 minute

1. https://github.com/new
   - Repository name: `jinnyfin`
   - **Public** (GitHub Pages free-yil public venam — code-il ninte data illa,
     data muzhuvan Supabase-il aanu, so safe)
   - **Create repository**
2. Puthiya repo page-il **uploading an existing file** link click cheyyu.
3. `jinnyfin` folder-inte **ullile ellam** (index.html, js, css, data,
   icons, supabase, scripts, .github ... — folder alla, ullilullath) drag & drop.
   6 MB-inte `data/seed-data.json` undu, upload kurach samayam edukkum.
4. Thazhe **Commit changes**.
5. **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`,
   folder `/ (root)` → **Save**.
6. 1–2 minute kazhinju ninte app ivide live aakum:

   ```
   https://<ninte-github-username>.github.io/jinnyfin/
   ```

---

## STEP 4 — Install + data load · ~3 minute

1. Aa link browser-il thurakku → ninte email + Step 1-il set cheytha password
   vechu **Sign in**.
2. **Settings → Backup & import → "Load workbook data"** click cheyyu.
   25,074 transactions, 42 accounts, 63 categories, FX history, assets,
   policies, equity portfolio — ellam kayarum. 2–4 minute edukkum, tab
   thurannu thanne vekkanam.
3. Kayarikkazhinju **Settings → Backup & import → Numbers check** nokku —
   ella figure-um Excel sheet-inte koode match aakunnathu kaanam.

### Install cheyyan

| Device | Engane |
|---|---|
| **Android (Chrome)** | ⋮ menu → **Add to Home screen** / "Install app" |
| **iPhone (Safari)** | Share icon → **Add to Home Screen** |
| **PC (Chrome / Edge)** | Address bar-inte valathu vashathe **install ⊕** icon |

Install cheythu kazhinjal veruthe oru app pole thanne. Internet illenkilum
thurakkum — offline-il cheyyunna entry-kal net varumbol thaane sync aakum.

### Notification on cheyyan
**Insurance & Documents** page → **Renewal reminders → Turn on** → browser
"Allow" click cheyyu. iPhone-il ith **home screen-il install cheytha shesham**
mathrame work cheyyu.

---

## Optional — daily email reminder

App thurakkathe thanne mail venamenkil, repo-yil already undu:
`.github/workflows/expiry-email.yml`. GitHub repo → **Settings → Secrets and
variables → Actions → New repository secret**, ee 6 ennam add cheyyu:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Step 1-le Project URL |
| `SUPABASE_ANON_KEY` | Step 1-le anon key |
| `JINNYFIN_EMAIL` | app login email |
| `JINNYFIN_PASSWORD` | app login password |
| `RESEND_API_KEY` | https://resend.com free key |
| `MAIL_TO` | mail varendath evide |

Divasavum raavile 7 manikku (Riyadh time) check cheyyum. Onnum due
illenkil mail ayakkilla. **Actions** tab-il poyi "Run workflow" click cheythu
test cheyyam.

---

## Card vault — install kazhinju cheyyendath

**Card Vault** page → **+ Card**. Number, expiry, CVV, ATM PIN — ellam ninte
device-il thanne AES-256 vechu encrypt cheyyum, oru **vault PIN** vechu.
Server-il ethunnath vayikkan pattatha ciphertext matram — Supabase-inu polum
vayikkan pattilla.

Randu kaaryam ariyanam:
- **Vault PIN marannal aa data poyi.** Reset illa. Athanu ith safe aakkunnath.
- **CVV vekkunnath aanu risk.** Number + expiry + CVV — ee moonnum koodi
  undenkil aarkkum online purchase cheyyam. Field avide undu, nee chodhichu.
  Pakshe blank ittalum ninakku practical aayi onnum nashtam varilla.

---

## Divasavum engane use cheyyanam

1. Chelavu varumbol phone-il app thurannu **+** അമര്‍ത്തuka → amount →
   category → Save. 5 second.
2. Amount field-il `1200+340-15` ennu ezhuthiyalum work cheyyum.
3. Masam avasanam **Settings → Accounts** → oro account-inum "Bank says"
   ezhuthi **Reconcile** tab nokku — ethu account-il vyathyasam undennu udane kaanam.
4. Puthiya masam thudangumbol **Settings → Exchange rates** → aa masathe
   SAR→INR rate add cheyyu (nee money transfer cheyyumbol kittiya real rate).
5. `Settings → Backup & import → Download backup` — masathil oru thavana
   eduthu vekku. Athu oru JSON file, ethu device-ilekkum restore cheyyam.

---

## Enthenkilum kuzhappam vannal

| Prashnam | Cheyyendath |
|---|---|
| "Setup not finished" ennu kaanunnu | `config.js`-il URL/key paste aayittilla, or GitHub-il push aayittilla |
| Sign in cheyyan pattunnilla | Supabase → Authentication → Users-il user undo, "Auto Confirm" tick undo ennu nokku |
| Numbers match aakunnilla | Settings → Backup & import → **Rebuild local copy** |
| Data randu thavana kayari (duplicate) | Settings → Backup & import → **Delete everything** → veendum import |
| Puthiya version upload cheythittum മാറുന്നില്ല | `sw.js`-il `misa-v1` → `misa-v2` ennu maattu, upload cheyyu, app onnu close cheythu thurakku |
| Mobile-il aa dayivam sync aakunnilla | Rendu device-ilum same email-il login aano ennu nokku; top-il ulla sync chip click cheythal manually sync aakum |
| "error loading dynamically imported module" | Oru file GitHub-il ethiyittilla, or aa file-inte peru underscore (`_`) kondu thudangunnu — GitHub Pages avaye ozhivaakkum. Repo-yil `.nojekyll` enna khaali file undakkuka |
| Puthiya file upload cheythittum മാറുന്നില്ല | `sw.js`-il `jinnyfin-v2` → `v3` aakku, upload cheyyu, ennittu Ctrl+Shift+R |
| "Could not reach Supabase" ennu login-il | Net illa, or aa network CDN block cheyyunnu. App ennalum thurakkum — offline aayi entry cheythu vekkam, net varumbol sync aakum |
