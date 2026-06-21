I now have everything I need: the plugin contract, the existing single-view SNI Cortex plugin, the agent data shape, the design tokens, and the SSE/backend wiring pattern (atlas). I have enough to write a concrete, grounded master plan. No task tracking needed for a synthesis deliverable.

---

# SNI MASTER PLAN — Native Rebuild Inside Subunit Desktop

**Target:** One `sni` plugin in `subunit-desktop` (Tauri 2 + React 19, host-injected React, Subunit Liquid Glass). Today it ships a single Cortex view (`src/plugins/sni/index.tsx`, ~530 lines) + ported `agents.ts`. This plan grows it into the full SNI module with **internal tabs** (not new dock plugins — internal sub-nav inside the one plugin surface), porting all 6 source clusters while collapsing duplicates.

**Architecture decision (load-bearing):** SNI is ONE dock plugin (`nav.section:"core"`) with an internal tab bar. The original SNI's 9 top-level web tabs + Cortex 3D map collapse into ~8 internal tabs. The shell's left dock = app modules (Atlas, Chat, Echo, SNI…); SNI's own tab bar = its sub-views. Render one React root; switch tabs via internal state, persisted via `host.storage`.

---

## 1) COMPLETE TAB LIST (deduplicated, ordered)

The source has heavy duplication: "Agent Registry," "Detail Panel," and "Terminal" each appear in 4–6 clusters as the SAME component. Collapsed:

| # | Tab | Purpose (one-line) | Richness | Key functions |
|---|-----|--------------------|----------|---------------|
| 1 | **Home** | Command-center landing: greeting, system integrity %, GPU/server health, aggregate agent stats | rich | Time-of-day greeting; `/api/gpu` poll (5s) for vram/power/temp/fan/clock; aggregate CPU across agents; running-agent count; server health card; aurora glass backdrop |
| 2 | **Cortex** (signature) | The neural map — U1 + agents on tier rings, axone edges, reflex pulses, inspector, live synapse log | **signature** | Force/ring node layout; axone↔reflexe mode toggle; node select→inspector; hover-lit edges; live log stream; **(upgrade to 3D — see §2)** |
| 3 | **Agents** (Overview) | Registry grid grouped by tier (Surface/Core/Deep) with stats header + click-to-inspect | rich | Global stats (uptime/active/ΣCPU/ΣRAM); tier-grouped cards w/ status LED + CPU/MEM bars; click→Detail Panel (shared); start/stop/restart actions |
| 4 | **Network** (Axons & Reflexes) | Documentation/mapping grid for all axone (workflows) + reflexe (triggers) with detail modals | rich | Mode toggle Axons↔Reflexes; multi-select agent filter; auto-fill card grid; Axon/Reflex detail modal (workflow steps, mechanics, tech-stack, n8n viz, connected agents); category color map |
| 5 | **Reflexe** (Scripts & Workflows) | Browse/search internal scripts + n8n workflows with permission/status badges | rich | Dual-tab Reflexe(scripts)↔Axone(workflows); full-text search; permission badges (auto/ask/deny); active/inactive status; counts; `/api/reflexe` + `/api/axone` fetch |
| 6 | **Marketplace** | Discover/procure future agents — tiers, categories, search, bundles, recommendations, detail modal | rich | Tier+category filters; search; sort (A-Z/€/status); bundle view; recommendations from active agents; status-gated CTAs; detail modal (features/axone/requires) |
| 7 | **U1** (Orchestrator + Chat + Voice) | Unit One control room: 24h cron timeline, cost tracker, text chat + voice orb | rich | 24h/96-slot timeline + magnifier; cron job cards + model selector; cost tracker (heute/monat/gesamt/prognose); U1 text chat (`/ws` or `/api`); voice orb (8-state, mic 16kHz, WS audio) |
| 8 | **Security** (Server + Financial Guard) | Infra health + cost/budget guard with forecasting and alerts | rich | Server status (CPU/Mem/Disk donuts, uptime, load); FinancialSecurity tabs (Dashboard/Tage/Monat/Prognose/Alerts); budget meters; CostChart SVG; editable limits; `/api/security/dashboard` (30s) |
| — | **Detail Panel** | (NOT a tab — shared right-rail component) agent inspector with metrics/logs/axone/reflex chips | rich | Reused by Cortex, Agents; status+CPU/MEM bars; filtered logs; clickable axone/reflex chips → Network modal; cross-nav to Cortex with highlight |
| — | **Terminal / Synapse-Feed** | (NOT a tab — shared bottom panel, optional) live color-coded log stream w/ auto-scroll + opacity fade | standard | Timestamp+code+msg; type colors (info/success/warn/error); fade old entries; LIVE pulse; fed by `useLiveData` WS |
| — | **Login** | (NOT an SNI tab) auth is the SHELL's job — `host.auth`, not a ported Supabase screen | — | Drop the ported Login/Supabase entirely; gate via host account |
| — | **DayEditor** | (DEFER — Phase 4 sub-view of U1) full week scheduler with drag-drop tasks + cron overlay | rich | 7-day grid; drag/resize tasks; recurrence; cron hatched blocks; `/api/schedule` |

