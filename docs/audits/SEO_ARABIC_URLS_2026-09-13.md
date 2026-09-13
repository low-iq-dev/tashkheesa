# Arabic SEO Core: One URL per Language + Arabic Titles/Meta — Tashkheesa — 2026-09-13

**Scope:** Parts A (A1–A4) and D of the SEO plan. Public marketing pages,
layouts, static routes and headers only. B/C/E/F/G (redirects, noindex,
internal linking, schema, perf) are the deliberate second pass. The
authenticated portal's cookie/session language is unchanged.

**Baseline:** `origin/main` @ `493aa9d`, branch `seo/arabic-urls`, which is
fast-forwarded to `main`. The standard suite database is intentionally
unmigrated, so DB-integration tests skip.
- The new SEO guards render every public route in-process through the real
  middleware with a stubbed database (`tests/_helpers/public_site_app.js`).
- The server-booting HTTP tests and the curl transcript run against a local
  dev server on the migrated local scratch database (`tashkheesa_mobile`).
  That server has every external channel off and third-party credentials
  blanked.

**Evidence tier:**
- code + in-process renders + curl against the local dev server
- the production "before" state, captured live
- the production "after" state, captured live post-deploy

**House rules honoured:**
- **Full suite** on a clean checkout before, and after every commit group;
  the six baseline failures are byte-identical in every run.
- **Every change has a guard, negative-tested:** the change was reverted,
  the guard confirmed to fail, the change restored (checksums identical),
  and the guard confirmed to pass.
- **One commit per section**, `fix(seo): …`, with the mechanism in the body.
- **Nothing touched** under `routes/patient*`, `doctor*`, `superadmin*`,
  `api/`, `case_lifecycle.js`, payments, notifications, or the auth logic.
  The only `middleware.js` change is a guard that skips the
  cookie/session/`?lang=` resolution on a public URL.

---

## Suite counts

`node tests/run.js`, each run on a clean worktree of the commit:

| Run | Commit | Passed | Failed | Skipped |
|---|---|---|---|---|
| Baseline | `493aa9d` | 1594 | 6 | 52 |
| A1, first cut | `4ae1cad` (amended) | 1605 | **7** | 52 |
| A1 (amended) + A2 | `0b66b78` | 1618 | 6 | 52 |
| + A3 + A4 | `c4ecc3f` | 1660 | 6 | 52 |
| + D | `e6ec703` | 1701 | 6 | 52 |
| + review fixes | `6494979` | **1709** | **6** | **52** |

The six failures, identical in every run:
- `env-vars-validated-or-documented`
- `orders-table-readers-allowlist`
- `payment-money-paths-wiring` ×3
- `theme9-video-flag-enforcement`

**The 7th failure in the A1 first cut was the new A1 guard.** It passed on
its own but failed inside `run.js`. Several `tests/auth/*` files replace
`src/middleware` with a stub in `require.cache` and never restore it, so in
the shared process the guard was testing that stub. The guard and the
harness now load real modules through a cache-bypassing `loadReal()`, which
puts the previous cache entry back. The A1 commit was amended before
anything was pushed, and every later run is clean. A3 had no separate run;
the `c4ecc3f` run covers it.

**Server-booting HTTP tests.** `run.js` skips these, because they need a
migrated database. Run against `tashkheesa_mobile`:

| Test | `493aa9d` | `e6ec703` and `6494979` |
|---|---|---|
| `lang-toggle` | old toggle contract | 17 pass, 0 fail |
| `rtl-doc-direction-flips` | — | 14 pass, 0 fail |
| `blog` | 3 fail | 9 pass, same 3 fail |
| `faq` | 2 fail | 7 pass, same 2 fail |
| `specialties` | 5 fail | 1–2 pass, same 5 fail |

The blog, faq and specialties failures predate this work: they fail the same
assertions on `493aa9d`. They're content drift (`٣` vs `3` in blog titles,
MSA vs dialect FAQ strings) and a fixture database without the real
catalogue.

---

## Transcript — production before (`493aa9d`, 2026-09-13 19:16 UTC)

```
$ curl -sI -A Googlebot https://tashkheesa.com/ar/ | head -1
HTTP/2 404
$ curl -s -A Googlebot https://tashkheesa.com/?lang=ar | grep -o '<link rel="canonical"[^>]*>'
<link rel="canonical" href="https://tashkheesa.com/" />
$ curl -s https://tashkheesa.com/ -H 'Accept-Language: ar' | grep -o '<html[^>]*>'
<html lang="en" dir="ltr">
$ curl -sI -A Googlebot "https://tashkheesa.com/?lang=ar" | grep -iE "^(HTTP|location|set-cookie)"
HTTP/2 200
set-cookie: lang=ar; Max-Age=31536000; Path=/; …          ← a lang cookie on Googlebot
set-cookie: csrf_token=…
$ curl -s https://tashkheesa.com/ | grep -c hreflang
0
$ curl -s https://tashkheesa.com/sitemap.xml | grep -c "<loc>"; … | grep -c hreflang
15
0
$ curl -s -A Googlebot "https://tashkheesa.com/services?lang=ar" | grep -oE "<title>…|description…"
<title>الخدمات والأسعار – Tashkheesa</title>
<meta name="description" content="Browse 183 specialist medical review services across 23 specialties. 7…
```

