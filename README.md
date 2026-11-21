# prusaslicer-mcp

> **Work in progress.** Until PrusaSlicer 3.0 is officially released, its support here is experimental. It is checked against 3.0.0-alpha14 only, and a later alpha, beta or the release may change what the server relies on: [PRUSASLICER3.md](PRUSASLICER3.md) lists what was measured. PrusaSlicer 2.9 is the version the server is built and tested for.

An MCP server for the PrusaSlicer on your machine. It explores profiles, slices with your presets, transforms models, reads and edits G-code, and looks at the running GUI.

PrusaSlicer is the source of truth. Profiles, compatibility, inheritance, slicing and mesh analysis come from PrusaSlicer itself, through its CLI. The server only parses what the CLI does not give: G-code, binary G-code and 3MF project metadata. There is no recommendation engine and no filament database of its own.

## Requirements

- Node.js 24 or newer
- PrusaSlicer 2.9. It is found in `/Applications`, `/Applications/Original Prusa Drivers`, `~/Applications`, `Program Files\Prusa3D\PrusaSlicer`, on `PATH`, or on Linux as Flathub's Flatpak `com.prusa3d.PrusaSlicer` (see [Linux](#linux)). 3.0.0-alpha14 works with every tool, experimentally; point `PRUSASLICER_PATH` at it, see [PrusaSlicer 3.0](#prusaslicer-30).
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
| `PRUSASLICER_PATH` | The `.app` bundle, `prusa-slicer-console.exe`, the binary, or `com.prusa3d.PrusaSlicer` for the Flatpak | auto-detected |
| `PRUSASLICER_DATADIR` | Use another PrusaSlicer data directory (passed as `--datadir`) | PrusaSlicer's own |
| `PRUSASLICER_MCP_ROOTS` | Directories the server may read and write, separated by the path delimiter | anywhere |
| `PRUSASLICER_MCP_TIMEOUT_MS` | Time limit per slice or export | 600000 |
| `PRUSASLICER_MCP_ALLOW_POST_PROCESS` | `1` lets `slice` run post-processing scripts when asked with `allow_post_process` | off |
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
| `update_profiles` | Whether newer official profile bundles exist; on 3.x also installs them with PrusaSlicer's own updater |
| `find_printerials_filament` | Search Printerials' filament catalogue; gives the variant id for `create_filament_preset` |
| `create_filament_preset` | A PrusaSlicer profile for a filament without an official one, from a Spoolman spool, Printerials or stated values, built on the matching Prusa generic for the printer |
| `connect_printerials` | Link your Printerials account with a browser sign-in (OAuth), for your spools without a pasted URL |
| `disconnect_printerials` | Revoke that link at Printerials and remove it here |
| `list_spools` | Spools on your Printerials shelf or in Spoolman: filament, grams left (weighed), price per kg, location |
| `record_spool_usage` | Subtract what a print used from a spool, after the user confirmed the print was made |
| `slice` | Slice to G-code with presets, a project's config or the GUI selection, plus overrides and transforms, with thumbnails for the printer's display; a project on several beds one bed per call |
| `model_info` | PrusaSlicer's mesh analysis: size, volume, facets, parts, manifold |
| `project_info` | A 3MF's presets, settings it changes, per-object and per-range settings, colour changes, the beds and what stands on each, thumbnail |
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
  - `allow_post_process` works only when the server runs with `PRUSASLICER_MCP_ALLOW_POST_PROCESS=1`. A tool argument alone could be set by an agent misled by a downloaded file; the environment is the user's.
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
- **Profile bundle updates are the GUI's job in 2.9.** At start, with "Check for configuration updates" on (`preset_update = 1`), it downloads each bundle's index into `cache/` and offers what is new; the CLI has no updater. `update_profiles` compares `config_version` of each bundle in `vendor/` with the newest version in that cached index that suits the running PrusaSlicer, and says when the index was downloaded. It does not install: that stays with the GUI.
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
- **A filament profile's override wins over the print setting.** Buddy3D PETG @COREONE HF0.4 has `filament_travel_ramping_lift = 1`. With `--travel-ramping-lift=0 --retract-lift=0.4` alone, the G-code header shows both values, yet a 3DBenchy still slices with ramped lifts: 1 % of its lifts are 0.4 mm. With `--filament-travel-ramping-lift=0 --filament-retract-lift=0.4` as well, all of them are (2026-11-19). So when an override's `filament_<key>` is set (not `nil`) in the resolved config or the project, `slice` and `edit_project` set it too, and say so.
- **Print stability warnings are not in the CLI output.** "Detected print stability issues: Long bridging extrusions" (and "Collapsing overhang", "Loose extrusions", "Low bed adhesion") is in the binary. 2.9.7 runs the check from the CLI but reports nothing, not even at `--loglevel 5`. 3.0.0-alpha14 leaves only its code in the trace log; see `stability_check` under PrusaSlicer 3.0.
- **The CLI's 3MF export holds no print settings.**
- **The CLI draws no thumbnails.** It embeds one only when the single input is a 3MF holding `Metadata/thumbnail.png`, scaled and cut to each size the printer asks for (2.9.7 and 3.0.0-alpha14). G-code sliced from an STL had no preview on the printer.
  - So `slice` draws them itself (`src/render/thumbnail.ts`): the model seen as PrusaSlicer shows it (from the front left, 45 degrees from above, Z up), lit with the lights of PrusaSlicer's shader, in the filament's colour on a transparent background, at each size and format (PNG, QOI) the printer preset asks for.
  - They go into the G-code where PrusaSlicer puts its own, after the slice: in ASCII after the first line, in binary G-code as thumbnail blocks after the printer metadata. The unit tests compare the blocks and the QOI encoding byte for byte with PrusaSlicer's, and the integration tests re-encode PrusaSlicer's own thumbnails to the same bytes. The result is read back (binary: every block checksum) before it replaces the sliced file; when anything fails, the G-code stays as sliced and `thumbnails` says why.
  - The model is the STL itself, or PrusaSlicer's `--export-stl` with the same transforms. A 3MF with its own thumbnail gets PrusaSlicer's. `thumbnails: false` turns it off.
  - Handing PrusaSlicer a 3MF with a PNG in it instead was measured and dropped: 2.9 does not arrange a 3MF when slicing (its positions count as meant), and its `--export-3mf` does not arrange either, so the model would have landed elsewhere on the bed.