**Net: 8 internal tabs** (Home, Cortex, Agents, Network, Reflexe, Marketplace, U1, Security) + 2 shared panels (Detail, Terminal) + 1 deferred sub-view (DayEditor under U1).

**Dropped from the port:** Login/Supabase (shell owns auth), Header/Sidebar/Mobile-tab-bar/Connection-badge/Main-content (shell chrome — replaced by host dock + one internal tab bar), SynapseNetwork decorative SVG (fold its motifs into Home/Cortex backdrop only if cheap). The standalone "U1Chat," "BotChat," "VoiceCall," "U1Profile," "DayEditor" web components all collapse INTO tab 7 (U1).

---

## 2) SIGNATURE PIECES — must stay detail-rich, never abbreviated

**A. Cortex 3D Neural Viz (THE signature).** The current Desktop port is a clean *2D* glass map — good, but the source's `cortex/Cortex.jsx` is the showpiece and should be the v2 target. What makes it impressive and must be preserved verbatim:
- **True 3D projection** — perspective FOV (~900px), force-directed tier layout (core/surface/deep at 180/340/480px radii), repulsion (48000N) + spring (0.003) + radial constraint, Z-depth painter's-algorithm sort. Canvas-2D simulating 3D (DPR-aware/retina), NOT WebGL — keeps it WKWebView-safe like the rest of the app.
- **U1 crown node** — corona halo (3.2× radius), two precessing orbital rings (48 points each, counter-rotating satellites), a rotating 55° scanner arc with trailing fade, dashed outer ring, rotating inner hexagon, 4 radiating ticks — all phase-locked to global time, dimming to 0.3× when dormant. This is the "alive intelligence" centerpiece.
- **ChromaDB vector sphere** — 4000-point golden-spiral cloud in 5 color clusters, world-space radius ~1060px breathing on a sine, front-hemisphere culling that opens the "atom shell" when zoomed in, limb-brightening, cluster flash on absorption, incoming vectors spawning from U1 with 6-point trails + ripple waves on impact. This is the single most distinctive visual in the whole app.
- **Interaction depth** — drag-rotate (clamp ±90°), scroll/pinch zoom (0.08–4×), auto-rotate, hit-detection prioritized by z-depth across agents/axon-midpoints/reflex-orbitals/vectors; clickable axon midpoints + reflex diamond orbitals → detail modals; live search with golden dashed-ring pulse; minimap with viewport frame; HUD chips; layer toggles (AXONE/REFLEXE/VEKTOREN/GRID); tier filters; zoom controls.

→ **Do not flatten any of these to bullet-summaries in code.** The 2D version ships first (already done); the 3D `<canvas>` engine is the Phase-3 crown jewel ported from `cortex/cortexUtils.jsx` + `Cortex.jsx`.

**B. Axon & Reflex Detail Modals** — full workflow pipelines (numbered step timeline w/ connecting lines), tech-stack pills, animated n8n workflow viz (pulsing nodes + stream-flow arrows + workflow ID), connected-agents avatars, version/lastUpdated, ESC/backdrop close, slide-up+scale entrance. These carry the "real system" credibility — keep every section.

**C. Voice Orb (U1 tab)** — multi-layer breathing orb (5 glow layers + core gradient + highlight + center dot), 8 state colors, animated rings during speak/think, real mic capture→16kHz downsample, bidirectional WS audio with scheduled playback, RMS amplitude → orb size. The flagship "talk to U1" moment.

**D. FinancialSecurity CostChart + budget meters** — 800×240 bar+line SVG with cumulative overlay, hard/soft limit reference lines, hover tooltips, color-coded bars (billing-override purple), stacked budget meters with soft/warning/hard threshold markers. The "we run a real cost-governed agency" proof.

**E. U1 24h timeline** — 96×15-min slots, magnifier-lens hover popup, vertical hourly timeline with pulsing now-marker, per-job color bars, model-selector dropdown. The orchestration heartbeat.