Every public page with `?lang=ar`, before (title / description start / canonical):

| Page | `<title>` | description | canonical |
|---|---|---|---|
| `/` | تشخيصة - استشارات طبية متخصصة | Arabic | `/` |
| `/services` | الخدمات والأسعار – Tashkheesa | **English** | `/services` |
| `/specialties` | التخصصات الطبية – Tashkheesa | **English** | `/specialties` |
| `/about` | عن تشخيصة – Tashkheesa | **English** | `/about` |
| `/contact` | كلمنا – Tashkheesa | **English** | `/contact` |
| `/faq` | الأسئلة الشائعة – Tashkheesa | **English** | `/faq` |
| `/blog` | مدونة تشخيصة – Tashkheesa | **English** | `/blog` |
| `/blog/how-tashkheesa-works` | إزاي تشخيصة بتشتغل: رأي تاني في 3 خطوات **– تشخيصة – Tashkheesa** | **English** | English |
| `/privacy` | سياسة الخصوصية **— تشخيصة – Tashkheesa** | Arabic | English |
| `/apply` | قدّم للانضمام لتشخيصة – Tashkheesa | **patient default, English** | **none** |
| `/help-me-choose` | **Find Your Service – Tashkheesa** | **English** | English |
| `/app` | تطبيق تشخيصة – Tashkheesa | **English** | none (noindex) |
| `/coming-soon` | قريب **— تشخيصة – Tashkheesa** | **English** | English |

## Transcript — local after (`e6ec703`, dev server :3200)

```
$ curl -sI -A Googlebot localhost:3200/ar/ | head -1
HTTP/1.1 200 OK
$ curl -s -A Googlebot "localhost:3200/?lang=ar" -o /dev/null -w "%{http_code} %{redirect_url}"
301 http://localhost:3200/ar/
$ curl -s localhost:3200/ -H "Accept-Language: ar" | grep -o "<html[^>]*>"     # the URL decides: / is English
<html lang="en" dir="ltr">
$ curl -s -A Googlebot localhost:3200/ar/ | grep -oE "<html…|<title>…|<link rel=canonical|alternate…"
<html lang="ar" dir="rtl">
<title>رأي طبي ثانٍ من استشاريين مصريين خلال ٤٨ ساعة | تشخيصة</title>
<link rel="canonical" href="https://tashkheesa.com/ar/" />
<link rel="alternate" hreflang="ar-EG" href="https://tashkheesa.com/ar/" />
<link rel="alternate" hreflang="en" href="https://tashkheesa.com/" />
<link rel="alternate" hreflang="x-default" href="https://tashkheesa.com/" />
$ curl -sI -A Googlebot localhost:3200/ar/services | grep -iE "^(HTTP|content-language|set-cookie)"
HTTP/1.1 200 OK
Content-Language: ar
Set-Cookie: csrf_token=…                                   ← pre-existing CSRF cookie; no lang cookie
$ curl -s -A Googlebot localhost:3200/ar/services | grep -oE "<title>…|description…|canonical…"
<title>الخدمات والأسعار – تشخيصة</title>
<link rel="canonical" href="https://tashkheesa.com/ar/services" />   (+ the three alternates)
$ curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "localhost:3200/services?lang=ar&spec=cardiology"
301 http://localhost:3200/ar/services?spec=cardiology
$ curl … "localhost:3200/ar/about?lang=en"        → 301 http://localhost:3200/about
$ curl … localhost:3200/ar                         → 301 http://localhost:3200/ar/
$ curl … localhost:3200/ar/services/               → 200, canonical https://tashkheesa.com/ar/services
$ curl … localhost:3200/ar/about.html              → 301 /ar/about
$ curl … localhost:3200/ar/login                   → 404
$ curl -sI "localhost:3200/login?lang=ar"          → 200, Set-Cookie: lang=ar, Vary: Cookie   (portal unchanged)
$ curl -s localhost:3200/ar/specialties/cardiothoracic | grep -oE "<title>…|description…|canonical…"
<title>جراحة القلب والصدر – تشخيصة</title>
<meta name="description" content="تعالج جراحة القلب والصدر الحالات الجراحية للقلب والرئتين وتجويف الصدر، بما في ذلك جراحة الشرايين التاجية — رأي طبي ثانٍ من استشاريين مصريين خلال ٤٨ ساعة"
<link rel="canonical" href="https://tashkheesa.com/ar/specialties/cardiothoracic" />
$ curl -s localhost:3200/sitemap.xml → <loc> 40, <xhtml:link> 120, /ar/ <loc> 20, login|register|doctor/signup 0
$ curl -s localhost:3200/robots.txt | grep -E "lang|login|register|Sitemap"
Disallow: /lang/
Disallow: /login?
Disallow: /register?
Sitemap: https://tashkheesa.com/sitemap.xml
$ every public <a> on /ar/about (language switch excluded) → all under /ar/:
/ar/ /ar/about /ar/apply /ar/blog /ar/contact /ar/delivery-policy /ar/faq /ar/privacy /ar/refund-policy /ar/services /ar/specialties /ar/terms
$ attacker probes
/services?lang=ar&next=//evil.example              → 301 /ar/services?next=%2F%2Fevil.example   (relative, allowlisted path)
Host: evil.example  /?lang=ar                        → 301 /ar/                                    (Location never uses Host)
/ar//evil.example?lang=en                            → 404                                         (not an allowlisted path)
/ar/specialties/..%2f..%2flogin?lang=en              → 404
/about?lang=ar&x=%0d%0aSet-Cookie:%20pwn=1           → 301 /ar/about?x=%0D%0ASet-Cookie%3A+pwn%3D1 (re-encoded; no header injection)
```

