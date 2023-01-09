import {
    CompletionItem,
    CompletionItemKind, createConnection, Diagnostic as LspDiagnostic,
    DiagnosticSeverity, DidChangeConfigurationNotification, InitializeParams, InitializeResult, LocationLink, NotificationType,
    ParameterInformation,
    Position as LspPosition, ProposedFeatures, Range as LspRange, SemanticTokensBuilder, SemanticTokensRequest, SignatureHelp, SignatureInformation, TextDocumentPositionParams,
    TextDocumentSyncKind, VersionedTextDocumentIdentifier
} from 'vscode-languageserver/node';

import {
    TextDocument
} from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

import { MiKe } from '@necode-org/mike';
import { AnyNode, ASTNodeKind, Expression, getNodeAt, getNodeSourceRange, Identifier, inRange, isAfter, isExpression, Position as MiKePosition, Range as MiKeRange, TypeIdentifier, VariableDefinition, visit } from '@necode-org/mike/ast';
import { createMiKeDiagnosticsManager, Diagnostic as MiKeDiagnostic, DiagnosticsManager, Severity } from '@necode-org/mike/diagnostics';
import { LibraryInterface } from '@necode-org/mike/library';
import { isKeyword, isOperator, isTrivia, Token, TokenType } from '@necode-org/mike/parser';
import { EventRegistration, Typechecker } from '@necode-org/mike/semantics';
import { KnownType, SimpleType, stringifyType, TypeAttribute, TypeAttributeKind, TypeKind } from '@necode-org/mike/types';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

const semanticTokenTypes = ['type', 'parameter', 'variable', 'property', 'function', 'method', 'comment', 'string', 'keyword', 'number', 'operator'] as const;
const semanticTokenModifiers = ['readonly'] as const;

const semanticTokenTypesMap = Object.fromEntries(semanticTokenTypes.map((x, i) => [x, i])) as { [k in typeof semanticTokenTypes[number]]: number };
const semanticTokenModifiersMap = Object.fromEntries(semanticTokenModifiers.map((x, i) => [x, 1 << i])) as { [k in typeof semanticTokenModifiers[number]]: number };

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true,
                triggerCharacters: ['.'],
			},
            signatureHelpProvider: {
                triggerCharacters: ['('],
                retriggerCharacters: [','],
            },
            hoverProvider: true,
            semanticTokensProvider: {
                legend: {
                    tokenTypes: semanticTokenTypes.map(x => x),
                    tokenModifiers: semanticTokenModifiers.map(x => x),
                },
                full: true,
            },
            definitionProvider: true,
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(async () => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}

    const configUri = await connection.sendRequest<string | null>('mike/getMikeConfigUri');
    if (configUri) {
        loadMiKeConfig(configUri);
    }
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();
const mikeInstances = new Map<string, {
    mike: MiKe;
    diagnosticsManager: DiagnosticsManager;
    doc: TextDocument;
    validated?: boolean;
}>();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
        mikeInstances.clear();
	} else {
		globalSettings = <ExampleSettings>(
			(change.settings.languageServerExample || defaultSettings)
		);
	}

	reloadInstances();
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'mikeLanguageServer'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
connection.onDidCloseTextDocument(({ textDocument }) => {
	documentSettings.delete(textDocument.uri);
    mikeInstances.delete(textDocument.uri);
});

connection.onDidOpenTextDocument(({ textDocument }) => {
    connection.console.log('Opened MiKe file: ' + textDocument.uri);

    mikeInstances.set(textDocument.uri, {
        ...loadInstance(textDocument.text),
        doc: TextDocument.create(textDocument.uri, textDocument.languageId, textDocument.version, textDocument.text),
    });

    validateTextDocument(textDocument);
});

function loadInstance(source: string) {
    const diagnosticsManager = createMiKeDiagnosticsManager();
    const mike = new MiKe();
    mike.setDiagnosticsManager(diagnosticsManager);
    connection.console.log(config ? 'Configuration found.' : 'No configuration.');
    if (config?.events) {
        mike.setEvents(config?.events);
    }
    config?.libraries?.forEach(lib => mike!.addLibrary(lib));
    mike.init();
    mike.loadScript(source);

    return { mike, diagnosticsManager };
}

