# elek brand

Elek should feel precise, geometric, and review-focused: closer to a memorable
engineering product than a generic CI dashboard. The identity uses the supplied
blocky elek wordmark direction: purple structure, yellow interior fills, white
negative space, and hard long-shadow geometry.

## Positioning

**Review-only AI for pull requests.**

Use this line when the product needs to be explained in one sentence:

> Elek cross-checks pull requests with independent AI reviewers while keeping
> every model inside a narrow, non-destructive tool surface.

Primary product CTA once hosted onboarding is open:

> Install the elek GitHub App.

Secondary technical CTA:

> Self-host with the GitHub Action.

## Logo Assets

| Asset | Use |
|---|---|
| `assets/elek-logo.png` | Primary supplied PNG logo for README headers, documentation headers, GitHub comments, avatars, and product lockups |
| `assets/elek-logo-purple.png` | Supplied purple wordmark PNG for single-color or light-background placements |
| `assets/elek-logo-inverse.png` | Supplied inverse PNG for dark or purple-field placements |

Keep the mark blocky and geometric. Do not add eyes, characters, mascots,
glows, or extra review symbols around it. Use the supplied square PNG files
directly; the square canvas and long-shadow crop are intentional brand assets.

## Palette

| Token | Hex | Use |
|---|---|---|
| Ink | `#171421` | Primary text |
| Purple | `#8152a0` | Primary brand structure, buttons, shadows |
| Purple-deep | `#5e367b` | Borders, depth, active states |
| Purple-dark | `#332044` | Dark panels and dashboard surfaces |
| Yellow | `#fee15c` | Logo fill, primary CTA, status accents |
| Cream | `#fffdf7` | Light page backgrounds and logo negative space |
| Stone | `#6f617a` | Secondary text |
| Line | `#d8c6e6` | Borders and subtle separators |

Use Yellow as the active accent and Purple as the dominant brand field. Most
surfaces should be Ink on Cream, Yellow on Purple, or Cream on Purple-dark.
Avoid generic purple-blue gradients; the brand should read as hard-edged,
blocky, and logo-led.

## Typography

Use Google Fonts with platform fallbacks:

```css
--elek-display: "Instrument Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--elek-text: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Use Instrument Sans for the logo and short display lines. Use IBM Plex Sans for
supporting copy, docs, and product UI. Do not use decorative serif, mono-only,
or condensed display fonts for the primary brand.

Do not recreate the logo from live fonts in product surfaces. Use the supplied
PNG files so GitHub, package registries, and hosted pages render the same shape.

## GitHub Avatar

The hosted GitHub App should be the primary branded surface for elek reviews:
the App name and avatar appear directly in the PR timeline. Workflow comments
posted with the default `GITHUB_TOKEN` always appear as
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
