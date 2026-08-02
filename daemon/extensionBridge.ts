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
	private writer: Writer | undefined;
	// Identifies which `attach()` call installed the current writer, so a
	// stale connection's `detach()` (e.g. a superseded relay connection
	// closing after a newer one has already attached) can't clobber a
	// newer connection's state.
	private writerToken: symbol | undefined;
	private readonly decoder = new FrameDecoder();
	private readonly pending: PendingRequests;

	constructor(timeoutMs: number) {
		this.pending = new PendingRequests(timeoutMs);
	}

	get connected(): boolean {
		return this.writer !== undefined;
	}

	attach(writer: Writer): symbol {
		const token = Symbol("extension-connection");
		this.writer = writer;
		this.writerToken = token;
		return token;
	}

	detach(token: symbol) {
		if (token !== this.writerToken) return;
		this.writer = undefined;
		this.writerToken = undefined;
		this.pending.rejectAll("The extension disconnected.");
	}

	handleIncomingBytes(chunk: Uint8Array) {
		let messages: unknown[];
		try {
			messages = this.decoder.push(chunk);
		} catch (error) {
			console.error("rango daemon: dropping malformed frame", error);
			return;
		}

		for (const message of messages) {
			if (isExtensionResponse(message)) this.pending.resolve(message);
		}
	}

	async send(action: CommandAction): Promise<ExtensionToDaemonResponse> {
		if (!this.writer) {
			return { id: "", success: false, error: "No extension connected." };
		}

		const id = randomUUID();
		const response = this.pending.register(id);
		try {
			this.writer(encodeFrame({ id, action }));
		} catch (error) {
			this.pending.resolve({ id, success: false, error: String(error) });
		}

		return response;
	}
}