## Transcript — production after

Captured 2026-09-13 19:40 UTC. Production ran `6494979` (deployed about 75 s
after the push); `/healthz` was ok, all four workers alive, clock ok.

```
$ curl -sI -A Googlebot https://tashkheesa.com/ar/ | grep -iE '^(HTTP|content-language|set-cookie: lang)'
HTTP/2 200
content-language: ar                                        ← no lang cookie
$ curl -s -A Googlebot https://tashkheesa.com/ar/ | grep -oE '<html…|<title>…|canonical|alternate'
<html lang="ar" dir="rtl">
<title>رأي طبي ثانٍ من استشاريين مصريين خلال ٤٨ ساعة | تشخيصة</title>
<link rel="canonical" href="https://tashkheesa.com/ar/" />
<link rel="alternate" hreflang="ar-EG" href="https://tashkheesa.com/ar/" />
<link rel="alternate" hreflang="en" href="https://tashkheesa.com/" />
<link rel="alternate" hreflang="x-default" href="https://tashkheesa.com/" />
$ curl -s -A Googlebot https://tashkheesa.com/ar/services | grep -oE 'title|description|canonical'
<title>الخدمات والأسعار – تشخيصة</title>
<meta name="description" content="تصفّح 183 من خدمات المراجعة الطبية المتخصصة في 23 من التخصصات، منها 70 متاحة الآن بدءًا من 1,600 جنيه — أمراض القلب، الباطنة، النساء والتوليد وغيرها."
<link rel="canonical" href="https://tashkheesa.com/ar/services" />   (+ ar-EG / en / x-default)
$ curl -sI -A Googlebot 'https://tashkheesa.com/?lang=ar' | grep -iE '^(HTTP|location|set-cookie: lang)'
HTTP/2 301
location: /ar/                                              ← no cookie
$ curl … 'https://tashkheesa.com/services?lang=ar&utm_source=wa'  → 301 https://tashkheesa.com/ar/services?utm_source=wa
$ curl … https://tashkheesa.com/SERVICES                          → 301 https://tashkheesa.com/services
$ curl … https://tashkheesa.com/ar/login                          → 404
$ curl -sI 'https://tashkheesa.com/login?lang=ar'                → 200, set-cookie: lang=ar, vary: Cookie   (portal unchanged)
$ curl -s https://tashkheesa.com/sitemap.xml
  <loc> 44 · <xhtml:link> 132 · Arabic <loc> 22 · specialty <loc> 14 (7 specialties × 2) · login/register/doctor-signup 0
$ curl -s https://tashkheesa.com/robots.txt | grep -E 'lang|login|register|Sitemap'
Disallow: /lang/
Disallow: /login?
Disallow: /register?
Sitemap: https://tashkheesa.com/sitemap.xml
$ booking links on /ar/services (booking is live in production)
href="/login?next=/patient/new-case?service_id=card_ctca&amp;lang=ar"      ← lang=ar top-level
href="/login?next=/patient/new-case?lang=ar"                             ← the main CTA: lang INSIDE next (finding 18)
$ curl -s https://tashkheesa.com/ar/specialties/cardiology
200 · <title>أمراض القلب – تشخيصة</title>
<meta name="description" content="تختص أمراض القلب بتشخيص وعلاج اضطرابات القلب والأوعية الدموية، بما في ذلك أمراض القلب الإقفارية واضطرابات — رأي طبي ثانٍ من استشاريين مصريين خلال ٤٨ ساعة"
<link rel="canonical" href="https://tashkheesa.com/ar/specialties/cardiology" />
```

