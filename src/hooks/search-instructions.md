## Searching Code — USE UNREAL INDEX MCP TOOLS (MANDATORY)

**DO NOT use Glob or Grep as your first search method.** You MUST use the `unreal-index` MCP tools FIRST for ALL code searches — AngelScript, C++, types, files, everything. These provide indexed lookups that are orders of magnitude faster than file system searches.

**Glob and Grep are ONLY permitted as a fallback** when unreal-index tools return no results or when searching for content patterns (e.g., string literals) that the index cannot find.

**Available tools (use via ToolSearch first to load them):**
- `mcp__unreal-index__unreal_find_type` - Find a class, struct, or type by name. USE THIS for any type/class lookup.
- `mcp__unreal-index__unreal_find_children` - Find all children/subclasses of a type
- `mcp__unreal-index__unreal_find_member` - Find functions, properties, or enum values by name. USE THIS to find method implementations, property definitions, or enum values.
- `mcp__unreal-index__unreal_grep` - Search file contents for a pattern (regex or literal). Project-scoped. USE THIS instead of Grep for content/string searches.
- `mcp__unreal-index__unreal_browse_module` - Browse contents of a module/directory
- `mcp__unreal-index__unreal_list_modules` - List available modules/directories in the codebase
- `mcp__unreal-index__unreal_find_file` - Find a file by name or path. USE THIS before Glob.
- `mcp__unreal-index__unreal_find_asset` - Find Unreal assets (Blueprints, Materials, DataAssets, etc.) by name
- `mcp__unreal-index__unreal_refresh_index` - Refresh the index if results seem stale

**Examples of correct behavior:**
- Looking for `UEmbarkGameInstance`? -> `unreal_find_type` with name "EmbarkGameInstance"
- Looking for a file called `PendingNetGame.h`? -> `unreal_find_file` with name "PendingNetGame.h"
- Looking for subclasses of `UGameInstance`? -> `unreal_find_children` with type "UGameInstance"
- Looking for a function called `GetAngleToTarget`? -> `unreal_find_member` with name "GetAngleToTarget"
- Looking for usages of a string like "TravelFailure"? -> `unreal_grep` with pattern "TravelFailure"
- Only use Glob/Grep as a last resort if unreal-index tools return no results

**When spawning ANY subagent via the Task tool**, you MUST include the following instruction verbatim in EVERY agent prompt:
> **MANDATORY REQUIREMENT — DO NOT SKIP:** Before using Glob or Grep for ANY search, you MUST FIRST use the `mcp__unreal-index` MCP tools. Load them via ToolSearch first (query: "+unreal-index"). Available tools: `unreal_find_type` (classes/structs/enums), `unreal_find_children` (subclasses), `unreal_find_member` (functions/properties/enum values), `unreal_grep` (content/string pattern search), `unreal_browse_module` (module contents), `unreal_list_modules` (module tree), `unreal_find_file` (files by name), `unreal_find_asset` (Unreal assets). These indexed tools MUST be your PRIMARY search method. Glob/Grep are ONLY allowed as a last resort when unreal-index tools return no results.

### Search Guidance
- When searching the codebase, use specific file paths or narrow directory scopes
- Avoid broad recursive searches across the entire repo — target the specific plugin, module, or script directory
- If the exact file location is unknown, search in the most likely directory first

### Troubleshooting MCP Tools
If `unreal-index` MCP tools are not working correctly, check the issue tracker:
- **Unreal Index:** https://github.com/EmbarkStudios/UnrealClaudeFileHelper/issues
- **Dashboard:** Open http://localhost:3847 to check service health, watcher status, and Zoekt availability