function reloadInstances() {
    for (const [key, { doc }] of mikeInstances) {
        mikeInstances.set(key, {
            ...loadInstance(doc.getText()),
            doc,
        });

        validateTextDocument(doc);
    }
}

connection.onDidChangeTextDocument(({ textDocument, contentChanges }) => {
    if (mikeInstances.has(textDocument.uri)) {
        connection.console.log(`MiKe file changed: ${textDocument.uri}`);
        const entry = mikeInstances.get(textDocument.uri)!;

        const { mike, doc } = entry;
        
        for (const change of contentChanges) {
            TextDocument.update(doc, [change], textDocument.version);
            // TODO: Re-enable once incremental diagnostics are functional
            // if ('range' in change) {
            //     const startByte = doc.offsetAt(change.range.start);
            //     const endByte = doc.offsetAt(change.range.end);
            //     mike.editScript(startByte, endByte - startByte, change.text);
            // }
            // else {
            //     mike.loadScript(change.text);
            // }
            mikeInstances.set(textDocument.uri, { ...loadInstance(doc.getText()), doc });
        }
        validateTextDocument(textDocument);
    }
    else {
        connection.console.warn(`MiKe file changed but not currently loaded: ${textDocument.uri}`);
    }
});

function mikeToLspRange(range: MiKeRange): LspRange {
    return {
        start: {
            line: Math.max(0, range.start.line - 1),
            character: Math.max(0, range.start.col - 1),
        },
        end: {
            line: Math.max(0, range.end.line - 1),
            character: Math.max(0, range.end.col - 1),
        },
    };
}

function lspToMikePosition(pos: LspPosition): MiKePosition {
    return {
        line: pos.line + 1,
        col: pos.character + 1,
    };
}

function lspToPreviousMikePosition(pos: LspPosition): MiKePosition {
    return {
        line: pos.line + 1,
        col: Math.max(1, pos.character),
    };
}

function mikeToLspDiagnostic(diagnostic: MiKeDiagnostic): LspDiagnostic {
    const severity = {
        [Severity.Info]: DiagnosticSeverity.Information,
        [Severity.Warning]: DiagnosticSeverity.Warning,
        [Severity.Error]: DiagnosticSeverity.Error,
    }[diagnostic.severity];

    return {
        severity,
        code: diagnostic.id,
        message: diagnostic.getDescription(),
        range: diagnostic.range ? mikeToLspRange(diagnostic.range) : {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
        },
        source: diagnostic.namespace,
    };
}

let config: {
    events?: EventRegistration[];
    libraries?: LibraryInterface[];
} | undefined;

async function validateTextDocument(textDocument: VersionedTextDocumentIdentifier): Promise<void> {
	// In this simple example we get the settings for every validate run.
	const settings = await getDocumentSettings(textDocument.uri);

    const entry = mikeInstances.get(textDocument.uri)!;
    const { mike, diagnosticsManager, validated } = entry;

    if (!validated) {
        mike.validate();
        entry.validated = true;
        connection.console.log(`Ran mike.validate() in ${textDocument.uri}`);    
        const mikeDiagnostics = diagnosticsManager.getDiagnostics().slice(0, settings.maxNumberOfProblems);
        const lspDiagnostics = mikeDiagnostics.map(mikeToLspDiagnostic);
    
        // Send the computed diagnostics to VSCode.
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: lspDiagnostics });
    }
}

type IdentifierKind = 'method' | 'property' | 'variable' | 'parameter' | 'type' | 'function';

function getIdentifierKind(node: Identifier | undefined, type: KnownType, def: VariableDefinition | undefined): IdentifierKind {
    return (
        node?.parent?.kind === ASTNodeKind.Dereference
            ? type.kind === TypeKind.Function
                ? 'method'
                : 'property'
        : type.kind === TypeKind.Function
            ? def?.kind === ASTNodeKind.TypeDefinition || (def?.kind === ASTNodeKind.OutOfTree && type.returnType.kind === TypeKind.Simple && type.returnType.name === node?.name)
                ? 'type'
                : 'function'
        : def?.kind === ASTNodeKind.Parameter
            ? 'parameter'
            : 'variable'
    );
}

