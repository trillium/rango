import browser, { type Runtime } from "webextension-polyfill";
import { handleNativeCommand, isIncomingRequest } from "./handleNativeCommand";
import { safePortPost } from "./safePortPost";

const nativeHostName = "com.rango.daemon";
const reconnectBaseDelayMs = 1000;
const reconnectMaxDelayMs = 30_000;

let port: Runtime.Port | undefined;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Connects to the rango daemon over native messaging (Chrome and Firefox
 * both support `connectNative`), replacing the clipboard poll as the CLI's
 * transport into `handleCommand()`. If the native host isn't registered
 * (e.g. the daemon was never installed, or we're on Safari, which uses a
 * different native-messaging API) this fails silently — the clipboard/Talon
 * transport keeps working either way.
 */
export function connectNativeHost() {
	let currentPort: Runtime.Port;
	try {
		currentPort = browser.runtime.connectNative(nativeHostName);
	} catch (error) {
		console.warn("Rango: native messaging unavailable.", error);
		return;
	}

	port = currentPort;

	currentPort.onMessage.addListener(async (message: unknown) => {
		if (!isIncomingRequest(message)) return;
		const response = await handleNativeCommand(message);
		safePortPost(currentPort, response);
	});

	// Guards against a stale `onDisconnect` from a superseded connection
	// clobbering a newer one's state (e.g. if `connectNativeHost` is ever
	// called again before this listener fires).
	currentPort.onDisconnect.addListener(() => {
		if (port !== currentPort) return;
		port = undefined;
		scheduleReconnect();
	});

	reconnectAttempt = 0;
}

function scheduleReconnect() {
	const delay = Math.min(
		reconnectBaseDelayMs * 2 ** reconnectAttempt,
		reconnectMaxDelayMs
	);
	reconnectAttempt += 1;

	clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(connectNativeHost, delay);
}
