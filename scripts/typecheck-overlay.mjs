// Typecheck using a bounded, hash-pinned AG Grid declaration overlay.
// Exactly one prospective Program; no emit, custom resolver, trace, or retry.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { projectRoot, loadPolicy, prepareOverlay, ioState } from './prepare-aggrid-typecheck.mjs';

const started = performance.now();
function checkpoint() { guard(performance.now() - started < 180000, 'SHARED_WORK_WALL_LIMIT'); }
const LIMIT = Object.freeze({ reportBytes: 2097152, files: 4096, references: 4096,
  diagnostics: 64, roots: 4096, pathBytes: 2048, specifierBytes: 2048,
  astNodes: 4000000, astDepth: 2048, astQueue: 262144, symbolDeclarations: 64,
  policyBytes: 65536, manifestBytes: 2097152, optionBytes: 65536 });
const result = { schema: 'paypal-canonical-typecheck-r26/v1', acceptance: false,
  futurePassLabel: 'OVERLAY_ASSISTED_MODIFIED_DECLARATIONS',
  originalPinnedPackageStrictcheck: 'ORIGINAL_PINNED_PACKAGE_STRICTCHECK_FAILED',
  programCount: 0, limits: LIMIT, failures: [], omissions: {},
  diagnostics: [], diagnosticCount: 0, policyAcceptanceComplete: false, actualDirectiveEdgesComplete: false,
  proofBoundary: 'Actual single Program, public module symbols and explicit R25 finite directive source policy; actual directive edges remain unproved. Versions are declared source data; no loaded-image, runtime, release, full-S3, or descendant proof.' };