Every public page at its Arabic URL (Googlebot UA, no cookie):

| URL | Status | `<title>` | Canonical |
|---|---|---|---|
| `/ar/` | 200 | رأي طبي ثانٍ من استشاريين مصريين خلال ٤٨ ساعة \| تشخيصة | self |
| `/ar/services` | 200 | الخدمات والأسعار – تشخيصة | self |
| `/ar/specialties` | 200 | التخصصات الطبية – تشخيصة | self |
| `/ar/about` | 200 | عن تشخيصة | self |
| `/ar/contact` | 200 | تواصل معنا – تشخيصة | self |
| `/ar/faq` | 200 | الأسئلة الشائعة – تشخيصة | self |
| `/ar/blog` | 200 | مدونة تشخيصة | self |
| `/ar/blog/how-tashkheesa-works` | 200 | كيف تعمل تشخيصة: رأي طبي ثانٍ في 3 خطوات | self |
| `/ar/blog/when-to-get-medical-second-opinion` | 200 | متى تحتاج إلى رأي طبي ثانٍ؟ – تشخيصة | self |
| `/ar/privacy` | 200 | سياسة الخصوصية — تشخيصة | self |
| `/ar/terms` | 200 | شروط الخدمة – تشخيصة | self |
| `/ar/refund-policy` | 200 | سياسة الاسترداد والإلغاء – تشخيصة | self |
| `/ar/delivery-policy` | 200 | سياسة التسليم والخدمة – تشخيصة | self |
| `/ar/apply` | 200 | قدّم للانضمام لتشخيصة | self |
| `/ar/help-me-choose` | 200 | اختر الخدمة المناسبة لحالتك – تشخيصة | self |
| `/ar/coming-soon` | 200 | قريب — تشخيصة | self |
| `/ar/app` | 200 | تطبيق تشخيصة | none (noindex, by design) |

Every description is Arabic. The lengths the live script printed were bash
byte counts: Arabic letters are 2 bytes in UTF-8, so a 225-byte description
is about 115 characters. The 70–160 character rule is enforced by
`seo-titles-meta`, not by this transcript.

---

## A1 — Arabic had no URL of its own

**What was wrong.** Language came from a `lang` cookie, the session, or
`?lang=ar`, and defaulted to English, so `/ar/` returned 404. A crawler
carries no cookie, so every address served English to Google. `?lang=ar`
also wrote a `lang` cookie on the crawler.

**Mechanism.** `baseMiddlewares` (`src/middleware.js`) resolves
`?lang` > session > cookie > `en` for every request. No public page had a
language of its own.

**Change.**
- **The prefix middleware.** `src/utils/public_lang_url.js` adds
  `publicLangPrefix`, mounted in `server.js` immediately before
  `baseMiddlewares`. It acts only on an allowlisted public path:
  - `/`, `/services`, `/specialties[/:slug]`, `/about`, `/contact`, `/faq`,
    `/blog[/:slug]`
  - `/privacy`, `/terms`, `/refund-policy`, `/delivery-policy`
  - `/apply`, `/help-me-choose`, `/app`, `/coming-soon`
  - the legacy `.html` redirects
- **On those paths it:**
  - strips `/ar` and rewrites `req.url`, so the existing handlers run
    unchanged, while `req.originalUrl` keeps `/ar/…`
  - sets `lang`/`dir`/`isAr`/`langPrefix`/`altLangUrl`/`publicPath` and
    `Content-Language`
  - 301s `?lang=ar|en` to the page's URL in that language, stripping the
    parameter and keeping the others. `/ar` 301s to `/ar/`. The `Location`
    path always comes from the allowlist, never from input.
- **Everything else under `/ar/` is not rewritten.** `/ar/login` and
  `/ar/portal/…` fall through to 404. Non-public responses get
  `Vary: Cookie`.
- **`middleware.js`.** When `langPrefix` is set, the URL's language wins and
  neither the session nor a cookie is written. Portal, auth and API routes
  resolve exactly as before, cookie write included.
- **The toggles.** The public-layout toggle is a plain
  `<a rel="alternate" hreflang>` to the other language's URL, keeping the
  query string, instead of `/lang/:code?next=`. The homepage EN/AR buttons
  point at `/` and `/ar/`. `/lang/:code` is unchanged for the portal.
- **Redirects that keep the prefix:** the contact 303, the apply 303s, and
  the legacy `.html` redirects.

