import { randomUUID } from "node:crypto";
import { encodeFrame, FrameDecoder } from "../shared/frame";
import {
	type CommandAction,
	type ExtensionToDaemonResponse,
	isExtensionResponse,
} from "../shared/protocol";
import { PendingRequests } from "./pendingRequests";

type Writer = (chunk: Uint8Array) => void;

/**
 * The daemon's one connection to "the extension" — whether that byte stream
 * is this process's own stdio (spawned directly by the browser as the native
 * host) or a relayed control-socket connection (forwarded from a sibling
 * process the browser spawned while this singleton was already running) is
 * transparent to this class; both speak the same length-prefixed JSON frames.
 */
export class ExtensionBridge {
	// More than one connection can be attached briefly at once (e.g. a relay
	// connection overlapping with the singleton's own stdio during a
	// reconnect). Each gets its own frame decoder, keyed by the token
	// `attach()` returned, so a partial frame from one stream can never mix
	// with bytes from another. The most-recently-attached still-live
	// connection is "the" extension for outgoing sends; when it detaches, the
	// next most-recent survivor takes over automatically since it's just
	// whatever token sorts last in the map's insertion order.
	private readonly writers = new Map<symbol, Writer>();
	private readonly decoders = new Map<symbol, FrameDecoder>();
	private readonly pending: PendingRequests;

	constructor(timeoutMs: number) {
		this.pending = new PendingRequests(timeoutMs);
	}

	get connected(): boolean {
		return this.writers.size > 0;
	}

	attach(writer: Writer): symbol {
		const token = Symbol("extension-connection");
		this.writers.set(token, writer);
		this.decoders.set(token, new FrameDecoder());
		return token;
	}

	detach(token: symbol) {
		if (!this.writers.delete(token)) return;
		this.decoders.delete(token);
		if (this.writers.size === 0) {
			this.pending.rejectAll("The extension disconnected.");
		}
	}

	handleIncomingBytes(token: symbol, chunk: Uint8Array) {
		const decoder = this.decoders.get(token);
		if (!decoder) return;

		let messages: unknown[];
		try {
			messages = decoder.push(chunk);
		} catch (error) {
			console.error("rango daemon: dropping malformed frame", error);
			// The decoder's internal buffer still holds the oversized/invalid
			// frame; replace it so this connection isn't stuck re-throwing on
			// every subsequent chunk.
			this.decoders.set(token, new FrameDecoder());
			return;
		}

		for (const message of messages) {
			if (isExtensionResponse(message)) this.pending.resolve(message);
		}
	}

	async send(action: CommandAction): Promise<ExtensionToDaemonResponse> {
		let activeToken: symbol | undefined;
		for (const token of this.writers.keys()) activeToken = token;
		const writer = activeToken ? this.writers.get(activeToken) : undefined;
		if (!writer) {
			return { id: "", success: false, error: "No extension connected." };
		}

		const id = randomUUID();
		const response = this.pending.register(id);
		try {
			writer(encodeFrame({ id, action }));
		} catch (error) {
			this.pending.resolve({ id, success: false, error: String(error) });
		}

		return response;
	}
}
