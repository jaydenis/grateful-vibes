# AGENTS.md

Guidance for AI agents working in this repository.

**Grateful Vibes** streams Grateful Dead live concerts from the Internet Archive. The
frontend is a static vanilla-JavaScript app (Vite + Bootstrap) with no backend and no
API keys, packaged as a Tauri 2 desktop and mobile app. Data comes from two public,
CORS-enabled, keyless APIs.

---

## Commands

| Command | What it actually does |
| --- | --- |
| `npm install` | Installs frontend deps. |
| `npm run dev` | **Bumps the patch version**, then Vite on `http://localhost:5173` (strict port). |
| `npm run build` | **Bumps the minor version**, then `vite build` into `dist/`. |
| `npm test` | **Bumps the patch version**, then `vite build`. There is no test suite. |
| `npm run preview` | Serves `dist/`. |
| `npm run desktop:dev` | `tauri dev` — native window with Vite hot reload. |
| `npm run desktop:build` | `tauri build` — installer for the host OS. |
| `npm run android:dev` / `ios:dev` | Mobile targets; need their host toolchains. |

### The version-bump trap

`dev`, `test`, and `build` all start with `npm version patch|minor --no-git-tag-version`.
They rewrite `package.json` and `package-lock.json` and leave the tree dirty. Do **not**
run them merely to check that a change compiles — you will produce an unrelated version
bump in your diff.

To verify the frontend without side effects:

```bash
npx vite build          # exit 0, writes only gitignored dist/
```

### Verifying Rust changes

```bash
cd src-tauri
cargo check                              # verified clean
cargo clippy
cargo fmt --all --check
```

`cargo fmt --all --check` currently reports diffs in **`build.rs`** and **`src/main.rs`**
only, which keep the upstream Tauri template's 2-space indent. `src/lib.rs` and
`src/sonos.rs` are clean. Do not reformat those two files as a drive-by in an unrelated
change.

There is no linter, formatter, or test runner configured for the JavaScript. Do not add
one unless asked.

---

## Layout

```
index.html            403 lines — the entire markup; element ids are the contract with main.js
src/main.js          2697 lines — all UI state and DOM orchestration
src/api.js            Archive.org + Relisten fetching and normalization
src/player.js         the single <audio> element, transport, Media Session
src/storage.js        versioned localStorage persistence
src/themes.js         the 26 color palettes
src/style.css         custom styles and Bootstrap overrides
src-tauri/src/lib.rs  the seven sonos_* Tauri commands
src-tauri/src/sonos.rs  UPnP implementation behind them
src-tauri/src/main.rs   six-line native entry point
```

`src/main.js` is divided by banner comments: helpers, show list, city hierarchy,
grouping, songs, track panel, transport, listeners, themes, reset data, boot. Put new
code in the matching section rather than appending to the file.

## How the pieces fit

- **`api.js`** exports `fetchCatalog`, `dedupeShows`, `fetchSongbook`, `fetchSongShows`,
  and `fetchShowTracks`. All fetch calls take `{ signal }`; keep new requests abortable.
- **`player.js`** keeps exactly one *active* `<audio>` element, plus a second one that
  is only created to buffer the next track once 30 seconds remain on the current one.
  On `ended` the buffered element is promoted instead of reloading `src`. Playback
  state is always read from the active element through `snapshot()`; never cache a
  reference to an element across a track change.
- **`main.js` mirrors browse state into the URL.** `render()` is a thin wrapper over
  `renderView()` that also calls `syncUrl()`; `restoreFromUrl()` reapplies a link once
  the catalog is loaded. New browse state needs a param in both, or a shared link
  silently drops it.
- **`storage.js`** namespaces every key with `grateful-vibes:v1:`. If you change a stored
  shape, bump `VERSION` and migrate; clearing site data otherwise silently resets user
  state. `clearAllData()` deletes any key starting with `grateful-vibes:`.
- **`themes.js`** defines each palette as an ordered color array. `applyTheme()` in
  `main.js` maps it to the CSS variables `--theme-1` … `--theme-5`, `--theme-action`,
  and `--accent-text`, plus `document.documentElement.dataset.theme`. New CSS should
  consume those variables, never hardcode a palette color.
- **Colors used as text go through `readableInk()`.** The palette colors double as the
  `--ink-*` tokens, and several are far too dark to read as small text on the dark
  panels, so `applyTheme()` also sets `--theme-N-ink` to a lightness-lifted variant and
  `style.css` maps `--ink-*` to those. Use the raw `--theme-N` for fills, borders, and
  gradients; use `--ink-*` for any text or icon that must stay legible.

## Tauri specifics

- **The CSP is tight and there are two of them.** `app.security.csp` and
  `app.security.devCsp` in `src-tauri/tauri.conf.json` must both allow any new external
  host — under `connect-src` for APIs, `media-src` for audio. A request that works in
  `npm run dev` in a browser will fail in the packaged app if you only update one.
- **Register new commands twice.** A `#[tauri::command]` must be added to
  `generate_handler!` in `lib.rs`, and to `src-tauri/capabilities/default.json` if it
  needs more than `core:default`.
- **Desktop-only code paths.** `sonos::supported()` gates the Sonos feature; on mobile
  the commands return an error string rather than being absent.
- **Versioning.** `package.json` is the source of truth; `tauri.conf.json` reads
  `"version": "../package.json"`. The `version` in `Cargo.toml` is not what the app
  displays. The frontend gets `__APP_VERSION__` from the `define` block in
  `vite.config.js`, so it is baked in at build time.
- **Pinned crates.** `sonos-api` and `sonos-sdk-discovery` are pinned exactly (`=0.9.0`)
  and talk to real hardware. Do not bump them without a device to test against.

## Conventions

- Vanilla JS and DOM APIs only: no framework, no state library, no templating step. Work
  within that constraint.
- Bootstrap is CSS only — `main.js` imports `bootstrap/dist/css/bootstrap.min.css` and
  nothing loads the Bootstrap JS bundle. No `data-bs-*` toggles, modals, or dropdowns
  will work; the header menus are hand-rolled in `main.js` with real focus handling.
- 2-space indent, single quotes, semicolons. Match the surrounding file; sources are CRLF.
- Comments explain *why*. Anything counter-intuitive in this codebase (the version bumps
  in `package.json` scripts, the date-based dedupe, the legacy UPnP path) deserves one.
- `README.md` documents behavior and known limitations in detail. When you change
  behavior, update that section instead of leaving it stale.
- Where `README.md` and the code disagree, the code wins. The theme list is duplicated
  by hand in both places, so a palette added to `themes.js` also needs a README mention,
  and `Cargo.toml`'s `rust-version` is the real minimum toolchain.

## Out of scope by design

Do not add these without an explicit request: downloads, accounts, favorites or user
playlists, non-Grateful-Dead content, a web backend, or API keys. The whole app is
static and keyless, and that is deliberate.
