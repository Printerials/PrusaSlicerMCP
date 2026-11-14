# prusaslicer-mcp

An MCP server for the PrusaSlicer on your machine. It explores profiles, slices with your presets, transforms models, reads and edits G-code, and looks at the running GUI.

PrusaSlicer is the source of truth. Profiles, compatibility, inheritance, slicing and mesh analysis come from PrusaSlicer itself, through its CLI. The server only parses what the CLI does not give: G-code, binary G-code and 3MF project metadata. There is no recommendation engine and no filament database of its own.

## Requirements

- Node.js 24 or newer
- PrusaSlicer 2.9. It is found in `/Applications`, `/Applications/Original Prusa Drivers`, `~/Applications`, `Program Files\Prusa3D\PrusaSlicer`, or on `PATH`. 3.0 support exists but is experimental; see below.
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
| `slice` | Slice to G-code with presets, a project's config or the GUI selection, plus overrides and transforms |
| `model_info` | PrusaSlicer's mesh analysis: size, volume, facets, parts, manifold |
| `project_info` | A 3MF's presets, settings it changes, per-object and per-range settings, colour changes, thumbnail |
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
- **Installed profiles live in `PrusaSlicer.ini`:** `[filaments]` (`name = 1`) and `[vendor:<id>]` (`model:<ID> = <variants>`), as the Configuration Wizard writes them.
  - Variants with spaces must be quoted (`"HT Hotend 0.4"`), or PrusaSlicer drops the model.
  - A duplicate key makes it reject the whole file as corrupt.
  - The GUI keeps this in memory and writes it back on quitting. So `install_profiles` refuses while PrusaSlicer runs on the same data directory.
  - `find_profiles` lets PrusaSlicer judge compatibility, by querying a scratch copy of the data directory with everything enabled.
- **The CLI's 3MF export holds no print settings**, and the CLI embeds no thumbnails (it renders none).

## PrusaSlicer 3.0

3.0 changes more than options:

- Configs are JSON (`--load`, `--save`, the G-code config block and `Metadata/PrusaSlicer3_project.json` in 3MF).
- Vendor bundles are YAML.
- The data directory is `PrusaSlicer3` (`-dev` for alphas and betas).
- The profile query is now `--query-print-tool-filament-profiles`.

The server picks a backend from the binary's version (`src/slicer/v2.ts`, `src/slicer/v3.ts`) and recognizes 3.0 files by their content, also next to a 2.9 install. The 3.0 backend was written from the 3.0.0-alpha14 source. It is covered by unit tests on data shaped after that source, but it has not run against a 3.0 binary yet, and `slicer_status` says so.

## Development

```bash
npm run dev               # run from source (Node 24 strips the types)
npm run typecheck
npm test                  # unit tests, no PrusaSlicer needed
npm run test:integration  # end to end through an MCP client against the installed PrusaSlicer
```

The integration test writes only to a temporary directory and does not open anything in the GUI. The fixtures in `test/fixtures` were made with PrusaSlicer 2.9.7: a 20 mm cube, the same cube at 25% sliced for a CORE One, and the output of `--help`, `--help-fff` and `--info`.

## Credits

The Windows window code is adapted from [PrusaMCP](https://github.com/Noosbai/PrusaMCP) by Noosbai (MIT).
