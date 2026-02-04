import { readFile } from 'fs/promises';

export async function parseCppFile(filePath) {
  const content = await readFile(filePath, 'utf-8');
  return parseCppContent(content, filePath);
}

export function parseCppContent(content, filePath = '') {
  const result = {
    path: filePath,
    classes: [],
    structs: [],
    enums: [],
    delegates: [],
    members: []
  };

  const lines = content.split('\n');

  let pendingUClass = null;
  let pendingUStruct = null;
  let pendingUEnum = null;
  let pendingUFunction = null;
  let pendingUProperty = null;

  // Brace depth tracking for member parsing
  let currentType = null;
  let braceDepth = 0;
  let typeStartDepth = 0;
  let inEnum = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('//')) {
      continue;
    }

    const braceDelta = countBraces(line);

    // Delegate macros (#7) - these are top-level declarations
    // DECLARE_DELEGATE(FName), DECLARE_MULTICAST_DELEGATE(FName),
    // DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FName, type, param)
    // DECLARE_DELEGATE_RetVal(RetType, FName)
    // DECLARE_EVENT(OwnerClass, FName)
    const delegateMatch = trimmed.match(/^\s*DECLARE_(?:DYNAMIC_(?:MULTICAST_)?)?(?:MULTICAST_)?DELEGATE_RetVal(?:_\w+)?\s*\(\s*[^,)]+\s*,\s*(\w+)/) ||
                          trimmed.match(/^\s*DECLARE_(?:DYNAMIC_(?:MULTICAST_)?)?(?:MULTICAST_)?DELEGATE(?:_\w+)?\s*\(\s*(\w+)/) ||
                          trimmed.match(/^\s*DECLARE_EVENT(?:_\w+)?\s*\(\s*\w+\s*,\s*(\w+)/);
    if (delegateMatch && delegateMatch[1].startsWith('F')) {
      result.delegates.push({
        name: delegateMatch[1],
        line: lineNum,
        kind: 'delegate'
      });
      braceDepth += braceDelta;
      continue;
    }

    // Top-level type declarations (when not inside a type body)
    if (!currentType) {
      const uclassMatch = trimmed.match(/^\s*UCLASS\s*\(/);
      if (uclassMatch) {
        pendingUClass = { line: lineNum, specifiers: extractSpecifiers(trimmed) };
        braceDepth += braceDelta;
        continue;
      }

      const ustructMatch = trimmed.match(/^\s*USTRUCT\s*\(/);
      if (ustructMatch) {
        pendingUStruct = { line: lineNum, specifiers: extractSpecifiers(trimmed) };
        braceDepth += braceDelta;
        continue;
      }

      const uenumMatch = trimmed.match(/^\s*UENUM\s*\(/);
      if (uenumMatch) {
        pendingUEnum = { line: lineNum, specifiers: extractSpecifiers(trimmed) };
        braceDepth += braceDelta;
        continue;
      }

      // Class declaration
      const classMatch = trimmed.match(/^\s*class\s+(?:(\w+_API)\s+)?(\w+)(?:\s+final)?(?:\s*:\s*(?:public|private|protected)\s+(\w+))?/);
      if (classMatch) {
        const className = classMatch[2];
        const parentClass = classMatch[3] || null;

        const isForwardDecl = trimmed.endsWith(';') && !trimmed.includes('{');
        if (isForwardDecl) {
          braceDepth += braceDelta;
          continue;
        }

        // #6: Interface detection
        const isInterface = className.startsWith('I');

        if (pendingUClass && (lineNum - pendingUClass.line <= 3)) {
          const classInfo = {
            name: className,
            parent: parentClass,
            line: lineNum,
            reflected: true,
            kind: isInterface ? 'interface' : 'class',
            specifiers: pendingUClass.specifiers
          };
          result.classes.push(classInfo);
          currentType = classInfo;
          typeStartDepth = braceDepth;
          inEnum = false;
          pendingUClass = null;
        } else if (className.startsWith('U') || className.startsWith('A') || className.startsWith('F') || className.startsWith('I')) {
          const classInfo = {
            name: className,
            parent: parentClass,
            line: lineNum,
            reflected: false,
            kind: isInterface ? 'interface' : 'class',
            specifiers: []
          };
          result.classes.push(classInfo);
          currentType = classInfo;
          typeStartDepth = braceDepth;
          inEnum = false;
        }
        braceDepth += braceDelta;
        continue;
      }

      // Struct declaration (#4: capture parent)
      const structMatch = trimmed.match(/^\s*struct\s+(?:(\w+_API)\s+)?(\w+)(?:\s+final)?(?:\s*:\s*(?:public|private|protected)\s+(\w+))?/);
      if (structMatch) {
        const structName = structMatch[2];
        const structParent = structMatch[3] || null;

        const isForwardDecl = trimmed.endsWith(';') && !trimmed.includes('{');
        if (isForwardDecl) {
          braceDepth += braceDelta;
          continue;
        }

        if (pendingUStruct && (lineNum - pendingUStruct.line <= 3)) {
          const structInfo = {
            name: structName,
            parent: structParent,
            line: lineNum,
            reflected: true,
            specifiers: pendingUStruct.specifiers
          };
          result.structs.push(structInfo);
          currentType = structInfo;
          typeStartDepth = braceDepth;
          inEnum = false;
          pendingUStruct = null;
        } else if (structName.startsWith('F')) {
          const structInfo = {
            name: structName,
            parent: structParent,
            line: lineNum,
            reflected: false,
            specifiers: []
          };
          result.structs.push(structInfo);
          currentType = structInfo;
          typeStartDepth = braceDepth;
          inEnum = false;
        }
        braceDepth += braceDelta;
        continue;
      }

      // Enum declaration
      const enumMatch = trimmed.match(/^\s*enum\s+(?:class\s+)?(\w+)/);
      if (enumMatch) {
        const enumName = enumMatch[1];

        const isForwardDecl = trimmed.endsWith(';') && !trimmed.includes('{');
        if (isForwardDecl) {
          braceDepth += braceDelta;
          continue;
        }

        if (pendingUEnum && (lineNum - pendingUEnum.line <= 3)) {
          const enumInfo = {
            name: enumName,
            line: lineNum,
            reflected: true,
            specifiers: pendingUEnum.specifiers
          };
          result.enums.push(enumInfo);
          currentType = enumInfo;
          typeStartDepth = braceDepth;
          inEnum = true;
          pendingUEnum = null;
        } else if (enumName.startsWith('E')) {
          const enumInfo = {
            name: enumName,
            line: lineNum,
            reflected: false,
            specifiers: []
          };
          result.enums.push(enumInfo);
          currentType = enumInfo;
          typeStartDepth = braceDepth;
          inEnum = true;
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
        if (trimmed !== '{' && trimmed !== '};' && trimmed !== '}' &&
            !trimmed.startsWith('//') && !trimmed.startsWith('UMETA') &&
            !trimmed.startsWith('GENERATED')) {
          const enumValueMatch = trimmed.match(/^(\w+)\s*(?:[,=}]|$)/);
          if (enumValueMatch && enumValueMatch[1] !== 'UMETA') {
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
        // Inside class/struct body

        // UFUNCTION marker (#1)
        if (trimmed.match(/^\s*UFUNCTION\s*\(/)) {
          pendingUFunction = { specifiers: extractSpecifiers(trimmed) };
          braceDepth += braceDelta;
          continue;
        }

        // UPROPERTY marker (#3)
        if (trimmed.match(/^\s*UPROPERTY\s*\(/)) {
          pendingUProperty = { specifiers: extractSpecifiers(trimmed) };
          braceDepth += braceDelta;
          continue;
        }

        // Skip braces, macros, generated body
        if (trimmed === '{' || trimmed === '};' || trimmed === '}' ||
            trimmed.startsWith('//') || trimmed.startsWith('GENERATED') ||
            trimmed.startsWith('#') || trimmed.startsWith('friend ')) {
          braceDepth += braceDelta;
          if (currentType && braceDepth <= typeStartDepth) {
            currentType = null;
            inEnum = false;
          }
          continue;
        }

        // Only parse at first level inside type
        if (braceDepth === typeStartDepth + 1) {
          // Function with UFUNCTION
          if (pendingUFunction) {
            const funcMatch = trimmed.match(/^(?:virtual\s+)?(?:static\s+)?(?:const\s+)?(\w[\w<>:,\s*&]*?)\s+(\w+)\s*\(/);
            if (funcMatch) {
              result.members.push({
                name: funcMatch[2],
                memberKind: 'function',
                line: lineNum,
                isStatic: /\bstatic\b/.test(trimmed),
                specifiers: pendingUFunction.specifiers.join(', ') || 'UFUNCTION',
                ownerName: currentType.name
              });
              pendingUFunction = null;
              pendingUProperty = null;
              braceDepth += braceDelta;
              if (currentType && braceDepth <= typeStartDepth) {
                currentType = null;
                inEnum = false;
              }
              continue;
            }
            pendingUFunction = null;
          }

          // Property with UPROPERTY
          if (pendingUProperty) {
            const propMatch = trimmed.match(/^(?:const\s+)?(\w[\w<>:,\s*&]*?)\s+(\w+)\s*(?:[=;{])/);
            if (propMatch) {
              result.members.push({
                name: propMatch[2],
                memberKind: 'property',
                line: lineNum,
                isStatic: /\bstatic\b/.test(trimmed),
                specifiers: pendingUProperty.specifiers.join(', ') || 'UPROPERTY',
                ownerName: currentType.name
              });
              pendingUProperty = null;
              pendingUFunction = null;
              braceDepth += braceDelta;
              if (currentType && braceDepth <= typeStartDepth) {
                currentType = null;
                inEnum = false;
              }
              continue;
            }
            pendingUProperty = null;
          }
        }
      }
    }

    braceDepth += braceDelta;

    // Check if we've exited the current type
    if (currentType && braceDepth <= typeStartDepth) {
      currentType = null;
      inEnum = false;
      pendingUFunction = null;
      pendingUProperty = null;
    }
  }

  return result;
}

function extractSpecifiers(line) {
  const match = line.match(/\(([^)]*)\)/);
  if (!match) return [];
  return match[1].split(',').map(s => s.trim()).filter(Boolean);
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
      break;
    } else if (ch === '{') {
      delta++;
    } else if (ch === '}') {
      delta--;
    }
  }
  return delta;
}
