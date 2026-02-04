import { readFileSync, openSync, readSync, closeSync } from 'fs';

const UASSET_MAGIC = 0x9E2A83C1;

// Blueprint-like class names that have parent class hierarchies
const BLUEPRINT_CLASS_NAMES = new Set([
  'BlueprintGeneratedClass',
  'WidgetBlueprintGeneratedClass',
  'AnimBlueprintGeneratedClass',
  'GameplayAbilityBlueprintGeneratedClass',
]);

/**
 * Parse the binary header of a .uasset file to extract class hierarchy information.
 * Only reads the first portion of the file (header + name/import/export tables).
 *
 * @param {string} filePath - Absolute path to the .uasset file
 * @returns {{ assetClass: string|null, parentClass: string|null }}
 */
export function parseUAssetHeader(filePath) {
  const result = { assetClass: null, parentClass: null };

  let buf;
  try {
    // Read first 256KB - enough for header + name/import/export tables in most files
    const READ_SIZE = 256 * 1024;
    const fd = openSync(filePath, 'r');
    buf = Buffer.alloc(READ_SIZE);
    const bytesRead = readSync(fd, buf, 0, READ_SIZE, 0);
    closeSync(fd);
    if (bytesRead < 32) return result;
    buf = buf.subarray(0, bytesRead);
  } catch {
    return result;
  }

  try {
    return parseBuffer(buf);
  } catch {
    return result;
  }
}

/**
 * Parse a .uasset buffer (exported for testing).
 */
export function parseBuffer(buf) {
  const result = { assetClass: null, parentClass: null };

  if (buf.length < 32) return result;
  if (buf.readUInt32LE(0) !== UASSET_MAGIC) return result;

  const legacyVer = buf.readInt32LE(4);
  if (legacyVer !== -8 && legacyVer !== -7 && legacyVer !== -6) return result;

  let off = 8;

  // LegacyUE3Version
  off += 4;

  // FileVersionUE4
  const fileVerUE4 = buf.readInt32LE(off); off += 4;

  // FileVersionUE5 (only present if legacyVer <= -8)
  let fileVerUE5 = 0;
  if (legacyVer <= -8) {
    fileVerUE5 = buf.readInt32LE(off); off += 4;
  }

  // FileVersionLicenseeUE
  off += 4;

  // Custom versions array
  const customVerCount = buf.readInt32LE(off); off += 4;
  if (customVerCount < 0 || customVerCount > 1000) return result;
  off += customVerCount * 20; // FGuid(16) + int32(4)

  if (off + 4 > buf.length) return result;

  // TotalHeaderSize
  off += 4;

  // FolderName (FString)
  off = skipFString(buf, off);
  if (off < 0) return result;

  // PackageFlags
  off += 4;

  // NameCount, NameOffset
  const nameCount = buf.readInt32LE(off); off += 4;
  const nameOffset = buf.readInt32LE(off); off += 4;

  if (nameCount < 0 || nameCount > 500000) return result;

  // SoftObjectPathsCount, SoftObjectPathsOffset (UE5) or GatherableTextData (UE4)
  if (fileVerUE5 > 0) {
    off += 8; // SoftObjectPathsCount + SoftObjectPathsOffset
  }

  // LocalizationId (FString) - present in UE4.14+ (fileVerUE4 >= 516)
  if (fileVerUE4 >= 516) {
    off = skipFString(buf, off);
    if (off < 0) return result;
  }

  // GatherableTextDataCount, GatherableTextDataOffset
  if (fileVerUE4 >= 516) {
    off += 8;
  }

  // ExportCount, ExportOffset
  if (off + 8 > buf.length) return result;
  const exportCount = buf.readInt32LE(off); off += 4;
  const exportOffset = buf.readInt32LE(off); off += 4;

  // ImportCount, ImportOffset
  if (off + 8 > buf.length) return result;
  const importCount = buf.readInt32LE(off); off += 4;
  const importOffset = buf.readInt32LE(off); off += 4;

  // DependsOffset
  if (off + 4 > buf.length) return result;
  const dependsOffset = buf.readInt32LE(off); off += 4;

  // Validate
  if (exportCount < 0 || importCount < 0 || exportCount > 100000 || importCount > 100000) return result;
  if (nameOffset <= 0 || importOffset <= 0 || exportOffset <= 0) return result;
  if (nameOffset >= buf.length || importOffset >= buf.length || exportOffset >= buf.length) return result;

  // Calculate entry sizes from table boundaries
  const importEntrySize = importCount > 0 && exportOffset > importOffset
    ? Math.floor((exportOffset - importOffset) / importCount) : 0;
  const exportEntrySize = exportCount > 0 && dependsOffset > exportOffset
    ? Math.floor((dependsOffset - exportOffset) / exportCount) : 0;

  // Validate entry sizes are reasonable
  if (importEntrySize < 28 || importEntrySize > 64) return result;
  if (exportEntrySize < 56 || exportEntrySize > 200) return result;

  // Parse name table
  const names = parseNameTable(buf, nameOffset, nameCount);
  if (!names) return result;

  // Parse import table
  const imports = parseImportTable(buf, importOffset, importCount, importEntrySize, names);
  if (!imports) return result;

  // Find the BlueprintGeneratedClass import index
  let bpClassImportIndex = -1;
  let bpClassName = null;
  for (let i = 0; i < imports.length; i++) {
    if (imports[i].className === 'Class' && BLUEPRINT_CLASS_NAMES.has(imports[i].objectName)) {
      bpClassImportIndex = i;
      bpClassName = imports[i].objectName;
      break;
    }
  }

  // Scan export table for the main class export
  if (bpClassImportIndex >= 0 && exportOffset + exportCount * exportEntrySize <= buf.length) {
    // The ClassIndex for a BlueprintGeneratedClass export references the import as -(importIndex + 1)
    const targetClassIndex = -(bpClassImportIndex + 1);

    for (let i = 0; i < exportCount; i++) {
      const entryOff = exportOffset + i * exportEntrySize;
      if (entryOff + 8 > buf.length) break;

      const classIndex = buf.readInt32LE(entryOff);
      if (classIndex === targetClassIndex) {
        const superIndex = buf.readInt32LE(entryOff + 4);
        result.assetClass = bpClassName;

        // Resolve SuperIndex to parent class name
        if (superIndex < 0) {
          const superImportIdx = -superIndex - 1;
          if (superImportIdx < imports.length) {
            result.parentClass = imports[superImportIdx].objectName;
          }
        }
        break;
      }
    }
  }

  // If no BlueprintGeneratedClass found, try to identify the asset class from the first export
  if (!result.assetClass && exportCount > 0 && exportOffset + exportEntrySize <= buf.length) {
    const classIndex = buf.readInt32LE(exportOffset);
    if (classIndex < 0) {
      const importIdx = -classIndex - 1;
      if (importIdx < imports.length) {
        const className = imports[importIdx].objectName;
        // Map common asset class names
        result.assetClass = className;
      }
    }
  }

  return result;
}

