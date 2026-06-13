# Elek Brand

Elek should feel precise, quiet, and review-focused: closer to a disciplined
engineering tool than a mascot product. The identity uses warm neutrals and a
single clay accent so it feels human without looking playful or loud.

## Positioning

**Review-only AI for pull requests.**

Use this line when the product needs to be explained in one sentence:

> Elek cross-checks pull requests with independent AI reviewers while keeping
> every model inside a narrow, non-destructive tool surface.

## Logo Assets

| Asset | Use |
|---|---|
| `assets/elek-mark.svg` | Icon, avatar, favicon source, compact placements |
| `assets/elek-wordmark.svg` | README header, documentation header, lockups |
| `assets/elek-card.svg` | Social preview, launch images, large brand placements |
| `assets/elek-spinner.svg` | GitHub tracking comments and live progress states |

Keep the mark simple. Do not add eyes, characters, mascots, shadows, glows, or
extra review symbols around it. The logo should stay recognizable at 16px.

## Palette

| Token | Hex | Use |
|---|---|---|
| Ink | `#171412` | Primary text and mark strokes |
| Bone | `#f7f2ea` | Warm light backgrounds |
| Clay | `#c76d50` | Validation stroke, active states, small accents |
| Stone | `#6f6760` | Secondary text |
| Line | `#e1d5ca` | Borders and subtle separators |

Use Clay sparingly. Most surfaces should be Ink on Bone, or Bone on Ink for
dark placements. Avoid saturated greens, blues, and purple gradients; they make
the product look like a generic CI dashboard instead of elek.

## Typography

Use Google Fonts with platform fallbacks:

```css
--elek-display: "Instrument Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--elek-text: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Use Instrument Sans for the logo and short display lines. Use IBM Plex Sans for
supporting copy, docs, and product UI. Do not use decorative serif, mono-only,
or condensed display fonts for the primary brand.

When rendering static assets, keep the platform fallbacks in the SVG so GitHub
and package registries still render cleanly if they do not load remote fonts.

## GitHub Avatar

Workflow comments posted with the default `GITHUB_TOKEN` always appear as
`github-actions[bot]`. GitHub Actions cannot override that avatar, even when
the action has custom branding.

To show an elek avatar in the PR timeline, run elek with a token from either:

- a dedicated GitHub App named `elek`, with the elek mark as its avatar, or
- a dedicated bot account PAT.

The safer default remains `GITHUB_TOKEN`; the visible brand is embedded in the
tracking comment header and review body.

Prefer lowercase `elek` in prose and logo contexts. Capitalize only at the
start of a sentence or in generated UI where title casing is unavoidable.

## Voice

Write like a strict reviewer that is trying to be useful:

- Clear over clever.
- Evidence over confidence.
- Review-only, not autonomous merge authority.
- Cross-checks and validation, not "magic".

Avoid phrases that imply elek can approve, merge, deploy, close issues, or own
the final decision.