**Guard.** `tests/core/seo-arabic-url-prefix.test.js`, 12 checks. It runs in
process with the real `publicLangPrefix` and `baseMiddlewares`:
- the rewrite and its locals
- the URL beats the cookie, and no `lang` cookie is set (Googlebot UA)
- the `?lang=` 301s, including a repeated `lang`
- open-redirect probes
- `/ar/login` not rewritten
- portal `?lang=` and cookie behaviour unchanged
- `POST /ar/contact`
- a source check of the mount order

**Negative test:**
- reverting the `middleware.js` guard fails 4 checks
- mounting the prefix after `baseMiddlewares` fails the source check
- restored: 12/12

**Tests deliberately updated for the new contract** (not regressions):
- `lang-toggle`: the toggle now points to `/ar<path>`; `?lang=` is a 301 with
  no cookie; the `/lang/:code` round trip is still pinned
- `blog`, `faq`, `specialties`: Arabic fetched at `/ar/…`
- `rtl-doc-direction-flips`: it counted a non-200 as a skip, so the new 301
  would have silently removed its Arabic coverage

## A2 — every page told Google its English URL was the only one

**What was wrong.** Every public page, in both languages, declared the
English URL as its canonical and carried no hreflang, so the Arabic page was
a duplicate to drop. `index.ejs` has its own `<head>`, so the homepage had
the same bug a second time: a hard-coded `https://tashkheesa.com/`
canonical and `og:url`.

**Change.**
- **The public layout.** On a public URL, the canonical is the page's own
  language URL, built from the route's `canonical`, so it carries no query
  string and the Arabic home is `/ar/`. It uses the middleware's `pathFor`
  as `res.locals.publicPathFor`, the same rule the redirects use.
- **Alternates:** `ar-EG`, `en`, and `x-default` (English), identical on
  both versions. `og:url` = canonical, and `og:locale:alternate` is added.
- **`index.ejs`** gets the same.
- **Pages off the public URL scheme** keep the old single canonical.

**Guard.** `tests/core/seo-canonical-hreflang.test.js`, 12 checks, run for
`/`, `/about`, `/faq` and `/contact?sent=1` in both languages:
- a self-referencing canonical with no query string
- the same alternate set on both versions
- `og:url` = canonical
- `<html lang/dir>` and `Content-Language`

**Negative test:** with the layout and `index.ejs` reverted, 8 fail;
restored, 12/12.

## A3 — internal links sent the Arabic site back to English

**What was wrong.** Every internal link was a hard-coded `href="/services"`.
On `/ar/` pages each one led to the English page, so a crawler following
the Arabic site's links walked straight out of it.

**Change.**
- **Prefix expression.** Every root-relative `href`/`action` to a public
  route in 14 public views is now `href="<%= locals.langPrefix || '' %>/…"`.
  It uses `locals.langPrefix`, not a bare `langPrefix`, because several of
  these views are rendered without the public middleware (tests, other
  frames), where a bare name throws.
- **Views covered:**
  - nav, footer, homepage
  - services, specialties index and detail
  - the blog index and both posts, FAQ
  - apply (link and form action), the contact form action, 404
  - the help-me-choose link inside a JS string (concatenated)
- **Not prefixed:** auth, portal and API targets. Header and homepage
  `/login` and `/register` carry `?lang=ar` on Arabic pages. The homepage
  EN/AR buttons stay literal: they are the switch.

**Superseded in review (`6494979`):**
- **Link prefix:** now `locals.publicLinkPrefix`, set on every request, so
  portal and auth pages link the public site in their own language.
- **Auth parameter:** now `langParam`, carrying `lang=ar` or `lang=en`.
- **Lint scope:** now every view.

**Guards:**
- **`tests/lint/public-links-carry-lang-prefix.test.js`** scans 21 public
  views:
  - no root-relative link outside a no-twin allowlist, unless it is the
    `rel="alternate" hreflang` switch
  - a sanity floor of at least 40 prefixed links (50 today)
  - auth links carry the lang expression
- **`tests/core/seo-internal-links.test.js`** renders 16 pages in both
  languages and reads them as a crawler would:
  - every `<a>`/`<form>` to a public page from `/ar/` stays under `/ar/`
  - auth links carry `lang=ar`
  - English pages never link into `/ar/`

**Negative test:**
- with the 14 views reverted, the lint reports 54 unprefixed links, a zero
  floor and bare auth links, and the rendered check fails on all 16 Arabic
  pages
- restored: 3/3 and 32/32

## A4 — the sitemap was a hand-written English list

**What was wrong.** `/sitemap.xml` was 15 hard-coded English URLs:
- no specialty page, no Arabic URL, no hreflang
- `/doctor/signup` included

**Change.**
- **`LIVE_SPECIALTY_WHERE`** is the one definition of "a specialty page that
  returns 200". `/specialties/:slug` filters on it (the same SQL, moved) and
  the sitemap lists exactly what it matches.