- **A project on several beds: the CLI slices one and drops the rest without a word.** A project with a cube on each of three beds gave the G-code of the first, exit 0, in 2.9.7 and in 3.0.0-alpha14. Objects on no bed are left out the same way.
  - **Where the beds are.** 2.9 keeps them implicit: bed i lies on a grid at the bed's size plus a gap of min(100 mm, 0.3 × its diagonal), up to 9 beds, and an object belongs to the bed it lies wholly inside (source 2.9.7 `MultipleBeds.cpp`; a CORE One's second bed starts at x 349.9). 3.0 lists its beds with their positions in the project JSON.
  - **2.9.7 applies the wrong bed's colour changes and pauses.** With more than one bed in use its CLI gave bed 1 the pauses of bed 2, and none when bed 2 had none; with one bed in use, bed 1's (measured in five projects). 3.0 keeps each bed's own.
  - **Checked against the 2.9.7 GUI** with a project it made (`test/fixtures/beds-2.9.7.3mf`: a 140 mm cube on bed 1, a 120 mm cube on bed 2 with a colour change at 55.08 mm). The server found the same beds, and its bed 2 took 408.14 g and 6h46m, as the GUI's slice did. The CLI on its own put that colour change on bed 1.
  - **What the server does** (`src/formats/beds.ts`). `project_info` lists the beds and what stands on each, and the objects on no bed. `slice` refuses a project with objects on several beds and lists them; with `bed` it slices that one. For another bed than the first it slices a copy in which that bed and bed 1 change places (their objects, and in 3.0 their pauses and wipe towers), which made both versions slice the chosen bed. A 2.9 project with several beds always goes through a copy that gives every bed the chosen bed's colour changes, pauses and wipe tower, so the CLI applies them whichever it reads. The G-code is named with `-bed<N>`, and its thumbnails show that bed only. A single bed in use is sliced whichever it is. 3.0 projects with more than one printer are refused.
- **Several input files give several G-code files.** Without `--merge`, 2.9.7 and 3.0.0-alpha14 slice each input to a G-code of its own. `slice` returns one, so it refuses several inputs without `transforms.merge`. 2.9.7's `--merge` crashes (exit 139), also with one file and for `--export-stl`; 3.0 merges.