function isIdentifierReadonly(typechecker: Typechecker, node: Identifier | undefined, def: VariableDefinition | undefined) {
    if (def) {
        if (def.kind === ASTNodeKind.ParameterDefinition || def.kind === ASTNodeKind.OutOfTree) {
            return true;
        }
    }
    else if (node?.parent) {
        if (node.parent.kind === ASTNodeKind.AssignField) {
            const type = typechecker.fetchType(node.parent.obj);
            if (type.kind === TypeKind.Simple && !typechecker.fetchTypeInfoFromSimpleType(type)?.attributes.some(x => x.kind === TypeAttributeKind.IsUserDefined)) {
                return true;
            }
        }
        else if (node.parent.kind === ASTNodeKind.Dereference) {
            let parent = node.parent;
            while (parent?.parent?.kind === ASTNodeKind.Dereference) {
                parent = parent.parent;
            }
            const objType = typechecker.fetchType(parent.obj);
            if (objType.kind === TypeKind.Simple && !typechecker.fetchTypeInfoFromSimpleType(objType)?.attributes.some(x => x.kind === TypeAttributeKind.IsUserDefined)) {
                return true;
            }
        }
    }
    return false;
}

connection.onRequest(SemanticTokensRequest.method, (({ textDocument }) => {
    const builder = new SemanticTokensBuilder();

    const push = (token: Token, _type: keyof typeof semanticTokenTypesMap, _modifiers: (keyof typeof semanticTokenModifiersMap)[] = []) => {
        const range = mikeToLspRange(token.range);
        const type = semanticTokenTypesMap[_type];
        const modifiers = _modifiers.reduce((result, next) => result | semanticTokenModifiersMap[next], 0);
        const [firstTokenContent, ...rest] = token.content.split('\n');

        builder.push(range.start.line, range.start.character, firstTokenContent.length, type, modifiers);

        rest.forEach((content, i) => builder.push(range.start.line + i, 0, content.length, type, modifiers));
    };

    const mike = mikeInstances.get(textDocument.uri)?.mike;

    if (!mike) {
        return;
    }

    visit(mike.root, node => {
        if (!node.tokens) {
            return true;
        }

        if (node.kind === ASTNodeKind.Identifier) {
            const type = mike.typechecker.fetchTypeFromIdentifier(node);
            const def = mike.symbolTable.getVariableDefinition(node);

            const tokenType = getIdentifierKind(node, type, def);
            
            const tokenModifiers: (keyof typeof semanticTokenModifiersMap)[] =
                isIdentifierReadonly(mike.typechecker, node, def) ? ['readonly'] : [];

            push(node.tokens[0], tokenType, tokenModifiers);
            return true;
        }
        else if (node.kind === ASTNodeKind.TypeIdentifier) {
            push(node.tokens[0], 'type');
        }
        else if (node.kind === ASTNodeKind.ListenerDefinition) {
            if (node.eventToken) {
                push(node.eventToken, 'function');
            }
        }
    });

    for (const token of mike.root.tokens!) {
        if (isOperator(token)) {
            push(token, 'operator');
        }
        else if (isKeyword(token)) {
            push(token, 'keyword');
        }
        else {
            switch (token.type) {
                case TokenType.LIT_STRING:
                    push(token, 'string');
                    break;
                case TokenType.LIT_INT:
                case TokenType.LIT_FLOAT:
                    push(token, 'number');
                    break;
                case TokenType.TRIVIA_COMMENT:
                    push(token, 'comment');
                    break;
            }
        }
    }

    return builder.build();
}) as SemanticTokensRequest.HandlerSignature);

let mikeConfigVersion = 0;

async function loadMiKeConfig(uri: string) {
    connection.console.log('Loading: ' + uri + `?v=${mikeConfigVersion++}`);
    try {
        // Need to invalidate the require cache because of how ts-node works.
        // The version query string should be sufficient for standard ESM imports
        const requirePath = require.resolve(URI.parse(uri).fsPath);
        delete require.cache[requirePath];
        const imported = await import(uri + `?v=${mikeConfigVersion}`);
        config = uri.endsWith('.ts') ? imported.default : imported;
        connection.console.log('Loaded config.');
    }
    catch (e) {
        connection.console.log(`Failed to load config config:\n${e}`);
    }
    reloadInstances();
}

connection.onDidChangeWatchedFiles(async _change => {
	// Monitored files have change in VSCode
	for (const change of _change.changes) {
        connection.console.log(`File changed: ${change.uri}`);
        if (/[\\/]mikeconfig.(?:m?j|t)s$/.test(change.uri)) {
            await loadMiKeConfig(change.uri);
        }
    }
});

