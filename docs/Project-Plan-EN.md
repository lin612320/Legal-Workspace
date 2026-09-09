# Faron (法元) · Legal Workbench — Project Plan

> **Baseline for this document: the competition build v0.6.0-赛事版** (branch `feature/赛事版`, tag `v0.6.0-赛事版`, packaged 2026-09-07, includes Floating-Ball Assistant 1.0.1). Differences from the main dev line (v0.6.0 “法元 · Faron”) are summarized in §2.1 and detailed in `docs/11-赛事版改动说明.md` (Chinese).
>
> Document version: v1.0-EN · 2026-09-07 · English mirror of `docs/项目计划书.md` (Chinese, v2.4), written against the current source tree and docs.
> Engineering name: **legal-workbench** — main executable `legal-workbench.exe`; bundle/data identifier `com.legalworkbench.app` (unchanged through every rebrand).
> Brand history: 律政工作台 (Legal Workbench, ≤ 0.4.x) → 律衡 (Lüheng, 0.4.1–0.5.0) → **法元 · Faron** (0.6.0 onward; Chinese name 法元, English name **Faron**). Companion desktop utility: **悬浮球助手 Floating-Ball Assistant** (Electron). Mobile companion demo: **Faron Mobile Demo** (Capacitor, `legal-workbench-mobile`).
> Product naming guide for readers: 法元 = Faron; 小元 = “Xiao Yuan” (agent persona); 律政工作台 = “Legal Workbench”; 悬浮球 = “floating ball”.

---

## 1. Project Overview

### 1.1 Background and positioning

Legal professionals (lawyers, in-house counsel, mediators, etc.) routinely combine *statute lookup, document drafting, AI Q&A and foreign-language translation*, but today these tasks live in separate tools — browsers, translators, and generic AI chatbots — with fragmented data and context. Generic AI answers cannot guarantee that cited statutes are real and traceable, and cloud-only products expose sensitive client documents to outbound traffic.

**Faron (法元)** is a **local-first, all-in-one legal workbench**: a statute library + a document agent (“Xiao Yuan” / 小元) + translation + a desktop floating-ball text-grab assistant, packaged into one offline desktop application. **All data stays on the local machine** — sensitive documents never leave the user’s environment. A built-in **Japan/US statute library of 152,940 real articles** (sources: Japan e-Gov, U.S. govinfo.gov, constitutioncenter.org) works out of the box, with **no online import required**.

The **primary scenario is cross-border/cross-jurisdiction legal work involving Japanese and U.S. law** — reviewing contracts and documents governed by Japanese/U.S. law (Sino-Japanese joint ventures, investment in the U.S., export-compliance matters). The document agent autonomously searches real statutes, drafts documents, and delivers **.docx files with traceable citations** — an end-to-end “digital employee” loop: *understand the brief → make a plan → call tools autonomously → deliver verifiable results*. A full Chinese statute corpus is on the roadmap for v0.7.0 (authoritative public sources only; fabricated provisions are prohibited); today Chinese capability is demonstrated with built-in sample articles and Chinese document templates.

### 1.2 Objectives (v0.6.0-赛事版 acceptance view)

- **Feature surface (competition build)**: 8 navigation sections — Home, Law Query, Template Library, Document Agent (Xiao Yuan), Translation, Todo & Reminders, Data Settings, Data Import. Law Query is upgraded to **browse by country → legal domain → whole law**, with bilingual law names, article-number jumping, print/save-as-PDF, selectable/copyable text, Chinese-input keyword search, and an **article-level built-in official Chinese translation of the U.S. Constitution** (Preamble + Articles I–VII).
- **Digital-employee capability**: plan cards (editable), an autonomous function-calling tool loop over the real local library, human-in-the-loop confirmation gates, task history with resume, multi-role relay (planner → searcher → drafter → QA), **deterministic citation self-check** (code-level rule verification — not model self-report), and one-click **.docx delivery** recorded to “Recent documents”.
- **Brand (0.6.0)**: product name/window title/sidebar/notifications/AI prompts/ball panel/deliverable sign-off unified under **法元 · Faron**; agent persona renamed **Xiao Yuan**; engineering identity and user-data directory intentionally unchanged so upgrades never lose data.
- **Deliverables (packaged)**: `发布包/法元_0.6.0_赛事版_x64-setup.exe` (≈135.1 MB, embeds the preloaded law DB + Floating-Ball Assistant 1.0.1 in versioned dir `win-unpacked-0.6.0`) and portable `发布包/悬浮球助手 1.0.1_赛事版.exe`; mobile demo APK `律政工作台-移动端/发布/法元-移动端-演示-v0.1.0-debug.apk`.
- **Repository releases**: desktop `lin612320/Legal-Workspace` — `dev` branch tagged `v0.6.0` (mainline) and `feature/赛事版` branch tagged `v0.6.0-赛事版`; mobile demo on `lin612320/legal-workbench-mobile` (`main`).
- **Competition framing**: presented at the “2026 AI 模型智能体创新大赛（AI 杭州 码动未来）” as the evolution *from a Q&A assistant to a digital employee that delivers artifacts*, with the flagship demo scenario of cross-border Japanese/U.S. legal work.
- **Roadmap (v0.7.0, task breakdown in §6.1)**: full Chinese statute corpus ingestion as the main thread, plus data-safety (P0), architecture/experience (P1/P2) and engineering (P3) improvements.

