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
            description: 'Find file(s) containing a class, struct, enum, event, or delegate by name. Searches AngelScript and C++ code. Use this to quickly locate type definitions.',
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
                  enum: ['all', 'angelscript', 'cpp'],
                  default: 'all',
                  description: 'Filter by language: all, angelscript, or cpp'
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
            description: 'Find all classes inheriting from a given parent class. Useful for understanding class hierarchies across AngelScript and C++.',
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
                  enum: ['all', 'angelscript', 'cpp'],
                  default: 'all',
                  description: 'Filter by language: all, angelscript, or cpp'
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
            description: 'Find source files by filename. Searches AngelScript (.as) and C++ (.h, .cpp) files.',
            inputSchema: {
              type: 'object',
              properties: {
                filename: {
                  type: 'string',
                  description: 'Filename to search for (e.g. Actor, PlayerController, GameMode)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared, Engine, EnginePlugins, DiscoveryPlugins)'
                },
                language: {
                  type: 'string',
                  enum: ['all', 'angelscript', 'cpp'],
                  default: 'all',
                  description: 'Filter by language: all, angelscript, or cpp'
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
