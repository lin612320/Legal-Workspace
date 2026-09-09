# Faron (法元) · Legal Workbench — Feature Demonstration Report

> **Competition build under demo: Faron 0.6.0-赛事版** (branch `feature/赛事版`, tag `v0.6.0-赛事版`, embedded Floating-Ball Assistant 1.0.1). Installer: `发布包/法元_0.6.0_赛事版_x64-setup.exe` (packaged 2026-09-07, ≈135.1 MB). Mobile demo: Faron-branded APK `发布/法元-移动端-演示-v0.1.0-debug.apk` (in-app name “法元（移动演示）”). English mirror of `docs/功能演示报告.md` · v1.0-EN · 2026-09-07.
>
> Product naming guide: 法元 = Faron · 律政工作台 = Legal Workbench · 小元 = “Xiao Yuan” (the document agent) · 悬浮球助手 = Floating-Ball Assistant · 文书智能体 = Document Agent.

---

## 1. Purpose and Scope

This report walks reviewers / judges through the core capabilities of the **Faron competition build** with operable, item-by-item demo paths. Emphasis goes to two areas:

1. the **Document Agent “Xiao Yuan” end-to-end loop with deterministic citation self-check** — “understand the brief → plan → autonomously call real tools → draft → QA → deliver .docx”; and
2. the upgraded **Law Query: browse by country → legal domain → whole law** (bilingual names, article-number jumping, print/save-as-PDF, selectable body text, Chinese-input search, built-in official Chinese translation of the U.S. Constitution).

The flagship scenario is **cross-border / cross-jurisdiction legal work involving Japanese and U.S. law**, citing the built-in local JP/US official statute library. The mobile app is presented as a lightweight companion demo describing its position and data-source design.

> Competition-branch caliber: the left navigation is trimmed to **8 sections** (“AI Q&A” and “Focus Timer” are removed). Instant advisory is served by the Floating Ball’s “Ask AI” panel, or materials can be handed straight to Xiao Yuan for a deliverable.
>
> All “Operation / Expected result” steps below are written against the competition-branch code and installer. Real-device, item-by-item acceptance and measured data follow `docs/07-真机验收清单.md` + `docs/09-真机验收执行指引.md` and are to be backfilled; screenshot / recording slots are left open.

## 2. Product in One Line

A **locally-run digital employee for cross-border legal work**: browse statutes *by country → domain → whole law* and search by keyword (bilingual, article jumping, print/PDF) + a **Document Agent** that autonomously looks up real statutes, drafts and delivers **.docx** outputs + translation + a select-text floating ball — with **152,940 built-in JP/US articles working out of the box (no online import)** and **all data staying on the local machine**.

## 3. Desktop Demo Walkthrough (Operation / Expected Result)

### 1. Install & first launch (≈1 min)

- **Operation**: run `发布包/法元_0.6.0_赛事版_x64-setup.exe` → first launch.
- **Expected**: the Floating-Ball Assistant auto-starts (system tray, version 1.0.1 shown on hover); “Law Query” shows “built-in statutes 152,940”; the left navigation contains **8 sections** (Home / Law Query / Template Library / Document Agent / Translation / Todo / Data Settings / Data Import); window and installer display the brand “法元 · Faron”.

### 2. Law browsing + keyword search (key section, ≈3 min)