---

## 3) DATA + LIVE-WIRING PER TAB

**Static-portable (ships offline, no backend) — Phase 1–3:**
- `agents.ts` (AGENTS, LOG_TEMPLATES, TIER_LABEL) — already ported ✓
- `neural-knowledge.js` → `neural-knowledge.ts` (axons + reflexes graph w/ workflowSteps, tools, n8nWorkflowId, version) — **port next, drives Cortex modals + Network tab**
- MARKETPLACE_ITEMS / MARKETPLACE_BUNDLES / TIER_CONFIG / CATEGORY_CONFIG / STATUS_CONFIG → Marketplace tab
- All color maps, log templates, mock cron jobs, mock cost data — seed every tab so SNI is fully demoable with zero backend.

**Needs a backend (wire via `host.backend` / `host.auth`, gated by `backend:<name>` permission) — Phase 4+:**
| Source endpoint | Tab | Host wiring |
|---|---|---|
| `useLiveData` WS (`ws://…:3099`, msgs `agents`/`log`) | Cortex, Agents, Terminal | Move to `host.backend.sse(...)` or a Tauri WS command; replace the synthetic `setInterval` log loop |
| `/api/gpu` (5s poll) | Home | `host.backend.fetch("sni-api","/api/gpu")` |
| `/api/reflexe`, `/api/axone` | Reflexe | `host.backend.fetch` |
| `/api/security/dashboard` (30s), `PUT /api/security/budgets` | Security | `host.backend.fetch` + write |
| `/api/usage/*`, `/api/terminal/stream` (SSE), `/api/schedule` (+`PUT /…/{day}`) | U1, DayEditor | `host.backend.sse` + fetch |
| `/ws/voice`, `/ws/faq` | U1 (voice/chat), Bot | Tauri WS or host stream; mic via browser `getUserMedia` |
| Supabase auth | — | **DROP** — use `host.auth.account()` / `getToken()` |

