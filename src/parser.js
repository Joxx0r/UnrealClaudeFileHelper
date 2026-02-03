import { readFile } from 'fs/promises';

const PATTERNS = {
  class: /^(?:UCLASS\s*\([^)]*\)\s*\n)?class\s+([UA]\w+)(?:\s*:\s*(\w+))?/gm,
  struct: /^struct\s+(F\w+)/gm,
  enum: /^enum\s+(E\w+)/gm,
  event: /^event\s+\w+\s+(F\w+)\s*\(/gm,
  delegate: /^delegate\s+\w+\s+(F\w+)\s*\(/gm,
  namespace: /^namespace\s+(\w+)/gm,
  uclass: /^UCLASS\s*\(([^)]*)\)/gm
};

export async function parseFile(filePath) {
  const content = await readFile(filePath, 'utf-8');
  return parseContent(content, filePath);
}

export function parseContent(content, filePath = '') {
  const lines = content.split('\n');
  const result = {
    path: filePath,
    classes: [],
    structs: [],
    enums: [],
    events: [],
    delegates: [],
    namespaces: []
  };

  let pendingUClass = null;
  let pendingUClassLine = -1;
  const seenNamespaces = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const uclassMatch = line.match(/^UCLASS\s*\(([^)]*)\)/);
    if (uclassMatch) {
      pendingUClass = uclassMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      pendingUClassLine = lineNum;
      continue;
    }

    const classMatch = line.match(/^class\s+([UA]\w+)(?:\s*:\s*(\w+))?/);
    if (classMatch) {
      const classInfo = {
        name: classMatch[1],
        parent: classMatch[2] || null,
        line: lineNum,
        specifiers: []
      };
      if (pendingUClass && (lineNum - pendingUClassLine <= 2)) {
        classInfo.specifiers = pendingUClass;
      }
      result.classes.push(classInfo);
      pendingUClass = null;
      continue;
    }

    const structMatch = line.match(/^struct\s+(F\w+)/);
    if (structMatch) {
      result.structs.push({
        name: structMatch[1],
        line: lineNum
      });
      continue;
    }

    const enumMatch = line.match(/^enum\s+(E\w+)/);
    if (enumMatch) {
      result.enums.push({
        name: enumMatch[1],
        line: lineNum
      });
      continue;
    }

    const eventMatch = line.match(/^event\s+\w+\s+(F\w+)\s*\(/);
    if (eventMatch) {
      result.events.push({
        name: eventMatch[1],
        line: lineNum
      });
      continue;
    }

    const delegateMatch = line.match(/^delegate\s+\w+\s+(F\w+)\s*\(/);
    if (delegateMatch) {
      result.delegates.push({
        name: delegateMatch[1],
        line: lineNum
      });
      continue;
    }

    const namespaceMatch = line.match(/^namespace\s+(\w+)/);
    if (namespaceMatch) {
      const nsName = namespaceMatch[1];
      if (!seenNamespaces.has(nsName)) {
        seenNamespaces.add(nsName);
        result.namespaces.push({
          name: nsName,
          line: lineNum
        });
      }
      continue;
    }
  }

  return result;
}
