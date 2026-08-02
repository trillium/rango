import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder } from "../shared/frame";
import { ExtensionBridge } from "./extensionBridge";

describe("ExtensionBridge", () => {
	test("reports disconnected with no writer attached", async () => {
		const bridge = new ExtensionBridge(1000);
		expect(bridge.connected).toBe(false);

		const result = await bridge.send({ name: "clickElement" });
		expect(result).toEqual({
			id: "",
			success: false,
			error: "No extension connected.",
		});
	});

	test("sends a framed request and resolves on a matching framed response", async () => {
		const bridge = new ExtensionBridge(1000);
		const written: Uint8Array[] = [];
		const token = bridge.attach((chunk) => written.push(chunk));

		const resultPromise = bridge.send({ name: "clickElement", target: "x" });

		expect(written).toHaveLength(1);
		const decoder = new FrameDecoder();
		const [sent] = decoder.push(written[0]!) as [
			{ id: string; action: { name: string; target?: string } },
		];
		expect(sent.action).toEqual({ name: "clickElement", target: "x" });

		bridge.handleIncomingBytes(
			token,
			encodeFrame({ id: sent.id, success: true, data: { clicked: true } })
		);

		await expect(resultPromise).resolves.toEqual({
			id: sent.id,
			success: true,
			data: { clicked: true },
		});
	});

	test("detach rejects in-flight requests and flips connected to false", async () => {
		const bridge = new ExtensionBridge(1000);
		const token = bridge.attach(() => {});
		const resultPromise = bridge.send({ name: "refreshHints" });

		bridge.detach(token);

		expect(bridge.connected).toBe(false);
		const result = await resultPromise;
		expect(result.success).toBe(false);
	});

	test("assembles a response split across multiple incoming chunks", async () => {
		const bridge = new ExtensionBridge(1000);
		const written: Uint8Array[] = [];
		const token = bridge.attach((chunk) => written.push(chunk));

		const resultPromise = bridge.send({ name: "clickElement" });

		const decoder = new FrameDecoder();
		const [sent] = decoder.push(written[0]!) as [{ id: string }];
		const frame = Buffer.from(encodeFrame({ id: sent.id, success: true }));

		bridge.handleIncomingBytes(token, frame.subarray(0, 4));
		bridge.handleIncomingBytes(token, frame.subarray(4));

		await expect(resultPromise).resolves.toEqual({
			id: sent.id,
			success: true,
		});
	});

	test("promotes a surviving connection as writer when the active one detaches", async () => {
		const bridge = new ExtensionBridge(1000);
		const writtenA: Uint8Array[] = [];
		const writtenB: Uint8Array[] = [];
		const tokenA = bridge.attach((chunk) => writtenA.push(chunk));
		const tokenB = bridge.attach((chunk) => writtenB.push(chunk));

		void bridge.send({ name: "refreshHints" });
		expect(writtenB).toHaveLength(1);
		expect(writtenA).toHaveLength(0);

		bridge.detach(tokenB);
		expect(bridge.connected).toBe(true);

		void bridge.send({ name: "refreshHints" });
		expect(writtenA).toHaveLength(1);

		bridge.detach(tokenA);
		expect(bridge.connected).toBe(false);
	});

	test("keeps decoder state isolated per connection and recovers after a malformed frame", async () => {
		const bridge = new ExtensionBridge(1000);
		const tokenA = bridge.attach(() => {});
		const writtenB: Uint8Array[] = [];
		const tokenB = bridge.attach((chunk) => writtenB.push(chunk));

		const resultPromise = bridge.send({ name: "clickElement" });
		const decoder = new FrameDecoder();
		const [sent] = decoder.push(writtenB[0]!) as [{ id: string }];

		// Connection A declares an oversized frame length; this must not
		// affect connection B's independent decoder.
		const oversized = Buffer.alloc(4);
		oversized.writeUInt32LE(64 * 1024 * 1024, 0);
		bridge.handleIncomingBytes(tokenA, oversized);

		bridge.handleIncomingBytes(
			tokenB,
			encodeFrame({ id: sent.id, success: true })
		);

		await expect(resultPromise).resolves.toEqual({
			id: sent.id,
			success: true,
		});

		// A's decoder should have been reset, not stuck re-throwing on the
		// next chunk it receives.
		expect(() =>
			bridge.handleIncomingBytes(tokenA, Buffer.alloc(0))
		).not.toThrow();
	});
});