**Backend-name decision:** register one logical backend (e.g. `"sni-api"`) in `src/lib/config.ts` pointing at the SNI server (`server.js`, the 36KB Express+WS already in the repo) and declare `permissions: ["backend:sni-api", "storage"]` on the manifest. Today's manifest has `permissions: []` — that's fine while static; bump it the moment a tab goes live. **Verify before claiming live:** the SNI `server.js` routes must be confirmed against each `/api/*` path before wiring (not yet verified here — it's a 36KB file).

---

## 4) BUILD ORDER (phases)

**Phase 0 — Internal-tab scaffold (½ day).** Refactor `index.tsx`: extract `CortexView` into `tabs/Cortex.tsx`; add an SNI tab bar (Liquid Glass segmented control, same `.cx-seg` style already in the file) + `useState<TabId>` persisted via `host.storage`. Tab bar tabs = the 8 from §1; Cortex stays default. One React root, one CSS injection. **Outcome:** module shell with working sub-nav, Cortex intact.

**Phase 1 — Static content tabs (2–3 days).** Port the no-backend-needed tabs against mock data, full design fidelity:
1. **Agents** (Overview grid + shared **Detail Panel** — build the Detail Panel once, reuse in Cortex).
2. **Network** (port `neural-knowledge.ts` first; then grid + Axon/Reflex **detail modals** — signature §2B).
3. **Marketplace** (items/bundles/filters/detail modal).
4. **Home** (greeting + stat cards; GPU section with mock values, real `/api/gpu` later).

**Phase 2 — Mock-rich interaction tabs (2 days).**
5. **Reflexe** (scripts/workflows browser on mock arrays).
6. **Security** (Server donuts + FinancialSecurity tabs + CostChart on mock cost data — signature §2D).
7. **U1** (24h timeline + cost tracker + text chat on canned `U1_RESPONSES` — signature §2E; voice orb visual-only first).

**Phase 3 — Cortex 3D upgrade (3–4 days, the crown jewel).** Replace the 2D SVG map with the ported canvas 3D engine (`cortexUtils.jsx` projection/physics + crown node + 4000-pt vector sphere + minimap + HUD + controls + zoom). Keep the 2D as a `prefers-reduced-motion` / low-power fallback. This is where the "wow" lives — budget it generously, cross-check FPS on retina (the app already cares about WKWebView perf).

**Phase 4 — Live wiring (2–3 days, gated on verifying `server.js`).** Flip tabs from mock → live one endpoint at a time behind a `LIVE/MOCK` flag: `useLiveData` WS → Cortex/Agents/Terminal; `/api/gpu` → Home; `/api/security/*` → Security; `/api/usage` + `/api/schedule` → U1; voice/faq WS → U1. Add `host.storage`-persisted tab state, `host.notifications` for budget-CRITICAL alerts, ⌘K commands per tab.

**Phase 5 — Polish (1–2 days).** DayEditor under U1; Terminal bottom panel; reduced-motion passes; light/dark theme audit (Cortex well stays dark in both per the existing pattern); SPS handoff update.

---

## 5) MODELING AGENTS GENERICALLY (S-01..S-12 are OUTDATED)

The hardcoded S-01..S-11 roster (Radar/Kontakt/Kalender…) is a demo fiction and will be redefined. Make the agent set **data-driven and swappable** so a future real roster drops in without touching any view:

1. **Single source of truth, runtime-loadable.** Keep the `Agent` interface in `agents.ts` (it's already clean: `id/name/code/role/tier/color/status/cpu/mem/desc/axone/reflexe`). Treat the `AGENTS` array as a *seed/fixture*, not a constant baked into components. Add a loader: `getAgents(host): Promise<Agent[]>` that tries `host.backend.fetch("sni-api","/api/agents")` and falls back to the seed. Every tab already consumes `AGENTS` by import — change them to consume the loader's result via one context/hook (`useAgents()`).

2. **No hardcoded codes anywhere.** Remove all literal `"S-01"` / `"U1"` assumptions from view logic. The only structural invariant is **"exactly one orchestrator"** — model it as a flag (`role:"orchestrator"` or `kind:"orchestrator"`) rather than the literal code `"U1"`. Layout, edges, and the crown node should pick the orchestrator by flag, not by `code==="U1"`. (Current `index.tsx` hardcodes `"U1"` in ~8 places — refactor to `agents.find(a=>a.orchestrator)`.)

3. **Tiers stay an open enum.** `"surface"|"core"|"deep"` are presentation rings, not business identity. Keep them, but drive ring radii/colors from a `TIER_CONFIG` map so adding a 4th tier (or renaming) is a one-line data change.

4. **Axone/Reflexe by reference, validated.** `axone: string[]` references other agents' `code`. Add a dev-time validator (`buildEdges` already skips unknown codes — formalize it) so a redefined roster with dangling references degrades gracefully instead of crashing. The `neural-knowledge.ts` graph keys on the same codes — keep agents and knowledge graph keyed identically so one rename propagates.

5. **Status/metrics are live-overlay, identity is config.** Split the data: **identity** (code/name/role/tier/color/desc/axone/reflexe) = config/seed; **telemetry** (status/cpu/mem) = live overlay merged at runtime from the WS feed. This lets the real roster define *who exists* while the backend defines *how they're doing*, and makes the mock→live flip a merge, not a rewrite.

6. **Marketplace agents = same shape, different status.** Future/planned agents already share the `Agent` shape with `status:"planned"|"development"`. Keep one type; Marketplace is just a filtered view of "agents you don't have yet." When the real roster lands, promoting a marketplace agent to active is a status change, not a new model.

**Net:** one `Agent` type, one runtime loader with seed fallback, orchestrator-by-flag, tiers/categories as config maps, identity⊥telemetry split. Redefining the agency's real agents later = swap the seed/endpoint payload; zero view changes.

---

**Key files for the build:**
- `/Users/tomsync/subunit/subunit-desktop/src/plugins/sni/index.tsx` — current single-view plugin (refactor target, Phase 0)
- `/Users/tomsync/subunit/subunit-desktop/src/plugins/sni/agents.ts` — ported agent seed (extend per §5)
- `/Users/tomsync/subunit/subunit-desktop/src/plugin/types.ts` — host contract (backend/auth/storage/nav/events)
- `/Users/tomsync/subunit/subunit-desktop/src/plugins/atlas/index.tsx` — reference for `host.backend.sse` live wiring (Phase 4)
- `/Users/tomsync/subunit/subunit-desktop/src/styles/subunit-liquid-glass.css` — design tokens (`--glass`, `--ink/2/3`, `--cyan`, `--r`, `--shadow`, `--rim`…) — use these, no new palette
- **Port sources** (READ-ONLY ref): `/Users/tomsync/subunit/sni/src/data/neural-knowledge.js` (→ port next), `/Users/tomsync/subunit/sni/src/components/cortex/` (3D engine, Phase 3), `/Users/tomsync/subunit/sni/server.js` (verify `/api/*` routes before Phase 4)