---

## 2. Scope and Product Form

| Form | Status | Scope |
| --- | --- | --- |
| **Desktop (Windows, Tauri 2)** | ✅ Competition build packaged & pushed (2026-09-07) | 8 sections: Home / Law Query / Template Library / Document Agent (Xiao Yuan) / Translation / Todo & Reminders / Data Settings / Data Import; built-in JP/US library of 152,940 articles; Floating-Ball Assistant bundled (including “related-law lookup” bridged into the main app’s local library) |
| **Floating-Ball Assistant (Electron 33)** | ✅ v1.0.1 bundled with the competition installer | Select-text and use: translate / related-law lookup / ask AI; multi-skin theming; two-way file bridge with the main app; grabbed text can prefill the Document Agent task |
| **Mobile (Capacitor demo)** | 🚧 Demo APK (released) | Law lookup (country + keyword + preview), AI multi-session chat, translation (reuses AI endpoint), templates, todos, focus timer, themes; data sources abstracted as `local / remote` (read-only server protocol ready, server not yet deployed) |
| **Read-only backend service (planned)** | 🚧 Planned | Statute read-only API (`/api/laws/*`, protocol in mobile `src/laws/remote.ts`) / update packages / usage stats; deliberately no accounts and no sync in phase one |

### 2.1 Competition-build changes vs. the mainline (summary)

- Navigation reduced **10 → 8**: “AI Q&A” (`/assistant`) and “Focus Timer” (`/focus`) sections were removed from the competition branch. Their chat tables and AI-interface configuration are retained (used by the Document Agent and Translation). Instant Q&A is served by the Floating Ball’s “Ask AI” panel or by handing materials to Xiao Yuan for a full deliverable run.
- Law Query rebuilt around **“country → legal domain → whole law” browsing** with bilingual metadata, plus keyword search that **accepts Chinese input** (hits translated titles/content), FTS5-first with LIKE fallback, and a one-click “open whole law” entry.
- New DB columns/tables (`laws.title_zh`/`content_zh`, `laws_meta`, `country_intro`) with automatic, backward-compatible migrations; new backend commands `laws_country_home(country)` and `law_page(title)`.
- **Official Chinese translation of the U.S. Constitution baked in at article level** (25 paragraphs, aligned 25/25 with the U.S. State Department official translation PDF — generated content is never passed off as translation).
- Floating-Ball fixes → **1.0.1**: fixed window sizes + an 800 ms size watchdog, drag clamping to the primary-monitor work area, stale drag-state cleanup, results auto-clear, restored grab-mode quick switch.

### 2.2 Explicit non-goals (0.6.0 boundary)

- Cloud accounts / multi-device sync / team collaboration (local-first is the product position, not a defect).
- **Full Chinese statute corpus** (primary scenario is cross-border JP/US legal work; Chinese provisions are ingested from authoritative public sources on the v0.7.0 roadmap).
- Full offline statute library on mobile (a ~490 MB library is unsuitable as a default mobile distribution).
- Semantic/vector retrieval over the whole 150k-article library (keyword recall via FTS5 → top results fed to the model instead of full-library embedding).
- Advanced .docx layouts (tabulated risk lists, comment/revision mode) — the current exporter is a minimal OOXML subset.
- Scheduled automatic backup (persisted configuration + manual execution only).

---

## 3. User Scenarios and Value