function stringifyTypeAttribute(attr: TypeAttribute) {
    switch (attr.kind) {
        case TypeAttributeKind.IsLegalCondition:
            return `[IsLegalCondition${attr.destructInto ? `<${stringifyType(attr.destructInto)}>` : ''}]`;
        default:
            return `[${TypeAttributeKind[attr.kind]}]`;
    }
}

connection.onHover(({ position, textDocument }) => {
    const entry = mikeInstances.get(textDocument.uri);

    if (!entry) {
        return;
    }

    const { mike, doc } = entry;
    
    // connection.console.log(`Hovered over ${JSON.stringify(lspToMikePosition(position))}`)
    let hovered = getNodeAt(mike.root, lspToMikePosition(position));
    if (hovered) {

        let type: KnownType | undefined;
        let exprText: string | undefined;
        let varPrefix = '';

        if (hovered.kind === ASTNodeKind.Identifier) {
            type = mike.typechecker.fetchTypeFromIdentifier(hovered);
            const source = mike.symbolTable.getVariableDefinition(hovered);
            switch (source?.kind) {
                case ASTNodeKind.ParameterDefinition:
                    varPrefix = 'param ';
                    break;
                case ASTNodeKind.StateDefinition:
                    varPrefix = 'state ';
                    break;
                case ASTNodeKind.LetStatement:
                    varPrefix = 'let ';
                    break;
                case ASTNodeKind.IfCase:
                    varPrefix = '(destructured) ';
                    break;
                case ASTNodeKind.Parameter:
                    if (source.parent?.kind === ASTNodeKind.TypeDefinition) {
                        varPrefix = type.kind === TypeKind.Function ? '(method) ' : '(property) ';
                        exprText = `${source.parent.name.name}.${hovered.name}`;
                    }
                    else {
                        varPrefix = '(parameter) ';
                    }
                    break;
                case ASTNodeKind.OutOfTree:
                    varPrefix = '(external) ';
                    break;
                default:
                    // else
                    let current: AnyNode = hovered;
                    while (current.parent?.kind === ASTNodeKind.Dereference) {
                        current = current.parent!;
                    }
            }
            if (hovered.parent?.kind === ASTNodeKind.Dereference || hovered.parent?.kind === ASTNodeKind.AssignField) {
                varPrefix = type.kind === TypeKind.Function ? '(method) ' : '(property) ';
                const objType = mike.typechecker.fetchType(hovered.parent.obj);
                exprText = `${stringifyType(objType)}.${hovered.name}`;
            }
        }
        else if (isExpression(hovered)) {
            type = mike.typechecker.fetchType(hovered);
        }

        if (type) {
            const range = mikeToLspRange(getNodeSourceRange(hovered));
            exprText ??= doc.getText(range);
            return {
                contents: {
                    kind: 'plaintext',
                    language: 'mike',
                    value: `${varPrefix}${exprText}: ${stringifyType(type)}`,
                },
                range,
            };
        }

        // Not a value. Could be a type
        let range: LspRange;
        switch (hovered.kind) {
            case ASTNodeKind.TypeIdentifier:
                if (hovered.parent?.kind === ASTNodeKind.GenericType && mike.symbolTable.getPositionInParent(hovered) === 0) {
                    hovered = hovered.parent;
                }
                // Intentional fallthrough
            case ASTNodeKind.GenericType:
                const type = mike.typechecker.fetchTypeOfTypeNode(hovered) as SimpleType;
                const typeInfo = mike.typechecker.fetchTypeInfoFromSimpleType(type);
                range = mikeToLspRange(getNodeSourceRange(hovered));
                if (!typeInfo) {
                    // Invalid type
                    return {
                        contents: {
                            kind: 'plaintext',
                            language: 'mike',
                            value: `(unknown) ${doc.getText(mikeToLspRange(getNodeSourceRange(hovered)))}`,
                        },
                        range,
                    };
                }
                const IsUserDefined = typeInfo.attributes.some(x => x.kind === TypeAttributeKind.IsUserDefined);
                const attributes = IsUserDefined ? typeInfo.attributes.filter(x => x.kind !== TypeAttributeKind.IsUserDefined) : typeInfo.attributes;
                return {
                    contents: {
                        kind: 'plaintext',
                        language: 'mike',
                        value: `${
                                    IsUserDefined ? '' : `(external)${attributes.length > 0 ? '\n' : ' '}`
                                }${// Attributes
                                    attributes.length > 0
                                        ? attributes.map(stringifyTypeAttribute).join('\n') + '\n'
                                        : ''
                                }type ${stringifyType(type)}(${
                                    // Fields
                                    Object.entries(typeInfo.members)
                                        .map(([name, type]) => `\n\t${name}: ${stringifyType(type)}`)
                                        + (Object.keys(typeInfo.members).length > 0 ? '\n' : '')
                                });`,
                    },
                    range,
                };
            case ASTNodeKind.FunctionType:
                range = mikeToLspRange(getNodeSourceRange(hovered));
                return {
                    contents: {
                        kind: 'plaintext',
                        language: 'mike',
                        value: `${stringifyType(mike.typechecker.fetchTypeOfTypeNode(hovered))}`,
                    },
                    range,
                };
        }
    }
});

