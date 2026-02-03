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
    enums: []
  };

  const lines = content.split('\n');

  let pendingUClass = null;
  let pendingUStruct = null;
  let pendingUEnum = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const uclassMatch = line.match(/^\s*UCLASS\s*\(/);
    if (uclassMatch) {
      pendingUClass = { line: lineNum, specifiers: extractSpecifiers(line) };
      continue;
    }

    const ustructMatch = line.match(/^\s*USTRUCT\s*\(/);
    if (ustructMatch) {
      pendingUStruct = { line: lineNum, specifiers: extractSpecifiers(line) };
      continue;
    }

    const uenumMatch = line.match(/^\s*UENUM\s*\(/);
    if (uenumMatch) {
      pendingUEnum = { line: lineNum, specifiers: extractSpecifiers(line) };
      continue;
    }

    const classMatch = line.match(/^\s*class\s+(?:(\w+_API)\s+)?(\w+)(?:\s+final)?(?:\s*:\s*(?:public|private|protected)\s+(\w+))?/);
    if (classMatch) {
      const className = classMatch[2];
      const parentClass = classMatch[3] || null;

      const isForwardDecl = line.trim().endsWith(';') && !line.includes('{');
      if (isForwardDecl) {
        continue;
      }

      if (pendingUClass && (lineNum - pendingUClass.line <= 3)) {
        result.classes.push({
          name: className,
          parent: parentClass,
          line: lineNum,
          reflected: true,
          specifiers: pendingUClass.specifiers
        });
        pendingUClass = null;
      } else if (className.startsWith('U') || className.startsWith('A') || className.startsWith('F') || className.startsWith('I')) {
        result.classes.push({
          name: className,
          parent: parentClass,
          line: lineNum,
          reflected: false,
          specifiers: []
        });
      }
      continue;
    }

    const structMatch = line.match(/^\s*struct\s+(?:(\w+_API)\s+)?(\w+)/);
    if (structMatch) {
      const structName = structMatch[2];

      const isForwardDecl = line.trim().endsWith(';') && !line.includes('{');
      if (isForwardDecl) {
        continue;
      }

      if (pendingUStruct && (lineNum - pendingUStruct.line <= 3)) {
        result.structs.push({
          name: structName,
          line: lineNum,
          reflected: true,
          specifiers: pendingUStruct.specifiers
        });
        pendingUStruct = null;
      } else if (structName.startsWith('F')) {
        result.structs.push({
          name: structName,
          line: lineNum,
          reflected: false,
          specifiers: []
        });
      }
      continue;
    }

    const enumMatch = line.match(/^\s*enum\s+(?:class\s+)?(\w+)/);
    if (enumMatch) {
      const enumName = enumMatch[1];

      const isForwardDecl = line.trim().endsWith(';') && !line.includes('{');
      if (isForwardDecl) {
        continue;
      }

      if (pendingUEnum && (lineNum - pendingUEnum.line <= 3)) {
        result.enums.push({
          name: enumName,
          line: lineNum,
          reflected: true,
          specifiers: pendingUEnum.specifiers
        });
        pendingUEnum = null;
      } else if (enumName.startsWith('E')) {
        result.enums.push({
          name: enumName,
          line: lineNum,
          reflected: false,
          specifiers: []
        });
      }
      continue;
    }
  }

  return result;
}

function extractSpecifiers(line) {
  const match = line.match(/\(([^)]*)\)/);
  if (!match) return [];
  return match[1].split(',').map(s => s.trim()).filter(Boolean);
}