- **Sitemap contents:**
  - the static paths (minus `/doctor/signup`, plus `/help-me-choose`)
  - every `BLOG_POST_VIEWS` key
  - every live specialty as `/specialties/<slug>`, with the `spec-` prefix
    stripped by the rule the index uses
- **Per page:** an English `<url>` and an `/ar/` `<url>`. Both carry the
  same three `xhtml:link` alternates and a `<lastmod>`. Only `isPublicPath`
  URLs are emitted, XML-escaped.
- **Caching:** 1 h in memory, plus `Cache-Control: public, max-age=3600`.
- **`robots.txt`** adds `Disallow: /lang/`, `/login?` and `/register?`.

**Guard.** `tests/core/seo-sitemap.test.js`, 7 checks:
- 200 + XML + `max-age` + the xhtml namespace
- every static page, post and live specialty in both languages (exactly two
  per page, slug rule applied)
- the correct alternates and a `lastmod` on every URL
- no auth, portal or `/lang/` URL
- the shared clause, in both routes
- the cache hit
- the `robots.txt` lines

**Negative test:** with `static-pages.js` reverted, all 7 fail
individually; restored, 7/7.

## D — Arabic titles and meta

**What was wrong.** See the "before" table:
- an English brand suffix on every Arabic title, and a double brand on four
- English descriptions on 11 Arabic pages
- the English name as the Arabic specialty title
- `slice(0,160)` snippets cut mid-word
- English service cards on Arabic `/services`
- `/apply` with no description or canonical

**Change.**
- **Layout brand rule.** `hasBrand = /Tashkheesa|تشخيصة/`; the suffix is
  `– تشخيصة` on Arabic pages and `– Tashkheesa` otherwise, appended only
  here. The default description is bilingual.
- **Views that hard-coded a `<title>`** (both posts, help-me-choose,
  specialty detail, contact) now take `title` from the route.
- **Per-language title/description (MSA) in `static-pages.js`:**
  - services: the same counts, Arabic specialty names, the same length cap,
    and number-safe phrasing after review
  - about, contact, FAQ
  - the blog index and posts (`title_ar`, `description_ar`)
  - specialties, and specialty detail (`name_ar`, `description_ar`)
  - help-me-choose, coming-soon
  - the Arabic terms description (was 66 characters)
- **`site_stats` injectable** for the guard.
- **Specialty snippet.** The description in the page's language, cut at the
  last word boundary so that, with the specified suffix, the total is
  ≤155 characters. Under 70 characters, a full sentence is used instead.
- **Services.** `SERVICE_DESCRIPTIONS_AR` holds body copy in Egyptian Arabic.
  `services.ejs` prefers it; a service without an Arabic line falls back to
  its English one, and one with no specific line gets the Arabic generic.
- **Homepage.** The specified title and H1. The meta description is in MSA;
  the English one is cut from 164 to 151 characters.
- **Other routes:**
  - `apply.js`: description (both languages) + canonical `/apply`
  - `app_landing.ejs`: an Arabic description
  - `register.ejs`: a bilingual title

**Guard.** `tests/core/seo-titles-meta.test.js`, 41 checks over 19 routes ×
2 languages:
- Arabic title and description contain Arabic and no `Tashkheesa`; English
  ones contain no Arabic
- the brand at most once
- description 70–160 characters
- canonical and alternates present and correct (noindex `/app` excepted)
- the specified homepage title/H1
- the snippet cut/suffix/fallback
- Arabic service cards

**Negative test:**
- with the 12 changed files reverted, 26 fail: double brand, English on
  Arabic pages, the 164-character homepage description, the `Short.`
  snippet, English specialty titles
- restored: 41/41

---

## Found in review

Found while doing the work:
1. **The A1 guard failed only inside `run.js`.** `tests/auth/*` leaks
   `require.cache` stubs of `src/middleware`. Fixed with `loadReal()` in the
   guard and the harness. The leak itself isn't fixed: it's in other teams'
   tests.
2. **The first mechanical link-prefix pass over-matched.** Its regex treated
   every `/…` as "the home page", so portal and API links were prefixed too.
   The lint caught it before commit, and the pass was redone. The same pass
   had prefixed the homepage EN button, so `/ar/`'s "EN" pointed back at
   `/ar/`. Restored, and the lint now exempts `rel="alternate" hreflang`
   switches.
3. **`rtl-doc-direction-flips` would have silently lost coverage.** It
   treats a non-200 as a skip, and the new `?lang=` 301 would have made
   every Arabic check a skip. It now fetches `/ar/…`.
4. **The brief's snippet rule contradicts its own guard.** "Cut at 155, then
   append a ~50-character suffix" would exceed the 160 cap. The body is
   budgeted so the total is ≤155.
