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
import { Indexer } from './indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class UnrealIndexMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'unreal-index',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.indexer = null;
    this.config = null;
  }

  async initialize() {
    const configPath = join(__dirname, '..', 'config.json');
    const configContent = await readFile(configPath, 'utf-8');
    this.config = JSON.parse(configContent);

    this.indexer = new Indexer(this.config);

    const cachePath = join(__dirname, '..', this.config.cacheFile);
    const loaded = await this.indexer.loadFromCache(cachePath);

    if (!loaded) {
      await this.indexer.buildIndex();
      await this.indexer.saveToCache(cachePath);
    }

    this.setupHandlers();
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'angelscript_find_type',
            description: 'Find AngelScript file(s) containing a class, struct, enum, event, or delegate by name. Use this to quickly locate type definitions.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Type name to search for (e.g. ADiscoveryPlayerController, FKillingBlowInformation, ESpectatorState)'
                },
                fuzzy: {
                  type: 'boolean',
                  default: false,
                  description: 'Enable fuzzy/partial matching for uncertain names'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared)'
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
            name: 'angelscript_find_children',
            description: 'Find all classes inheriting from a given parent class. Useful for understanding class hierarchies.',
            inputSchema: {
              type: 'object',
              properties: {
                parentClass: {
                  type: 'string',
                  description: 'Parent class name (e.g. ADiscoveryPlayerControllerBase, UActorComponent)'
                },
                recursive: {
                  type: 'boolean',
                  default: true,
                  description: 'Include all descendants, not just direct children'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared)'
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
            name: 'angelscript_browse_module',
            description: 'List all types and files in a module/directory. Use to explore a specific area of the codebase.',
            inputSchema: {
              type: 'object',
              properties: {
                module: {
                  type: 'string',
                  description: 'Module path (e.g. Discovery.UI, Discovery.Player, Shared.EmbarkScript)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project'
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
            name: 'angelscript_find_file',
            description: 'Find AngelScript files by filename. Use when you know the file name but not the exact type/class name.',
            inputSchema: {
              type: 'object',
              properties: {
                filename: {
                  type: 'string',
                  description: 'Filename to search for (e.g. DiscoveryPlayerController, HUD, Widget)'
                },
                project: {
                  type: 'string',
                  description: 'Filter by project (Discovery, Pioneer, Shared)'
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
            name: 'angelscript_refresh_index',
            description: 'Rebuild the AngelScript file index. Use when files have been added or modified.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'angelscript_find_type': {
            const result = this.indexer.findTypeByName(args.name, {
              fuzzy: args.fuzzy || false,
              project: args.project,
              maxResults: args.maxResults || 10
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'angelscript_find_children': {
            const result = this.indexer.findChildrenOf(args.parentClass, {
              recursive: args.recursive !== false,
              project: args.project,
              maxResults: args.maxResults || 50
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'angelscript_browse_module': {
            const result = this.indexer.browseModule(args.module, {
              project: args.project,
              maxResults: args.maxResults || 100
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'angelscript_find_file': {
            const result = this.indexer.findFileByName(args.filename, {
              project: args.project,
              maxResults: args.maxResults || 20
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          }

          case 'angelscript_refresh_index': {
            await this.indexer.buildIndex();
            const cachePath = join(__dirname, '..', this.config.cacheFile);
            await this.indexer.saveToCache(cachePath);
            const stats = this.indexer.getStats();
            return {
              content: [{ type: 'text', text: JSON.stringify({ success: true, stats }, null, 2) }]
            };
          }

          default:
            return {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true
            };
        }
      } catch (error) {
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
            uri: 'angelscript://index/summary',
            name: 'AngelScript Index Summary',
            description: 'Compact summary of the AngelScript index: project names, module counts, type statistics',
            mimeType: 'application/json'
          }
        ]
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      if (uri === 'angelscript://index/summary') {
        const summary = this.indexer.getSummary();
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(summary, null, 2)
            }
          ]
        };
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

const server = new UnrealIndexMCPServer();
server.run().catch(console.error);
