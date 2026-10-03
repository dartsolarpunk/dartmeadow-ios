# Credits & sources

Outside work that DART Meadow: Journey of the Skyboard builds on — code, techniques, data, libraries, fonts, tools and services — with author, links and licence. The same list is in the game under **MENU → ABOUT**; its source of truth is `CREDITS` in `index.html`.

Use: **code** = code or tables included (licence terms apply) · **technique** = studied and re-implemented from scratch · **original** = the project’s own work · **data**, **library**, **font**, **tool**, **service** as named.

## Techniques & code references

- **Coding Adventure: Atmosphere · Solar-System** — Sebastian Lague. *MIT* (technique). Ray-marched Rayleigh scattering (1/λ⁴ per channel, scaled by 400 nm) for planet atmospheres, reached through the DART Meadow sandbox; the galaxy star haze uses the same scattering model.
  <https://www.youtube.com/watch?v=DxfEbulyFcY> · <https://github.com/SebLague/Solar-System>
- **Coding Adventure: Marching Cubes** — Sebastian Lague. *MIT* (technique). Approach for density-field planet terrain; rewritten for the browser, no code copied.
  <https://www.youtube.com/watch?v=M3iI2l0ltbE> · <https://github.com/SebLague/Marching-Cubes>
- **Coding Adventure: Simulating Fluids · Fluid-Sim** — Sebastian Lague. *MIT* (code). SPH kernels and steps (spiky density / near-density, shared-pressure force, Poly6 viscosity, predicted positions, trapped-air foam rule) ported to JavaScript for the live water around the pilot (`ui/dm-fluid.js`), as in ArcLake.
  <https://youtu.be/rSKMYc1CQHE> · <https://github.com/SebLague/Fluid-Sim>
- **Unified Spray, Foam and Bubbles for Particle-Based Fluids** — M. Ihmsen, N. Akinci, G. Akinci, M. Teschner (2012). *Published paper* (technique). Foam, spray and bubble particles thrown up by churned water.
  <https://cg.informatik.uni-freiburg.de/publications/2012_CGI_sprayFoamBubbles.pdf>
- **ArcLake · SPH Ocean** — DART-Skyboard · Radical Deepscale. *DART Meadow project* (technique). The project’s own browser SPH ocean; the reference for bringing Fluid-Sim into the game.
  <https://radicaldeepscale.com/ArcLakeFluidSim.html>
- **Procedural Planets (cube-sphere)** — Sebastian Lague. *MIT* (technique). Cube-to-sphere planet patches used by the sandbox’s quadtree LOD planet.
  <https://github.com/SebLague/Procedural-Planets>
- **Polygonising a scalar field (marching cubes tables)** — Paul Bourke; tables by Cory Gene Bloyd. *Free to use with attribution* (code). MC_EDGE_TABLE / MC_TRI_TABLE lookup tables.
  <https://paulbourke.net/geometry/polygonise/> · <https://gist.github.com/dwilliamson/c041e3454a713e58baf6e4f8e5fffecd>
- **Marching Cubes: A High Resolution 3D Surface Construction Algorithm** — W. E. Lorensen & H. E. Cline, SIGGRAPH 1987. *Published paper* (technique). The original marching cubes algorithm.
  <https://doi.org/10.1145/37402.37422>
- **Simulating Atoms in C++ · Atoms · kavang.com/atom** — Kavan (kavan010). *No licence published — all rights reserved* (technique). Idea of drawing structure as probability-sampled particle clouds, applied to galaxy star clouds. Studied only; no code copied.
  <https://youtu.be/OSAOh4L41Wg> · <https://github.com/kavan010/Atoms> · <https://www.kavang.com/atom>
- **Simulating Black Holes in C++ · black_hole · gravity_sim** — Kavan (kavan010). *No licence published — all rights reserved* (technique). Reference for the galactic-core black holes and their gravitational lensing. Studied only; no code copied — the lens is the textbook thin-lens equation, written from scratch.
  <https://youtu.be/8-B6ryuBkCM> · <https://github.com/kavan010/black_hole> · <https://github.com/kavan010/gravity_sim>
- **Chunked LOD** — Thatcher Ulrich. *Published article* (technique). Terrain level-of-detail approach.
  <http://tulrich.com/geekstuff/chunklod.html>
- **Geometry Clipmaps** — F. Losasso & H. Hoppe, Microsoft Research (2004). *Published paper* (technique). Terrain level-of-detail approach.
  <https://hhoppe.com/proj/geomclipmap/>
- **Nanite (continuous LOD concept)** — Epic Games — Unreal Engine 5. *Concept only* (technique). Inspiration for the walking-terrain LOD.
  <https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine>
- **three-nanite** — AIFanatic. *MIT* (technique). Meshlet LOD reference.
  <https://github.com/AIFanatic/three-nanite>
- **Web3D Asset Compiler** — Abdul Rafay Khalid (ARafayKhalid). *GPL-3.0-or-later* (technique). Keyframe-reduction idea for character animation clips; re-implemented, no code copied.
  <https://github.com/ARafayKhalid/web3d-asset-compiler>
- **UE5: Sprite-Sheets (Niagara Particles!)** — Royal Skies. *Tutorial video* (technique). Reference for volumetric sprite particles in the galaxy.
  <https://youtu.be/iXBZwiiwwfI>
- **Fields Galaxy (Blender geometry nodes)** — DART Meadow — built by following a YouTube Blender galaxy tutorial (tutorial link to be added). *DART Meadow project* (technique). The project’s own Blender galaxy; its node graph is ported to JavaScript for flocculent galaxies.
  <https://github.com/dartsolarpunk/dartmeadow-space/tree/main/reference-assets/fields-galaxy>
