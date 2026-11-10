// Prepare a private declaration overlay without changing installed packages.
// This module never loads TypeScript, launches a child, or changes installed files.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ioState = { opened: 0, closed: 0, closeFailures: 0 };
function closeFile(fd) {
  try { fs.closeSync(fd); ioState.closed++; }
  catch (error) { ioState.closeFailures++; throw error; }
}
export function guard(ok, code) {
  if (!ok) { const error = new Error(code); error.proofCode = code; throw error; }
}
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function within(p, root) { return p === root || p.startsWith(root + path.sep); }
function relativeName(name) {
  guard(typeof name === 'string' && name.length > 0 && !path.isAbsolute(name) &&
    !/[\\\u0000-\u001f\u007f]/u.test(name) && name.split('/').every(x => x && x !== '.' && x !== '..') &&
    Buffer.byteLength(name) <= 2048, 'INVALID_RELATIVE_INPUT');
  return name;
}
export function local(name) { return path.join(projectRoot, relativeName(name)); }
function sameStat(a, b) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink', 'mode', 'uid'].every(k => a[k] === b[k]);
}
function regular(name, maximum) {
  const st = fs.lstatSync(name);
  // Read-only installed preimages may have store hardlinks; generated copies must not.
  guard(st.isFile() && !st.isSymbolicLink() && st.nlink >= 1 && st.size <= maximum &&
    fs.realpathSync(name) === name, 'REGULAR_INPUT_OR_BOUND');
  return st;
}
// Read only named, bounded text/data inputs. Compiler executable bodies are excluded.
export function readNamed(name, maximum) {
  const before = regular(name, maximum);
  let fd;
  try {
    fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    ioState.opened++;
    guard(sameStat(before, fs.fstatSync(fd)), 'INPUT_OPEN_RACE');
    // Bound allocation even if the file grows after lstat; never readFile on an unbounded fd.
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    guard(length === before.size && sameStat(before, fs.fstatSync(fd)) &&
      sameStat(before, fs.lstatSync(name)) && fs.realpathSync(name) === name, 'INPUT_CHANGED_DURING_READ');
    const bytes = buffer.subarray(0, length);
    const text = bytes.toString('utf8');
    guard(!text.includes('\0') && Buffer.from(text, 'utf8').equals(bytes), 'INPUT_NOT_UTF8_TEXT');
    return { bytes, text, stat: before };
  } finally {
    if (fd !== undefined) closeFile(fd);
  }
}
export function loadPolicy() {
  guard(process.cwd() === projectRoot && fs.realpathSync(projectRoot) === projectRoot, 'CANONICAL_PROJECT_CWD_REQUIRED');
  const input = readNamed(local('typecheck/aggrid-overlay-policy.json'), 65536);
  const policy = JSON.parse(input.text);
  guard(policy.schema === 'aggrid-overlay-policy-r26/v1' && policy.limits.policyBytes === 65536 &&
    policy.limits.manifestBytes === 2097152 && policy.limits.reportBytes === 2097152,
  'POLICY_SCHEMA_OR_CAP_CHANGE');
  return { policy, policySha256: sha256(input.bytes) };
}
function ownedDirectory(name) {
  const st = fs.lstatSync(name);
  guard(st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid() &&
    fs.realpathSync(name) === name, 'DIRECTORY_OWNERSHIP_OR_LINK');
  return st;
}
function privateDirectory(name) {
  fs.mkdirSync(name, { mode: 0o700 }); // No recursive creation or existing-root reuse.
  guard((ownedDirectory(name).mode & 0o777) === 0o700, 'PRIVATE_DIRECTORY_MODE');
}
function writeExclusive(name, bytes, context) {
  let fd;
  try {
    fd = fs.openSync(name, 'wx', 0o600);
    ioState.opened++;
    // Capture every newly created file, even if its first write or close fails.
    context.filesCreated++;
    let written = 0;
    while (written < bytes.length) {
      const n = fs.writeSync(fd, bytes, written, bytes.length - written);
      guard(n > 0, 'GENERATED_SHORT_WRITE');
      written += n;
    }
    const st = fs.fstatSync(fd);
    guard(st.isFile() && st.nlink === 1 && st.uid === process.getuid() &&
      (st.mode & 0o777) === 0o600 && st.size === bytes.length &&
      fs.realpathSync(name) === name, 'GENERATED_FILE_OWNERSHIP');
    return st;
  } finally {
    if (fd !== undefined) closeFile(fd);
  }
}
export function prepareOverlay(policy, namespace, onOwned, checkpoint) {
  const manifestInput = readNamed(local(policy.manifest), 2097152);
  guard(sha256(manifestInput.bytes) === policy.manifestSha256, 'DECLARATION_MANIFEST_HASH');
  const manifest = JSON.parse(manifestInput.text);
  guard(manifest.schema === 'aggrid-declaration-manifest-r26/v1' &&
    manifest.package === 'ag-grid-community@36.2.0' && manifest.files.length === 634,
  'DECLARATION_MANIFEST_SCHEMA_COUNT');
  const rows = manifest.files;
  const allowed = new Set();
  let declarations = 0;
  for (const row of rows) {
    guard(Array.isArray(row) && row.length === 5, 'MANIFEST_ROW');
    const [relative, preBytes, preHash, postBytes, postHash] = row;
    relativeName(relative);
    const declaration = relative.startsWith('dist/types/') && relative.endsWith('.d.ts');
    guard(declaration || relative === 'package.json' || relative === 'dist/types/package.json', 'MANIFEST_WHITELIST');
    guard(!allowed.has(relative) && [preHash, postHash].every(x => /^[a-f0-9]{64}$/u.test(x)) &&
      [preBytes, postBytes].every(x => Number.isInteger(x) && x >= 0 &&
        x <= (declaration ? 262144 : 65536)), 'MANIFEST_IDENTITY');
    allowed.add(relative);
    if (declaration) declarations++;
  }
  guard(declarations === 632 && allowed.has('package.json') && allowed.has('dist/types/package.json'), 'MANIFEST_EXACT_SCOPE');
  const patch = readNamed(local(policy.patch), 65536);
  guard(sha256(patch.bytes) === policy.patchSha256 && policy.edits.length === 2,
    'EXACT_TWO_HUNK_PATCH_REQUIRED');
  const edits = new Map(policy.edits.map(e => [e.relative, e]));
  guard(edits.size === 2 && edits.has('dist/types/src/interfaces/iFrameworkOverrides.d.ts') &&
    edits.has('dist/types/src/rendering/cellRenderers/iCellRenderer.d.ts'), 'EXACT_EDIT_PATHS');
  for (const row of rows) guard((row[2] !== row[4]) === edits.has(row[0]), 'EXACT_EDIT_DELTA');
  const originalConfig = readNamed(local(policy.originalConfig), 65536);
  guard(sha256(originalConfig.bytes) === policy.originalConfigSha256, 'ORIGINAL_CONFIG_HASH');
  const ignored = readNamed(local('.gitignore'), 65536);
  guard(sha256(ignored.bytes) === manifest.sourcePins['.gitignore'] &&
    ignored.text.split('\n').includes('test-results/'), 'GENERATED_PARENT_NOT_IGNORED');
  const sourceRoot = local(policy.originalCommunityRoot);
  ownedDirectory(sourceRoot);

  // Exact dist/types inventory from the whitelist; do not crawl package/cache/runtime siblings.
  const children = new Map();
  for (const relative of allowed) {
    if (relative === 'package.json') continue;
    const pieces = relative.split('/');
    for (let i = 2; i < pieces.length; i++) {
      const directory = pieces.slice(0, i).join('/');
      if (!children.has(directory)) children.set(directory, new Set());
      children.get(directory).add(pieces[i]);
    }
  }
  let entries = 0;
  for (const [directory, names] of children) {
    checkpoint();
    guard(directory.split('/').length <= 24, 'TREE_DEPTH');
    ownedDirectory(path.join(sourceRoot, directory));
    const handle = fs.opendirSync(path.join(sourceRoot, directory));
    ioState.opened++;
    const actual = [];
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        checkpoint();
        guard(++entries <= 4096 && names.has(entry.name) &&
          (entry.isFile() || entry.isDirectory()) && !entry.isSymbolicLink(), 'EXACT_SOURCE_TREE_ENTRY');
        actual.push(entry.name);
      }
    } finally {
      try { handle.closeSync(); ioState.closed++; }
      catch (error) { ioState.closeFailures++; throw error; }
    }
    guard(JSON.stringify(actual.sort()) === JSON.stringify([...names].sort()), 'EXACT_SOURCE_TREE');
  }
  const parent = local('test-results');
  try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  ownedDirectory(parent);
  const generatedRoot = namespace === undefined
    ? path.join(parent, 'aggrid-strict-r26-' + randomBytes(16).toString('hex'))
    : path.resolve(projectRoot, namespace);
  guard(path.dirname(generatedRoot) === parent &&
    /^aggrid-strict-r26-[A-Za-z0-9-]{1,96}$/u.test(path.basename(generatedRoot)) &&
    Buffer.byteLength(generatedRoot) <= 2048, 'EXACT_NAMESPACE_REQUIRED');
  fs.mkdirSync(generatedRoot, { mode: 0o700 }); // EEXIST fails; never reuse/delete old evidence.
  const context = { generatedRoot, filesCreated: 0, declarations: 0, packageManifests: 0,
    preimageBytes: 0, postimageBytes: 0, changedFiles: [], prepared: false,
    evidenceRetained: true, automaticDeletion: false, synchronousFileHandlesClosed: false };
  onOwned(context);
  try {
    guard((ownedDirectory(generatedRoot).mode & 0o777) === 0o700, 'PRIVATE_NAMESPACE_MODE');
    const privateRoot = path.join(generatedRoot, 'declarations', 'ag-grid-community');
    const made = new Set([generatedRoot]);
    function makeParents(target) {
      const relative = path.relative(generatedRoot, path.dirname(target));
      guard(within(target, generatedRoot), 'GENERATED_PATH_ESCAPE');
      let next = generatedRoot;
      for (const part of relative.split(path.sep).filter(Boolean)) {
        next = path.join(next, part);
        if (!made.has(next)) { privateDirectory(next); made.add(next); }
      }
    }
    const identities = [];
    let declarationBytes = 0;
    for (const [relative, preBytes, preHash, postBytes, postHash] of rows) {
      checkpoint();
      const isDeclaration = relative.endsWith('.d.ts');
      const original = readNamed(path.join(sourceRoot, relative), isDeclaration ? 262144 : 65536);
      guard(original.bytes.length === preBytes && sha256(original.bytes) === preHash, 'DECLARATION_PREIMAGE_MISMATCH');
      if (isDeclaration) {
        declarationBytes += preBytes;
        guard(declarationBytes <= 16777216, 'DECLARATION_TOTAL_CAP');
      }
      let output = original.bytes;
      if (edits.has(relative)) {
        const edit = edits.get(relative);
        const lines = original.text.split('\n');
        guard(Number.isInteger(edit.line) && lines[edit.line - 1] === edit.before &&
          original.text.split(edit.before).length === 2, 'PATCH_EXACT_LINE_PREIMAGE');
        lines[edit.line - 1] = edit.after;
        output = Buffer.from(lines.join('\n'), 'utf8');
        context.changedFiles.push(relative);
      }
      guard(output.length === postBytes && sha256(output) === postHash, 'DECLARATION_POSTIMAGE_MISMATCH');
      if (!isDeclaration) {
        const metadata = JSON.parse(original.text);
        guard(metadata.name === 'ag-grid-community' && metadata.version === '36.2.0' &&
          (relative !== 'dist/types/package.json' || metadata.type === 'commonjs'), 'PACKAGE_TYPE_SCOPE');
      }
      const target = path.join(privateRoot, relative);
      makeParents(target);
      const copied = writeExclusive(target, output, context);
      guard(copied.dev !== original.stat.dev || copied.ino !== original.stat.ino, 'COPY_NOT_INDEPENDENT');
      identities.push([relative, preBytes, preHash, postBytes, postHash]);
      context.preimageBytes += preBytes;
      context.postimageBytes += postBytes;
      if (isDeclaration) context.declarations++; else context.packageManifests++;
    }
    guard(context.declarations === 632 && context.packageManifests === 2 &&
      context.changedFiles.length === 2 && context.preimageBytes === policy.preimageTotalBytes &&
      context.postimageBytes === policy.postimageTotalBytes, 'PREPARATION_TOTALS');
    const approvedPaths = { 'ag-grid-community': [path.join(privateRoot, policy.privateEntry)],
      ...Object.fromEntries(Object.entries(policy.peerPaths).map(([k, p]) => [k, [local(p)]])) };
    guard(JSON.stringify(Object.keys(approvedPaths).sort()) ===
      JSON.stringify(['ag-charts-types', 'ag-grid-community', 'ag-stack']), 'ONLY_THREE_PATHS');
    const configFile = path.join(generatedRoot, 'tsconfig.overlay.json');
    const config = Buffer.from(JSON.stringify({ extends: local(policy.originalConfig),
      compilerOptions: { paths: approvedPaths } }, null, 2) + '\n');
    writeExclusive(configFile, config, context);
    const receipt = Buffer.from(JSON.stringify({ schema: 'aggrid-preparation-r26/v1',
      claim: policy.claim, declarationManifestSha256: policy.manifestSha256,
      patchSha256: policy.patchSha256, originalConfigSha256: policy.originalConfigSha256,
      generatedConfigSha256: sha256(config), files: identities }, null, 2) + '\n');
    guard(receipt.length < 2097152, 'PREPARATION_RECEIPT_CAP');
    writeExclusive(path.join(generatedRoot, 'preparation.json'), receipt, context);
    context.prepared = true;
    return { privateRoot, approvedPaths, configFile, manifest, context };
  } finally {
    // readNamed/writeExclusive close every captured fd synchronously, including throws.
    // A close failure propagates and must not be represented as proven closure.
    context.synchronousFileHandlesClosed = ioState.opened === ioState.closed && ioState.closeFailures === 0;
  }
}
