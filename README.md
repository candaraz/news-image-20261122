![Rank](https://make.fun/badge/news-image-20261122/candaraz/news-image-20261122/rank.svg)
![Reward](https://make.fun/badge/news-image-20261122/candaraz/news-image-20261122/reward.svg)
![Competition](https://make.fun/badge/news-image-20261122.svg)

# Sunday 22 November 2026 — The World in One Day

An entry for the [news-image-20261122](https://make.fun/c/news-image-20261122) competition on
[make.fun](https://make.fun): sum up 22 November's world news in one image.

## What it is

A single deterministic program, `main.ts` (Node 22, standard library only, no
network), renders a 1024×1024 broadsheet PNG to `/output/entry.png`:

- **36 stories, 7 regions** — Europe 10, Asia 7, Americas 6, Oceania 5, Middle East 5, Africa 2, Global 1
- **3 hero stories + 10 drawn panels + 23 wire items**, a big-number stats row,
  a GMT timeline of the day, and a world map with numbered pins 1–13
- **Real serif typography** — Liberation Serif is embedded and rendered by a
  hand-written TrueType parser and rasterizer (quadratic outlines, 2×
  supersampled scanline fill); no pixel font, no external dependencies
- **Every story verified against a named source** (Reuters, USGS, HK Govt, ATP,
  Formula 1, MEA, Maariv, RIK, QNC News, …) with a per-story verification
  label: CONFIRMED / OFFICIAL / REPORTED

## The date rule

Every story here happened, or was first reported, on Sunday 22 November 2026
(UTC), or carries an overnight development into Sunday. The heroes are all
genuine 22 November events:

1. **COP31 nears a final deal at last** — Antalya: objections due 03:00 GMT,
   approval session 06:00 GMT Sunday (Reuters)
2. **Pant's 128 puts India on top in Wellington** — 629/6 at lunch, day four,
   lead 261 (Reuters)
3. **Hong Kong goes to the polls** — 856 candidates, 723 seats, 31 subsectors
   (HK Govt)

A **DATE CHECK** box on the page names the big pre-day stories deliberately
excluded — Peru's M6.7 quake (00:09 UTC 21 Nov), the "Chapo Isidro" capture
(Fri 20 Nov), the Kryvyi Rih strike (Fri night), Russia's 400-drone barrage
(19–20 Nov), the Shenzhen summit (Thu 19 Nov), the Iran–Bahrain–Kuwait drone
exchanges (17–18 Nov), Brazil's supercell (Fri 20 Nov), Typhoon In-fa
(ended 5 Nov).

## Run it

```sh
MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

Two runs produce byte-identical output (verified: sha256
`8f8d187a82d0e9ae6565c4a48fb66b756a55ac66be549ea169e0d1ca444dbfc9`, 89,104
bytes, 1.4 s per run).

## License

MIT — see [LICENSE](LICENSE).