let ts;
let diagnosticTotal = 0;
let pathTable = [];
let reportWritten = false;
function stop(code) { const e = new Error(code); e.proofCode = code; throw e; }
function fail(code) { if (!result.failures.includes(code)) result.failures.push(code); }
function omitted(key, count) { result.omissions[key] = count; fail('OMITTED_' + key); }
function guard(ok, code) { if (!ok) stop(code); }
function boundedText(s, maximum, code) {
  guard(typeof s === 'string' && !/[\u0000-\u001f\u007f]/u.test(s) && Buffer.byteLength(s) <= maximum, code);
  return s;
}
function absolute(p) { return boundedText(path.resolve(p), LIMIT.pathBytes, 'PATH_BOUND'); }
function within(p, root) { return p === root || p.startsWith(root + path.sep); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  }
  return value;
}
function equal(a, b) { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
function exactList(names, code) {
  guard(names.length <= LIMIT.roots, code + '_CAP');
  const out = names.map(absolute).sort();
  guard(new Set(out).size === out.length, code + '_DUPLICATES');
  return out;
}
function diagnostics(items, phase) {
  diagnosticTotal += items.length;
  for (const d of items.slice(0, Math.max(0, LIMIT.diagnostics - result.diagnostics.length))) {
    // Deliberately no messageText, source snippets, chains, relatedInfo or raw stack.
    const item = { phase, code: d.code, category: d.category };
    if (d.file) item.file = absolute(d.file.fileName);
    if (Number.isInteger(d.start)) item.start = d.start;
    if (Number.isInteger(d.length)) item.length = d.length;
    result.diagnostics.push(item);
  }
  result.diagnosticCount = diagnosticTotal;
  if (diagnosticTotal) fail('DIAGNOSTICS_PRESENT');
  if (diagnosticTotal > LIMIT.diagnostics) omitted('diagnostics', diagnosticTotal - LIMIT.diagnostics);
}
function emit() {
  result.acceptance = result.policyAcceptanceComplete && result.programCount === 1 &&
    result.failures.length === 0 && diagnosticTotal === 0 && Object.keys(result.omissions).length === 0;
  let wire = JSON.stringify(result) + '\n';
  if (Buffer.byteLength(wire) >= LIMIT.reportBytes) {
    // No truncated JSON, hidden omitted roots, second output, or raised cap.
    result.acceptance = false;
    wire = JSON.stringify({ schema: result.schema, acceptance: false, policyAcceptanceComplete: false, actualDirectiveEdgesComplete: false,
      originalPinnedPackageStrictcheck: result.originalPinnedPackageStrictcheck,
      futurePassLabel: result.futurePassLabel, programCount: result.programCount,
      failures: ['REPORT_BYTE_CAP'], omissions: { entireDetailedReport: true },
      candidateBytes: Buffer.byteLength(wire), maximumBytes: LIMIT.reportBytes }) + '\n';
  }
  // Synchronous single bounded write; an error is a nonpassing process, not success.
  const payload = Buffer.from(wire);
  try {
    if (fs.writeSync(1, payload) !== payload.length) { process.exitCode = 1; return; }
  } catch {
    process.exitCode = 1;
    return;
  }
  reportWritten = true;
  process.exitCode = result.acceptance ? 0 : 1;
}
try {
  guard(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--namespace'), 'EXACT_ARGUMENTS_REQUIRED');
  guard(process.execArgv.length === 1 && process.execArgv[0] === '--max-old-space-size=1024', 'EXACT_HEAP_ARGUMENT_REQUIRED');
  const { policy: c, policySha256 } = loadPolicy();
  result.policySha256 = policySha256;
  result.declarationManifestSha256 = c.manifestSha256;
  checkpoint();
  const prepared = prepareOverlay(c, process.argv[3], owned => { result.preparation = owned; }, checkpoint);
  const { privateRoot: generatedPrivateRoot, approvedPaths: generatedPaths, configFile } = prepared;
  c.cwd = projectRoot;
  c.originalConfig = absolute(path.join(projectRoot, c.originalConfig));
  c.overlayConfig = configFile;
  c.compilerEntry = absolute(path.join(projectRoot, c.compilerEntry));
  c.privateCommunityRoot = generatedPrivateRoot;
  c.originalCommunityRoot = absolute(path.join(projectRoot, c.originalCommunityRoot));
  c.reactRoot = absolute(path.join(projectRoot, c.reactRoot));
  c.approvedPaths = generatedPaths;
  c.expectedOriginalRoots = c.expectedOriginalRoots.map(p => path.join(projectRoot, p));
  c.privateDeclarationRelativePaths = prepared.manifest.files.map(r => r[0]).filter(p => p.endsWith('.d.ts'));
  result.declaredSourceData = c.declaredSourceData;
  result.exactCompilerEntry = c.compilerEntry;
  guard(c.publicCompilerOptionNames.length === 109 && new Set(c.publicCompilerOptionNames).size === 109 &&
    c.expectedOriginalRoots.length === 79, 'EXACT_CONTRACT_COUNTS');
  // This is the only compiler load. No package-name search or entry fallback.
  // The installed executable body is never hashed by this checker.
  ts = createRequire(import.meta.url)(c.compilerEntry);
  const configHost = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => diagnostics([d], 'config-fatal') };
  const original = ts.getParsedCommandLineOfConfigFile(c.originalConfig, undefined, configHost);
  const overlay = ts.getParsedCommandLineOfConfigFile(c.overlayConfig, undefined, configHost);
  guard(original && overlay, 'CONFIG_PARSE_UNAVAILABLE');
  diagnostics(original.errors, 'original-config');
  diagnostics(overlay.errors, 'overlay-config');
  guard(diagnosticTotal === 0, 'CONFIG_DIAGNOSTICS');

  // Public CompilerOptions names were transcribed from the permitted d.ts text.
  // Do not inspect undocumented parser metadata or AST-bearing option fields.
  // The exact source config pins + public option projection establish input parity.
  function publicOptions(options) {
    const out = {};
    for (const key of c.publicCompilerOptionNames) {
      if (options[key] !== undefined) out[key] = options[key];
    }
    guard(Buffer.byteLength(JSON.stringify(out)) <= LIMIT.optionBytes, 'OPTION_CAP');
    return out;
  }
  const baselineOptions = publicOptions(original.options);
  const overlayOptions = publicOptions(overlay.options);
  const approvedPaths = c.approvedPaths;
  const baselineWithoutPaths = { ...baselineOptions };
  const overlayWithoutPaths = { ...overlayOptions };
  delete baselineWithoutPaths.paths;
  delete overlayWithoutPaths.paths;
  result.options = { baseline: baselineOptions, overlay: overlayOptions,
    comparedPublicNames: c.publicCompilerOptionNames,
    parityExceptExactApprovedPaths: equal(baselineWithoutPaths, overlayWithoutPaths) &&
      baselineOptions.paths === undefined && equal(overlayOptions.paths, approvedPaths),
    scope: 'All 109 named public CompilerOptions retained from the R23 contract; compiler-created config metadata is not an option or a resolution proof.' };
  guard(result.options.parityExceptExactApprovedPaths, 'OPTION_PARITY');
  guard(overlayOptions.strict === true && overlayOptions.exactOptionalPropertyTypes === true && overlayOptions.skipLibCheck === false &&
    overlayOptions.noEmit === true && overlayOptions.noCheck !== true &&
    overlayOptions.skipDefaultLibCheck !== true && overlayOptions.noResolve !== true &&
    overlayOptions.traceResolution !== true && equal(overlayOptions.types, ['node']), 'STRICT_OR_TYPES_GUARD');
  guard(overlayOptions.typeRoots === undefined && overlayOptions.baseUrl === undefined &&
    overlayOptions.preserveSymlinks === undefined, 'UNAPPROVED_RESOLUTION_SETTING');
  guard(equal(original.projectReferences, overlay.projectReferences) &&
    !overlay.projectReferences?.length, 'PROJECT_REFERENCE_CHANGE_OR_EXTRA_PROGRAM_SCOPE');
  const originalRoots = exactList(original.fileNames, 'ORIGINAL_ROOTS');
  const overlayRoots = exactList(overlay.fileNames, 'OVERLAY_ROOTS');
  const expectedRoots = exactList(c.expectedOriginalRoots, 'PINNED_ROOTS');
  result.roots = { original: originalRoots, overlay: overlayRoots, pinned: expectedRoots,
    parsedEquality: equal(originalRoots, overlayRoots), pinnedEquality: equal(originalRoots, expectedRoots) };
  guard(result.roots.parsedEquality && result.roots.pinnedEquality, 'FULL_ORIGINAL_ROOTSET_EQUALITY');

  // A default compiler host/resolver: no resolveModule* or cache hooks supplied.
  checkpoint();
  const program = ts.createProgram({ rootNames: overlay.fileNames, options: overlay.options,
    projectReferences: overlay.projectReferences, configFileParsingDiagnostics: overlay.errors });
  result.programCount = 1;
  // One complete pre-emit diagnostic collection, no emit or second Program.
  const allDiagnostics = ts.getPreEmitDiagnostics(program);
  diagnostics(allDiagnostics, 'all-pre-emit');
  checkpoint();
  const actualRoots = exactList(program.getRootFileNames(), 'ACTUAL_ROOTS');
  result.roots.program = actualRoots;
  result.roots.actualEquality = equal(actualRoots, originalRoots);
  guard(result.roots.actualEquality, 'PROGRAM_ROOTSET_EQUALITY');
  guard(equal(publicOptions(program.getCompilerOptions()), overlayOptions), 'PROGRAM_OPTION_PARITY');
  const allFiles = program.getSourceFiles();
  result.sourceFileCount = allFiles.length;
  if (allFiles.length > LIMIT.files) { omitted('sourceFiles', allFiles.length); stop('SOURCE_FILE_CAP'); }
  const privateRoot = absolute(c.privateCommunityRoot);
  const originalCommunityRoot = absolute(c.originalCommunityRoot);
  const reactRoot = absolute(c.reactRoot);
  guard(c.privateDeclarationRelativePaths.length === 632, 'PRIVATE_MANIFEST_CAP');
  const privateAllowed = new Set(c.privateDeclarationRelativePaths.map(relative => {
    const target = absolute(path.join(privateRoot, relative));
    guard(within(target, privateRoot) && relative.endsWith('.d.ts'), 'PRIVATE_MANIFEST_PATH');
    return target;
  }));
  guard(privateAllowed.size === 632, 'PRIVATE_DECLARATION_MANIFEST_COUNT');
  function isCommunity(p) {
    return within(p, privateRoot) || within(p, originalCommunityRoot) ||
      /\/node_modules\/ag-grid-community(?:\/|$)/u.test(p) || /\/ag-grid-community@/u.test(p);
  }
  const indexBySource = new Map();
  const programPaths = new Map();
  const physicalPaths = new Map();
  let physicalCommunityCount = 0;
  let reactFileCount = 0;
  const nodeTypeFiles = [];
  const privateCommunityFiles = [];
  const originalOrForeignCommunityFiles = [];
  // Each source filename appears once; roots remain explicit exact path lists.
  for (let i = 0; i < allFiles.length; i++) {
    checkpoint();
    const sf = allFiles[i];
    const name = absolute(sf.fileName);
    const real = absolute(fs.realpathSync(name));
    const row = { file: name, physical: real, declaration: sf.isDeclarationFile };
    pathTable.push(row);
    indexBySource.set(sf, i);
    guard(!programPaths.has(name), 'DUPLICATE_PROGRAM_FILENAME');
    programPaths.set(name, sf);
    guard(!physicalPaths.has(real), 'DUPLICATE_PROGRAM_PHYSICAL_PATH');
    physicalPaths.set(real, i);
    if (within(real, reactRoot)) reactFileCount++;
    if (/\/node_modules\/@types\/node\//u.test(real)) nodeTypeFiles.push(i);
    if (isCommunity(name) || isCommunity(real)) {
      physicalCommunityCount++;
      const st = fs.lstatSync(name);
      if (!(name === real && privateAllowed.has(real) && st.isFile() && !st.isSymbolicLink() && st.nlink === 1)) {
        originalOrForeignCommunityFiles.push(i);
      } else privateCommunityFiles.push(i);
    }
  }
  result.sourceFiles = pathTable;
  result.originalOrForeignCommunityFiles = originalOrForeignCommunityFiles;
  result.privateCommunityFiles = privateCommunityFiles;
  result.nodeTypes = { configured: overlayOptions.types, files: nodeTypeFiles,
    indexPresent: nodeTypeFiles.some(i => pathTable[i].physical.endsWith('/@types/node/index.d.ts')) };
  result.reactFileCount = reactFileCount;
  guard(originalRoots.every(p => programPaths.has(p)), 'ORIGINAL_ROOT_NOT_IN_PROGRAM');
  guard(originalOrForeignCommunityFiles.length === 0 && physicalCommunityCount > 0, 'COMMUNITY_FILE_ISOLATION');
  guard(result.nodeTypes.indexPresent && nodeTypeFiles.length > 0, 'ACTUAL_NODE_TYPES_MISSING');
  guard(reactFileCount > 0, 'REACT_PROGRAM_FILES_MISSING');
  const checker = program.getTypeChecker();
  const bindings = [];
  result.communityBindings = bindings;
  result.bindingColumns = ['importerSourceIndex', 'astKind', 'literalStart', 'moduleSpecifier', 'boundSourceIndex'];
  // New schema: finite source-policy completion is separate from actual edge proof.
  const directivePolicy = c.directivePolicy;
  guard(directivePolicy.observedResolvedEdge === false && directivePolicy.actualDirectiveEdgesComplete === false &&
    directivePolicy.tuples.length === 73 && directivePolicy.nodeFiles.length === 66, 'FINITE_DIRECTIVE_CONTRACT');
  const packageRoots = directivePolicy.packageRoots.map(p => absolute(path.join(projectRoot, p)));
  const expectedDirectives = new Map();
  const seenDirectives = new Set();
  function tupleKey(importer, kind, start, end, spelling) {
    return JSON.stringify([importer, importer, kind, start, end, spelling]);
  }
  for (const tuple of directivePolicy.tuples) {
    const [ip, relative, kind, start, end, spelling, cp, candidateRelative] = tuple;
    guard(Number.isInteger(ip) && Number.isInteger(cp) && packageRoots[ip] && packageRoots[cp] &&
      (kind === 'file' || kind === 'type') && Number.isInteger(start) && Number.isInteger(end) &&
      start >= 0 && end >= start, 'DIRECTIVE_POLICY_TUPLE');
    const importer = absolute(path.join(packageRoots[ip], relative));
    const candidate = absolute(path.join(packageRoots[cp], candidateRelative));
    guard(within(importer, packageRoots[ip]) && within(candidate, packageRoots[cp]) &&
      !isCommunity(importer) && !isCommunity(candidate), 'DIRECTIVE_KNOWN_PACKAGE_SCOPE');
    const key = tupleKey(importer, kind, start, end, spelling);
    guard(!expectedDirectives.has(key), 'DUPLICATE_POLICY_DIRECTIVE');
    expectedDirectives.set(key, { candidate, importerPackage: packageRoots[ip], candidatePackage: packageRoots[cp] });
  }
  const expectedNodeRoot = absolute(path.join(projectRoot, directivePolicy.nodePackageRoot));
  const expectedNodeFiles = directivePolicy.nodeFiles.map(p => absolute(path.join(expectedNodeRoot, p))).sort();
  guard(new Set(expectedNodeFiles).size === 66 && expectedNodeFiles.every(p => within(p, expectedNodeRoot)), 'NODE_POLICY_SET');
  const actualNodePaths = nodeTypeFiles.map(i => pathTable[i].physical).sort();
  const expectedNodeIndexPath = path.join(expectedNodeRoot, 'index.d.ts');
  const actualNodeIndex = physicalPaths.get(expectedNodeIndexPath);
  guard(equal(actualNodePaths, expectedNodeFiles) && Number.isInteger(actualNodeIndex) &&
    nodeTypeFiles.every(i => pathTable[i].file === pathTable[i].physical && pathTable[i].declaration) &&
    pathTable[actualNodeIndex].file === expectedNodeIndexPath, 'EXACT_ACTUAL_66_NODE_FILES_AND_UNIQUE_INDEX');
  result.nodeTypes = { ...result.nodeTypes, actualUniqueIndex: actualNodeIndex,
    complete66FileSourcePolicy: true, actualPerImporterTypeEdgesObserved: false };
  const directiveProof = { enumerationComplete: false, finiteSourcePolicyComplete: false,
    actualDirectiveEdgesComplete: false, observedResolvedEdge: false, filesExamined: 0,
    total: 0, fileDirectives: 0, typeDirectives: 0, privateCommunityOrigin: 0,
    namedCommunity: 0, unsupportedRelevant: 0, unknown: 0, duplicate: 0,
    semanticFileCandidates: 0, nodeTypeSourcePolicyCandidates: 0,
    columns: ['importerSourceIndex', 'kind', 'start', 'end', 'spelling',
      'privateCommunityOrigin', 'namedCommunity', 'classification', 'candidateSourceIndex', 'observedResolvedEdge'], rows: [],
    inferenceBoundary: directivePolicy.inferenceBoundary,
    resolutionModeBoundary: 'Historical FileReference.resolutionMode was not retained; no attribute absence or historical per-importer edge inferred.' };
  result.fileTypeDirectiveSourcePolicy = directiveProof;
  let visited = 0;
  let moduleLiterals = 0;
  let reactCommunityBindings = 0;
  let applicationCommunityBindings = 0;
  function moduleLiteral(lit, kind, sf, importerIndex) {
    if (!lit || !ts.isStringLiteralLike(lit)) stop('NONLITERAL_MODULE_REFERENCE');
    moduleLiterals++;
    const specifier = lit.text;
    const namedCommunity = specifier === 'ag-grid-community' || specifier.startsWith('ag-grid-community/');
    const importerPrivate = privateAllowed.has(pathTable[importerIndex].physical);
    const privateRelative = importerPrivate && specifier.startsWith('.');
    const symbol = checker.getSymbolAtLocation(lit);
    const declarations = symbol?.getDeclarations();
    // For unrelated unresolved modules, pre-emit diagnostics remain authoritative.
    // A Community or private-relative reference must have unambiguous actual proof.
    guard(!declarations || declarations.length <= LIMIT.symbolDeclarations, 'MODULE_SYMBOL_DECLARATION_CAP');
    const declarationSources = declarations?.map(d => d.getSourceFile()) ?? [];
    const targetsCommunity = declarationSources.some(s => {
      const index = indexBySource.get(s);
      return index !== undefined && (isCommunity(pathTable[index].file) || isCommunity(pathTable[index].physical));
    });
    if (!namedCommunity && !privateRelative && !targetsCommunity) return;
    if (bindings.length + directiveProof.rows.length >= LIMIT.references) { omitted('communityReferences', 'at-least-one; traversal-stopped'); stop('COMMUNITY_REFERENCE_CAP'); }
    boundedText(specifier, LIMIT.specifierBytes, 'COMMUNITY_SPECIFIER_BOUND');
    guard(symbol && declarations && declarations.length > 0 && declarations.length <= LIMIT.symbolDeclarations,
      'MISSING_OR_UNBOUNDED_COMMUNITY_SYMBOL');
    // Reject merged ambient modules/augmentations, multiple files, alias guesses,
    // and symbols not backed by the actual Program's SourceFile object.
    guard(declarations.every(d => ts.isSourceFile(d)), 'AMBIGUOUS_COMMUNITY_MODULE_DECLARATIONS');
    const targetIndices = [...new Set(declarationSources.map(s => indexBySource.get(s)))];
    guard(targetIndices.length === 1 && targetIndices[0] !== undefined, 'AMBIGUOUS_OR_NONPROGRAM_COMMUNITY_BINDING');
    const target = targetIndices[0];
    guard(privateAllowed.has(pathTable[target].physical) &&
      pathTable[target].file === pathTable[target].physical, 'NONPRIVATE_COMMUNITY_BINDING');
    if (namedCommunity) guard(specifier === 'ag-grid-community' &&
      pathTable[target].physical === approvedPaths['ag-grid-community'][0], 'UNAPPROVED_COMMUNITY_ENTRY_OR_SUBPATH');
    bindings.push([importerIndex, kind, lit.getStart(sf), specifier, target]);
    if (within(pathTable[importerIndex].physical, reactRoot)) reactCommunityBindings++;
    // R27: the generated private tree now lives inside the checkout; it is never application source.
    if (within(pathTable[importerIndex].physical, c.cwd) && !within(pathTable[importerIndex].physical, privateRoot) &&
      !pathTable[importerIndex].physical.includes('/node_modules/')) applicationCommunityBindings++;
  }
  for (let fileIndex = 0; fileIndex < allFiles.length; fileIndex++) {
    const sf = allFiles[fileIndex];
    checkpoint();
    // Retain every actual directive, remapping by logical/physical paths, never old indices.
    guard(sf.referencedFiles.length + sf.typeReferenceDirectives.length <= LIMIT.references, 'FILE_DIRECTIVE_CAP');
    const importerPrivate = privateAllowed.has(pathTable[fileIndex].physical);
    for (const [kind, directives] of [['file', sf.referencedFiles], ['type', sf.typeReferenceDirectives]]) {
      for (const directive of directives) {
        if (bindings.length + directiveProof.rows.length >= LIMIT.references) {
          omitted('fileTypeDirectives', 'at-least-one; enumeration-stopped'); stop('FILE_DIRECTIVE_CAP');
        }
        const specifier = boundedText(directive.fileName, LIMIT.specifierBytes, 'DIRECTIVE_SPECIFIER_BOUND');
        guard(Number.isInteger(directive.pos) && Number.isInteger(directive.end) &&
          directive.pos >= 0 && directive.end >= directive.pos, 'DIRECTIVE_POSITION_UNPROVEN');
        const namedCommunity = specifier.includes('ag-grid-community');
        const importer = pathTable[fileIndex];
        const key = tupleKey(importer.physical, kind, directive.pos, directive.end, specifier);
        const expected = expectedDirectives.get(key);
        let classification = 'UNKNOWN_NONPASS';
        let candidateIndex = null;
        directiveProof.total++;
        if (kind === 'file') directiveProof.fileDirectives++; else directiveProof.typeDirectives++;
        if (importerPrivate) directiveProof.privateCommunityOrigin++;
        if (namedCommunity) directiveProof.namedCommunity++;
        if (importerPrivate || namedCommunity) {
          directiveProof.unsupportedRelevant++;
          fail('COMMUNITY_DIRECTIVE_UNPROVEN');
        } else if (!expected || importer.file !== importer.physical || importer.declaration !== true) {
          directiveProof.unknown++;
          fail('UNEXPECTED_OR_CHANGED_DIRECTIVE');
        } else if (seenDirectives.has(key)) {
          directiveProof.duplicate++;
          fail('DUPLICATE_ACTUAL_DIRECTIVE');
        } else {
          seenDirectives.add(key);
          candidateIndex = physicalPaths.get(expected.candidate);
          guard(Number.isInteger(candidateIndex), 'DIRECTIVE_CANDIDATE_MISSING');
          const candidate = pathTable[candidateIndex];
          guard(candidate.file === expected.candidate && candidate.physical === expected.candidate &&
            candidate.declaration === true && !privateAllowed.has(candidate.physical) &&
            !isCommunity(candidate.file) && !isCommunity(candidate.physical), 'DIRECTIVE_CANDIDATE_NOT_UNIQUE_KNOWN_MEMBER');
          if (kind === 'file') {
            guard(expected.importerPackage === expected.candidatePackage &&
              within(importer.physical, expected.importerPackage) &&
              within(candidate.physical, expected.importerPackage) &&
              !path.isAbsolute(specifier) && absolute(path.join(path.dirname(importer.file), specifier)) === candidate.file,
            'FILE_DIRECTIVE_SEMANTIC_CANDIDATE_CHANGED');
            classification = 'RELATIVE_FILE_SEMANTIC_CANDIDATE_PRESENT';
            directiveProof.semanticFileCandidates++;
          } else {
            // Conjunction, never name-only acceptance or a separately invoked resolver.
            guard(specifier === 'node' && expected.candidatePackage === expectedNodeRoot &&
              candidateIndex === actualNodeIndex && candidate.file === expectedNodeIndexPath &&
              equal(actualNodePaths, expectedNodeFiles) && equal(overlayOptions.types, ['node']) &&
              equal(Object.keys(approvedPaths).sort(), ['ag-charts-types', 'ag-grid-community', 'ag-stack']) &&
              result.options.parityExceptExactApprovedPaths, 'NODE_TYPE_SOURCE_POLICY_CONJUNCTION');
            classification = 'KNOWN_NODE_PACKAGE_SOURCE_POLICY_ACTUAL_EDGE_UNPROVED';
            directiveProof.nodeTypeSourcePolicyCandidates++;
          }
        }
        directiveProof.rows.push([fileIndex, kind, directive.pos, directive.end,
          specifier, importerPrivate, namedCommunity, classification, candidateIndex, false]);
      }
    }
    directiveProof.filesExamined++;
    const pending = [[sf, 0]];
    while (pending.length) {
      if ((visited & 4095) === 0) checkpoint();
      const [node, depth] = pending.pop();
      if (++visited > LIMIT.astNodes || depth > LIMIT.astDepth) {
        omitted('astTraversal', 'incomplete'); stop('AST_TRAVERSAL_CAP');
      }
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) moduleLiteral(node.moduleSpecifier, ts.isImportDeclaration(node) ? 'import' : 'export', sf, fileIndex);
      } else if (ts.isImportTypeNode(node)) {
        guard(ts.isLiteralTypeNode(node.argument), 'NONLITERAL_IMPORT_TYPE');
        moduleLiteral(node.argument.literal, 'import-type', sf, fileIndex);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        moduleLiteral(node.moduleReference.expression, 'import-equals', sf, fileIndex);
      } else if (ts.isCallExpression(node)) {
        const loader = node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require');
        const communityArg = node.arguments.find(a => ts.isStringLiteralLike(a) &&
          (a.text === 'ag-grid-community' || a.text.startsWith('ag-grid-community/')));
        if (loader) moduleLiteral(node.arguments[0], 'module-call', sf, fileIndex);
        else if (communityArg) moduleLiteral(communityArg, 'community-call-failclosed', sf, fileIndex);
      } else if (ts.isModuleDeclaration(node) && ts.isStringLiteralLike(node.name) &&
        (node.name.text === 'ag-grid-community' || node.name.text.startsWith('ag-grid-community/'))) {
        stop('COMMUNITY_AMBIENT_OR_AUGMENTATION_UNPROVEN');
      }
      // No traversal of parents, internal import caches, source text scans, or JSDoc examples.
      ts.forEachChild(node, child => {
        if (pending.length >= LIMIT.astQueue) { omitted('astQueue', 'incomplete'); stop('AST_QUEUE_CAP'); }
        pending.push([child, depth + 1]);
        return undefined;
      });
    }
  }
  directiveProof.enumerationComplete = directiveProof.filesExamined === allFiles.length &&
    directiveProof.total === directiveProof.rows.length &&
    directiveProof.total === directiveProof.fileDirectives + directiveProof.typeDirectives;
  directiveProof.exactTupleMultiset = seenDirectives.size === expectedDirectives.size &&
    directiveProof.total === 73 && directiveProof.duplicate === 0 && directiveProof.unknown === 0;
  directiveProof.finiteSourcePolicyComplete = directiveProof.enumerationComplete &&
    directiveProof.exactTupleMultiset && directiveProof.unsupportedRelevant === 0 &&
    directiveProof.privateCommunityOrigin === 0 && directiveProof.namedCommunity === 0 &&
    directiveProof.fileDirectives === 66 && directiveProof.typeDirectives === 7 &&
    directiveProof.semanticFileCandidates === 66 && directiveProof.nodeTypeSourcePolicyCandidates === 7;
  result.traversal = { moduleTraversalComplete: true, visitedNodes: visited, moduleLiterals,
    communityBindings: bindings.length, reactCommunityBindings, applicationCommunityBindings };
  guard(directiveProof.finiteSourcePolicyComplete, 'FINITE_FILE_TYPE_SOURCE_POLICY_INCOMPLETE');
  guard(bindings.length === c.expectedActualCounts.communityBindings &&
    reactCommunityBindings === c.expectedActualCounts.reactCommunityBindings &&
    applicationCommunityBindings === c.expectedActualCounts.applicationCommunityBindings,
  'EXACT_REQUIRED_COMMUNITY_BINDING_COUNTS');
  guard(ioState.opened === ioState.closed && ioState.closeFailures === 0, 'PREPARATION_IO_CLOSURE_UNPROVEN');
  checkpoint();
  result.policyAcceptanceComplete = true;
} catch (e) {
  // No raw exception text, paths from arbitrary messages, stack or source text.
  fail(typeof e?.proofCode === 'string' ? e.proofCode : 'UNEXPECTED_CHECKER_EXCEPTION');
  result.policyAcceptanceComplete = false;
} finally {
  result.preparationIO = { ...ioState, allCapturedFileHandlesClosed: ioState.opened === ioState.closed && ioState.closeFailures === 0 };
  emit();
}
if (!reportWritten) process.exitCode = 1;
