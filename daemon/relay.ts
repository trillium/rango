import { platform } from "../shared/platform";
import { checkExistingSingleton, removeControlSocketFile } from "./lifecycle";
import type { ExtensionBridge } from "./extensionBridge";

function isAddrInUseError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EADDRINUSE" || error.message.includes("EADDRINUSE");
}

/**
 * Runs in the singleton process. Accepts the one connection standing in for
 * "the extension" — either a relayed browser-spawned process's stdio, or (in
 * tests) a direct socket connection standing in for the extension leg.
 */
export function startControlSocketServer(bridge: ExtensionBridge) {
	// Tracks which `attach()` call each live connection owns, so its `close()`
	// only detaches the bridge if it's still the current writer (see
	// ExtensionBridge's writerToken).
	const connectionTokens = new WeakMap<Bun.Socket<unknown>, symbol>();

	const listenOptions = {
		unix: platform.controlSocketPath,
		socket: {
			open(socket: Bun.Socket<unknown>) {
				const token = bridge.attach((chunk) => {
					socket.write(chunk);
				});
				connectionTokens.set(socket, token);
			},
			data(_socket, chunk) {
				bridge.handleIncomingBytes(chunk);
			},
			close(socket) {
				const token = connectionTokens.get(socket);
				if (token) bridge.detach(token);
			},
			error(_socket, error) {
				console.error("rango daemon: control socket error", error);
			},
		},
	} satisfies Parameters<typeof Bun.listen>[0];

	try {
		return Bun.listen(listenOptions);
	} catch (error) {
		if (!isAddrInUseError(error)) throw error;

		// The socket file already exists and is bound. Only steal it if the
		// process that owns it is actually dead — the PID file is advisory,
		// but a dead PID plus a bound socket path means a previous singleton
		// crashed without cleaning up, rather than a live one we'd be
		// stealing the connection from.
		if (checkExistingSingleton().alive) throw error;

		removeControlSocketFile();
		return Bun.listen(listenOptions);
	}
}

/**
 * Runs in a process the browser spawned as the native-messaging host while a
 * singleton was already running. Does no protocol-level work of its own — it
 * just pipes raw framed bytes between its own stdio (the browser's native
 * host pipe) and the singleton's control socket, so the singleton can treat
 * either connection kind identically.
 */
export async function runRelay(): Promise<void> {
	return new Promise((resolve) => {
		Bun.connect({
			unix: platform.controlSocketPath,
			socket: {
				open(socket) {
					process.stdin.on("data", (chunk: Buffer) => {
						socket.write(chunk);
					});
					process.stdin.on("close", () => {
						socket.end();
					});
				},
				data(_socket, chunk) {
					process.stdout.write(chunk);
				},
				close() {
					resolve();
				},
				error(_socket, error) {
					console.error("rango daemon: relay connection error", error);
					resolve();
				},
			},
		}).catch((error: unknown) => {
			console.error("rango daemon: failed to connect relay", error);
			resolve();
		});
	});
}