- **dm-jots-sandbox** — DART Meadow (dartsolarpunk). *DART Meadow project* (code). The project’s own prototype sandbox: compute marching-cubes planets, depth-aware water, Rayleigh atmosphere, planet walker. Its marching-cubes methods draw on several YouTube creators’ tutorials and, with the atmosphere, on Sebastian Lague’s projects (listed above).
  <https://github.com/dartsolarpunk/dm-jots-sandbox> · <https://dartsolarpunk.github.io/dm-jots-sandbox/>
## Data

- **Natural Earth (110m coastlines)** — Tom Patterson, Nathaniel Vaughn Kelso & contributors. *Public domain* (data). Earth coastlines on the maps.
  <https://www.naturalearthdata.com/> · <https://github.com/nvkelso/natural-earth-vector>
- **Galactic positions & distances** — NASA/IPAC Extragalactic Database (NED), SIMBAD (CDS Strasbourg). *Public scientific data* (data). Galactic l/b and distances of nearby stars, nebulae and the visitable galaxies (rounded).
  <https://ned.ipac.caltech.edu/> · <https://simbad.cds.unistra.fr/>
- **Sun’s distance from the Galactic Centre (8.178 kpc)** — GRAVITY Collaboration, A&A 625, L10 (2019). *Published paper* (data). Places Sol 26,670 ly from Sgr A*.
  <https://doi.org/10.1051/0004-6361/201935656>
- **Known black holes (Gaia BH1–3, Cygnus X-1, V404 Cygni, A0620-00)** — El-Badry et al. 2023 (Gaia BH1, BH2); Gaia Collaboration 2024 (Gaia BH3); Miller-Jones et al. 2021 (Cyg X-1); SIMBAD. *Public scientific data* (data). Positions, distances and masses of the real black holes near the Sun (rounded).
  <https://simbad.cds.unistra.fr/> · <https://doi.org/10.1093/mnras/stac3140> · <https://doi.org/10.1051/0004-6361/202449763> · <https://doi.org/10.1126/science.abb3363>
- **Planetary orbital elements** — NASA JPL Solar System Dynamics. *Public scientific data* (data). Semi-major axes, eccentricities and periods of the planets.
  <https://ssd.jpl.nasa.gov/planets/approx_pos.html>
- **Size It Up — Space** — sizeitup.games. *Reference only* (data). Scale reference for the Sun and planets.
  <https://sizeitup.games/space>
## Libraries

- **three.js (r185, WebGPU + TSL)** — three.js authors (mrdoob & contributors). *MIT* (library). Rendering engine, with its GLTFLoader and SkeletonUtils add-ons (other players' characters are SkeletonUtils clones).
  <https://threejs.org/> · <https://github.com/mrdoob/three.js>
- **MQTT.js** — MQTT.js contributors. *MIT* (library). Optional multiplayer transport, loaded only when an MQTT broker is configured.
  <https://github.com/mqttjs/MQTT.js>
- **eruda** — liriliri. *MIT* (library). On-device debug console (only with ?debug).
  <https://github.com/liriliri/eruda>
## Fonts

- **Orbitron** — Matt McInerney. *SIL Open Font License 1.1* (font).
  <https://fonts.google.com/specimen/Orbitron>
- **Rajdhani** — Indian Type Foundry. *SIL Open Font License 1.1* (font).
  <https://fonts.google.com/specimen/Rajdhani>
- **Share Tech Mono** — Carrois Apostrophe. *SIL Open Font License 1.1* (font).
  <https://fonts.google.com/specimen/Share+Tech+Mono>
- **Audiowide** — Brian J. Bonislawsky (Astigmatic). *SIL Open Font License 1.1* (font). Titles and labels, set italic to match the DART Meadow logo; self-hosted in static/fonts with its licence (Audiowide-OFL.txt).
  <https://fonts.google.com/specimen/Audiowide>

## Project assets

- **3D models, characters, skyboards, Bird Temple & artwork** — DART Meadow (dartsolarpunk). *DART Meadow original work* (original). All 3D assets are the project’s own, many based on its original artwork.
  <https://dartmeadow.com/>
- **LEATR Session Cube (live feed)** — DART Meadow — same author as dartmeadow.com and cube.leatr.xyz. *DART Meadow original work* (original). The live Session Cubes drifting above the Bird Temple, ported from dartmeadow.com’s live cube.
  <https://cube.leatr.xyz> · <https://dartmeadow.com/>
- **Music** — DART Meadow — generated with Google Gemini under the project’s account. *DART Meadow original work* (original). The in-game soundtrack.
  <https://gemini.google.com/>
- **Splash / menu video** — DART Meadow — generated with Grok (xAI) under the project’s account. *DART Meadow original work* (original). The splash-screen background video.
  <https://grok.com/>
## Tools & services

- **Meshy AI** — Meshy. *Meshy terms of use* (tool). Used in the character pipeline (the earlier Sentinel placeholder and animation clips; the files keep its name prefix).
  <https://www.meshy.ai/>
- **Blender** — Blender Foundation. *GPL (tool; output unrestricted)* (tool). Modelling and the Fields Galaxy template.
  <https://www.blender.org/>
  <https://firebase.google.com/>
- **Stripe** — Stripe, Inc.. *Service terms* (service). Support payments.
  <https://stripe.com/>
- **GitHub** — GitHub, Inc.. *Service terms* (service). Sign-in (device flow) and each player’s private jots- save repository.
  <https://github.com/>
- **jsDelivr · Google Fonts · AllOrigins** — jsDelivr, Google, AllOrigins. *Service terms* (service). Serving libraries, fonts and the coastline data.
  <https://www.jsdelivr.com/> · <https://fonts.google.com/> · <https://allorigins.win/>
