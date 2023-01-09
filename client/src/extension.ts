import * as path from 'path';
import { workspace, ExtensionContext } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	NotificationType,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: {
				execArgv: ['--loader', 'ts-node/esm'],
				env: {
					'TS_NODE_TRANSPILE_ONLY': '1',
				},
			},
		},
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: {
				execArgv: ['--loader', 'ts-node/esm'],
				env: {
					'TS_NODE_TRANSPILE_ONLY': '1',
				},
			},
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