import { readFile } from 'fs/promises';

// Keywords that should not be treated as return types for function detection
const AS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'default', 'new', 'delete', 'cast', 'import', 'from', 'class',
  'struct', 'enum', 'event', 'delegate', 'namespace', 'mixin', 'access',
  'UCLASS', 'USTRUCT', 'UENUM', 'UPROPERTY', 'UFUNCTION', 'override',
  'property', 'settings', 'private', 'protected', 'public'
]);

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
    namespaces: [],
    members: []
  };

  let pendingUClass = null;
  let pendingUClassLine = -1;
  let pendingUFunction = false;
  let pendingUProperty = false;
  const seenNamespaces = new Set();

  // Brace depth tracking for member parsing
  let currentType = null;
  let braceDepth = 0;
  let typeStartDepth = 0;
  let inEnum = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Skip empty lines and comments (don't count braces in comments)
    if (trimmed === '' || trimmed.startsWith('//')) {
      continue;
    }

    // Count braces for depth tracking
    const braceDelta = countBraces(line);

    // Top-level declarations (only when not inside a type body)
    if (!currentType) {
      const uclassMatch = trimmed.match(/^UCLASS\s*\(([^)]*)\)/);
      if (uclassMatch) {
        pendingUClass = uclassMatch[1].split(',').map(s => s.trim()).filter(Boolean);
        pendingUClassLine = lineNum;
        braceDepth += braceDelta;
        continue;
      }

      // Match classes with U, A, I, F prefixes (#6: added I and F)
      const classMatch = trimmed.match(/^class\s+([UAIF]\w+)(?:\s*:\s*(\w+))?/);
      if (classMatch) {
        const name = classMatch[1];
        const kind = name.startsWith('I') ? 'interface' : 'class';
        const classInfo = {
          name,
          parent: classMatch[2] || null,
          line: lineNum,
          kind,
          specifiers: []
        };
        if (pendingUClass && (lineNum - pendingUClassLine <= 2)) {
          classInfo.specifiers = pendingUClass;
        }
        result.classes.push(classInfo);
        pendingUClass = null;

        currentType = classInfo;
        typeStartDepth = braceDepth;
        inEnum = false;
        braceDepth += braceDelta;
        continue;
      }

      // Struct with parent capture (#4)
      const structMatch = trimmed.match(/^struct\s+(F\w+)(?:\s*:\s*(\w+))?/);
      if (structMatch) {
        const structInfo = {
          name: structMatch[1],
          parent: structMatch[2] || null,
          line: lineNum
        };
        result.structs.push(structInfo);

        currentType = structInfo;
        typeStartDepth = braceDepth;
        inEnum = false;
        braceDepth += braceDelta;
        continue;
      }

      const enumMatch = trimmed.match(/^enum\s+(E\w+)/);
      if (enumMatch) {
        const enumInfo = {
          name: enumMatch[1],
          line: lineNum
        };
        result.enums.push(enumInfo);

        currentType = enumInfo;
        typeStartDepth = braceDepth;
        inEnum = true;
        braceDepth += braceDelta;
        continue;
      }

      const eventMatch = trimmed.match(/^event\s+\w+\s+(F\w+)\s*\(/);
      if (eventMatch) {
        result.events.push({ name: eventMatch[1], line: lineNum });
        braceDepth += braceDelta;
        continue;
      }

      const delegateMatch = trimmed.match(/^delegate\s+\w+\s+(F\w+)\s*\(/);
      if (delegateMatch) {
        result.delegates.push({ name: delegateMatch[1], line: lineNum });
        braceDepth += braceDelta;
        continue;
      }

      const namespaceMatch = trimmed.match(/^namespace\s+(\w+)/);
      if (namespaceMatch) {
        const nsName = namespaceMatch[1];
        if (!seenNamespaces.has(nsName)) {
          seenNamespaces.add(nsName);
          result.namespaces.push({ name: nsName, line: lineNum });
        }
        braceDepth += braceDelta;
        continue;
      }

      braceDepth += braceDelta;
      continue;
    }

    // Inside a type body - parse members
    if (currentType && braceDepth > typeStartDepth) {
      if (inEnum) {
        // Parse enum values (#2)
        if (trimmed !== '{' && trimmed !== '};' && trimmed !== '}' && !trimmed.startsWith('//')) {
          const enumValueMatch = trimmed.match(/^(\w+)\s*(?:[,=}]|$)/);
          if (enumValueMatch) {
            result.members.push({
              name: enumValueMatch[1],
              memberKind: 'enum_value',
              line: lineNum,
              isStatic: false,
              specifiers: null,
              ownerName: currentType.name
            });
          }
        }
      } else {
        // Inside class/struct body - parse functions and properties

        // Check for UFUNCTION/UPROPERTY markers
        if (trimmed.match(/^UFUNCTION\s*\(/)) {
          pendingUFunction = true;
          braceDepth += braceDelta;
          continue;
        }
        if (trimmed.match(/^UPROPERTY\s*\(/)) {
          pendingUProperty = true;
          braceDepth += braceDelta;
          continue;
        }

        // Skip pure braces and common non-declaration lines
        if (trimmed === '{' || trimmed === '};' || trimmed === '}' ||
            trimmed.startsWith('//') || trimmed.startsWith('GENERATED_BODY') ||
            trimmed.startsWith('default ') || trimmed.startsWith('settings ') ||
            trimmed.startsWith('#')) {
          pendingUFunction = false;
          pendingUProperty = false;
          braceDepth += braceDelta;
          if (currentType && braceDepth <= typeStartDepth) {
            currentType = null;
            inEnum = false;
          }
          continue;
        }

        // Only parse member declarations at the first level inside the type
        if (braceDepth === typeStartDepth + 1) {
          const isStatic = /\bstatic\b/.test(trimmed);
          const cleanLine = trimmed
            .replace(/^(private|protected|public)\s+/, '')
            .replace(/^static\s+/, '');

          // Function: type name(
          const funcMatch = cleanLine.match(/^(\w[\w<>,\s]*?)\s+(\w+)\s*\(/);
          if (funcMatch && !AS_KEYWORDS.has(funcMatch[1]) && !AS_KEYWORDS.has(funcMatch[2])) {
            result.members.push({
              name: funcMatch[2],
              memberKind: 'function',
              line: lineNum,
              isStatic,
              specifiers: pendingUFunction ? 'UFUNCTION' : null,
              ownerName: currentType.name
            });
            pendingUFunction = false;
            pendingUProperty = false;
            braceDepth += braceDelta;
            if (currentType && braceDepth <= typeStartDepth) {
              currentType = null;
              inEnum = false;
            }
            continue;
          }

          // Property: type name = or type name;
          const propMatch = cleanLine.match(/^(\w[\w<>,\s]*?)\s+(\w+)\s*[=;]/);
          if (propMatch && !AS_KEYWORDS.has(propMatch[1]) && !AS_KEYWORDS.has(propMatch[2])) {
            result.members.push({
              name: propMatch[2],
              memberKind: 'property',
              line: lineNum,
              isStatic,
              specifiers: pendingUProperty ? 'UPROPERTY' : null,
              ownerName: currentType.name
            });
            pendingUProperty = false;
            pendingUFunction = false;
            braceDepth += braceDelta;
            if (currentType && braceDepth <= typeStartDepth) {
              currentType = null;
              inEnum = false;
            }
            continue;
          }
        }

        pendingUFunction = false;
        pendingUProperty = false;
      }
    }

    braceDepth += braceDelta;

    // Check if we've exited the current type
    if (currentType && braceDepth <= typeStartDepth) {
      currentType = null;
      inEnum = false;
    }
  }

  return result;
}

function countBraces(line) {
  let delta = 0;
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
    } else if (ch === '/' && line[i + 1] === '/') {
      break; // rest is comment
    } else if (ch === '{') {
      delta++;
    } else if (ch === '}') {
      delta--;
    }
  }
  return delta;
}