## Linux

Prusa ships 2.9.7 for Linux as a Flatpak on Flathub only; there is no AppImage on GitHub for it, and 3.0.0-alpha14 has no Linux build at all. The server takes a `prusa-slicer` on `PATH` first, then the Flatpak, per user or system-wide. Measured with Flathub's 2.9.7 on aarch64 (2026-11-20):

- **The CLI runs `prusa-slicer` in the sandbox itself** (`flatpak run --command=prusa-slicer`). The app's own command is a script that starts PrusaSlicer in the background and prints a banner first, so its output and exit code are not PrusaSlicer's. The GUI goes through that script, as the desktop file does.
- **The sandbox sees the home directory only, and has a `/tmp` of its own.** A model in `/tmp` gave "No such file". Every directory outside home that a run names (an input, an output, the server's own temporary files in `/tmp`) is added for that run with `--filesystem`. A path with `:` cannot be added that way.
- **Its data directory is `~/.var/app/com.prusa3d.PrusaSlicer/config/PrusaSlicer`,** not `~/.config/PrusaSlicer`.
- **It calls itself `2.9.7+flathub.org`.** The server reports `2.9.7` with `build: flathub.org`, and compares versions without the build.
- **Its process is called `slic3r_main`,** and the sandbox's `bwrap` carries `prusa-slicer` in its arguments. The server tells the GUI apart by its command line in `/proc`: PrusaSlicer without one of its actions (`--export-gcode`, `--info`, ...). A name match would also have counted the server's own runs, and any process run from a directory called PrusaSlicerMCP.
- **Not tested on Linux:** the GUI tools. `screenshot_prusaslicer` is macOS and Windows only; `open_in_prusaslicer` sends files with `--single-instance`, untried without a display.

`test/linux/run.sh` runs the unit and integration tests in Docker against Flathub's PrusaSlicer.

## PrusaSlicer 3.0

3.0 changes more than options:

- Configs are JSON (`--load`, `--save`, the G-code config block and `Metadata/PrusaSlicer3_project.json` in 3MF).
- Vendor bundles are YAML.
- The data directory is `PrusaSlicer3` (`-dev` for alphas and betas).
- The profile query is now `--query-print-tool-filament-profiles`.

Everything measured about 3.0 so far, and what the source says that is not measured yet, is in [PRUSASLICER3.md](PRUSASLICER3.md).

The server picks a backend from the binary's version (`src/slicer/v2.ts`, `src/slicer/v3.ts`) and recognizes 3.0 files by their content, also next to a 2.9 install. Point `PRUSASLICER_PATH` at the 3.0 app: the auto-detection looks for `PrusaSlicer.app` only, so it finds the 2.9 first.

The 3.0 backend was checked against **3.0.0-alpha14 on macOS (2026-11-17 and 2026-11-19)**, tool by tool through an MCP client: `slicer_status`, `list_printers`, `list_profiles`, `get_config`, `describe_setting`, `slice` (models, a 3.0 project, overrides, transforms), `model_info`, `export_model`, `project_info`, `gcode_info`, `postprocess_gcode` and `screenshot_prusaslicer` work. A 3DBenchy slices the same in both versions: 11.12 g and 52m35s with 2.9.7, 11.13 g and 52m41s with alpha14 (CORE One, 0.15mm BALANCED, Prusament PLA), with as many travel lifts. The unit tests use fixtures made by that binary (`test/fixtures/3.0.0-alpha14`). What alpha14 does differently, as measured:

- **Settings given as command line options are ignored, with exit code 0.** `--thick-bridges=1` changes nothing, and so does a `--load` next to presets; `--load` may be given once. Only a complete config in the format `--save` writes works. So `slice` saves the config of the presets (or of the project), changes the values in it (`src/slicer/v3-config.ts`, typed and range checked by the schema) and slices with that file. The fixed switches (`post_process` off, `output_filename_format` for projects) go the same way.
- **Filament overrides are the same key in another section.** A filament keeps its override of a print setting as `filament_settings.<key>` (Prusament PLA: `travel_ramping_lift: [true]`), and it wins. An override is written into every section that holds the key; `filament_<key>`, the 2.x name, writes the filament section only and adds the key there. With Buddy3D PETG and `travel_ramping_lift: false` in `print_settings` alone, a 3DBenchy kept its ramped lifts; with both sections, 2426 of its 2427 lifts were 0.4 mm.
- **Every changed value is read back before slicing,** per section. PrusaSlicer loads the written config and saves it again (`--load … --save …`); a value that does not come back as written is refused, and nothing is sliced. `overrides_confirmed` lists the overrides that came back. Not the G-code header: see below.
- **No settings list in `--help-fff`.** The catalogue comes from `--export-config-schema`: types, ranges, enum values and the section of each setting, but no descriptions (`describe_setting` shows none for 3.0).
- **Profile queries print their JSON between log lines.** The server has them write to a file (`--output`).
- **Unknown presets are refused by PrusaSlicer** (exit 1), not replaced by the GUI's selection as in 2.9.
- **The app config does not say which presets the GUI has selected.** `slice` and `get_config` need printer, print and filament; the server says so when they are missing.
- **The G-code format follows the extension of `output_filename_format`**, not `binary_gcode` or `--binary-gcode`; `-o x.bgcode` alone gave ASCII under that name. `slice` sets the extension itself: `.bgcode` for `gcode_format: "binary"`, and for `auto` when the printer has `binary_gcode`, as 2.x does. A result in the other format is refused.
- **`stability_check: true` on `slice`** says whether PrusaSlicer's own stability check found issues. 3.0 runs it in the CLI but drops the result; only at `--loglevel 5` does `warnings_to_append: [7]` (7 = StabilityIssues) appear in the log, without which issue it was. A project the GUI flagged with "Long bridging extrusions" gives it, a cube does not. It makes PrusaSlicer's `log.txt` grow by thousands of lines per slice.
- **The G-code header is not faithful.** `printer_settings_id`, `print_settings_id` and `filament_settings_id` are empty, and `retract_lift`, `travel_max_lift` and `travel_ramping_lift` read 0, while the G-code itself lifts the nozzle as 2.9.7 does (a 3DBenchy: 2687 moves above the layer height against 2649, the same lift heights). So the server never judges a 3.0 slice by its header.
- **`--info` includes the origin in the bounding box.** A model at x 115..135 comes back as `min_x = 0, size_x = 135`; negative coordinates come out right, and `--center` and `--align-xy` are ignored there. Where `min_x` or `min_y` is exactly 0, `model_info` and `export_model` export the model as STL where it lies and measure X and Y on that mesh (`bounds_note` says so). Volume, facets and manifold stay PrusaSlicer's.
- **`--export-stl` and `--export-3mf` move a lone model to the bed centre**; 2.9 leaves it where it is. `export_model` passes `--dont-arrange` unless the call arranges, merges or duplicates.
- **`edit_project` on a 3.0 project** rewrites only `Metadata/PrusaSlicer3_project.json`, on every bed, and copies every other entry as stored. PrusaSlicer loads the result and every value is read back per section, because 3.0 replaces a value it does not take by its built-in default without a word. Settings an object, part or height range sets itself are reported (`kept_by_objects`); they win there. The GUI shows changed presets as "(From 3mf) <name>", having no "modified" flag. A 2.x project with a 3.x server is refused: 3.0 opens it, and saving it there makes it a 3.0 project.
- **`create_filament_preset` on 3.0** writes `presets/user/<repo>/<vendor>/filament-<name>.yaml`: `unconditional_inherits` on the parent's id, a condition for that printer model and nozzle (`printer.base_model == "COREONE" and tool.nozzle_diameter == 0.4 and tool.nozzle_high_flow`) and only the values that differ. Two mistakes in such a file break PrusaSlicer: an unknown variable in the condition hides almost every printer of the vendor, and a missing parent makes every CLI call abort (exit 134). So the server checks the printer count, the listing and every value after writing, and takes the file out again when a check fails.
- **Files cannot be opened in the 3.0 GUI as projects from outside** (checked with the GUI). `open -a` and Finder's "Open With" give an empty project; `--single-instance` imports into the open project as geometry, without a 3MF's settings. `open_in_prusaslicer` therefore imports models and refuses projects, saying to open them in PrusaSlicer; `edit_project` with `open: true` does the same.
- **What is open in the 3.0 GUI.** Its window title is always the build id and it keeps no selected presets, but it writes a full 3MF of each unsaved project to `backup_projects/<instance>_<id>_<name>.3mf` on every change, and removes it once saved (seen with the GUI). `slicer_status` reports the newest as the open project, and while the GUI runs its presets count as the selection, as 2.x's GUI selection does; the answer says where they came from. A project without unsaved changes has no backup.
- **Nothing is written into PrusaSlicer's data directory** (any version): an output there, such as G-code next to a backup of an open project, is refused. A 3MF in `backup_projects` would be offered for recovery at PrusaSlicer's next start.
- **Post-processing scripts do not run in 3.0.0-alpha14's CLI.** With a script in the config, the CLI asks `Continue(Y/N) ?` on stdin, and without a Y it stops with no output and exit 0, even for a `--save`. Answered Y, it slices, but the script did not run (the source defines `run_post_process_scripts` and calls it nowhere). The server answers Y only to `--save`, which exports no G-code; `slice` blanks the script unless allowed, and says so when allowed on 3.0.
- **Profile updates from the CLI in 3.0.** `--preset-update-list` asks the preset repository (into `update_sync/`) and lists regular and forced updates, new and removed vendors; `--preset-update` installs them. `update_profiles` runs the first, and with `install: true` the second, refused while this version's GUI runs on the same data directory; it lists again afterwards. Measured on a copy of the data directory with the Prusa bundle set back one version: listed, installed, up to date. Pending forced updates make 3.0 refuse to slice ("Pending forced preset reconfigurations"); `slice` then points to `update_profiles`.
- **No installed list in 3.0.** Every profile in the vendor bundles is available. `find_profiles` lists what fits, and `install_profiles` changes nothing and says so. `list_printers` shows the user's own presets from `presets/user` and the names of physical printers.

## Development

```bash
npm run dev               # run from source (Node 24 strips the types)
npm run typecheck
npm test                  # unit tests, no PrusaSlicer needed
npm run test:integration  # end to end through an MCP client against the installed PrusaSlicer
```

The integration tests write only to a temporary directory and do not open anything in the GUI. They run on a data directory of their own (`test/helpers/datadir.ts`), so they do not depend on how PrusaSlicer is set up here: 2.x gets the PrusaResearch bundle it ships and a CORE One HF0.4 enabled (with an empty one every call fails with "Configuration wasn't found", exit 0); 3.x fills an empty one itself. `PRUSASLICER_TEST_DATADIR=user` runs them on PrusaSlicer's own data directory instead. The fixtures in `test/fixtures` were made with PrusaSlicer 2.9.7: a 20 mm cube, the same cube at 25% sliced for a CORE One, and the output of `--help`, `--help-fff` and `--info`; `test/fixtures/3.0.0-alpha14` was made with that alpha.

- **Against 3.0:** `PRUSASLICER_PATH=/Applications/PrusaSlicer-3.0.0-alpha14.app npm run test:integration` runs `test/integration-v3.test.ts` and the rest against 3.0 (the 2.x-only tests skip).
- **Both, compared:** with `PRUSASLICER_PATH_3` set to the 3.0 app, `test/integration-benchy.test.ts` slices a 3DBenchy with both versions and compares filament, time and lifts.
- **3DBenchy** ([CreativeTools/3DBenchy](https://github.com/CreativeTools/3DBenchy), public domain under CC0 since February 2025) is not in the repository: 11 MB. The test downloads `Single-part/3DBenchy.stl` once, checks its SHA-256 and caches it in `~/Library/Caches/PrusaSlicerMCP/test-models` (`PRUSASLICER_MCP_TEST_CACHE` to put it elsewhere). Offline and without the cache, those tests skip.
- **On Linux:** `test/linux/run.sh` builds an Ubuntu 24.04 image with Flathub's PrusaSlicer and Node, copies in the files git tracks, and runs `npm test` and `npm run test:integration` (or the command given). The container runs `--privileged`, which Flatpak's sandbox needs inside Docker, and starts the system and session bus a desktop would have.
- **Keep the Mac awake** for the integration tests (`caffeinate -i npm run test:integration`). In sleep the clock runs on, and every PrusaSlicer call that was running hits its 60 s limit on waking.

## License

AGPL-3.0-only, see [LICENSE](LICENSE). Copyright (C) 2026 Enkodo.

## Credits

The Windows window code is adapted from [PrusaMCP](https://github.com/Noosbai/PrusaMCP) by Noosbai (MIT).