1. **Review a Japan/U.S.-related contract (flagship end-to-end scenario).** Paste a contract (Sino-Japanese JV, U.S. investment, cross-border trade/export-compliance) → Xiao Yuan makes a plan → autonomously searches the built-in real JP/US statutes → drafts a 《Contract Review Opinion》 (Chinese output citing official article numbers + sources) → exports .docx, every citation checkable.
2. **Draft cross-border documents.** One-click pipelines for complaints / evidence-opinions, backed by both templates and real statutes; search terms, legal sources, and document language can branch by “Japan-related / U.S.-related”.
3. **Ask AI for grounded answers.** AI responses are injected with real statutes — “cite real provisions, never fabricate”; answers can be handed off to the Document Agent as a task in one click.
4. **Look up foreign law.** For cross-border work — Japanese law (“遺留分”) or U.S. Code (“trademark”) — in-country hits within seconds, FTS5 ranked, source attribution included.
5. **Select-text and go.** In any application, select text → the Floating Ball offers translate / related-law lookup (routed into the main app’s local library) / ask AI / prefill a Document Agent task.
6. **Chinese-law extension (roadmap v0.7.0).** Once the full Chinese corpus is ingested, the same agent capability serves domestic contract review and labor-dispute scenarios; currently Chinese is demonstrated with built-in samples + Chinese templates.
7. **On the move.** Court/hearing or business travel: statute lookup and AI summarization from the mobile companion demo.

---

## 4. Feature Scope

### 4.1 Desktop — competition build (8 sections)

**Home Overview** — greeting + date; stat cards (today / in progress / overdue); overdue banner linking to Todo; today’s due todos (checkable inline); **Recent documents** (agent deliverables, open/delete); quick-entry grid for all sections.

**Law Query** (two modes) — `📚 Browse by law`: pick a country (🇯🇵 Japan / 🇺🇸 U.S. / 🇨🇳 China) → country overview page (polity / state form / legal-system overview + laws grouped by legal domain with bilingual names) → whole-law page `/law/:title` (bilingual metadata, full text defaulting to official original language, chapter headings, selectable/copyable body text, article jump accepting Arabic/Chinese/Roman numerals such as `103`/`百三`/`第一条`/`Amendment 5`, and **print / save-as-PDF** via the WebView printer with zero added dependencies; a “view translation” toggle reveals the built-in official Chinese translation of the U.S. Constitution article-by-article). `🔍 Keyword search`: country-limited, FTS5-first (trigram + BM25), automatic LIKE fallback for short keywords or FTS failure, up to 500 hits grouped by law title, **Chinese input matches translated titles and body translations**, each result offers “open the whole law”.

**Template Library** — built-in document templates across categories (authorization, litigation, labor arbitration, letters, contracts); category chips; create custom templates (the `____` convention marks fill-in blanks); built-in templates are protected from deletion.

**Document Agent “Xiao Yuan”** — contract review → review opinion / complaint drafting / cross-examination opinion pipelines. Model structured **plan card** (editable steps/keywords/country); autonomous tool-calling loop over `laws_search / law_by_id / laws_country_preview / template_load / translate_text` (≤6 rounds; only real tool returns may be cited); human confirmation gates, pause/resume, fail-stop; task history load & continue; **deterministic citation self-check** appended to QA (code-level rules parse in-text article numbers and verify each against the articles the tools actually returned — uncovered citations are named for human review and not counted as valid); real-time deliverable preview → **export .docx** (recorded to Home → Recent documents; the browser build downloads .md). **Demo mode** (no model key configured) runs the preset pipeline with tools really executing — so a full run can be shown even offline or without an API key.

**Translation** — 15 target languages + auto-detect; free engine out of the box (Google gtx endpoint, no key) and an optional paid OpenAI-compatible engine; language swap, shortcut send, one-click copy, character count, live engine indicator.

**Todo & Reminders** — CRUD with due time, advance-reminder minutes, desktop-popup toggle; filters with counts; automatic overdue/upcoming/due labels; **desktop system notification on due time** (Rust background poller, 30 s); sidebar badge and Home stats fed from the same data.

**Data Settings** — AI/translation endpoint configuration (shared by the agent and translation; **API keys stored obfuscated with `enc:` XOR+hex**, never plaintext, with automatic migration of legacy plaintext); day/night theme; manual backup (`legal-YYYYMMDD-HHMMSS.db`), auto-backup configuration (config + manual run only), database restore; preferences.

**Data Import** — Excel batch import of statutes/templates (Chinese or English headers; statute import supports optional `title_zh` / `content_zh` translation columns), result summary “N added, M skipped”; imported statutes are instantly searchable (FTS5 trigger keeps the index in sync).

