#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVICE_URL = 'http://127.0.0.1:3847';

async function fetchService(endpoint, params = {}) {
  const url = new URL(endpoint, SERVICE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

async function postService(endpoint) {
  const url = new URL(endpoint, SERVICE_URL);
  const response = await fetch(url.toString(), { method: 'POST' });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

class UnrealIndexBridge {
  constructor() {
    this.server = new Server(
      {
        name: 'unreal-index',
        version: '2.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );
  }

  async initialize() {
    this.setupHandlers();
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'unreal_find_type',
            description: 'Find file(s) containing a class, struct, enum, event, or delegate by name. Searches AngelScript, C++, and Blueprint assets. Use this to quickly locate type definitions.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Type name to search for (e.g. ADiscoveryPlayerController, AActor, FVector, ESpectatorState)'
                },
                fuzzy: {
                  type: 'boolean',
                  default: false,
                  description: 'Enable fuzzy/partial matching for uncertain names'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'blueprint'],
                  default: 'all',
                  description: 'Filter by source language. Note: C++ types exposed to AngelScript via bindings are stored as cpp, so use "all" (default) to find all types usable from AngelScript.'
                },
                kind: {
                  type: 'string',
                  enum: ['class', 'struct', 'enum', 'interface', 'delegate', 'event', 'namespace'],
                  description: 'Filter by type kind'
                },
                maxResults: {
                  type: 'number',
                  default: 10,
                  description: 'Maximum results to return'
                }
              },
              required: ['name']
            }
          },
          {
            name: 'unreal_find_children',
            description: 'Find all classes inheriting from a given parent class. Includes source code types (AngelScript, C++) and Blueprint subclasses.',
            inputSchema: {
              type: 'object',
              properties: {
                parentClass: {
                  type: 'string',
                  description: 'Parent class name (e.g. AActor, UActorComponent, ADiscoveryPlayerControllerBase)'
                },
                recursive: {
                  type: 'boolean',
                  default: true,
                  description: 'Include all descendants, not just direct children'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'blueprint'],
                  default: 'all',
                  description: 'Filter by source language. Note: C++ types exposed to AngelScript via bindings are stored as cpp, so use "all" (default) to find all types usable from AngelScript.'
                },
                maxResults: {
                  type: 'number',
                  default: 50,
                  description: 'Maximum results to return'
                }
              },
              required: ['parentClass']
            }
          },
          {
            name: 'unreal_browse_module',
            description: 'List all types and files in a module/directory. Use to explore a specific area of the codebase.',
            inputSchema: {
              type: 'object',
              properties: {
                module: {
                  type: 'string',
                  description: 'Module path (e.g. Discovery.UI, Engine.Source.Runtime, EnginePlugins.Online)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp'],
                  default: 'all',
                  description: 'Filter by language: all, angelscript, or cpp'
                },
                maxResults: {
                  type: 'number',
                  default: 100,
                  description: 'Maximum types to return'
                }
              },
              required: ['module']
            }
          },
          {
            name: 'unreal_find_file',
            description: 'Find source files by filename. Searches AngelScript (.as), C++ (.h, .cpp), and config (.ini) files.',
            inputSchema: {
              type: 'object',
              properties: {
                filename: {
                  type: 'string',
                  description: 'Filename to search for (e.g. Actor, PlayerController, GameMode, DefaultEngine.ini)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins, DiscoveryConfig, EngineConfig)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'config'],
                  default: 'all',
                  description: 'Filter by language: all, angelscript, cpp, or config'
                },
                maxResults: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum results to return'
                }
              },
              required: ['filename']
            }
          },
          {
            name: 'unreal_refresh_index',
            description: 'Rebuild the file index. Optionally specify a language to rebuild only that index.',
            inputSchema: {
              type: 'object',
              properties: {
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp'],
                  default: 'all',
                  description: 'Language to refresh: all, angelscript, or cpp'
                }
              }
            }
          },
          {
            name: 'unreal_find_member',
            description: 'Find functions, properties, or enum values by name. Search across class/struct members in AngelScript and C++. Use this to find method implementations, property definitions, or enum values.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Member name to search for (e.g. BeginPlay, TakeDamage, MaxHealth, DeathCam)'
                },
                fuzzy: {
                  type: 'boolean',
                  default: false,
                  description: 'Enable fuzzy/partial matching'
                },
                containingType: {
                  type: 'string',
                  description: 'Filter to members of a specific type (e.g. AActor, UWidget)'
                },
                memberKind: {
                  type: 'string',
                  enum: ['function', 'property', 'enum_value'],
                  description: 'Filter by member kind'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp'],
                  default: 'all',
                  description: 'Filter by language'
                },
                maxResults: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum results to return'
                }
              },
              required: ['name']
            }
          },
          {
            name: 'unreal_find_asset',
            description: 'Find Unreal assets (Blueprints, Materials, Maps, DataAssets, etc.) by name. Returns content browser paths, asset class type, and parent class for Blueprints. Works offline without a running editor.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Asset name to search for (e.g. BP_ATK_MapBorder, M_Highlight, MI_Default)'
                },
                fuzzy: {
                  type: 'boolean',
                  default: false,
                  description: 'Enable fuzzy/partial matching'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (DiscoveryContent, PioneerContent, EngineContent)'
                },
                folder: {
                  type: 'string',
                  description: 'Filter by content browser folder path (e.g. /Game/Discovery/Props)'
                },
                maxResults: {
                  type: 'number',
                  default: 20,
                  description: 'Maximum results to return'
                }
              },
              required: ['name']
            }
          },
          {
            name: 'unreal_grep',
            description: 'Search file contents for a pattern (regex or literal string). Scoped to indexed projects. Use for finding usages, string references, variable assignments, or any content pattern that structural type/member lookups cannot find.',
            inputSchema: {
              type: 'object',
              properties: {
                pattern: {
                  type: 'string',
                  description: 'Search pattern (regex supported, e.g. "GameModeTagExclusionFilter", "UPROPERTY.*EditAnywhere")'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins, DiscoveryConfig, EngineConfig)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp', 'config'],
                  default: 'all',
                  description: 'Filter by language: all, angelscript, cpp, or config'
                },
                caseSensitive: {
                  type: 'boolean',
                  default: true,
                  description: 'Case sensitive search'
                },
                maxResults: {
                  type: 'number',
                  default: 50,
                  description: 'Maximum matching lines to return'
                },
                contextLines: {
                  type: 'number',
                  default: 2,
                  description: 'Lines of context before and after each match'
                }
              },
              required: ['pattern']
            }
          },
          {
            name: 'unreal_list_modules',
            description: 'List available modules/directories in the codebase. Use to discover code organization and navigate the module tree.',
            inputSchema: {
              type: 'object',
              properties: {
                parent: {
                  type: 'string',
                  description: 'Parent module path to list children of (empty for root level modules)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp'],
                  default: 'all',
                  description: 'Filter by language'
                },
                depth: {
                  type: 'number',
                  default: 1,
                  description: 'How many levels deep to return'
                }
              }
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'unreal_find_type': {
            const result = await fetchService('/find-type', {
              name: args.name,
              fuzzy: args.fuzzy,
              project: args.project,
              language: args.language,
              kind: args.kind,
              maxResults: args.maxResults
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'unreal_find_children': {
            const result = await fetchService('/find-children', {
              parent: args.parentClass,
              recursive: args.recursive,
              project: args.project,
              language: args.language,
              maxResults: args.maxResults
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'unreal_browse_module': {
            const result = await fetchService('/browse-module', {
              module: args.module,
              project: args.project,
              language: args.language,
              maxResults: args.maxResults
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'unreal_find_file': {
            const result = await fetchService('/find-file', {
              filename: args.filename,
              project: args.project,
              language: args.language,
              maxResults: args.maxResults
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'unreal_refresh_index': {
            const endpoint = args.language && args.language !== 'all'
              ? `/refresh?language=${args.language}`
              : '/refresh';
            const result = await postService(endpoint);
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'unreal_find_member': {
            const result = await fetchService('/find-member', {
              name: args.name,
              fuzzy: args.fuzzy,
              containingType: args.containingType,
              memberKind: args.memberKind,
              project: args.project,
              language: args.language,
              maxResults: args.maxResults
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'unreal_find_asset': {
            const result = await fetchService('/find-asset', {
              name: args.name,
              fuzzy: args.fuzzy,
              project: args.project,
              folder: args.folder,
              maxResults: args.maxResults
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'unreal_grep': {
            const result = await fetchService('/grep', {
              pattern: args.pattern,
              project: args.project,
              language: args.language,
              caseSensitive: args.caseSensitive,
              maxResults: args.maxResults,
              contextLines: args.contextLines
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'unreal_list_modules': {
            const result = await fetchService('/list-modules', {
              parent: args.parent,
              project: args.project,
              language: args.language,
              depth: args.depth
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          default:
            return {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true
            };
        }
      } catch (error) {
        const isConnectionError = error.cause?.code === 'ECONNREFUSED' ||
                                  error.message.includes('ECONNREFUSED') ||
                                  error.message.includes('fetch failed');

        if (isConnectionError) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'Unreal Index Service is not running',
                hint: 'Start the service with: npm start (in D:\\p4\\games\\Games\\Tools\\unreal-index)'
              }, null, 2)
            }],
            isError: true
          };
        }

        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: [
          {
            uri: 'unreal://index/summary',
            name: 'Unreal Index Summary',
            description: 'Compact summary of the code index: project names, languages, type statistics, and indexing status',
            mimeType: 'application/json'
          },
          {
            uri: 'unreal://index/status',
            name: 'Unreal Index Status',
            description: 'Current indexing status for each language (ready, indexing, error)',
            mimeType: 'application/json'
          }
        ]
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      if (uri === 'unreal://index/summary' || uri === 'angelscript://index/summary') {
        try {
          const summary = await fetchService('/summary');
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(summary, null, 2)
              }
            ]
          };
        } catch (error) {
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({ error: error.message }, null, 2)
              }
            ]
          };
        }
      }

      if (uri === 'unreal://index/status') {
        try {
          const status = await fetchService('/status');
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(status, null, 2)
              }
            ]
          };
        } catch (error) {
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({ error: error.message }, null, 2)
              }
            ]
          };
        }
      }

      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `Unknown resource: ${uri}`
          }
        ]
      };
    });
  }

  async run() {
    await this.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

const bridge = new UnrealIndexBridge();
bridge.run().catch(console.error);
