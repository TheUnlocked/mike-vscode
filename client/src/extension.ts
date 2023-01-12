import { execSync } from 'child_process';
import * as path from 'path';
import { ExtensionContext, window, workspace } from 'vscode';

import {
	ForkOptions,
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);

	const out = window.createOutputChannel('MiKe Language Client');
	
	const cwd = workspace.workspaceFolders[0]?.uri.fsPath;
	out.appendLine(`CWD: ${cwd}`);

	let options: ForkOptions;
	try {
		execSync(`node -e "require('ts-node')"`, { cwd });
		// ts-node is available
		out.appendLine('ts-node available');
		options = {
			cwd,
			execArgv: ['--loader', 'ts-node/esm'],
			env: {
				'TS_NODE_TRANSPILE_ONLY': '1',
				'TS_NODE_SKIP_PROJECT': '1',
			},
		};
	}
	catch (e) {
		out.appendLine('ts-node not available');
		options = {
			cwd
		};
	}

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: {
			module: serverModule,
			transport: TransportKind.ipc,
			options,
		},
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options,
		},
	};

	const mikeConfigGlob = '**/mikeconfig.{js,mjs,ts}';
	const mikeDocumentSelector = { scheme: 'file', language: 'mike' };

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [mikeDocumentSelector],
		synchronize: {
			// Notify the server about file changes to mikeconfig.js files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher(mikeConfigGlob),
		},
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'mikeLanguageServer',
		'MiKe Language Server',
		serverOptions,
		clientOptions,
	);

	// Start the client. This will also launch the server
	client.start();

	// Wait for client to be ready before setting up handlers
	await client.onReady();

	client.onRequest('mike/getMikeConfigUri', async () => {
		const [uri] = await workspace.findFiles(mikeConfigGlob, '**​/node_modules/**', 1);
		if (uri) {
			await client.onReady();
			return uri.toString();
		}
	});
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}