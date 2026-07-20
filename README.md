# Sprite Baker

GLB/GLTF → game spritesheet baker. Installable PWA, works fully offline after first load. No build tools, no dependencies to install — plain HTML/CSS/JS.

## Features

- Load a GLB/GLTF **or FBX** model, frame it in an orthographic or perspective viewport. FBX (Mixamo's native export format) carries skeletal animation just like GLTF does, so blend, attachments, scene-object duplication, and everything else work the same regardless of which format a given file came in — you can even mix them, e.g. a GLTF soldier with an FBX weapon attachment, or vice versa.
- **ANIM mode** — auto-bakes N evenly spaced frames across an animation clip
- **MANUAL mode** — pose the model by hand (rotation, position, anchor point, animation time scrub) and capture individual frames one at a time, for static props or precise poses
- **PREVIEW toggle** — checkerboard background + crop framing guide, showing exactly what the final transparent sprite will look like
- **LIVE filter preview** — low-res real-time preview of the selected filter, so you see the final look before baking
- Rotation rig (YAW/PITCH/ROLL) with a movable rotation **anchor** point (e.g. pivot a hook from its handle, not its center)
- **Attachments** — load a second GLB (weapon, gear) and parent it to any bone on a rigged model's skeleton. It automatically follows that bone's animated transform across any clip, in preview and in the final bake. Supports multiple simultaneous attachments, each with its own bone, fine position/rotation offset, and scale, so you can fit a weapon precisely into a hand pose. A searchable bone list and a marker at the attach point make lining it up easier on rigs with many bones.
- **Import animation** — a soldier GLB often only contains one animation clip (a typical export from most AI mesh/animation tools). The **+ IMPORT ANIMATION** button loads clips out of a *separate* GLB that shares the same rig (matching bone names, e.g. two exports of the same Mixamo-rigged character) and adds them to the current model's available clips — this is how you get enough clips loaded to use with blend, below.
- **Layered animation blend** — combine two clips on one skeleton, e.g. a run cycle for the legs and a recoil clip for the upper body, so you can bake a running-and-shooting pose without needing a bespoke combined animation. Pick a LOWER and UPPER clip and a split bone (auto-guessed, usually the base spine bone); everything at or above the split follows the upper clip, everything below follows the lower clip. The two loop independently — a short recoil clip re-fires repeatedly across one longer run cycle. ANIM mode only.
- **Scene objects** — place additional freestanding models anywhere in the scene: extra soldiers, tiled ground/road pieces repeated into the distance, props. **+ ADD SCENE OBJECT** loads any GLB; **⎘ DUPLICATE MAIN MODEL** clones the currently loaded rigged model (proper skeleton clone via Three.js SkeletonUtils, so each copy animates independently) and **⎘ DUPLICATE THIS** clones an existing scene object — both use a configurable offset (axis, direction, amount) so repeated duplicates step further along consistently. Each object gets its own position/rotation/scale, and if it's animated, a clip picker plus a sync mode: INDEPENDENT (own timeline, with an adjustable phase offset so a group of duplicates doesn't move in perfect unison) or LOCKED (phase-matched to the main model's current animation, useful for squads moving in step). All scene objects render automatically in preview, live filter, and the final bake — no extra setup needed.
- **Custom / portrait resolution** — RES MODE toggle between SQUARE (the original fixed presets) and CUSTOM, with direct WIDTH × HEIGHT inputs (16–4096px each) plus quick presets (portrait, tall, wide, 1:1). The camera frustum, live preview, framing guide, manual capture, and bake all use the real target aspect ratio — a portrait request renders a true portrait, not a square crop with the sides cut off.
- Position offset, exposure control, autocrop, configurable sheet layout (auto-square, fixed columns, or custom)
- 9 stylized filters (pixel art, Game Boy, 1-bit dither, silhouette, comic ink, Borderlands-style cel-shade, sumi-e, PS1/PSX, neon noir) — every filter has adjustable parameters
- **Projects panel** — save/load your work (model + all settings, attachments, and scene objects) via IndexedDB, so you can revisit and tweak without redoing everything
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

### Updating after the first deploy

The service worker caches the app aggressively so it works offline — which means **reuploading changed files alone is not enough** for existing installs (browser tabs or the home-screen app) to see the update. `sw.js` has a `CACHE_NAME` constant (e.g. `sprite-baker-v2`); bump it by one on every deploy that touches `index.html`, `style.css`, or `app.js`. That forces the old cache to be discarded and the new files to be fetched fresh. If you forget, or want to force an update sooner on a device: open the app, then in Safari go to **Settings → Safari → Advanced → Website Data**, find the site, and remove it — or on desktop, open dev tools → Application → Service Workers → Unregister, then reload.

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

- **Supported formats: GLB, GLTF, FBX.** Other formats (OBJ, DAE/Collada, STL) aren't wired up yet. OBJ in particular has no built-in animation/skeleton support in the format itself, so it'd only ever be useful for static props — say if you need it.
- **Imported animations are not saved with a project** — only the original soldier GLB's own clips are stored. If you reload a saved project that used blend with an imported clip, the blend indices may no longer point to the right animation — re-import and re-select LOWER/UPPER/SPLIT after loading. Ask if you want this persisted properly; it's doable, just not built yet.
- **Attachments require a rigged model** — the ATTACHMENTS panel only appears if the loaded model has a skeleton (SkinnedMesh). Static props have nothing to parent a weapon to.
- **Attachment scale/position is not auto-guessed** — a raw weapon GLB's origin rarely lines up with a grip point, so attachments load at native import scale with zero offset, and you dial in position/rotation/scale by hand. Auto-fitting would just as often make it worse.
- **Loading a new soldier model clears attachments** — bone names are specific to that rig, so switching models resets the attachment list. Saved *projects* remember attachments correctly since they're tied to that specific soldier GLB.
- **Loading a new soldier model also clears scene objects** — same reasoning: a scene composed around one primary model may not make sense with a different one loaded. Duplicate/re-add after switching if needed.
- **Duplicating only clones the mesh/skeleton/animation** — attachments (weapons) on the main model are not copied onto duplicates. If you need an armed duplicate, add the weapon attachment separately to the copy.
- **Manual mode captures are not persisted** — saved projects restore the model, camera framing, all filter/rotation/position settings, but not previously captured manual frames (those would be large binary payloads per frame). Re-capture after reloading a manual-mode project.
- **Live filter preview** renders at a fixed 200×200px and throttles to roughly 6 updates/second — a fast, representative preview rather than the exact bake-resolution result. Final bake always runs the full filter at full resolution.
- The service worker precaches the core Three.js/GLTFLoader/DRACOLoader/OrbitControls files. If a model requires an additional loader submodule not in that list, it will be cached automatically the first time it's fetched successfully online, and available offline from then on.
- Autosave triggers after every successful bake, saved under the loaded file's name. Use the **PROJ** panel's named **SAVE** to keep multiple named variants instead of overwriting the same slot.