**Supporting pieces.** Floating-Ball Assistant 1.0.1 (Electron): auto/manual grab modes, skins & themes, hover bubble, two-way bridge with the main app, obfuscated shared key handling, system-proxy requests, independent portable mode. Built-in library: Japan 2,104 laws (95,897 articles) + U.S. Code 53 Titles & U.S. Constitution (57,037 articles) + 6 Chinese sample articles = **152,940 articles**; auto-loaded at first launch (old empty DB backed up first). Search: `laws_fts` external-content FTS5 index (trigram, BM25), keyword ≥3 chars → FTS5, otherwise/short/error → LIKE fallback.

### 4.2 Mobile (Faron lightweight companion — demo released)

- Statute lookup: country filter + keyword + key-statute preview (data-source interface `local / remote` switchable; protocol in `src/laws/remote.ts`).
- AI: multi-session streaming chat; translation (reuses the AI endpoint); templates; todos; focus timer; themes.
- Scope notes: data stored on-device (localStorage); the demo speaks to “Faron’s mobile-ecosystem demonstration” — it intentionally excludes the desktop’s full offline library, Excel import, Document-Agent tasks and .docx delivery (all desktop capabilities). The online retrieval source stays disabled until a server is deployed. Current APK: `法元-移动端-演示-v0.1.0-debug.apk`.

### 4.3 Data assets

- Preload DB: `src-tauri/preload/legal_preload.db` (≈490 MB, git-ignored, distributed inside the installer; docs cite ~467–490 MB).
- User DB: `%APPDATA%\com.legalworkbench.app\legal.db` (single-file SQLite, WAL).
- Processing pipeline: `法库ETL工作区/` (clean → article splitting → xlsx → import/preload), rerunnable per `ETL说明.md`.
- Legal text copyright: original statute text belongs to the official sources (e-Gov, govinfo.gov, constitutioncenter.org, national law databases, etc.); the app uses it for local lookup and citation only — distribution must respect the compliance boundary.

---

## 5. Technical Approach

### 5.1 Desktop stack (as built)

Tauri 2 (Rust) + React 18 / TypeScript 5.5 (strict) + Vite 5 (dev port 1420) + SQLite (rusqlite 0.31 bundled, WAL, `laws_fts` FTS5) · React HashRouter (8 sections + `/law/:title`) · zero-dependency OOXML .docx export (`docx.rs`) · XOR+hex API-key obfuscation (`keycrypt.rs`, `enc:` prefix, startup plaintext migration) · Electron 33 Floating Ball (`floating-ball/`, v1.0.1) with a `%APPDATA%\floating-ball` JSON file bridge · NSIS packaging embedding the preload DB and the versioned ball folder · dual-environment fallback (desktop SQLite vs. browser `localStorage` sample data via `isTauri()`).

Architecture notes (Rust side): `lib.rs` (commands, window show/hide, setup incl. SQLite init, preload loading, secret migration, ball auto-launch, and the 30 s todo-notification poller), `db.rs` (idempotent migrations `CREATE TABLE IF NOT EXISTS` + `ensure_column`, seeding, FTS5 maintenance), `ball.rs` (ball location/launch/control-file bridge), `docx.rs`, `keycrypt.rs`. Per the architecture doc (docs/01), the mainline registers **49 `#[tauri::command]`s** (43 in `lib.rs` + 6 in `ball.rs`); the competition branch adds the two whole-law browsing commands **`laws_country_home`** and **`law_page`**. Windows: `main` (1200×760, min 980×680) and an always-on-top `float` window (380×500, min 320×400); both are statically pre-declared and only shown/hidden at runtime.

### 5.2 Document Agent — technical points

- Access: OpenAI-compatible `/chat/completions` — streaming + `tools` (function calling) + structured JSON output (plan card).
- Engine: `src/lib/agent.ts` — planning (model-driven or demo-preset), execution (model-driven tool loop ≤6 rounds / deterministic demo), four-role prompts (planner / searcher / drafter / QA), stepwise logs, citation audit (`auditCitations`).
- Tools: `laws_search`, `law_by_id`, `laws_country_preview`, `template_load`, `translate_text` — all backed by the real local library, results carry `refs` (article provenance).
- State & memory: `tasks / task_steps / task_artifacts / mem_vectors` tables; task history can be reloaded and resumed; cross-task keyword/vector recall (embeddings computed on the frontend, stored back).
- Citation integrity: **deterministic rules** (not a model self-report) recognize Chinese/Japanese “第X条（之Y / のY）” and U.S. “§ NN” citation formats, and check each against the tool returns of the current run; the deliverable carries a fixed “Citation Self-Check (deterministic rule verification)” section.

