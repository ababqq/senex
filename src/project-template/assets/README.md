# Assets

Files made by the studio's own tools, or supplied by the user — images, icons, models, audio. `assets/<name>.<ext>` is
committed with the project, served to the preview and copied by export; reference it by a relative
URL (`assets/logo.png`). `assets/src/` holds the scripts and sources that made a file, so re-running
one replaces it. Never downloaded; copied from `references/` only when the user asks to use that image.
