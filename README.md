# Sprite Baker

GLB/GLTF → game spritesheet baker. Installable PWA, works fully offline after first load. No build tools, no dependencies to install — plain HTML/CSS/JS.

## Features

- Load a GLB/GLTF model, frame it in an orthographic or perspective viewport
- **ANIM mode** — auto-bakes N evenly spaced frames across an animation clip
- **MANUAL mode** — pose the model by hand (rotation, position, anchor point, animation time scrub) and capture individual frames one at a time, for static props or precise poses
- **PREVIEW toggle** — checkerboard background + crop framing guide, showing exactly what the final transparent sprite will look like
- **LIVE filter preview** — low-res real-time preview of the selected filter, so you see the final look before baking
- Rotation rig (YAW/PITCH/ROLL) with a movable rotation **anchor** point (e.g. pivot a hook from its handle, not its center)
- Position offset, exposure control, autocrop, configurable sheet layout (auto-square, fixed columns, or custom)
- 9 stylized filters (pixel art, Game Boy, 1-bit dither, silhouette, comic ink, Borderlands-style cel-shade, sumi-e, PS1/PSX, neon noir) — every filter has adjustable parameters
- **Projects panel** — save/load your work (model + all settings) via IndexedDB, so you can revisit and tweak without redoing everything
- Share sheet integration (`navigator.share`) for reliably saving PNG/JSON on iOS, with download-link and long-press-to-save fallbacks

## Running locally

Because this uses ES modules and a service worker, it must be served over `http://` or `https://` — **not** opened directly as a `file://` path.

Any static file server works:

```bash
# Python
python3 -m http.server 8080

# Node (if you have it)
npx serve .
```

Then open `http://localhost:8080` in your browser.

## Installing on iPhone

1. Host the app (see GitHub Pages steps below, or run it on your local network and open that URL in Safari on your iPhone).
2. Open the URL in **Safari** (not Chrome — the iOS "Add to Home Screen" PWA install only works from Safari).
3. Tap the **Share** icon → **Add to Home Screen**.
4. Launch it from the home screen icon — it opens fullscreen with no browser chrome, and the UI is already padded to sit clear of the Dynamic Island and the home-indicator bar.
5. After the first load (while online), all app files and the Three.js library are cached — it will keep working with no internet connection.

## Deploying to GitHub Pages

1. Create a new GitHub repository and push this folder's contents to it (the repo root should contain `index.html`, `style.css`, `app.js`, etc. directly — not nested in a subfolder).
2. In the repo, go to **Settings → Pages**.
3. Under **Source**, choose **Deploy from a branch**, pick your default branch (e.g. `main`) and the `/ (root)` folder. Save.
4. GitHub will publish at `https://<your-username>.github.io/<repo-name>/`.
5. Open that URL — everything is relative-pathed (`./style.css`, `./app.js`, etc.) so it works correctly whether hosted at a domain root or in a subpath like a GitHub Pages project site.

## File structure

```
index.html              — markup
style.css                — styles, iPhone safe-area handling
app.js                   — all application logic (ES module)
manifest.webmanifest      — PWA manifest
sw.js                     — service worker (offline caching)
icon-192.png
icon-512.png
icon-maskable-512.png
README.md
```

All files live flat in the repo root — no subfolders — so uploading via the GitHub web UI (drag-and-drop) works with zero path fixups.

## Notes / known limitations

- **Manual mode captures are not persisted** — saved projects restore the model, camera framing, all filter/rotation/position settings, but not previously captured manual frames (those would be large binary payloads per frame). Re-capture after reloading a manual-mode project.
- **Live filter preview** renders at a fixed 200×200px and throttles to roughly 6 updates/second — a fast, representative preview rather than the exact bake-resolution result. Final bake always runs the full filter at full resolution.
- The service worker precaches the core Three.js/GLTFLoader/DRACOLoader/OrbitControls files. If a model requires an additional loader submodule not in that list, it will be cached automatically the first time it's fetched successfully online, and available offline from then on.
- Autosave triggers after every successful bake, saved under the loaded file's name. Use the **PROJ** panel's named **SAVE** to keep multiple named variants instead of overwriting the same slot.
