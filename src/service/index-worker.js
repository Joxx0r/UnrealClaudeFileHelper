import { parentPort, workerData } from 'worker_threads';
import { readFileSync } from 'fs';
import { parseCppContent } from '../parsers/cpp-parser.js';
import { parseContent as parseAngelscriptContent } from '../parsers/angelscript-parser.js';

const { files, language, workerIndex } = workerData;

async function processFiles() {
  const results = [];
  let filesProcessed = 0;
  let typesFound = 0;
  const progressInterval = Math.max(100, Math.floor(files.length / 10));

  for (const file of files) {
    try {
      const content = readFileSync(file.path, 'utf-8');

      if (content.length > 500000) {
        filesProcessed++;
        continue;
      }

      let parsed;
      if (language === 'cpp') {
        parsed = parseCppContent(content, file.path);
      } else {
        parsed = parseAngelscriptContent(content, file.path);
      }

      const types = [];

      for (const cls of parsed.classes) {
        types.push({
          name: cls.name,
          kind: cls.kind || 'class',
          parent: cls.parent || null,
          line: cls.line
        });
      }

      for (const struct of parsed.structs) {
        types.push({
          name: struct.name,
          kind: 'struct',
          parent: struct.parent || null,
          line: struct.line
        });
      }

      for (const en of parsed.enums) {
        types.push({
          name: en.name,
          kind: 'enum',
          parent: null,
          line: en.line
        });
      }

      if (language === 'angelscript') {
        for (const event of parsed.events || []) {
          types.push({
            name: event.name,
            kind: 'event',
            parent: null,
            line: event.line
          });
        }

        for (const delegate of parsed.delegates || []) {
          types.push({
            name: delegate.name,
            kind: 'delegate',
            parent: null,
            line: delegate.line
          });
        }

        for (const ns of parsed.namespaces || []) {
          types.push({
            name: ns.name,
            kind: 'namespace',
            parent: null,
            line: ns.line
          });
        }
      }

      // C++ delegates from DECLARE_*DELEGATE* macros
      if (language === 'cpp') {
        for (const del of parsed.delegates || []) {
          types.push({
            name: del.name,
            kind: 'delegate',
            parent: null,
            line: del.line
          });
        }
      }

      results.push({
        path: file.path,
        project: file.project,
        module: file.module,
        mtime: file.mtime,
        types,
        members: parsed.members || []
      });

      typesFound += types.length;
      filesProcessed++;

      if (filesProcessed % progressInterval === 0) {
        parentPort.postMessage({
          type: 'progress',
          processed: progressInterval,
          workerIndex
        });
      }

    } catch (error) {
    }
  }

  parentPort.postMessage({
    type: 'complete',
    result: {
      filesProcessed,
      typesFound,
      results
    }
  });
}

processFiles();
