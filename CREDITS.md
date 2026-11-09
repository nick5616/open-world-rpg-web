# Credits

## Textures

All PBR texture sets are from [3dtextures.me](https://3dtextures.me) by Gendo
(Joao Paulo), released under CC0. Credit is not required; we give it anyway
(spec 12). Sources in `texture-sources/`, pipeline in `tools/textures/`.

| Set | Page | Used for |
| --- | --- | --- |
| Grass 005 | https://3dtextures.me/2020/08/28/grass-005/ | Terrain: grass (meadow, highlands, wetland) |
| Ground Forest 003 | https://3dtextures.me/2020/03/20/ground-forest-003/ | Terrain: forest floor |
| Ground Dirt 007 | https://3dtextures.me/2019/10/21/ground-dirt-007/ | Terrain: dirt |
| Rock 040 | https://3dtextures.me/2021/04/09/rock-040/ | Terrain: highland rock; cave rock (WP09) |
| Rock 038 | https://3dtextures.me/2020/01/14/rock-038/ | Terrain: cliffs (triplanar) |
| Rock Cliff 003 | https://3dtextures.me/2021/09/22/rock-cliff-003/ | Terrain: badlands cliffs |
| Snow 004 | https://3dtextures.me/2018/11/30/snow-004/ | Terrain: snow |
| Sand 006 | https://3dtextures.me/2020/02/21/sand-006/ | Terrain: sand |
| Mud 001 | https://3dtextures.me/2020/01/31/mud-001/ | Terrain: mud |
| Ground Wet Rocks 002 | https://3dtextures.me/2020/10/30/ground-wet-rocks-002/ | Cave wet rock (WP09) |
| Crystal 003 | https://3dtextures.me/2018/04/26/crystal-003/ | Gems and ore veins (WP09) |
| Marble White 006 | via 3d-portfolio-website | Ruins stone (WP20) |
| Stylized Stone Column 001 | via 3d-portfolio-website | Ruins stone (WP20) |

## Code

- three.js examples: CSM (cascaded shadow maps), KTX2Loader and the Basis
  Universal transcoder (`client/public/basis/`, Apache-2.0, Binomial LLC), MIT.
- `ktx2-encoder` (MIT) for building KTX2 textures; Basis Universal encoder (Apache-2.0).
- `postprocessing` by Raoul van Rueden (Zlib).
- Triplanar normal blending after Ben Golus, "Normal Mapping for a Triplanar Shader".

## Design

- Discovery intros (`client/src/ui/intro/`): the look and timing of the
  region reveal in Nicole Belovoskey's 3d-portfolio-website (`HudToasts.tsx`,
  `styles/gem.css`), rewritten for this client. Display face: Fraunces
  (Undercase Type, SIL Open Font License) from Google Fonts.