### 5.3 Retrieval evolution (implemented)

`LIKE full-table scan → FTS5 (trigram) + BM25 relevance (v0.4.0)`, with automatic LIKE fallback; semantic “second channel” is deferred (150k rows are not embedded wholesale — keyword recall + top results fed to the model is the recommended pattern).

---

## 6. Milestones and Current Status

| Version | Date | Milestone | Status |
| --- | --- | --- | --- |
| 0.1.0 | 2026-08-28 | Tauri 2 + React skeleton; 8 sections (browser/SQLite dual mode) | ✅ |
| 0.2.0 | 2026-08-30 | AI chat persistence / multi-session / RAG / focus timer / Excel import / first NSIS installer | ✅ |
| 0.3.0–0.3.2 | 2026-09-03/04 | Floating-Ball desktop assistant debut; versioned ball dirs; built-in JP/US law DB (152,940 articles); country filter & on-demand search | ✅ |
| 0.4.0 | 2026-09-06 | **Document Agent P0–P3** (plan cards / function calling / .docx / task history / multi-role / gates / demo mode) + FTS5 + key encryption + deliverable open/reveal + ball-launch hardening; NSIS packaging | ✅ code & installer; device acceptance pending |
| 0.4.1 | 2026-09-06 | Brand “律衡”; agent persona “小衡” | ✅ |
| 0.4.2 | 2026-09-06 | **Deterministic citation self-check** (code-level rules vs. tool returns) | ✅ |
| 0.5.0 | 2026-09-06 | Installer/product rename “律衡”; ball “related-law lookup” truly works through the main app’s local library; primary scenario set to cross-border JP/US legal work | ✅ packaged (`律衡_0.5.0_x64-setup.exe`) |
| **0.6.0** | 2026-09-06 | **Brand switch 法元 · Faron**; persona renamed Xiao Yuan (小元); engineering identity unchanged | ✅ packaged (`法元_0.6.0_x64-setup.exe`, ≈135 MB) & pushed to GitHub (dev, tag `v0.6.0`) |
| **0.6.0-赛事版** (this submission) | 2026-09-07 | Competition branch: nav 10→8 (AI Q&A & Focus Timer removed); Law Query → country/domain/whole-law browse + bilingual metadata + article jump + print/PDF + copyable text + Chinese search + **U.S. Constitution official Chinese translation baked in**; ball fixes → 1.0.1 | ✅ packaged (`法元_0.6.0_赛事版_x64-setup.exe`, ≈135.1 MB, embeds ball 1.0.1) & pushed (tag `v0.6.0-赛事版`) |
| Floating Ball 1.0.0 / 1.0.1 | 2026-09-03 … 09-07 | Desktop companion shipped from 0.3.0; 1.0.1 (competition build): fixed sizes + watchdog, drag clamping, grab-mode switch fix | ✅ portable + bundled |
| Mobile demo v0.1.0 | 2026-09-06 | Faron-branded Capacitor demo APK | ✅ APK released |
| 0.7.0 (planned; breakdown in §6.1) | — | Full Chinese statute corpus ingestion as the main thread; auto-backup scheduling & restorable checks (P0); global state / DB concurrency / versioned migrations / long-text chunking (P1); Chinese corpus + docx layout & UX (P2); tests / lint / CI / updater (P3) | 🚧 |

> Real-device acceptance checklist: `docs/07-真机验收清单.md`; step-by-step execution & record template: `docs/09-真机验收执行指引.md`; measured results are to be backfilled as competition evidence.

### 6.1 v0.7.0 plan breakdown (candidate task list)

Suggested sequencing: **M1 Chinese-corpus ingestion loop → M2 data safety & architecture stability (P0+P1) → M3 experience & engineering (selected P2+P3)**; each phase is accepted against the `docs/07` checklist + `docs/09` backfill, and packages only after `npm run build` (tsc) and `cargo check` are green.

