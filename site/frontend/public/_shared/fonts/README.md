# fonts/ — vendored display faces (optional)

**By default this directory is empty and that is correct.** The Arcanum body and
UI font is the **system-ui stack** (`--ark-font`), which needs no hosting and
makes zero network requests — it satisfies the offline / no-CDN rule out of the box:

```
system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
```

Code uses the system monospace stack (`--ark-mono`).

## Only add a face here if a site truly needs a display font
If a site wants a distinctive display/heading face, **vendor it locally** — never
hot-link a Google Fonts / CDN URL (that breaks offline + the D3 standard).

1. Drop the self-hosted `.woff2` files in this folder, e.g. `fonts/MyDisplay.woff2`.
2. Add an `@font-face` in the site's theme CSS (loaded after `arcanum.css`):

   ```css
   @font-face {
     font-family: "Arcanum Display";
     src: url("/static/_shared/fonts/MyDisplay.woff2") format("woff2");
     font-weight: 400 700; font-display: swap; font-style: normal;
   }
   :root { --ark-font-display: "Arcanum Display", var(--ark-font); }
   ```

3. Apply it to headings only (keep body on `--ark-font` for legibility):

   ```css
   h1, h2, .ark-hero h1 { font-family: var(--ark-font-display); }
   ```

- Use a license that permits self-hosting (OFL, etc.); keep the license file here.
- Subset to the glyphs you use to keep payload small.
- `font-display: swap` so text never blocks on the font.

> If you add a face, note it in the site's DPR/methodology and in the kit
> changelog so it's not mistaken for an external dependency.