connection.onDefinition(({ position, textDocument }) => {
    const mike = mikeInstances.get(textDocument.uri)?.mike;

    if (!mike) {
        return;
    }

    const getIdentifierAt = (position: LspPosition) => {
        const node = getNodeAt(mike.root, lspToMikePosition(position));
        if (node?.kind !== ASTNodeKind.Identifier && node?.kind !== ASTNodeKind.TypeIdentifier) {
            return getNodeAt(mike.root, lspToPreviousMikePosition(position));
        }
        return node;
    }

    const node = getIdentifierAt(position);

    switch (node?.kind) {
        case ASTNodeKind.Identifier:
            if (node.parent?.kind === ASTNodeKind.Dereference || node.parent?.kind === ASTNodeKind.AssignField) {
                const objType = mike.typechecker.fetchType(node.parent.obj);
                if (!objType || objType.kind !== TypeKind.Simple) {
                    return;
                }
                const varDef = mike.symbolTable.getScope(node).get(objType.name);
                if (!varDef || varDef.kind !== ASTNodeKind.TypeDefinition) {
                    return;
                }
                const field = varDef.parameters.find(p => p.name.name === node.name);
                if (field) {
                    return [LocationLink.create(
                        textDocument.uri,
                        mikeToLspRange(getNodeSourceRange(varDef)),
                        mikeToLspRange(getNodeSourceRange(field.name)),
                    )];
                }
            }
            const varDef = mike.symbolTable.getVariableDefinition(node);
            let idNode: Identifier | TypeIdentifier;
            switch (varDef?.kind) {
                case ASTNodeKind.TypeDefinition:
                case ASTNodeKind.ParameterDefinition:
                case ASTNodeKind.StateDefinition:
                case ASTNodeKind.LetStatement:
                case ASTNodeKind.Parameter:
                    idNode = varDef.name;
                    break;
                case ASTNodeKind.IfCase:
                    idNode = varDef.deconstruct!;
                    break;
                case ASTNodeKind.OutOfTree:
                case undefined:
                    return;
            }
            return [LocationLink.create(
                textDocument.uri,
                mikeToLspRange(getNodeSourceRange(varDef)),
                mikeToLspRange(getNodeSourceRange(idNode)),
            )];
        case ASTNodeKind.TypeIdentifier:

    }

    return;
});