5. **Arabic count agreement in the generated `/services` description.** It
   was "في 8 تخصصًا", correct only for 11–99. Rephrased so it reads
   correctly for any number ("183 من خدمات … منها 70 متاحة").
6. **Pre-existing, not changed:** every public GET sets `csrf_token`, and
   `last_path` when `Accept: text/html`, Googlebot included. These are
   CSRF/navigation cookies, not language cookies. Changing the CSRF
   middleware is out of scope. Google ignores cookies, but see "needs
   Ziad" 5.
7. **Pre-existing, not changed:** 404 and register use `layouts/auth.ejs`,
   which still appends "– Tashkheesa" to Arabic titles. Neither is indexed.
8. **Pre-existing, not changed:** the `/coming-soon` no-JS form fallback
   posts to `/api/pre-launch-interest`, which has no `/ar/` twin. Its error
   re-render therefore uses the cookie language. The JS path is unaffected.
9. **Pre-existing, not changed:** on a local `/login?lang=ar`, the `lang`
   cookie is emitted three times. This path is not touched by this work.

Found by an independent adversarial review (read as Googlebot, a cache, an
Arabic phone user, and an attacker). **Fixed** in `6494979`, each with a
guard and a negative test:

10. **Capitalised URLs bypassed the scheme.** Express matches routes
    case-insensitively, so `/SERVICES?lang=ar` returned 200 with a `lang`
    cookie, an Arabic body and an English canonical. It's now one 301 to
    `/ar/services`. POSTs and non-public paths are untouched.
11. **Arabic users on portal and auth pages were linked to English.** Public
    pages no longer read the cookie, so every link to them from outside the
    scheme opened English:
    - the shared footer, and the auth-layout logo
    - register and doctor-signup terms
    - dashboard blog cards and the refund-policy link
    - the delete-account and account-deleted privacy links
    - the error page's Home link

    `middleware.js` now sets `publicLinkPrefix` on every request, and every
    link to a public page in every view uses it. The lint scans all 197 views
    (`ops-*` and the help-guide mock-ups are exempt). Checked locally:
    `/register` with `lang=ar` links `/ar/terms` and `/ar/privacy`, and
    without the cookie `/terms` and `/privacy`.
12. **The English toggle couldn't reach the portal, and booking dropped
    Arabic.**
    - An old `lang=ar` cookie survived an English visit into `/login`.
    - An Arabic visitor clicking "book" landed on an English login. That's
      live in production.

    Auth and booking links now carry `langParam` (`lang=ar` or `lang=en`).
13. **A quadratic regex ran on every request.** `/\/+$/` took 217 ms
    in-process on a 16k-slash path, and the old code measured 1,023 ms for
    3 calls on 20k. It's now a loop with a 256-character cap; locally, an
    8,000-slash URL now answers 404 in 0.06 s.

**Documented, not fixed:**

14. **A two-hop chain.** `/services.html?lang=ar` → `/ar/services.html` →
    `/ar/services`. Rare, and it's a chain, not a loop. Part of pass B.
15. **`?lang=` and case 301s skip helmet's headers** (HSTS etc.), because
    they're answered before `baseMiddlewares`. Moving the middleware inside
    the helmet stack means editing `baseMiddlewares`; left for pass G.
16. **Latent: cookie-dependent public bodies without `Vary`.** `/`
    redirects signed-in users, `/services` builds booking links per user,
    and forms embed per-visitor CSRF tokens. None of these responses sends
    `Vary` or `Cache-Control: private`. Harmless today: every public
    response also sends `Set-Cookie: csrf_token`, so it isn't edge-cached.
    See "needs Ziad" 5.
17. **Sitemap specialties without an internal link.** The sitemap and detail
    route count a specialty as live when it has a visible service. The
    `/specialties` index only links specialties with a bookable one. Some
    live, 200, self-canonical specialty pages therefore have no link from the
    site. Part of pass E.

**Found in live verification after the deploy — fixed in `57a7269`:**

18. **The main "Start your case" button on `/services` put the language
    inside `next`.** It rendered `/login?next=/patient/new-case?lang=ar` for
    a logged-out visitor, so the login page itself stayed English (the
    per-service and per-specialty links were right: `…&lang=ar`). The guard
    had missed it because it matched `lang=ar` anywhere in the href. Fixed
    in `services.ejs`: the language joins with `&` when the URL already has
    a query. The booking and auth checks in `seo-internal-links` now parse
    each link and require `lang` as a top-level parameter. Negative-tested:
    with `services.ejs` at `6494979`, the tightened guard fails.

**Test limits the review noted:**
- **The harness isn't the real server.** It has no CSRF, no helmet and no
  `/lang/` route; mount order is checked by a source check.
- **`rtl-doc-direction-flips` treats a non-200 as a skip,** and the
  server-booting tests skip without a migrated DB. They are run here
  explicitly against `tashkheesa_mobile`.
