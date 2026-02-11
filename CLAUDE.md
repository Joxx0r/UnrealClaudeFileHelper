# embark-claude-index

MCP server plugin providing fast code navigation for Unreal Engine projects. Indexes AngelScript, C++, Blueprints, and assets.

## Tool Instructions

Always use unreal-index MCP tools instead of Bash commands for searching UE/AS code:

- Use `unreal_find_file` instead of `find` or `ls` to locate source files by name
- Use `unreal_grep` instead of `grep`, `rg`, or `sed -n` to search file contents or find line numbers
- Use `unreal_find_type` instead of grep to locate class/struct/enum definitions
- Use `unreal_find_member` instead of grep to locate function/property definitions
- Use the `Read` tool (not sed/cat/head) to read file contents after finding them

Never fall back to Bash find/grep — these tools are faster, project-aware, and return structured results.
If a search returns no results, check the hints in the response for guidance (wrong project filter, try fuzzy, etc).

## Architecture

- **Two-process split**: Windows watcher + WSL service
- **Windows watcher** (`src/watcher/watcher-client.js`): Watches project files, parses them, POSTs to the service
- **WSL service** (`src/service/index.js`): Express API, SQLite DB, in-memory query index, Zoekt integration
- **MCP bridge** (`src/bridge/mcp-bridge.js`): Translates MCP tool calls to HTTP API calls against the service
- **Setup wizard** (`src/setup.js`): Interactive config generation (project paths, engine root)

## Development

- `npm run setup` — Run the interactive setup wizard
- `npm start` — Start the indexing service
- `npm run watcher` — Start the file watcher
- `npm run bridge` — Start the MCP bridge standalone
- `npm test` — Run tests