- **A · Browse by law (competition-build feature)** — Law Query → switch to “📚 Browse by law” → select **🇯🇵 Japan**: the top shows the Japan country overview (polity / state form / legal system); below, laws are grouped **by legal domain** (original name + Chinese translated name). Click e.g. “日本地方税法 / 民法 / 日本国憲法” → the **whole-law page**: metadata + full text of the law.
- **B · Whole-law page capabilities** — type an article number to jump (Arabic `1`/`103`, Chinese `第一条`/`百三`, or Roman numerals e.g. `Article·Sec`/`Amendment 5`) → the target article is located/highlighted; body text is the official original by default and **selectable/copyable**; click “🖨 Print / Save as PDF” → the system save-as-PDF dialog opens; open the U.S. Constitution and flip the “View translation” toggle → the **official Chinese translation appears article by article** (Preamble + Articles I–VII; the 27 Amendments intentionally show no translation — the app does not fabricate translations).
- **C · Keyword search** — select **🇯🇵 Japan**, type `遺留分` (or `契約`); switch to **🇺🇸 U.S.**, type `trademark`; then type **Chinese** `宪法` (hits the translated title of the Japanese Constitution / U.S. Constitution translation).
- **Expected**: in-country hits within the library (the whole library contains “契約” in **4,565** rows); FTS5 is preferred, short keywords / no hits automatically fall back to LIKE; Chinese input hits translated names and body translations; on-demand search stays responsive (no full 150k load).

### 3. Document Agent “Xiao Yuan” — JP/US contract review (headline, ≈4 min)

1. Open “Document Agent (Xiao Yuan)” → task type **Contract Review** → paste a Japan/U.S.-related contract (or click “fill sample contract”) → **① Make a plan**: Xiao Yuan produces an editable **plan card** (with a real model this is LLM structured planning; without a configured model the app clearly enters **demo mode**, and the tools still really execute).
2. Optionally edit the plan (step JSON / search keywords & country) → **② Start execution**.
3. **Expected**: the progress view shows the **model autonomously calling real tools in sequence** (`laws_search → law_by_id → template_load` etc., ≥3 calls; use guaranteed in-library keywords — Japan `契約/民法`, U.S. `trademark`); a “laws cited this run” list shows law title / article number / source (e-Gov / govinfo) — **checkable, never fabricated**; the plan card shows the relay chain “Planner → Searcher → Drafter → QA” with status badges.
4. On completion, check the QA step’s final **【Citation Self-Check · deterministic rules】** verdict and the deliverable’s section “Citation Self-Check (deterministic rule verification)” — it runs in both model and demo modes — then **Export .docx** → click **“Open file”** (opens in Word/WPS) and **“Show in folder”**.
5. Return to Home: **Recent documents** shows this record with inline Open / Delete.
6. Optional: a step marked “needs human confirmation” pauses execution — click Continue to release; execution can be Paused anytime; after a refresh the task can be **loaded from Task History and resumed**.

### 4. Advisory entry points (competition build removed the standalone “AI Q&A” section)

- Instant Q&A is now served by the **Floating Ball panel → “Ask AI”** (selected text or a question → answer); **deliverable work** goes to **Xiao Yuan** (materials → plan → execute → QA → .docx).
- Demo talking point: need an *instant answer*? Ask the Floating Ball once. Need a *deliverable*? Hand the material to Xiao Yuan for the full pipeline.

### 5. Floating-Ball Assistant — select text and go (≈1 min)

- **Operation**: select text in any application → the ball popup offers **Translate / Related-law lookup / Ask AI**; “Related-law lookup” routes into the main app’s local 152,940-article library and echoes the hits back; the main panel can switch between **“🔄 Auto grab / ✋ Manual drag”**; selecting text while on the Document Agent page auto-prefills task material.
- **Expected**: tray tooltip shows **version 1.0.1**; dragging the ball/panel no longer “grows it larger” (fixed window sizes + 800 ms watchdog); the results area only shows action buttons while in use; if the top-bar “🎯 ball” launch fails, a popup explains the reason (no more silent failure); keys are obfuscated and requests go through the system proxy.

### 6. Templates / Translation / Todo (≈30 s each)

- **Template Library**: built-in templates (complaint, power-of-attorney, etc.), category filtering, create custom templates, delete (built-ins protected).
- **Translation**: free engine works out of the box; 15 languages; auto-detect source; one-click copy.
- **Todo**: due time + advance reminders + **desktop system notification at due time**; overdue / upcoming / due labels.
- Note: “Focus Timer” (Pomodoro) is not part of the competition build and is not demonstrated.

### 7. Data settings & security (≈1 min)