| Priority | Task | Acceptance points | Source |
| --- | --- | --- | --- |
| P0 · Data safety | Scheduled auto-backup (day-period thread mirroring the 30 s todo poller; run `backup_now` when `backup.interval_days` elapses); verifiable/restorable backups (`wal_checkpoint(FULL)` or `VACUUM INTO` before copy, integrity check after, back up current state before restore) | Backup file appears on schedule; restore opens with matching row counts | docs/05 P0 |
| P1 · Architecture & debt | Global data state (Context/Zustand or change notifications — fixes cross-page desync across Sidebar/Home/Todo/Agent); split SQLite read/write connections or a pool (move slow queries out of the global `Mutex`); batch settings IPC; converge `todos_update`/`todos_save` and fix the TEXT-vs-INTEGER id binding; versioned DB migrations (`PRAGMA user_version` / migrations table); agent long-text chunking by chapter + key-point extraction before drafting | Cross-page data consistent; no whole-library blocking; migrations expressible | docs/05 P1 |
| P2 · Chinese corpus + experience | **Chinese full-corpus ingestion (v0.7.0 main thread)** per docs/07 §八 (authoritative sources e.g. the National Laws & Regulations Database flk.npc.gov.cn → clean into `title/chapter/article_no/content/source` → runtime import or preload; first batch = commonly used laws such as the Civil Code; sizes labeled honestly; citation self-check must resolve Chinese “第X条”); docx tabulated layouts; keyword-recall top-results rerank (no 150k embedding); hit highlighting / by-title tree browsing / pagination; AI sliding window; translation long-text segmentation; todo calendar/recurring reminders | Chinese statute search + traceable agent citations; deliverables meet layout criteria | docs/05 P2, docs/07 §八 |
| P3 · Engineering | Vitest + Rust unit tests (`db.rs`/`keycrypt.rs`/`docx.rs`/agent pure functions) + lint + CI; `tauri-plugin-updater` & `tauri-plugin-log`; enable CSP as needed; parameterize launch scripts (no hardcoded author-machine paths) | Tests / lint / CI green; security items closed | docs/05 P3 |

---

## 7. Quality and Acceptance

1. **Functional acceptance**: every demo path in `docs/功能演示报告.md` (`Feature-Demo-Report-EN.md`) runs successfully.
2. **Performance acceptance**: statute keyword search targets ≤100 ms (FTS5 should be far faster than the old LIKE); measured values recorded per `docs/09`.
3. **Quality gates**: `tsc` (`npm run build`) and `cargo check` green before packaging; install smoke tests pass (first launch with the bundled library / upgrades keep data / ball auto-launch) before a release.
4. **Documentation sync**: README / CHANGELOG / docs stay in step with the version (aligned for 0.6.0 and the competition build).

---

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Real-device acceptance not fully executed (FTS timing / .docx opening / real-model tool calls) | Weak empirical evidence | Execute item-by-item per `docs/07` + `docs/09` and backfill measurements; the 0.6.0/赛事版 builds are packaged and statically verified |
| Full Chinese corpus not bundled (v0.7.0 roadmap); domestic-law scenarios cannot cite Chinese provisions directly | Narrative mismatch if the story stays “domestic contract review” | Position the primary scenario as **cross-border JP/US legal work** citing the built-in official JP/US statutes; Chinese shown via built-in samples + Chinese templates; docs/07 §7 keyword mapping ensures live hits |
| AI depends on external endpoints (key / network / cost) | Demo failure or cost | Demo mode runs the full agent pipeline with real tools and no key; system-proxy support; core local features work offline |
| Model gateway compatibility (tools / json_object) | Unstable pipeline | Probe + fallback: unsupported tools → preset pipeline explicitly labeled “demo mode” |
| API-key obfuscation (XOR+hex) is not cryptographic encryption | Messaging risk | Word it as “no plaintext on disk / anti-misreading”; the Floating Ball uses the same approach |
| Occasional floating-ball launch failure | UX friction | Hardened in 0.4.0+ (job-breakaway retry + visible error reasons); 1.0.1 fixes window-size drift |
| Statute content compliance / currency | Citation risk | Read-only lookup with source attribution; disclaimer “for reference only, official text prevails” |

---

## 9. Appendix

- `docs/Feature-Demo-Report-EN.md` (English) / `docs/功能演示报告.md` — demo paths, scripts and messaging.
- `CHANGELOG.md` — 0.1.0 → 0.6.0-赛事版 evolution (incl. 律衡 and 法元 · Faron rebrands).
- `法库ETL工作区/ETL说明.md` — data sources, cleaning rules, import/preload method (rerunnable).
- docs/06–09 — competition improvement proposal, device acceptance checklist, competition material pack, acceptance execution guide.
- Source repositories: desktop `https://github.com/lin612320/Legal-Workspace` (`dev` @ `v0.6.0`; `feature/赛事版` @ `v0.6.0-赛事版`); mobile demo `https://github.com/lin612320/legal-workbench-mobile` (`main`).