function skipFString(buf, off) {
  if (off + 4 > buf.length) return -1;
  const len = buf.readInt32LE(off); off += 4;
  if (len > 0) {
    off += len; // includes null terminator
  } else if (len < 0) {
    // UTF-16 encoded
    off += (-len) * 2;
  }
  if (off > buf.length) return -1;
  return off;
}

function parseNameTable(buf, offset, count) {
  const names = [];
  let off = offset;

  for (let i = 0; i < count; i++) {
    if (off + 4 > buf.length) return null;

    const len = buf.readInt32LE(off); off += 4;
    let str;

    if (len > 0) {
      if (off + len > buf.length) return null;
      str = buf.toString('utf8', off, off + len - 1); // -1 to skip null terminator
      off += len;
    } else if (len < 0) {
      const charCount = -len;
      if (off + charCount * 2 > buf.length) return null;
      str = buf.toString('utf16le', off, off + charCount * 2 - 2);
      off += charCount * 2;
    } else {
      str = '';
    }

    // Skip hash bytes (NonCasePreservingHash + CasePreservingHash = 4 bytes)
    off += 4;
    if (off > buf.length) return null;

    names.push(str);
  }

  return names;
}

function parseImportTable(buf, offset, count, entrySize, names) {
  const imports = [];

  for (let i = 0; i < count; i++) {
    const base = offset + i * entrySize;
    if (base + 28 > buf.length) return null;

    // FObjectImport layout (first 28 bytes are always the same):
    // ClassPackage FName: int32 nameIdx + int32 number (8 bytes)
    // ClassName FName: int32 nameIdx + int32 number (8 bytes)
    // OuterIndex: int32 (4 bytes)
    // ObjectName FName: int32 nameIdx + int32 number (8 bytes)
    const classPackageIdx = buf.readInt32LE(base);
    const classNameIdx = buf.readInt32LE(base + 8);
    const outerIndex = buf.readInt32LE(base + 16);
    const objectNameIdx = buf.readInt32LE(base + 20);

    imports.push({
      classPackage: (classPackageIdx >= 0 && classPackageIdx < names.length) ? names[classPackageIdx] : null,
      className: (classNameIdx >= 0 && classNameIdx < names.length) ? names[classNameIdx] : null,
      outerIndex,
      objectName: (objectNameIdx >= 0 && objectNameIdx < names.length) ? names[objectNameIdx] : null,
    });
  }

  return imports;
}
