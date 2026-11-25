# PrusaSlicer 3.0: what to know

The quirks of PrusaSlicer 3.0 that matter when you drive it through its CLI and its files, as this server does. Every point says how it is known:

- **measured**: run against the 3.0.0-alpha14 binary on macOS (Apple Silicon), 17–19 November 2026, and measured again against 3.0.0-alpha15 on 25 November 2026 (see [What changed in alpha15](#what-changed-in-alpha15)).
- **source**: read in a source checkout. Until 25 November that was master, which called itself 3.0.0-alpha14 but was newer than that binary: it had per-setting CLI options that neither alpha14 nor alpha15 has. Since then it is the `version_3.0.0-alpha15` tag, the source of the binary. Check a source claim against the binary before relying on it.

Paths in source references are relative to `src/` of that checkout. Where the server handles a quirk, the file is named.

## What changed in alpha15

Measured on 25 November 2026 against 3.0.0-alpha15 (89 commits after alpha14, mostly the GUI, Prusa Connect Local, painting and loading progress; none in the CLI).

- **Unchanged:** settings given as options are still ignored (`--thick-bridges=1 --fill-density=33%` gave `thick_bridges = 0`, `fill_density = 15%`); the G-code header still has empty preset ids and `retract_lift`, `travel_max_lift`, `travel_ramping_lift` at 0; `--info` still includes the origin (a cube at x 115..135: `size_x = 135`); `--export-stl` still moves a lone model to the bed centre; a project on three beds still gives the first bed's G-code only, exit 0; the CLI still runs no post-processing script (`run_post_process_scripts` is still called nowhere); the bundled PrusaResearch is still 1.0.22, with 1.0.25 recommended; no Linux build. The test suites pass unchanged. (measured)
- **G-code markers for custom G-code** (commit `ee474c462`): a pause with a message now has `;PAUSE_PRINT_MESSAGE:<message>` after `;PAUSE_PRINT` (before `M117 <message>` and `M601`, as in 2.9); custom G-code after `;CUSTOM_GCODE` is wrapped in `;CUSTOM_GCODE_START` / `;CUSTOM_GCODE_END`, and a template in `;CUSTOM_TEMPLATE_START` / `;CUSTOM_TEMPLATE_END` (names in `libpgcode/Types.hpp`). `gcode_info` reports the message, the custom block's lines and whether it is the template; from 2.9 the message comes from the `M117`, and custom blocks come without their lines, as nothing marks where they end. (measured)
- **Mirroring in projects** (commit `c9e8ec08d`): a volume in `Metadata/PrusaSlicer3_project.json` may carry `"mirror": "xyz"` (the axes mirrored), to tell a mirrored object from a rotated one; the mesh and the transform stay the real geometry. A project with `"mirror": "x"` loaded and sliced; `edit_project` keeps it, as it rewrites only `config_containers`. (measured; source `PrusaFile.cpp`)
- **A user preset whose parent does not exist** no longer aborts every CLI call (alpha14: exit 134). Alpha15 leaves that preset out and logs "Preset with id '…' not found", exit 0. `create_filament_preset` still finds it out (the preset does not resolve) and takes the file out again. (measured; commits `9b3e2ad0e`, `6b68866e3`)
- **The preset updater behind a proxy** (alpha14 as well): with `HTTPS_PROXY` set to a proxy whose certificate PrusaSlicer's own curl does not trust, "Download of Sources Database Manifest has failed: … SSL peer certificate … was not OK". A fresh data directory then keeps the app's built-in `Resources/presets/RepositoryManifest.json`, which points at `http://localhost:8000/`, and `--preset-update-list` lists nothing, with warnings only. Without the proxy, alpha15 listed and installed 1.0.22 -> 1.0.25. (measured)

## Running it

- **Location.** The app is `PrusaSlicer-3.0.0-alpha15.app` (alpha14: `PrusaSlicer-3.0.0-alpha14.app`); auto-detection looks for `PrusaSlicer.app` and finds a 2.9 first. Set `PRUSASLICER_PATH` to the 3.0 app. (measured)
- **Data directory.** `~/Library/Application Support/PrusaSlicer3-dev` for alphas and betas, `PrusaSlicer3` for releases. App config: `shared_runtime/PrusaSlicer.json`. (measured)
- **Every CLI call writes `shared_runtime/log.txt` in the default data directory, even with `--datadir`**, because logging starts before the data directory is read (source `slic3r-shared/src/Slic3r/App/Init.cpp:69-74`; seen by two separate runs). Nothing else is written there by a CLI call.
- **Clean stdout.** `SLIC3R_LOGLEVEL=1` in the environment; `--loglevel 1` still lets two `[info]` lines through before it takes effect. (measured)
- **Exit codes mean little.** "All objects are outside of the print volume" and export errors exit 0. Success is the output file existing (or `Slicing result exported to …` on stdout). Exit 1 comes from a missing input, a bad `--load`, an unknown preset, or pending forced preset updates. (measured; source `ProcessActions.cpp:330-336, 915-917`)
- **A missing parent preset crashed every call of alpha14** with exit 134 (an assert); alpha15 leaves the preset out with an error in the log. See Presets. (measured on a copy of the data directory)

## Settings

- **Settings given as options are ignored without a word.** `--thick-bridges=1 --top-solid-min-thickness=3.2` exits 0 and changes nothing; so do `--fill-density 42%` and `--perimeters 5`. (measured) The cause is not confirmed in the source.
- **`--load` is honored once, and alone.** A second `--load` is an error (exit 114), and a `--load` next to `--printer-profile`/`--print-profile`/`--material-profile` is ignored. (measured) Those flags also make a 3MF input load as geometry only. (source `LoadPrintData.cpp:280-284, 501-518`)
- **What works:** `--save` the config of the presets or of a project, change values in that JSON, slice with that one `--load`. `--load` also wins over a 3MF input's own config. (measured) The server does this in `src/slicer/v3-config.ts`.
- **The saved config:** `{"preset": {...}, "configuration": {"print_settings", "printer_settings", "filament_settings", "toolprint_settings", "project_settings"}}`. (measured)
  - Percentages and mixed values: `{"value": 15.0, "is_percent": true}`.
  - Filament settings are lists with one entry per tool, whatever the schema's type says (`"temperature": [230]`).
  - Integer settings must be JSON integers (`2`, not `2.0`). (source `ConfigJson.cpp:58`)
- **Filament overrides are the same key in another section, and they win.**
  - There is no `filament_retract_lift` in 3.0. A filament that overrides `retract_lift` holds `retract_lift` in `filament_settings`, and `--export-config-schema` lists which settings can be overridden (`overrides_in: ["Tool", "Filament", …]`).
  - Prusament PLA overrides `travel_ramping_lift`, `travel_max_lift` and `travel_slope`.
  - With Buddy3D PETG, `travel_ramping_lift: false` in `print_settings` alone kept a 3DBenchy's ramped lifts. With it in `filament_settings` too (and `retract_lift: [0.4]` added there), 2426 of 2427 lifts were 0.4 mm. Adding a key the filament did not override is accepted.
  - The server writes an override into every section that holds it, and reads `filament_<key>` (the 2.x name) as the filament layer.
  - (measured)
- **Invalid values become the built-in default, not an error.** A bad enum string or wrong type gives the default (not the preset's value). Unknown keys are ignored, and load warnings are thrown away. (source `ConfigLoad.cpp:199-226, 490-499`) The server therefore has PrusaSlicer load the written config and save it back (`--load … --save …`) and compares every value per section before it slices.
- **Settings catalogue.** `--help-fff` prints only the general help. `--export-config-schema FILE` writes, per section, `name`, `type`, `min`, `max`, `enum_values`, `location`, `overrides_in` and the default. It has no descriptions, and it logs an error about a missing bed model while still writing the file. (measured)
- **Unknown presets are refused** (exit 1, `Printer profile 'X' wasn't found.`), not replaced by the GUI's selection as in 2.9. `--tool-print-profile` is not needed. (measured)

## Post-processing scripts

- **A script in the config makes the CLI ask `Continue(Y/N) ?` on stdin**, after loading the inputs and `--load` and before any action. Any answer but Y (a closed stdin too) stops it with no output and exit 0, also for a plain `--save`. (measured; source `CLIApp.cpp:245`, `LoadPrintData.cpp:561-607`)
- **Answered Y, nothing runs:** a `--save` writes the config, and an `--export-gcode` writes the G-code, but the script did not run in either case. The source defines `run_post_process_scripts` (`GCode/PostProcessor.cpp:983`) and nothing calls it. (measured)
- A `--load` config without a script, given next to a project that has one, asks nothing: the `--load` replaces the project's config before the check. (measured)
- The server answers Y to `--save` (it exports no G-code) and to a slice the user allowed scripts for, and blanks the script otherwise. An allowed slice gets its scripts run by the server, as 2.9.7's CLI runs them: each line through `$SHELL -c` with the G-code's path last, every setting as `SLIC3R_<KEY>` plus `SLIC3R_PP_HOST` and `SLIC3R_PP_OUTPUT_NAME`, in place, after the thumbnails; a failing script (non-zero exit, or the G-code gone) leaves no G-code. (`src/slicer/post-process.ts`; 2.9.7 measured 2026-11-23)

## Queries

- `--query-printer-models` and `--query-print-tool-filament-profiles --printer-profile X` print their JSON between log lines; with `--output FILE` they write clean JSON. (measured)
- `printer_profile` in the profile query is the printer model's name, not the profile asked for. (measured)
- All vendor profiles are available without a wizard step: 31 printer models, about 247 filaments for a CORE One. (measured)

## G-code

- **ASCII unless the file name says otherwise.** The format follows the extension of `output_filename_format`. `binary_gcode` and `--binary-gcode` are ignored, and so is the name given with `-o`: `-o x.bgcode` gives an ASCII file named `.bgcode`. Prusa profiles end in `.gcode`. A `--load` config with `output_filename_format: "x.bgcode"` gives real binary G-code (first bytes `GCDE`). (measured; source `ExportNameParser.cpp:17-19`)
- **The commented config at the end is not faithful.**
  - `printer_settings_id`, `print_settings_id` and `filament_settings_id` are empty.
  - `retract_lift`, `travel_max_lift` and `travel_ramping_lift` read 0, while the G-code lifts as with 2.9.7.
  - Do not judge a slice by these lines.
  - (measured)
- **`; prusaslicer_json_config = begin … end`** holds the full JSON config with preset names and ids, and `; objects_info = {"objects":[{name, polygon}]}` follows it. Objects are also labelled with M486 / `EXCLUDE_OBJECT`. (measured; source `GCode.cpp:1491-1508`)
- **Thumbnails** only when the single input is a 3MF that contains `Metadata/thumbnail.png`. That PNG is scaled to fill each size the printer asks for and cut to it (`resize_and_crop`), then written as the preset says (QOI, PNG); STL input gives none. Same as 2.9.7. (measured, also with `--load`; source `CLIRuntime.cpp:38-43`, `3mf.cpp:883-918`)
- **Several input files give several G-code files,** one per input, unless `--merge` is given; `--merge` puts them on one plate (two cubes: 7.17 g against 3.61 g for one). 2.9.7 does the same without `--merge`, and crashes with it. (measured)
- **Same print as 2.9.7.** A 3DBenchy on a CORE One with 0.15mm BALANCED and Prusament PLA: 11.12 g and 52m35s with 2.9.7, 11.13 g and 52m41s with alpha14, with 2649 and 2687 lifted moves; 11.13 g and 52m37s with alpha15. (measured; `test/integration-benchy.test.ts`)
- **Multi-bed projects: the CLI slices one bed and drops the others without a word.** Three cubes on three beds (exported by 3.0 itself with `--duplicate 3`) gave one cube's G-code, exit 0. Which bed: the one at the first position, also with the `beds` list in the project JSON reordered. (measured; source `ProcessActions.cpp:293-303`)
  - Bed positions are in `config_containers[i].beds` (`position_x`, `position_y`; the CORE One's at 0, 270, 540), each with its own `custom_gcode` (`{mode, gcodes: [{gcode: {type, print_z, extruder, color, extra}}]}`) and `wipe_tower` (`{x, y, rotation_angle}` or null). (measured; source `PrusaFile.cpp:1643-1680`)
  - Moving the objects of bed 2 onto bed 1 and back the other way, with the two beds' `custom_gcode` exchanged, made the CLI slice bed 2 with bed 2's pause. 3.0 applies each bed's own pauses, unlike 2.9.7's CLI (see the README). (measured)

## Geometry

- **`--info` includes the origin in the bounding box.** A model at x 115..135 reports `min_x = 0, size_x = 135`; negative coordinates come out right. `--center` and `--align-xy` have no effect on `--info`, `--scale` does. Z is always on the bed, as in 2.9. The server measures X/Y on the mesh in that case (`src/formats/stl.ts`, `src/tools/model.ts`). (measured)
- **Export moves a lone model to the bed centre** (`--export-stl` of a cube at 0..20 gives 115..135); 2.9 leaves it. `--dont-arrange` keeps it. (measured) Any 3MF input implies `--dont-arrange`. (source `CLIApp.cpp:230-238`)
- `--info` also reports `open_edges` and repair counts. (source `Algorithms/ModelObject.cpp:352-397`)

## Print stability warnings

- "Detected print stability issues: Long bridging extrusions" (and "Collapsing overhang", "Loose extrusions", "Low bed adhesion", "Floating object part") appears only in the GUI. (measured)
- The check runs in the CLI too, on every slice, but its result is dropped; the CLI prints errors only. (source `Print.cpp:1419-1423`, `ProcessActions.cpp:329-337`)
- No option turns it on or off in 3.0. It skips objects for which supports are generated. (source `Print.cpp:1958-1976`)
- **The one trace outside:** at `--loglevel 5` a line `status_update: {… warnings_to_append: [7] …}` appears. 7 is `StabilityIssues`; which issue it was is not in it. Seen once in the trace of a project for which the GUI said "Long bridging extrusions". (measured; source `SlicingStatus.hpp:131-150`)
- The rules and constants are in `libslic3r/src/libslic3r/SupportSpotsGenerator.cpp` and `.hpp`. A long bridge is bridge infill more than one extrusion width outside the layer below, for longer than `max(3, 16/(1+|k|)³)` mm, with k the curvature in rad/mm. (source)

## Projects (3MF)

- **The config is in `Metadata/PrusaSlicer3_project.json`:** `objects`, `project`, `config_containers` (one per bed). (measured)
  - Each container has `beds`, `configuration` (the five sections above), `physical_printer` and `preset`.
  - In `preset`, `hw_config.config_name` is the printer profile, `print.name` the print preset and `materials[].name` the filaments; `preset.printer.name` is the printer model.
- **Painting** (seams, supports, colours) is in `Metadata/Slic3r_facets_annotation.json`, and colour changes are in `config_containers[i].beds[j].custom_gcode.gcodes[]`. (source `Format/3mf/PrusaFile.cpp:641-918, 1664-1678`)
- **Per-object, per-volume and per-range settings** (`objects[n].object_settings`, `volumes[m].volume_settings`, `ranges[k].configuration`) are flat overrides that win over the project config for that part. `configuration.macro_overrides` holds print modes such as vase mode. (source `ConfigLoad.cpp:211-222, 284-327`)
- **No dirty flag.** A preset whose stored values differ from the installed preset opens as a separate preset "(From 3mf) <name>", not as a modified one. A project that `edit_project` switched to "0.15mm SPEED @COREONE 0.4HF" with 33 % infill opened with print preset "(From 3mf) 0.15mm SPEED …" and fill density 33 %; its filament showed as "(From 3mf) Prusament PLA" too, as its stored values were those of the bundle the CLI ships rather than the installed one; the printer kept its plain name. (measured with the GUI, 2026-11-21; source `PresetInteractor.cpp:3716-3871`)
- **A 2.x project opens with its presets and values.** A 2.9.7 project for a CORE One HF0.4 became printer "Prusa CORE One & One+ 0.4 HF", with its own print, filament, layer height and infill. The source says legacy projects are not supported; the binary loads them. (measured)
- **A 3MF written by `--export-3mf`** carries the `--load` config in its `config_containers`, but no thumbnail. (measured; source `3mf.cpp:800-821`)

## Presets

- **User presets** live in `presets/user/<repo>/<vendor>/` (e.g. `prusa-research-fff/PrusaResearch/`) as YAML.
  - A filament has `kind: filament`, an `id`, and a variant with `name`, `condition`, `unconditional_inherits: [<parent's evaluated id>]` and only the `values` that differ.
  - The parent id is what `--save` shows as `preset.materials[0].id`, e.g. `Generic PLA`.
  - (measured on a copy of the data directory)
- **Two hazards.**
  - An unknown variable in `condition` makes almost every printer of that vendor disappear (31 models to 2).
  - A parent id that does not exist crashes every CLI call of alpha14 (exit 134); alpha15 leaves that preset out and logs "Preset with id '…' not found".
  - Validate after writing, and roll back. (measured on a copy)
- **When a new file is seen:** the CLI sees it on the next call. The GUI only at start: there is no file watcher. A preset written by the server showed in the GUI's filament list after a restart. (measured; source `DesktopApp.cpp:546-550`)
- **No "installed" profiles.** Every vendor profile is available. `printer_favorite_presets` (printer model ids) and `material_favorite_presets` (evaluated material ids) only filter the GUI's lists. (source `BundleLoader.cpp:90-108`, `MaterialSelectionDialog.cpp:30-36`)
- **`PrusaSlicer.json` is rewritten by the GUI when its window closes.** Edit it only while PrusaSlicer is closed. If one of `printer_favorite_presets`, `material_favorite_presets` or `recent_projects` is missing, the whole file is reset to defaults. (source `MainFrame.cpp:968-981`, `AppSettingsAdvanced.cpp:83-91`)
- **Vendor bundles** are updated with `--preset-update-sources`, `--preset-update-select-source UUID`, `--preset-update-list`, `--preset-update` and `--preset-update-add-local ZIP`, which write JSON to stdout. (source `ReadCLI.cpp:485-553`)
  - `--preset-update-sources` lists one source by default, Prusa FFF (`https://preset-repo-api.prusa3d.com/v2/repos/prusa-research-fff/`), selected. (measured)
  - `--preset-update-list` downloads the indices into `update_sync/` and prints `{"result": {regular_updates, forced_updates, forced_downgrades, not_in_index, new_vendors, removals}}`, each entry with `vendor_id`, `vendor_repo_id`, `current_version`, `recommended_version`, `state` and `comment`; `warnings` when there are any, `{"error": …}` on failure. A bundle set back to 1.0.24 in `presets/local/prusa-research-fff/PrusaResearch/vendor.yaml` was listed as a regular update to 1.0.25. (measured on a copy of the data directory)
  - `--preset-update` installs everything listed and prints nothing unless there are warnings; that bundle was 1.0.25 again, user presets untouched, no snapshot taken. (measured on a copy)
  - At `--loglevel 1` the error lines of the start (no physical printers, no bed model) come on stdout before the JSON; `SLIC3R_LOGLEVEL=0` keeps it clean. (measured)
  - **Pending forced updates block slicing:** "Execution blocked: Pending forced preset reconfigurations or updater error", exit 1. Regular updates do not. (source `ProcessActions.cpp:866-912`; regular: measured)
- **The GUI's selected presets are not in the app config.** `PrusaSlicer.json` has favourites, `last_used_physical_printer` and `recent_projects` only, so a slice needs printer, print and filament given. (measured)

## The running GUI

- **No control API.** (source)
  - The single-instance IPC (a macOS distributed notification, `OtherPrusaSlicerMulticastMessage`) can only open files or `prusaslicer://` URLs, and it imports them as geometry (source `AppInstanceMessageHandlerMac.mm:24, 64-76`, `ProjectInteractor.hpp:574-577`).
  - `prusaslicer://open?file=<https URL>` only takes Prusa, Printables, Thingiverse and Cults3D links. (source `FileDownloaderInteractor.cpp:41-90`)
- **Opening a file from outside does not open it as a project.** (measured with the GUI, 2026-11-19)
  - `open -a <app> <file>`, and Finder's "Open With", give an empty project: 3.0 handles no open-documents event (source `DesktopApp.cpp:706-711, 873-883`).
  - `PrusaSlicer --single-instance <file>` reaches the running GUI. It prints "Failed to create a lockfile" and exits 1, yet the file is imported into the current project, placed on the bed, as geometry only: a 3MF's settings do not come along.
  - Only the GUI's own Open project loads a 3MF with its settings. A project edited by the server's `edit_project` opened that way with its new values.
  - So `open_in_prusaslicer` imports models through `--single-instance`, and refuses projects with that reason instead of reporting them opened.
  - With 3.0 closed, the server starts it, waits for the process and five seconds more, and sends the files: a cube arrived in the new project, 5.5 s after the call. (measured with the GUI, 2026-11-21)
- **The window title is always the build id**, so it shows no project name and no unsaved-changes marker. (source `MainFrame.cpp:90`)
- **Unsaved projects are backed up as full 3MFs** in `backup_projects/<instance>_<id>_<name>.3mf` on every change, and removed when saved. With a project open and changed in the GUI, its backup held both objects, the presets and the changed values, written at the moment of the change. (measured; source `BackupStore.cpp:64-133`) The server reads the newest as the open project and takes its presets as the selection while the GUI runs, and writes nothing into the data directory: a 3MF placed in `backup_projects` is offered for recovery at the next start (source `BackupStore.cpp:320-351`).
- **Lua plugins** run only in the GUI, from a menu, in a sandbox with base, table, math and string; they cannot reach other processes. (source `LuaEngine.cpp:21-22`) See also the Onthoud note `prusaslicer-lua-plugins`.
- **Physical printers** are stored in `physical_printer/<uuid>.json`, with host, API key, user and password in plain text. The CLI cannot upload. (source `PhysicalPrinterJson.cpp:113-141`, `ProjectInteractor.cpp:983-1001`)

## What the server does with it

- `slice`: a project with objects on several beds is refused without `bed`, and sliced bed by bed with it (`src/formats/beds.ts`). Settings through one patched `--load` config, written into every section that holds the key and read back per section before slicing; the format by the extension of `output_filename_format`; `stability_check` from the trace log; thumbnails drawn by the server and written into the G-code after slicing, as for 2.9. (`src/slicer/v3-config.ts`, `src/tools/slice.ts`, `src/tools/thumbnails.ts`)
- `edit_project`: rewrites only the project JSON, checks by loading the result with the CLI, reports per-object overrides. (`src/tools/edit-project-v3.ts`) Measured: PrusaSlicer loads the written values back, the edited project slices with them (a lift of 0.4 mm on 263 of 264 lifted moves), and every other zip entry is byte-identical.
- `create_filament_preset`: YAML in `presets/user`, checked and rolled back. (`src/slicer/filament-preset-v3.ts`) Measured on a copy of the data directory: listed at once, sliced with (the G-code has its temperature), overwritten with the same ids.
- `model_info` and `export_model`: X/Y from the mesh where `--info` includes the origin; `--dont-arrange` on export.
- `find_profiles` lists what fits; `install_profiles` changes nothing.
- `update_profiles`: `--preset-update-list`, and with `install` `--preset-update` (refused while this version's GUI runs on the same data directory), checked by listing again. `slice` names it when forced updates block slicing. (`src/tools/update.ts`)

## Not known yet

- Whether `--load full.json --dont-arrange --export-3mf -o out.3mf in.3mf` keeps painting, ranges and colour changes.
- Whether the warning codes other than 7 have the numbers of the source in this build.