// This handler provides the initial list of the completion items.
connection.onCompletion(({ position, textDocument }): CompletionItem[] => {
    const mike = mikeInstances.get(textDocument.uri)?.mike;

    if (!mike) {
        return [];
    }

    const cursorPos = lspToPreviousMikePosition(position);
    const node = getNodeAt(mike.root, cursorPos) ?? mike.root;
    
    connection.console.log(`Requested completions for ${ASTNodeKind[node.kind]} node`);

    function getObjectThatCursorIsOnMemberOf() {
        const derefNode =
            node.kind === ASTNodeKind.Identifier
                ? node.parent ?? node
            : node;
        
        if (derefNode.kind === ASTNodeKind.AssignField || derefNode.kind === ASTNodeKind.Dereference) {
            const nonTrivia = derefNode.tokens?.filter(x => !isTrivia(x)) ?? [];
            const focusedToken = nonTrivia.find(token => inRange(token.range, cursorPos));
            
            if (focusedToken) {
                connection.console.log(`Focused token: ${focusedToken.content}`);
                if (focusedToken.type === TokenType.SYNTAX_DOT || focusedToken === derefNode.member.tokens?.at(-1)) {
                    return derefNode.obj;
                }
            }
        }
    }
    
    const parentObj = getObjectThatCursorIsOnMemberOf();
    if (parentObj) {
        const type = mike.typechecker.fetchType(parentObj);
        if (type.kind === TypeKind.Simple) {
            const info = mike.typechecker.fetchTypeInfoFromSimpleType(type);
            return Object.entries(info?.members ?? []).map(([name, type]) => ({
                label: name,
                kind: type.kind === TypeKind.Function ? CompletionItemKind.Method : CompletionItemKind.Field,
                detail: stringifyType(type),
            }));
        }
        else {
            return [];
        }
    }
    
    // Fall back to listing all symbols in the scope
    let parent = node;
    while (parent.kind !== ASTNodeKind.Block && parent.kind !== ASTNodeKind.Program) {
        parent = parent.parent!;
    }
    const scope = mike.symbolTable.getScope(parent);
    
    return scope.names.map(name => {
        const def = scope.get(name)!;
        const type = mike.typechecker.fetchVariableDefinitionType(def);
        const idKind = getIdentifierKind(undefined, type, def);
        const isReadonly = isIdentifierReadonly(mike.typechecker, undefined, def);
        return {
            label: name,
            kind: ({
                type: CompletionItemKind.Class,
                function: CompletionItemKind.Function,
                parameter: isReadonly ? CompletionItemKind.Constant : CompletionItemKind.Variable,
                variable: isReadonly ? CompletionItemKind.Constant : CompletionItemKind.Variable,
            } as { [type in IdentifierKind]: CompletionItemKind })[idKind],
            detail: stringifyType(type),
        };
    });
});

connection.onSignatureHelp(({ position, textDocument, context }) => {
    const mike = mikeInstances.get(textDocument.uri)?.mike;

    if (!mike) {
        return;
    }

    const afterCursorPos = lspToMikePosition(position);

    let node: AnyNode = getNodeAt(mike.root, afterCursorPos) ?? mike.root;

    while (node.kind !== ASTNodeKind.Invoke) {
        if (node.parent && isExpression(node.parent)) {
            node = node.parent;
        }
        else {
            return;
        }
    }

    const nonTrivia = node.tokens?.filter(x => !isTrivia(x));

    if (!nonTrivia || nonTrivia.length === 0) {
        return;
    }

    const getTokenAfter = (node: AnyNode) => {
        return nonTrivia[nonTrivia.indexOf(node.tokens?.at(-1)!) + 1];
    }

    const lParen = getTokenAfter(node.fn);

    if (!lParen || !isAfter(afterCursorPos, lParen.range.start)) {
        return;
    }

    const fnType = mike.typechecker.fetchType(node.fn);

    if (fnType.kind !== TypeKind.Function) {
        return;
    }

    const fnName =
        node.fn.kind === ASTNodeKind.Dereference
            ? `${stringifyType(mike.typechecker.fetchType(node.fn.obj))}.${node.fn.member.name}`
        : node.fn.kind === ASTNodeKind.Variable
            ? node.fn.identifier.name
        : '()';

    let label = `${fnName}(`;
    const parameterSpans = [] as [number, number][];

    for (const param of fnType.parameters) {
        if (parameterSpans.length > 0) {
            label += `, `;
        }
        const startIndex = label.length;
        label += stringifyType(param);
        parameterSpans.push([startIndex, label.length]);
    }

    const currentParamIndex = node.args.findIndex(arg => isAfter(getTokenAfter(arg).range.end, afterCursorPos));

    return {
        signatures: [
            SignatureInformation.create(
                `${fnName}(${fnType.parameters.map(stringifyType).join(', ')})`,
                undefined,
                ...parameterSpans.map(span => ParameterInformation.create(span)),
            ),
        ],
        activeSignature: 0,
        activeParameter: currentParamIndex === -1 ? node.args.length : currentParamIndex,
    };
});

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		if (item.data === 1) {
            item.documentation
			item.detail = 'TypeScript details';
			item.documentation = 'TypeScript documentation';
		} else if (item.data === 2) {
			item.detail = 'JavaScript details';
			item.documentation = 'JavaScript documentation';
		}
		return item;
	}
);


// Listen on the connection
connection.listen();