- **Signed-in and booking-on variants** are now rendered by the harness. The
  signed-in variant is covered only through the `user` option; no test uses
  it yet.

## Deliberately not done

- **The second pass.**
  - **B:** redirects (www/non-www, trailing-slash 301s, legacy paths beyond
    the `.html` set)
  - **C:** noindex hygiene
  - **E:** internal linking beyond carrying the prefix
  - **F:** schema — the homepage JSON-LD is still English-only
  - **G:** performance and caching
- **The optional `Accept-Language` redirect on `/`.** The brief says never
  redirect when a cookie exists, but the public toggle no longer sets a
  cookie. The only cookie left would be the one the redirect itself sets. A
  returning Arabic visitor would then land on English, which is worse than
  no redirect. The URL decides; Egyptian visitors reach Arabic through links,
  search results and the toggle.
- **No `/ar/` URLs for auth pages** (per the brief). Arabic pages link to
  `/login?lang=ar`.
- **`/app`** stays `noindex`, with no canonical or hreflang, and is not in
  the sitemap.
- **Homepage `og:title` / `twitter:title`** are unchanged, since the brief
  specifies `<title>` and H1.
- **`<lastmod>`** is the date the build started serving, not a per-page
  edit date: the pages are templates.

## Needs Ziad

1. **Google Search Console — submit and request indexing.**
   - Submit `https://tashkheesa.com/sitemap.xml` (Sitemaps → Add). It now
     lists every public page in both languages, with hreflang.
   - URL Inspection → Request indexing for `https://tashkheesa.com/ar/`,
     `/ar/services`, `/ar/specialties`, and each `/ar/specialties/<slug>`
     that is live.
   - In about 1–2 weeks, check Pages → Indexed for `/ar/` URLs, and the
     hreflang errors (if any) under the International Targeting / Enhancements
     reports.
2. **An Arabic-native review of the new titles and meta.** MSA was used for
   titles and descriptions, and Egyptian Arabic for body copy. The strings:
   - **Homepage:** `رأي طبي ثانٍ من استشاريين مصريين خلال ٤٨ ساعة | تشخيصة`
     and H1 `رأي طبي ثانٍ مكتوب من استشاري باسمه — خلال ٤٨ ساعة` (both from
     the brief); meta `احصل على رأي طبي ثانٍ من استشاريين مصريين معتمدين…`.
   - **Titles:** الخدمات والأسعار · التخصصات الطبية · عن تشخيصة · تواصل
     معنا · الأسئلة الشائعة · مدونة تشخيصة · متى تحتاج إلى رأي طبي ثانٍ؟ ·
     كيف تعمل تشخيصة: رأي طبي ثانٍ في 3 خطوات · اختر الخدمة المناسبة لحالتك.
   - **Descriptions:** services (generated), specialties, specialty detail
     (suffix `— رأي طبي ثانٍ من استشاريين مصريين خلال ٤٨ ساعة`), about,
     contact, FAQ, blog index and both posts, help-me-choose, coming-soon,
     apply, app, terms — all in `src/routes/static-pages.js`,
     `src/routes/apply.js`, and `src/views/app_landing.ejs`.
   - **The 16 Egyptian-Arabic service card lines** in
     `SERVICE_DESCRIPTIONS_AR`, and the Arabic generic line.
3. **Digits.** The brief's strings use Eastern Arabic digits (`٤٨`), while
   the rest of the site deliberately uses Western digits, as do the new
   generated counts and prices. Keep `٤٨` in the homepage title/H1 and the
   specialty suffix, or switch to `48`?
4. **Campaign links.** Existing `?lang=ar` links (WhatsApp, Instagram, email)
   still work: they 301 to `/ar/…` and keep UTM parameters. New links should
   point straight at `/ar/…`.
5. **Don't turn on Cloudflare HTML caching yet.** `/` redirects signed-in
   users, and the forms carry per-visitor CSRF tokens, so those bodies
   depend on cookies without `Vary: Cookie`. That belongs to pass G.

## Commits (oldest first)

1. `418e8d0` fix(seo): Arabic had no URL of its own, so Google only ever saw English
2. `0b66b78` fix(seo): every page told Google its English URL was the only one
3. `3e46f3e` fix(seo): internal links sent the Arabic site back to English
4. `c4ecc3f` fix(seo): the sitemap was a hand-written English list with no specialty pages
5. `e6ec703` fix(seo): Arabic pages had English titles and descriptions, and the brand twice
6. `6494979` fix(seo): what review found — capitalised URLs, English links from Arabic portal pages, booking links, a slow regex
7. `57a7269` fix(seo): the main booking button put the Arabic language inside next=, so login stayed English
8. `docs(audit)` this report
