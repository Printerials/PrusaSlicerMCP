# prusaslicer-mcp

An MCP server for the PrusaSlicer on your machine. It explores profiles, slices with your presets, transforms models, reads and edits G-code, and looks at the running GUI.

PrusaSlicer is the source of truth. Profiles, compatibility, inheritance, slicing and mesh analysis come from PrusaSlicer itself, through its CLI. The server only parses what the CLI does not give: G-code, binary G-code and 3MF project metadata. There is no recommendation engine and no filament database of its own.

## Requirements

- Node.js 24 or newer
- PrusaSlicer 2.9. It is found in `/Applications`, `/Applications/Original Prusa Drivers`, `~/Applications`, `Program Files\Prusa3D\PrusaSlicer`, or on `PATH`. 3.0.0-alpha14 works for all tools but four (`find_profiles`, `install_profiles`, `create_filament_preset`, `edit_project`), which refuse it; point `PRUSASLICER_PATH` at it, see [PrusaSlicer 3.0](#prusaslicer-30).
- For the GUI tools, macOS or Windows.
  - On macOS, the app that runs the server needs **Screen Recording** permission, for window titles and screenshots.
  - It also needs **Files and Folders** permission to read from `~/Downloads`, `~/Documents` or `~/Desktop`.

## Install

```bash
npm install
npm run build
```

Claude Code:

```bash
claude mcp add prusaslicer -- node /absolute/path/to/PrusaSlicerMCP/build/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "prusaslicer": {
      "command": "node",
      "args": ["/absolute/path/to/PrusaSlicerMCP/build/index.js"]
    }
  }
}
```

### Environment

| Variable | Purpose | Default |
|---|---|---|
| `PRUSASLICER_PATH` | The `.app` bundle, `prusa-slicer-console.exe`, or the binary | auto-detected |
| `PRUSASLICER_DATADIR` | Use another PrusaSlicer data directory (passed as `--datadir`) | PrusaSlicer's own |
| `PRUSASLICER_MCP_ROOTS` | Directories the server may read and write, separated by the path delimiter | anywhere |
| `PRUSASLICER_MCP_TIMEOUT_MS` | Time limit per slice or export | 600000 |
| `SPOOLMAN_URL` | A Spoolman server (`http://host:7912`), or Printerials' Spoolman-compatible API by token URL. Goes before a connected Printerials account. The URL is treated as a credential: set it here only, it never appears in answers or logs | none |
| `PRINTERIALS_URL` | Printerials: its public catalogue, and the account `connect_printerials` links | `https://printerials.com` |
| `PRINTERIALS_TOKEN_FILE` | Keep the Printerials connection in this file (plain text, mode 0600) instead of the macOS Keychain; needed on Windows and Linux | Keychain on macOS |
| `PRINTERIALS_COUNTRY` | Delivery country for Printerials prices (`NL`, `DE`, ...). Without it no price is used | none |
| `PRINTERIALS_CURRENCY` | Currency for those prices | `EUR` |

## Tools

| Tool | What it does |
|---|---|
| `slicer_status` | Version, data directory, selected presets, recent projects, and the project open in the GUI (with unsaved-changes flag) |
| `list_printers` | Installed printer models, variants and beds, your printer presets, physical printers |
| `list_profiles` | Print and filament profiles compatible with a printer, as PrusaSlicer decides |
| `get_config` | The resolved config of a printer/print/filament set, or the diff between two sets |
| `describe_setting` | Type, unit, allowed values, default and description of a setting, or a search over all of them |
| `find_profiles` | Official filament and printer profiles in the installed bundles, also the ones not enabled yet; filament compatibility as PrusaSlicer evaluates it |
| `install_profiles` | Enable or disable those profiles, as the Configuration Wizard does (PrusaSlicer must be closed; dry_run and a backup) |
| `find_printerials_filament` | Search Printerials' filament catalogue; gives the variant id for `create_filament_preset` |
| `create_filament_preset` | A PrusaSlicer profile for a filament without an official one, from a Spoolman spool, Printerials or stated values, built on the matching Prusa generic for the printer |
| `connect_printerials` | Link your Printerials account with a browser sign-in (OAuth), for your spools without a pasted URL |
| `disconnect_printerials` | Revoke that link at Printerials and remove it here |
| `list_spools` | Spools on your Printerials shelf or in Spoolman: filament, grams left (weighed), price per kg, location |
| `record_spool_usage` | Subtract what a print used from a spool, after the user confirmed the print was made |
| `slice` | Slice to G-code with presets, a project's config or the GUI selection, plus overrides and transforms |
| `model_info` | PrusaSlicer's mesh analysis: size, volume, facets, parts, manifold |
| `project_info` | A 3MF's presets, settings it changes, per-object and per-range settings, colour changes, thumbnail |
| `edit_project` | Switch a 3MF project's filament or print preset and change its settings; PrusaSlicer loads the result to check every value, and it can open it in the GUI |
| `export_model` | Arrange, rotate, scale, duplicate, split or cut, and write 3MF/STL/OBJ |
| `gcode_info` | Time, filament, cost, layers, objects; for ASCII also filament per feature and pause/colour/tool events |
| `postprocess_gcode` | Insert a pause, colour change or custom G-code at layers, with the printer's own G-code |
| `open_in_prusaslicer` | Open files in the running PrusaSlicer, or start it with them |
| `screenshot_prusaslicer` | PNG of the PrusaSlicer window |

Every tool carries `readOnlyHint` and `destructiveHint`, so a client can allow the read-only ones without asking. No tool replaces an existing file unless it is given `overwrite: true`.

## Behaviour worth knowing

These were verified against PrusaSlicer 2.9.7 on macOS, and the server is built around them:

- **An incomplete or unknown preset set crashes PrusaSlicer 2.9.** That means printer only, printer plus print, or an unknown printer name, and the result is a segfault (exit 139).
  - The server therefore checks every preset name against PrusaSlicer's own listing first, and always passes all three.
  - A wrong name is refused with the closest matches.
- **A profile that cannot be used is silently replaced.** A filament that is not installed is replaced by the one selected in the GUI, with exit 0. So is one that does not fit.
  - The server checks names before the run.
  - It compares the `*_settings_id` of the resolved config and of the G-code with what was asked.
  - A filament that exists but is not installed is refused with a pointer to `install_profiles`.
- **Exit codes are not trusted.** "All objects are outside of the print volume" exits with 0. A run counts as successful when its output file exists; otherwise PrusaSlicer's message is returned.
- **An empty `--key=` takes the next argument as its value.** `--post-process=` followed by a model path makes the model the script. Empty values go as two arguments (`--key ""`), others as `--key=value`, so negative numbers do not pass for options.
- **Post-processing scripts are off by default.**
  - A 3MF can carry a `post_process` script that PrusaSlicer runs after slicing.
  - `slice` blanks it unless `allow_post_process` is set, and `project_info` warns when a project sets one.
  - Without stdin, PrusaSlicer 2.9 asks `Continue(Y/N) ?` and does not slice.
- **Output is staged.**
  - PrusaSlicer writes into a scratch directory next to the destination, and the result is renamed into place.
  - Without an explicit output name, the file keeps the name PrusaSlicer derives from `output_filename_format`, with a `-2` suffix and so on when that name is taken.
  - Except for a project's own `output_filename_format`: PrusaSlicer follows `../` in it out of the output directory and replaces whatever file is there (`../../victim.txt` overwrote a text file). A project slices to its own name instead (`bracket.3mf` → `bracket.bgcode`).
- **Installed profiles live in `PrusaSlicer.ini`:** `[filaments]` (`name = 1`) and `[vendor:<id>]` (`model:<ID> = <variants>`), as the Configuration Wizard writes them.
  - Variants with spaces must be quoted (`"HT Hotend 0.4"`), or PrusaSlicer drops the model.
  - A duplicate key makes it reject the whole file as corrupt.
  - The GUI keeps this in memory and writes it back on quitting. So `install_profiles` refuses while PrusaSlicer runs on the same data directory.
  - `find_profiles` lets PrusaSlicer judge compatibility, by querying a scratch copy of the data directory with everything enabled.
- **A user filament preset inherits nothing.** PrusaSlicer lays a preset file over its built-in defaults, not over its `inherits` parent (2.9.2 source, `PresetCollection::load_presets`). A file with only a temperature slices with bed 0 °C and type PLA.
  - `create_filament_preset` therefore writes the complete filament config (the 81 keys of `Preset::filament_options()`) of the printer-specific Prusa generic, with the stated values over it and `inherits` naming the generic.
  - A stated temperature range keeps the generic's tuned value when it lies inside, and the nearest bound otherwise.
  - The parent's own compatibility conditions come from the bundle, so the preset shows for the same printers.
- **User filament presets have their own list.** The profile query returns them in `user_filament_profiles`, next to `filament_profiles`.
- **Printerials and Spoolman:**
  - A spool from Printerials carries `external_id = printerials:variant/<id>`, so its catalogue entry (the maker's stated values, with sources) comes along.
  - What the spool cost beats the market price.
  - `slice` with `spool_id` warns when the weighed spool holds less than the print needs.
- **The Printerials connection (OAuth):**
  - Authorization code with PKCE S256 for a public client (`prusaslicer-mcp`), redirected to `http://127.0.0.1:<random port>/callback`, scopes `shelf:read` and `usage:write`. `connect_printerials` returns at once with the link; the sign-in stays open for 10 minutes.
  - The access token lives an hour, the refresh token 90 days and rotates on every refresh. Both are kept in the login Keychain (service `PrusaSlicerMCP Printerials`), written by `/usr/bin/security` with the secret on stdin, not in its arguments, which `ps` shows to every user.
  - A refresh token used twice makes Printerials revoke the whole connection. Every MCP host (Claude Code, Claude Desktop) runs its own server process on the same Keychain item, so refreshes are serialized by a lock file in `~/Library/Caches/PrusaSlicerMCP`, and each refresh rereads the Keychain first.
  - An access token refused with 401 gets one retry with a new one. A connection Printerials ended (`invalid_grant`) is removed, with `connect_printerials` as the way back.
- **The running GUI cannot be changed from outside.**
  - Selecting a preset or changing a setting in the open window has no API in 2.9.
  - `edit_project` produces the same result as a new project file. PrusaSlicer shows the changes as modified settings when it opens it.
  - A preset switch takes over every value in which the new preset differs from the old one.
- **Invalid enum values are replaced silently.** `fill_pattern = lightnin` in a project loads as the default `stars`, with exit 0. `edit_project` therefore has PrusaSlicer load the edited project and compares every changed value with what it loaded.
- **The CLI's 3MF export holds no print settings**, and the CLI embeds no thumbnails (it renders none).

## PrusaSlicer 3.0

3.0 changes more than options:

- Configs are JSON (`--load`, `--save`, the G-code config block and `Metadata/PrusaSlicer3_project.json` in 3MF).
- Vendor bundles are YAML.
- The data directory is `PrusaSlicer3` (`-dev` for alphas and betas).
- The profile query is now `--query-print-tool-filament-profiles`.

The server picks a backend from the binary's version (`src/slicer/v2.ts`, `src/slicer/v3.ts`) and recognizes 3.0 files by their content, also next to a 2.9 install. Point `PRUSASLICER_PATH` at the 3.0 app: the auto-detection looks for `PrusaSlicer.app` only, so it finds the 2.9 first.

The 3.0 backend was checked against **3.0.0-alpha14 on macOS (2026-11-17 and 2026-11-19)**, tool by tool through an MCP client: `slicer_status`, `list_printers`, `list_profiles`, `get_config`, `describe_setting`, `slice` (models, a 3.0 project, overrides, transforms), `model_info`, `export_model`, `project_info`, `gcode_info`, `postprocess_gcode` and `screenshot_prusaslicer` work. A 3DBenchy slices the same in both versions: 11.12 g and 52m35s with 2.9.7, 11.13 g and 52m41s with alpha14 (CORE One, 0.15mm BALANCED, Prusament PLA), with as many travel lifts. The unit tests use fixtures made by that binary (`test/fixtures/3.0.0-alpha14`). What alpha14 does differently, as measured:

- **Settings given as command line options are ignored, with exit code 0.** `--thick-bridges=1` changes nothing, and so does a `--load` next to presets; `--load` may be given once. Only a complete config in the format `--save` writes works. So `slice` saves the config of the presets (or of the project), changes the values in it (`src/slicer/v3-config.ts`, typed and range checked by the schema) and slices with that file. The fixed switches (`post_process` off, `output_filename_format` for projects) go the same way.
- **Every changed value is read back before slicing.** PrusaSlicer loads the written config and saves it again (`--load … --save …`); a value that does not come back as written is refused, and nothing is sliced. `overrides_confirmed` lists the overrides that came back. Not the G-code header: see below.
- **No settings list in `--help-fff`.** The catalogue comes from `--export-config-schema`: types, ranges, enum values and the section of each setting, but no descriptions (`describe_setting` shows none for 3.0).
- **Profile queries print their JSON between log lines.** The server has them write to a file (`--output`).
- **Unknown presets are refused by PrusaSlicer** (exit 1), not replaced by the GUI's selection as in 2.9.
- **The app config does not say which presets the GUI has selected.** `slice` and `get_config` need printer, print and filament; the server says so when they are missing.
- **The CLI writes ASCII G-code only**, whatever `binary_gcode`, `--binary-gcode` or the file name say. `gcode_format: "binary"` and a `.bgcode` output are refused instead of producing a mislabeled file.
- **The G-code header is not faithful.** `printer_settings_id`, `print_settings_id` and `filament_settings_id` are empty, and `retract_lift`, `travel_max_lift` and `travel_ramping_lift` read 0, while the G-code itself lifts the nozzle as 2.9.7 does (a 3DBenchy: 2687 moves above the layer height against 2649, the same lift heights). So the server never judges a 3.0 slice by its header.
- **`--info` includes the origin in the bounding box.** A model at x 115..135 comes back as `min_x = 0, size_x = 135`; negative coordinates come out right, and `--center` and `--align-xy` are ignored there. Where `min_x` or `min_y` is exactly 0, `model_info` and `export_model` export the model as STL where it lies and measure X and Y on that mesh (`bounds_note` says so). Volume, facets and manifold stay PrusaSlicer's.
- **`--export-stl` and `--export-3mf` move a lone model to the bed centre**; 2.9 leaves it where it is. `export_model` passes `--dont-arrange` unless the call arranges, merges or duplicates.
- Refused with 3.0, with a message saying so: `find_profiles`, `install_profiles` and `create_filament_preset` (3.0 keeps installed profiles and user presets differently), and `edit_project` (its check reads the 2.x config format). User presets do not show in `list_printers` yet.

## Development

```bash
npm run dev               # run from source (Node 24 strips the types)
npm run typecheck
npm test                  # unit tests, no PrusaSlicer needed
npm run test:integration  # end to end through an MCP client against the installed PrusaSlicer
```

The integration tests write only to a temporary directory and do not open anything in the GUI. The fixtures in `test/fixtures` were made with PrusaSlicer 2.9.7: a 20 mm cube, the same cube at 25% sliced for a CORE One, and the output of `--help`, `--help-fff` and `--info`; `test/fixtures/3.0.0-alpha14` was made with that alpha.

- **Against 3.0:** `PRUSASLICER_PATH=/Applications/PrusaSlicer-3.0.0-alpha14.app npm run test:integration` runs `test/integration-v3.test.ts` and the rest against 3.0 (the 2.x-only tests skip).
- **Both, compared:** with `PRUSASLICER_PATH_3` set to the 3.0 app, `test/integration-benchy.test.ts` slices a 3DBenchy with both versions and compares filament, time and lifts.
- **3DBenchy** ([CreativeTools/3DBenchy](https://github.com/CreativeTools/3DBenchy), public domain under CC0 since February 2025) is not in the repository: 11 MB. The test downloads `Single-part/3DBenchy.stl` once, checks its SHA-256 and caches it in `~/Library/Caches/PrusaSlicerMCP/test-models` (`PRUSASLICER_MCP_TEST_CACHE` to put it elsewhere). Offline and without the cache, those tests skip.
- **Keep the Mac awake** for the integration tests (`caffeinate -i npm run test:integration`). In sleep the clock runs on, and every PrusaSlicer call that was running hits its 60 s limit on waking.

## License

AGPL-3.0-only, see [LICENSE](LICENSE). Copyright (C) 2026 Enkodo.

## Credits

The Windows window code is adapted from [PrusaMCP](https://github.com/Noosbai/PrusaMCP) by Noosbai (MIT).