- AI / translation endpoint configuration (shared by the Document Agent and translation; `ai.api_key` / `translate.api_key` are stored **obfuscated with an `enc:` prefix** — no plaintext on disk — and legacy plaintext migrates automatically at startup).
- Manual backup / restore; **Excel data import** (statutes / templates) showing “N added, M skipped”.

## 4. Mobile (Faron lightweight companion — reporting caliber)

- **Status**: Faron · Mobile Demo (Capacitor + React); current APK `发布/法元-移动端-演示-v0.1.0-debug.apk` (2026-09-06, in-app name “法元（移动演示）”; older 律衡-branded APKs kept alongside). Demonstrable: statutes (country + keyword + preview), AI multi-session chat, translation, templates, todos, focus timer, themes.
- **Data-source design**: the `LawsSource` abstraction has `local / remote` implementations; once a server is ready, it plugs into the read-only protocol (`GET {server}/api/laws/*`, documented in `src/laws/remote.ts` and the About page). **No server is deployed today → the online source is disabled and the demo always runs on local sample articles.**
- **Boundaries (stated honestly)**: this is a lightweight companion — it does **not** include the desktop’s full statute library, Excel import, Document-Agent tasks, or .docx delivery (all desktop Faron capabilities). The wording is “Faron’s mobile-ecosystem demonstration”, not “a mobile Faron”.
- **Screenshot / recording slots (open)**: capture the laws page and an AI conversation with the same guaranteed keywords used on desktop (Japan `契約/民法`, U.S. `trademark`); video frames can fold into the 90-second desktop script’s “multi-device” beat.

## 5. Demo Environment and Preparation

- Demo machine: Windows 10/11 with the **competition installer** (`发布包/法元_0.6.0_赛事版_x64-setup.exe`, 2026-09-07; embeds Floating Ball 1.0.1). **Launch once beforehand** so the statute library loads, the AI key is valid, and network (proxy) works.
- Backup material: prefer the guaranteed in-library keywords in `docs/07` §7 (Japan `遺留分 / 契約 / 民法`; U.S. `trademark / bankruptcy`); Chinese sample keywords within the 6 built-in sample articles: `第五百零二条 / 隐私权` (explain that the full Chinese corpus is a v0.7.0 roadmap item); agent sample material should be a Japan/U.S.-related clause text whose citations land on those guaranteed keywords.
- Fallback when offline: demonstrate “statute lookup + Document Agent **demo mode (tools really execute)** + templates + local features”; AI-type features are backed by pre-recorded screenshots/documentation.
- Recording: follow the 90-second script in `docs/08` §7 (cross-border flagship caliber), then backfill media into this report.

## 6. Reusable Highlight Lines

1. “**152,940 real JP/US statutes installed and searchable offline — citations you can look up**” — no online import; answers and documents never invent provisions (flagship cross-border scenario: reviewing JP/US-related contracts cites local official statutes directly).
2. “**By country, by keyword — in seconds**” — FTS5-ranked search + country browse; no page freezes.
3. “**Hand the cross-border contract to Xiao Yuan**” — a digital employee that understands the brief → plan card → autonomously calls real tools in sequence → delivers an openable .docx whose citations pass a **deterministic rule self-check** (not a model self-report).
4. “**Human in the loop**” — editable plans, confirmable steps, fail-stop, pause/resume: the AI stays controllable.
5. “**Data never leaves the machine; keys never stored in plaintext**” — the local-first and security story.
6. “**The Chinese corpus is on the way**” — full Chinese provisions from authoritative public sources are a v0.7.0 roadmap item (docs/07 §八); today Chinese is shown through Chinese templates + built-in samples — honest framing, no overclaiming.
7. “**From one article to a whole law: browse by country, open the full text**” — the competition build’s country → domain → whole-law browsing: bilingual names, article jumps (Chinese/Arabic/Roman numerals), copyable text, one-click print/save-as-PDF — and **Chinese input still hits** (e.g., “宪法” → the Japanese Constitution / the U.S. Constitution’s official Chinese translation).
